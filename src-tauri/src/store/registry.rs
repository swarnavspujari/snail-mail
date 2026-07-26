//! DbRegistry: the one `global.db` connection plus lazily-opened per-account
//! connections (`accounts/<name>.db`), with legacy `fission.db` routing while
//! the split migration is in flight. Lock ordering rule: never hold two db
//! mutexes at once — fan-outs take account connections sequentially.

use rusqlite::Connection;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// kv keys that belong to `global.db`. Every other key in the legacy kv is
/// account-scoped by naming convention and migrates with its account
/// (`embed_model` is special-cased into each account file by the migrator so
/// the first embed beat doesn't wipe freshly migrated vectors).
pub const GLOBAL_KV_KEYS: [&str; 8] = [
    "accounts",
    "account", // v0.1 single-account blob, still read by get_accounts
    "settings",
    "kb",
    "streaks",
    "demo_rsvp",
    "unsplash:daily",
    "unsplash:hourly",
];

pub struct DbRegistry {
    global: Arc<Mutex<Connection>>,
    accounts: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    legacy: Mutex<Option<Arc<Mutex<Connection>>>>,
    pub data_dir: PathBuf,
}

impl DbRegistry {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir.join("accounts")).map_err(|e| e.to_string())?;
        let global = super::open_global(&data_dir.join("global.db"))?;
        let legacy_path = data_dir.join("fission.db");
        let mut legacy = None;
        if legacy_path.exists() && super::get_json::<bool>(&global, "migration_done") != Some(true) {
            let lc = super::open(&legacy_path)?;
            copy_global_kv(&lc, &global)?;
            legacy = Some(Arc::new(Mutex::new(lc)));
        }
        Ok(Self {
            global: Arc::new(Mutex::new(global)),
            accounts: Mutex::new(HashMap::new()),
            legacy: Mutex::new(legacy),
            data_dir: data_dir.to_path_buf(),
        })
    }

    pub fn global(&self) -> Arc<Mutex<Connection>> {
        self.global.clone()
    }

    /// Split definitions for classification, read from `global.db` — the only
    /// place `save_settings` writes them. Account files never hold a settings
    /// row, so classifiers must take these, never read defs off their own conn.
    pub fn split_defs(&self) -> Vec<crate::types::Split> {
        let g = self.global.lock().unwrap();
        super::split_config(&g)
    }

    /// The connection serving this account right now: its own file once the
    /// account is migrated (or there is no legacy db), else the legacy db.
    pub fn account(&self, email: &str) -> Result<Arc<Mutex<Connection>>, String> {
        if !self.is_migrated(email) {
            if let Some(l) = self.legacy.lock().unwrap().clone() {
                return Ok(l);
            }
        }
        let mut map = self.accounts.lock().unwrap();
        if let Some(c) = map.get(email) {
            return Ok(c.clone());
        }
        let conn = super::open(&self.account_db_path(email))?;
        let arc = Arc::new(Mutex::new(conn));
        map.insert(email.to_string(), arc.clone());
        Ok(arc)
    }

    pub fn account_db_path(&self, email: &str) -> PathBuf {
        self.data_dir.join("accounts").join(super::account_db_filename(email))
    }

    /// Emails currently in the registry (the accounts blob in global.db,
    /// including the demo-pair fallback).
    pub fn registered_emails(&self) -> Vec<String> {
        let g = self.global.lock().unwrap();
        super::get_accounts(&g).accounts.iter().map(|a| a.email.clone()).collect()
    }

    pub fn is_migrated(&self, email: &str) -> bool {
        if self.legacy.lock().unwrap().is_none() {
            return true; // nothing to migrate from
        }
        let g = self.global.lock().unwrap();
        super::get_json::<bool>(&g, &format!("migrated:{email}")) == Some(true)
    }

    pub fn mark_migrated(&self, email: &str) -> Result<(), String> {
        let g = self.global.lock().unwrap();
        super::set_json(&g, &format!("migrated:{email}"), &true)
    }

    pub fn legacy(&self) -> Option<Arc<Mutex<Connection>>> {
        self.legacy.lock().unwrap().clone()
    }

    /// Close this account's connection and delete its file (+ -wal/-shm).
    /// In-flight commands may briefly hold transient Arc clones, so the
    /// delete retries for a few seconds; a still-busy file is reported and
    /// left for the boot sweep. Idempotent — a missing file is Ok.
    pub fn close_and_delete(&self, email: &str) -> Result<(), String> {
        self.accounts.lock().unwrap().remove(email);
        let path = self.account_db_path(email);
        if !path.exists() {
            return Ok(());
        }
        let mut last_err: Option<std::io::Error> = None;
        for _ in 0..40 {
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    for side in ["-wal", "-shm"] {
                        let mut p = path.clone().into_os_string();
                        p.push(side);
                        let _ = std::fs::remove_file(std::path::PathBuf::from(p));
                    }
                    return Ok(());
                }
                Err(e) => {
                    last_err = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
        }
        Err(format!(
            "could not delete {}: {}",
            path.display(),
            last_err.map(|e| e.to_string()).unwrap_or_default()
        ))
    }

    pub fn legacy_db_path(&self) -> PathBuf {
        self.data_dir.join("fission.db")
    }

    /// Release the legacy connection (after the migration fully verifies) so
    /// the file can be renamed away.
    pub fn drop_legacy(&self) {
        *self.legacy.lock().unwrap() = None;
    }
}

