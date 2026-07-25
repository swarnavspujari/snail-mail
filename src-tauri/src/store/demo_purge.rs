//! One-shot removal of demo data that earlier builds seeded into real user
//! databases. Runs at boot behind a kv flag.
//!
//! Demo mode used to be the app's zero-account state: a fresh install booted
//! "signed in" to two fixture accounts whose mail was written straight into
//! the user's own SQLite files. Those rows are still there after an update, so
//! cutting the demo from the code is not enough — the data has to go too.
//!
//! **Safety.** `store/mod.rs` migrated pre-v0.2 databases with
//! `ALTER TABLE threads ADD COLUMN account_id TEXT NOT NULL DEFAULT
//! 'demo@fission.local'`, so a v0.1-era install's *real* mail can carry a demo
//! account id. Matching on the account alone would delete real mail. Every row
//! delete here therefore requires the fixture id shape (`t-` / `t2-`) **and** a
//! demo account_id. Real Gmail thread ids are hex and never take that shape.

use rusqlite::{params, Connection};

use crate::store::{DEMO_ACCOUNT, DEMO_ACCOUNT_2};
use crate::types::AccountsState;

/// Set once the purge has run. Also the reason the purge can only ever run
/// once: a real account that happens to look like a fixture must not be at
/// risk on every subsequent boot.
pub const PURGED_FLAG: &str = "demo_purged_v1";

/// The two seeded accounts by name, plus anything else on the fixture domain
/// (older builds also used `you@fission.local`). Naming the constants keeps
/// this migration tied to the canonical values rather than re-spelling them.
fn is_demo_email(email: &str) -> bool {
    email == DEMO_ACCOUNT || email == DEMO_ACCOUNT_2 || email.ends_with("@fission.local")
}

/// True if this thread id has the fixture shape. Deliberately the same rule as
/// `is_mock_id` in lib.rs, restated here so the migration does not depend on a
/// private helper it cannot see.
fn is_fixture_id(id: &str) -> bool {
    id.starts_with("t-") || id.starts_with("t2-")
}

