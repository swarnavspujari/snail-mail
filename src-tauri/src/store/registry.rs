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
}