/// One-time copy of the app-wide kv rows out of the legacy db into global.db.
/// Idempotent: guarded by a flag, and existing global rows win so a re-run
/// can never clobber settings changed after the first copy.
fn copy_global_kv(legacy: &Connection, global: &Connection) -> Result<(), String> {
    if super::get_json::<bool>(global, "global_kv_copied") == Some(true) {
        return Ok(());
    }
    for key in GLOBAL_KV_KEYS {
        let val: Option<String> = legacy
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .ok();
        if let Some(v) = val {
            global
                .execute("INSERT OR IGNORE INTO kv(key, value) VALUES(?1, ?2)", [key, v.as_str()])
                .map_err(|e| e.to_string())?;
        }
    }
    super::set_json(global, "global_kv_copied", &true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "snail-registry-{tag}-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn accounts_are_isolated_per_file() {
        let dir = tmp_dir("iso");
        let reg = DbRegistry::open(&dir).unwrap();
        let a = reg.account("a@x.test").unwrap();
        let b = reg.account("b@x.test").unwrap();
        crate::store::tests::seed(&a.lock().unwrap(), "t-1", "Hello", "body", "Ann", 1_000);
        let count = |c: &Arc<Mutex<Connection>>| -> i64 {
            c.lock().unwrap().query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0)).unwrap()
        };
        assert_eq!(count(&a), 1);
        assert_eq!(count(&b), 0, "b@x.test must not see a@x.test's thread");
        // same email → same connection object
        assert!(Arc::ptr_eq(&a, &reg.account("a@x.test").unwrap()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn legacy_routing_until_marked_migrated() {
        let dir = tmp_dir("route");
        // a legacy fission.db with one gmail account and one thread
        {
            let legacy = crate::store::open(&dir.join("fission.db")).unwrap();
            let acc = crate::types::AccountsState {
                accounts: vec![crate::types::AccountInfo {
                    email: "u@x.test".into(),
                    provider: "gmail".into(),
                    connected: true,
                    removing: false,
                }],
                active: "u@x.test".into(),
            };
            crate::store::save_accounts(&legacy, &acc).unwrap();
            crate::store::tests::seed(&legacy, "t-legacy", "Old mail", "body", "Ann", 1_000);
        }
        let reg = DbRegistry::open(&dir).unwrap();
        assert!(reg.legacy().is_some());
        assert_eq!(reg.registered_emails(), vec!["u@x.test".to_string()]);
        // unmigrated → the account conn IS the legacy conn
        let via = reg.account("u@x.test").unwrap();
        let n: i64 =
            via.lock().unwrap().query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // migrated → fresh per-account file, legacy thread not visible there
        reg.mark_migrated("u@x.test").unwrap();
        let own = reg.account("u@x.test").unwrap();
        let n: i64 =
            own.lock().unwrap().query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert!(reg.account_db_path("u@x.test").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn close_and_delete_is_instant_and_idempotent() {
        let dir = tmp_dir("del");
        let reg = DbRegistry::open(&dir).unwrap();
        {
            let db = reg.account("gone@x.test").unwrap();
            crate::store::tests::seed(&db.lock().unwrap(), "t-1", "Bye", "body", "Ann", 1_000);
        }
        let path = reg.account_db_path("gone@x.test");
        assert!(path.exists());
        reg.close_and_delete("gone@x.test").unwrap();
        assert!(!path.exists(), "db file must be gone");
        let mut wal = path.clone().into_os_string();
        wal.push("-wal");
        assert!(!std::path::PathBuf::from(wal).exists(), "sidecars must be gone");
        // double-click safe: a second delete of a missing file is Ok
        reg.close_and_delete("gone@x.test").unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn global_kv_copy_takes_app_keys_and_leaves_account_keys() {
        let dir = tmp_dir("kvcopy");
        {
            let legacy = crate::store::open(&dir.join("fission.db")).unwrap();
            crate::store::set_json(&legacy, "streaks", &serde_json::json!({"daily": 3})).unwrap();
            crate::store::set_json(&legacy, "settings", &serde_json::json!({"theme": "dark"})).unwrap();
            crate::store::set_json(&legacy, "history:u@x.test", &"12345").unwrap();
        }
        let reg = DbRegistry::open(&dir).unwrap();
        {
            let g = reg.global();
            let g = g.lock().unwrap();
            assert!(crate::store::get_json::<serde_json::Value>(&g, "streaks").is_some());
            assert!(crate::store::get_json::<serde_json::Value>(&g, "settings").is_some());
            assert!(
                crate::store::get_json::<String>(&g, "history:u@x.test").is_none(),
                "account-scoped kv must not leak into global.db"
            );
            // a later change in global.db survives a second registry open
            crate::store::set_json(&g, "streaks", &serde_json::json!({"daily": 9})).unwrap();
        }
        drop(reg);
        let reg2 = DbRegistry::open(&dir).unwrap();
        let g = reg2.global();
        let g = g.lock().unwrap();
        let s: serde_json::Value = crate::store::get_json(&g, "streaks").unwrap();
        assert_eq!(s["daily"], 9, "idempotent copy must not clobber newer global values");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The v0.23 desktop blocker: settings live only in global.db, so any
    /// classifier that reads split defs off the account conn silently gets the
    /// defaults and custom splits never fill. split_defs() is the fix — pin
    /// both directions.
    #[test]
    fn split_defs_read_global_settings_and_classify_account_threads() {
        let dir = tmp_dir("splitdefs");
        let reg = DbRegistry::open(&dir).unwrap();
        {
            let g = reg.global();
            let g = g.lock().unwrap();
            let mut settings = crate::store::default_settings();
            settings.splits.insert(
                0,
                crate::types::Split {
                    id: "travel".into(),
                    name: "Travel".into(),
                    builtin: false,
                    query: "from:thriftytraveler.com OR from:thepointsguy.com".into(),
                    account_id: None,
                    also_show: false,
                    hide_when_empty: false,
                    rules: vec![],
                    op: "or".into(),
                },
            );
            crate::store::set_json(&g, "settings", &settings).unwrap();
        }
        let defs = reg.split_defs();
        assert!(defs.iter().any(|s| s.id == "travel"), "split_defs must read global.db");

        let a = reg.account("u@x.test").unwrap();
        let conn = a.lock().unwrap();
        let t = crate::types::Thread {
            id: "t-tt".into(),
            subject: "Fare drop".into(),
            snippet: String::new(),
            participants: vec!["Thrifty Traveler <deals@thriftytraveler.com>".into()],
            recipients: vec![],
            message_count: 1,
            last_date: 1_000,
            unread: true,
            starred: false,
            labels: vec![],
            in_inbox: true,
            snoozed_until: None,
            split: String::new(),
            also_in: vec![],
        };
        crate::store::upsert_thread(&conn, "u@x.test", &t, &[], &defs).unwrap();
        let split: String = conn
            .query_row("SELECT split_id FROM threads WHERE id = 't-tt'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(split, "travel", "account-file upsert must classify with global defs");

        // The account file itself holds no settings row — defs read off it are
        // the defaults. If this ever starts passing a 'travel' split, the
        // global/account settings separation changed and split_defs can go.
        let off_account_conn = crate::store::split_config(&conn);
        assert!(
            !off_account_conn.iter().any(|s| s.id == "travel"),
            "account conns must not see custom splits (settings live in global.db)"
        );
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn test_mail(subject: &str) -> crate::types::OutgoingMail {
        crate::types::OutgoingMail {
            thread_id: None,
            to: vec!["x@y.test".into()],
            cc: vec![],
            bcc: vec![],
            subject: subject.into(),
            body_text: "b".into(),
            body_html: None,
            reply_all: false,
            attachments: vec![],
        }
    }

    fn draft_payload(reg: &DbRegistry, account: &str, id: i64) -> Option<String> {
        let db = reg.account(account).unwrap();
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT payload FROM drafts WHERE id = ?1 AND account_id = ?2",
            rusqlite::params![id, account],
            |r| r.get(0),
        )
        .ok()
    }

    fn outbox_subject(reg: &DbRegistry, account: &str, id: i64) -> Option<String> {
        let db = reg.account(account).unwrap();
        let conn = db.lock().unwrap();
        crate::store::outbox_get(&conn, id, account).map(|m| m.subject)
    }

    /// `drafts.id` / `outbox.id` are per-file AUTOINCREMENT, so id 1 in account
    /// A and id 1 in account B are different rows with the same name. The old
    /// commands resolved a bare id by probing account connections active-first,
    /// so whichever account happened to be active shadowed the real owner —
    /// deleting or sending a draft acted on the wrong mailbox. Identity is the
    /// pair (id, account) now; pin that every mutator honors it.
    #[test]
    fn colliding_draft_ids_resolve_to_the_owning_account() {
        let dir = tmp_dir("draftcollide");
        let reg = DbRegistry::open(&dir).unwrap();

        let id_a = {
            let db = reg.account("a@x.test").unwrap();
            let conn = db.lock().unwrap();
            crate::store::draft_insert(&conn, "a@x.test", "draft-A", 1_000).unwrap()
        };
        let id_b = {
            let db = reg.account("b@x.test").unwrap();
            let conn = db.lock().unwrap();
            crate::store::draft_insert(&conn, "b@x.test", "draft-B", 1_000).unwrap()
        };
        assert_eq!((id_a, id_b), (1, 1), "the id collision this test is about");

        // deleting B's draft leaves A's identically-numbered row alone
        {
            let db = reg.account("b@x.test").unwrap();
            let conn = db.lock().unwrap();
            crate::store::draft_delete(&conn, id_b, "b@x.test");
        }
        assert_eq!(draft_payload(&reg, "a@x.test", id_a).as_deref(), Some("draft-A"));
        assert_eq!(draft_payload(&reg, "b@x.test", id_b), None, "B's row is the one that goes");

        // an update addressed to the wrong owner must miss rather than clobber
        {
            let db = reg.account("a@x.test").unwrap();
            let conn = db.lock().unwrap();
            assert!(
                !crate::store::draft_update(&conn, id_a, "b@x.test", "clobbered", 2_000),
                "an id owned by A must not be writable as B"
            );
            assert!(crate::store::draft_update(&conn, id_a, "a@x.test", "draft-A2", 2_000));
        }
        assert_eq!(draft_payload(&reg, "a@x.test", id_a).as_deref(), Some("draft-A2"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn colliding_outbox_ids_send_and_cancel_the_owning_accounts_row() {
        let dir = tmp_dir("outboxcollide");
        let reg = DbRegistry::open(&dir).unwrap();

        let id_a = {
            let db = reg.account("a@x.test").unwrap();
            let conn = db.lock().unwrap();
            crate::store::outbox_add(&conn, "a@x.test", &test_mail("for-A"), 0).unwrap()
        };
        let id_b = {
            let db = reg.account("b@x.test").unwrap();
            let conn = db.lock().unwrap();
            crate::store::outbox_add(&conn, "b@x.test", &test_mail("for-B"), 0).unwrap()
        };
        assert_eq!((id_a, id_b), (1, 1), "the id collision this test is about");

        // send (claim → read → delete) B's row: A's identically-numbered row
        // must stay queued and unclaimed
        {
            let db = reg.account("b@x.test").unwrap();
            let conn = db.lock().unwrap();
            assert!(crate::store::outbox_claim(&conn, id_b, "b@x.test"));
            assert_eq!(
                crate::store::outbox_get(&conn, id_b, "b@x.test").map(|m| m.subject),
                Some("for-B".to_string()),
                "send must read the owner's payload, not a same-id neighbour's"
            );
            crate::store::outbox_delete(&conn, id_b, "b@x.test");
        }
        assert_eq!(outbox_subject(&reg, "a@x.test", id_a).as_deref(), Some("for-A"));
        assert_eq!(outbox_subject(&reg, "b@x.test", id_b), None, "B's row is the one that sent");
        {
            let db = reg.account("a@x.test").unwrap();
            let conn = db.lock().unwrap();
            assert_eq!(crate::store::outbox_due(&conn, 1).len(), 1, "A's send is still pending");
        }

        // cancel (Undo Send) addressed to the wrong owner is a no-op
        {
            let db = reg.account("a@x.test").unwrap();
            let conn = db.lock().unwrap();
            assert!(crate::store::outbox_cancel(&conn, id_a, "b@x.test").is_none());
            assert_eq!(
                crate::store::outbox_cancel(&conn, id_a, "a@x.test").map(|m| m.subject),
                Some("for-A".to_string())
            );
        }
        assert_eq!(outbox_subject(&reg, "a@x.test", id_a), None, "cancel removed A's row");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Why the commands resolve a frontend-supplied account through the
    /// registry first: opening one is lazy-CREATE, so handing `account()` a
    /// stale email (compose still holding a draft from a since-disconnected
    /// mailbox) writes an empty db back onto disk — undoing the delete that
    /// `close_and_delete` just performed.
    #[test]
    fn opening_an_unknown_account_creates_its_file() {
        let dir = tmp_dir("lazycreate");
        let reg = DbRegistry::open(&dir).unwrap();
        let path = reg.account_db_path("ghost@x.test");
        assert!(!path.exists());
        let _ = reg.account("ghost@x.test").unwrap();
        assert!(path.exists(), "account() creates on open — callers must gate on the registry");
        assert!(
            !reg.registered_emails().iter().any(|e| e == "ghost@x.test"),
            "…and it is still not a registered account"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Mid-migration both accounts share the legacy file, so picking "the right
    /// connection" resolves nothing on its own — `account_id` has to be in the
    /// WHERE clause. Ids can't collide inside one file, but a bare-id mutator
    /// still reaches straight across accounts, which is the same bug.
    #[test]
    fn shared_legacy_db_scopes_mutations_by_account() {
        let dir = tmp_dir("legacyscope");
        {
            let legacy = crate::store::open(&dir.join("fission.db")).unwrap();
            let acc = crate::types::AccountsState {
                accounts: vec![
                    crate::types::AccountInfo {
                        email: "a@x.test".into(),
                        provider: "gmail".into(),
                        connected: true,
                        removing: false,
                    },
                    crate::types::AccountInfo {
                        email: "b@x.test".into(),
                        provider: "gmail".into(),
                        connected: true,
                        removing: false,
                    },
                ],
                active: "a@x.test".into(),
            };
            crate::store::save_accounts(&legacy, &acc).unwrap();
        }
        let reg = DbRegistry::open(&dir).unwrap();
        let a = reg.account("a@x.test").unwrap();
        let b = reg.account("b@x.test").unwrap();
        assert!(Arc::ptr_eq(&a, &b), "unmigrated accounts share the legacy conn");

        let conn = a.lock().unwrap();
        let draft_b = crate::store::draft_insert(&conn, "b@x.test", "draft-B", 1_000).unwrap();
        let out_b = crate::store::outbox_add(&conn, "b@x.test", &test_mail("for-B"), 0).unwrap();

        // A is active; acting on B's ids as A must not reach B's rows
        crate::store::draft_delete(&conn, draft_b, "a@x.test");
        assert!(!crate::store::outbox_claim(&conn, out_b, "a@x.test"));
        assert!(crate::store::outbox_cancel(&conn, out_b, "a@x.test").is_none());
        crate::store::outbox_delete(&conn, out_b, "a@x.test");

        assert_eq!(crate::store::draft_list(&conn, "b@x.test").len(), 1, "B's draft survived");
        assert_eq!(
            crate::store::outbox_get(&conn, out_b, "b@x.test").map(|m| m.subject),
            Some("for-B".to_string()),
            "B's queued send survived"
        );
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }
}