/// Delete fixture threads and everything hanging off them from a mail-bearing
/// db (the legacy pre-split `fission.db`). Tolerates a db with no `threads`
/// table — `global.db` is kv-only, and calling this on it must be harmless.
pub fn sweep_demo_rows(conn: &Connection) -> Result<usize, String> {
    let table_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='threads'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);
    if !table_exists {
        return Ok(0);
    }

    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM threads
                 WHERE (id LIKE 't-%' OR id LIKE 't2-%')
                   AND account_id LIKE '%@fission.local'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        // Belt and braces: the SQL already restricts the id shape, and this
        // re-checks it in Rust. Removing *both* is what lets a v0.1 real
        // thread carrying the defaulted demo account_id get deleted — there is
        // a test that fails exactly then.
        rows.filter_map(|r| r.ok()).filter(|id| is_fixture_id(id)).collect()
    };

    for id in &ids {
        // vec rows first — they key off thread_id, which is about to vanish.
        let _ = crate::store::vec::delete_thread_vectors(conn, id);
        conn.execute(
            "DELETE FROM attachments WHERE message_id IN
             (SELECT id FROM messages WHERE thread_id = ?1)",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM messages WHERE thread_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        // fts5 is a virtual table; a missing row is not an error worth failing on
        let _ = conn.execute("DELETE FROM mail_fts WHERE thread_id = ?1", params![id]);
        conn.execute("DELETE FROM threads WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(ids.len())
}

/// Drop demo accounts from the registry kv. Returns the emails removed so the
/// caller can delete their per-account db files.
///
/// Repoints `active` when it named a demo account; deletes the `accounts` key
/// outright when nothing real remains, which is what makes `get_accounts`
/// report the empty zero-account state rather than an empty-but-present list.
pub fn purge_registry(conn: &Connection) -> Result<Vec<String>, String> {
    let Some(state) = crate::store::get_json::<AccountsState>(conn, "accounts") else {
        return Ok(vec![]);
    };
    let (demo, real): (Vec<_>, Vec<_>) = state
        .accounts
        .into_iter()
        .partition(|a| a.provider == "mock" || is_demo_email(&a.email));
    let removed: Vec<String> = demo.into_iter().map(|a| a.email).collect();
    if removed.is_empty() {
        return Ok(removed);
    }
    if real.is_empty() {
        conn.execute("DELETE FROM kv WHERE key = 'accounts'", [])
            .map_err(|e| e.to_string())?;
    } else {
        let active = if real.iter().any(|a| a.email == state.active) {
            state.active
        } else {
            real[0].email.clone()
        };
        crate::store::save_accounts(conn, &AccountsState { accounts: real, active })?;
    }
    Ok(removed)
}

/// Demo-only kv keys in the global db (the RSVP overlay the fixture calendar
/// wrote through).
pub fn sweep_demo_kv(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM kv WHERE key = 'demo_rsvp'", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn already_purged(conn: &Connection) -> bool {
    crate::store::get_json::<bool>(conn, PURGED_FLAG) == Some(true)
}

pub fn mark_purged(conn: &Connection) -> Result<(), String> {
    crate::store::set_json(conn, PURGED_FLAG, &true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AccountInfo, Message, Thread};

    fn mail_db() -> Connection {
        crate::store::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn global_db() -> Connection {
        crate::store::open_global(std::path::Path::new(":memory:")).unwrap()
    }

    fn plant(conn: &Connection, id: &str, account: &str) {
        let t = Thread {
            id: id.into(),
            subject: format!("subject {id}"),
            snippet: "snip".into(),
            participants: vec!["someone@x.test".into()],
            recipients: vec![],
            message_count: 1,
            last_date: 1_000,
            unread: false,
            starred: false,
            labels: vec![],
            in_inbox: true,
            snoozed_until: None,
            split: String::new(),
            also_in: vec![],
        };
        let m = Message {
            id: format!("{id}-m1"),
            thread_id: id.into(),
            from: "someone@x.test".into(),
            from_name: "Someone".into(),
            to: vec!["you@x.test".into()],
            cc: vec![],
            subject: format!("subject {id}"),
            snippet: String::new(),
            body_text: "body".into(),
            body_html: None,
            date: 1_000,
            unread: false,
            attachments: vec![],
        };
        crate::store::upsert_thread(conn, account, &t, &[(m, None, None, None, vec![])]).unwrap();
    }

    fn thread_ids(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT id FROM threads ORDER BY id").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.map(|r| r.unwrap()).collect()
    }

    fn acct(email: &str, provider: &str) -> AccountInfo {
        AccountInfo {
            email: email.into(),
            provider: provider.into(),
            connected: true,
            removing: false,
        }
    }

    #[test]
    fn sweeps_fixture_threads_only() {
        let conn = mail_db();
        plant(&conn, "t-term-sheet", "demo@fission.local");
        plant(&conn, "t2-standup", "angel@fission.local");
        plant(&conn, "18f2a3b4c5d6e7f8", "real@gmail.com");

        assert_eq!(sweep_demo_rows(&conn).unwrap(), 2);
        assert_eq!(thread_ids(&conn), vec!["18f2a3b4c5d6e7f8".to_string()]);
    }

    /// store/mod.rs defaulted every pre-v0.2 thread's account_id to
    /// demo@fission.local, so real mail can carry a demo account id. Matching
    /// on the account alone would eat it.
    #[test]
    fn spares_v01_real_mail_defaulted_to_the_demo_account() {
        let conn = mail_db();
        plant(&conn, "18f2a3b4c5d6e7f8", "demo@fission.local");

        assert_eq!(sweep_demo_rows(&conn).unwrap(), 0);
        assert_eq!(thread_ids(&conn), vec!["18f2a3b4c5d6e7f8".to_string()]);
    }

    /// And the mirror image: a fixture-shaped id belonging to a real account
    /// is not ours to delete either.
    #[test]
    fn spares_fixture_shaped_ids_on_real_accounts() {
        let conn = mail_db();
        plant(&conn, "t-something", "real@gmail.com");

        assert_eq!(sweep_demo_rows(&conn).unwrap(), 0);
        assert_eq!(thread_ids(&conn), vec!["t-something".to_string()]);
    }

    #[test]
    fn sweep_takes_messages_and_attachments_with_it() {
        let conn = mail_db();
        plant(&conn, "t-term-sheet", "demo@fission.local");
        sweep_demo_rows(&conn).unwrap();

        let msgs: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        let atts: i64 = conn
            .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(msgs, 0);
        assert_eq!(atts, 0);
    }

    #[test]
    fn sweep_is_idempotent_and_survives_a_kv_only_db() {
        let conn = mail_db();
        plant(&conn, "t-term-sheet", "demo@fission.local");
        assert_eq!(sweep_demo_rows(&conn).unwrap(), 1);
        assert_eq!(sweep_demo_rows(&conn).unwrap(), 0);

        // global.db has no threads table at all
        let g = global_db();
        assert_eq!(sweep_demo_rows(&g).unwrap(), 0);
    }

    #[test]
    fn drops_demo_accounts_and_repoints_active() {
        let conn = global_db();
        crate::store::save_accounts(
            &conn,
            &AccountsState {
                accounts: vec![acct("demo@fission.local", "mock"), acct("real@gmail.com", "gmail")],
                active: "demo@fission.local".into(),
            },
        )
        .unwrap();

        let removed = purge_registry(&conn).unwrap();

        assert_eq!(removed, vec!["demo@fission.local".to_string()]);
        let after = crate::store::get_accounts(&conn);
        assert_eq!(after.accounts.len(), 1);
        assert_eq!(after.active, "real@gmail.com");
    }

    #[test]
    fn clears_the_accounts_key_when_only_demo_existed() {
        let conn = global_db();
        crate::store::save_accounts(
            &conn,
            &AccountsState {
                accounts: vec![acct("demo@fission.local", "mock"), acct("angel@fission.local", "mock")],
                active: "demo@fission.local".into(),
            },
        )
        .unwrap();

        let removed = purge_registry(&conn).unwrap();

        assert_eq!(removed.len(), 2);
        let raw: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = 'accounts'", [], |r| r.get(0))
            .ok();
        assert!(raw.is_none(), "the key must be gone, not an empty list");
    }

    /// A registry with no demo accounts must come out byte-identical — the
    /// migration runs on every existing install, most of which are real.
    #[test]
    fn leaves_a_real_only_registry_alone() {
        let conn = global_db();
        crate::store::save_accounts(
            &conn,
            &AccountsState {
                accounts: vec![acct("a@gmail.com", "gmail"), acct("b@gmail.com", "gmail")],
                active: "b@gmail.com".into(),
            },
        )
        .unwrap();
        let before: String = conn
            .query_row("SELECT value FROM kv WHERE key = 'accounts'", [], |r| r.get(0))
            .unwrap();

        assert!(purge_registry(&conn).unwrap().is_empty());

        let after: String = conn
            .query_row("SELECT value FROM kv WHERE key = 'accounts'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn purge_registry_on_a_virgin_db_is_a_no_op() {
        let conn = global_db();
        assert!(purge_registry(&conn).unwrap().is_empty());
    }

    #[test]
    fn flag_round_trips() {
        let conn = global_db();
        assert!(!already_purged(&conn));
        mark_purged(&conn).unwrap();
        assert!(already_purged(&conn));
    }

    /// Runs the sweep against a real database, for verifying the migration on
    /// a copy of an actual install before shipping it. Never point this at a
    /// live db — it deletes rows.
    ///
    ///   SNAIL_PURGE_DB=/path/to/copy-of/fission.db \
    ///     cargo test purge_a_real_db -- --ignored --nocapture
    #[test]
    #[ignore = "needs SNAIL_PURGE_DB pointing at a COPY of a real database"]
    fn purge_a_real_db() {
        let path = std::env::var("SNAIL_PURGE_DB").expect("set SNAIL_PURGE_DB");
        let conn = crate::store::open(std::path::Path::new(&path)).unwrap();

        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(-1) };
        let threads = "SELECT COUNT(*) FROM threads";
        let fixtures = "SELECT COUNT(*) FROM threads
                        WHERE (id LIKE 't-%' OR id LIKE 't2-%')
                          AND account_id LIKE '%@fission.local'";
        let demo_acct = "SELECT COUNT(*) FROM threads WHERE account_id LIKE '%@fission.local'";

        println!("BEFORE threads={} fixtures={} demo_account_rows={} messages={}",
            count(threads), count(fixtures), count(demo_acct),
            count("SELECT COUNT(*) FROM messages"));
        println!("registry: {:?}", crate::store::get_json::<AccountsState>(&conn, "accounts"));

        let swept = sweep_demo_rows(&conn).unwrap();
        let removed = purge_registry(&conn).unwrap();
        sweep_demo_kv(&conn).unwrap();

        println!("SWEPT {swept} fixture threads; removed accounts {removed:?}");
        println!("AFTER  threads={} fixtures={} demo_account_rows={} messages={}",
            count(threads), count(fixtures), count(demo_acct),
            count("SELECT COUNT(*) FROM messages"));
        println!("registry: {:?}", crate::store::get_json::<AccountsState>(&conn, "accounts"));

        assert_eq!(count(fixtures), 0, "every fixture thread must be gone");
    }

    /// Read-only dump of a real global.db, for confirming what a booted app
    /// actually sees. Mutates nothing.
    ///
    ///   SNAIL_INSPECT_DB=/path/to/global.db \
    ///     cargo test inspect_real_db -- --ignored --nocapture
    #[test]
    #[ignore = "needs SNAIL_INSPECT_DB"]
    fn inspect_real_db() {
        let path = std::env::var("SNAIL_INSPECT_DB").expect("set SNAIL_INSPECT_DB");
        let conn = rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let mut stmt = conn.prepare("SELECT key, substr(value,1,300) FROM kv ORDER BY key").unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .unwrap();
        for r in rows {
            let (k, v) = r.unwrap();
            println!("KV {k} = {v}");
        }
        let onboarded: Option<String> = conn
            .query_row(
                "SELECT json_extract(value,'$.onboarded') FROM kv WHERE key='settings'",
                [],
                |r| r.get(0),
            )
            .ok();
        let accounts: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key='accounts'", [], |r| r.get(0))
            .ok();
        println!("GATE onboarded={onboarded:?} accounts={accounts:?}");
    }

    #[test]
    fn sweeps_the_rsvp_overlay() {
        let conn = global_db();
        crate::store::set_json(&conn, "demo_rsvp", &vec![("uid", "accepted")]).unwrap();
        sweep_demo_kv(&conn).unwrap();
        let raw: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = 'demo_rsvp'", [], |r| r.get(0))
            .ok();
        assert!(raw.is_none());
    }
}
