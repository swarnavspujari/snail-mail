//! Split the legacy all-accounts `fission.db` into per-account files.
//!
//! Correctness model: sync/crawl/embed/outbox loops are quiesced while this
//! runs, so the only concurrent writer is a user action going through the
//! app's legacy connection. Bulk content (messages, attachments, mail_fts,
//! vectors) is immutable-enough and copied in bounded transactions with the
//! rowid cursor committed in the SAME transaction — a kill either keeps or
//! rolls back a whole chunk, so resume is exactly-once. Small mutable tables
//! (threads, drafts, outbox, labels, contacts, people_contacts, events, the
//! per-account kv) are re-copied wholesale in one final "flip" transaction
//! held under the app's legacy connection lock, so no user write can race
//! the cutover. Row counts + spot checks must pass before the account's
//! `migrated:` flag is set; `fission.db` becomes `.bak` only when every
//! registered account has verified, and is deleted on the next boot that
//! re-verifies.

use super::registry::DbRegistry;
use rusqlite::{params, Connection};
use std::path::Path;

pub struct MigrateOpts {
    pub chunk_rows: usize,
    /// Test hook: stop after N chunk transactions (simulates a mid-flight kill).
    pub max_chunks: Option<usize>,
}

impl Default for MigrateOpts {
    fn default() -> Self {
        Self { chunk_rows: 2000, max_chunks: None }
    }
}

#[derive(Clone, serde::Serialize)]
pub struct MigrateProgress {
    pub email: String,
    pub table: String,
    pub copied: i64,
    pub total: i64,
}

pub fn needs_migration(global: &Connection, data_dir: &Path) -> bool {
    data_dir.join("fission.db").exists()
        && super::get_json::<bool>(global, "migration_done") != Some(true)
}

/// Exact per-account kv key prefixes (`{prefix}:{email}`).
const KV_EXACT: [&str; 11] = [
    "history",
    "crawl",
    "threads_total",
    "profile",
    "granted_scopes",
    "scope_notice_shown",
    "sendas",
    "people_synced",
    "drive_folder",
    "cal_synced_at",
    "cal_range",
];
/// Per-account kv key prefixes with a further `:{suffix}` segment.
const KV_PREFIX: [&str; 3] = ["cal_sync", "cal_anchor", "invite_miss"];

/// Small tables re-copied wholesale in the flip transaction.
const FLIP_TABLES: [&str; 7] =
    ["threads", "drafts", "outbox", "labels", "contacts", "people_contacts", "events"];

struct BulkSpec {
    name: &'static str,
    /// next chunk of source rowids: ?1 = account, ?2 = cursor, ?3 = limit
    rowids: &'static str,
    /// copy one rowid range: ?1 = account, ?2 = lo (exclusive), ?3 = hi (inclusive)
    inserts: &'static [&'static str],
    /// count for totals/verify: ?1 = account (run against both `legacy.` and `main.`)
    count: &'static str,
}

const BULK: [BulkSpec; 4] = [
    BulkSpec {
        name: "messages",
        rowids: "SELECT m.rowid FROM legacy.messages m JOIN legacy.threads t ON t.id = m.thread_id
                 WHERE t.account_id = ?1 AND m.rowid > ?2 ORDER BY m.rowid LIMIT ?3",
        inserts: &["INSERT OR IGNORE INTO main.messages
                    SELECT m.* FROM legacy.messages m JOIN legacy.threads t ON t.id = m.thread_id
                    WHERE t.account_id = ?1 AND m.rowid > ?2 AND m.rowid <= ?3"],
        count: "SELECT COUNT(*) FROM {db}messages m JOIN {db}threads t ON t.id = m.thread_id
                WHERE t.account_id = ?1",
    },
    BulkSpec {
        name: "attachments",
        rowids: "SELECT a.rowid FROM legacy.attachments a
                 JOIN legacy.messages m ON m.id = a.message_id
                 JOIN legacy.threads t ON t.id = m.thread_id
                 WHERE t.account_id = ?1 AND a.rowid > ?2 ORDER BY a.rowid LIMIT ?3",
        inserts: &["INSERT OR IGNORE INTO main.attachments
                    SELECT a.* FROM legacy.attachments a
                    JOIN legacy.messages m ON m.id = a.message_id
                    JOIN legacy.threads t ON t.id = m.thread_id
                    WHERE t.account_id = ?1 AND a.rowid > ?2 AND a.rowid <= ?3"],
        count: "SELECT COUNT(*) FROM {db}attachments a
                JOIN {db}messages m ON m.id = a.message_id
                JOIN {db}threads t ON t.id = m.thread_id WHERE t.account_id = ?1",
    },
    BulkSpec {
        name: "mail_fts",
        rowids: "SELECT f.rowid FROM legacy.mail_fts f JOIN legacy.threads t ON t.id = f.thread_id
                 WHERE t.account_id = ?1 AND f.rowid > ?2 ORDER BY f.rowid LIMIT ?3",
        inserts: &["INSERT INTO main.mail_fts(rowid, thread_id, subject, from_text, body)
                    SELECT f.rowid, f.thread_id, f.subject, f.from_text, f.body
                    FROM legacy.mail_fts f JOIN legacy.threads t ON t.id = f.thread_id
                    WHERE t.account_id = ?1 AND f.rowid > ?2 AND f.rowid <= ?3"],
        count: "SELECT COUNT(*) FROM {db}mail_fts f JOIN {db}threads t ON t.id = f.thread_id
                WHERE t.account_id = ?1",
    },
    // vec_meta + mail_vec stay paired inside one transaction per chunk,
    // mirroring write_batch's pairing rationale in mail/sync.rs.
    BulkSpec {
        name: "vec",
        rowids: "SELECT vec_rowid FROM legacy.vec_meta
                 WHERE account_id = ?1 AND vec_rowid > ?2 ORDER BY vec_rowid LIMIT ?3",
        inserts: &[
            "INSERT OR IGNORE INTO main.vec_meta
             SELECT * FROM legacy.vec_meta
             WHERE account_id = ?1 AND vec_rowid > ?2 AND vec_rowid <= ?3",
            "INSERT INTO main.mail_vec(rowid, embedding)
             SELECT v.rowid, v.embedding FROM legacy.mail_vec v
             JOIN legacy.vec_meta vm ON vm.vec_rowid = v.rowid
             WHERE vm.account_id = ?1 AND v.rowid > ?2 AND v.rowid <= ?3",
        ],
        count: "SELECT COUNT(*) FROM {db}vec_meta WHERE account_id = ?1",
    },
];

fn count_scoped(conn: &Connection, sql_tpl: &str, db: &str, email: &str) -> Result<i64, String> {
    let sql = sql_tpl.replace("{db}", db);
    conn.query_row(&sql, params![email], |r| r.get(0)).map_err(|e| e.to_string())
}

fn cursor_key(table: &str) -> String {
    format!("migrate_cursor:{table}")
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Defensive: both files are created by the same DDL+ALTER history, so the
/// column order must be identical — `SELECT *` copies depend on it.
fn assert_same_columns(target: &Connection, table: &str) -> Result<(), String> {
    let cols = |db: &str| -> Result<Vec<String>, String> {
        let mut stmt = target
            .prepare(&format!("SELECT name FROM {db}.pragma_table_info('{table}')"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    };
    let (l, m) = (cols("legacy")?, cols("main")?);
    if l != m {
        return Err(format!("column drift on {table}: legacy {l:?} vs new {m:?}"));
    }
    Ok(())
}

/// Copy one account out of the legacy db into its own file. Returns
/// Ok(true) when the account is fully migrated and verified, Ok(false) when
/// the chunk budget ran out (call again to resume).
pub fn migrate_account(
    reg: &DbRegistry,
    email: &str,
    opts: &MigrateOpts,
    progress: &mut dyn FnMut(MigrateProgress),
) -> Result<bool, String> {
    if reg.is_migrated(email) {
        return Ok(true);
    }
    let Some(legacy_arc) = reg.legacy() else {
        return Ok(true); // nothing to migrate from
    };
    let target = super::open(&reg.account_db_path(email))?;
    target
        .execute(
            "ATTACH DATABASE ?1 AS legacy",
            params![reg.legacy_db_path().to_string_lossy()],
        )
        .map_err(|e| e.to_string())?;
    for t in ["threads", "messages", "attachments", "vec_meta", "drafts", "outbox", "labels",
              "contacts", "people_contacts", "events", "kv"]
    {
        assert_same_columns(&target, t)?;
    }

    // totals for progress (legacy side, computed once per run)
    let mut total = 0i64;
    for spec in &BULK {
        total += count_scoped(&target, spec.count, "legacy.", email)?;
    }
    let mut copied = 0i64;
    for spec in &BULK {
        copied += count_scoped(&target, spec.count, "main.", email)?;
    }

    let mut chunks_used = 0usize;
    for spec in &BULK {
        loop {
            if let Some(max) = opts.max_chunks {
                if chunks_used >= max {
                    return Ok(false); // budget exhausted — resumable
                }
            }
            let lo: i64 =
                super::get_json(&target, &cursor_key(spec.name)).unwrap_or(0);
            let ids: Vec<i64> = {
                let mut stmt = target.prepare(spec.rowids).map_err(|e| e.to_string())?;
                let ids = stmt
                    .query_map(params![email, lo, opts.chunk_rows as i64], |r| r.get(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                ids
            };
            let Some(&hi) = ids.last() else { break };
            let tx = target.unchecked_transaction().map_err(|e| e.to_string())?;
            for ins in spec.inserts {
                tx.execute(ins, params![email, lo, hi]).map_err(|e| e.to_string())?;
            }
            super::set_json(&tx, &cursor_key(spec.name), &hi)?;
            tx.commit().map_err(|e| e.to_string())?;
            chunks_used += 1;
            copied += ids.len() as i64;
            progress(MigrateProgress {
                email: email.into(),
                table: spec.name.into(),
                copied,
                total,
            });
        }
    }

    // The FTS and vector scans are the expensive half of verification and
    // their sources are stable here (bulk cursors done, sync quiesced), so
    // they run BEFORE the flip guard — holding the app's legacy lock across
    // them showed up as a multi-second UI stall in the perf test.
    verify_bulk_indexes(&target, email)?;
    // Flip: hold the app's legacy connection lock so no user write can land
    // between the final copy, the remaining verification, and the routing flip.
    {
        let legacy_conn = legacy_arc.lock().unwrap();
        flip_small_tables(&target, email)?;
        verify_account(&target, email)?;
        drop(legacy_conn);
    }
    reg.mark_migrated(email)?;
    // Bookkeeping cleanup only AFTER the migrated flag is durable — see the
    // note in flip_small_tables. Best-effort: a leftover cursor key is inert.
    for spec in &BULK {
        let _ = target.execute("DELETE FROM kv WHERE key = ?1", params![cursor_key(spec.name)]);
    }
    Ok(true)
}

/// The pre-guard half of verification: mail_fts and mail_vec row parity
/// (full scans of the two biggest indexes). Runs BEFORE the flip, so the
/// main side can't join main.threads yet — but the target file only ever
/// receives this one account's rows, so plain counts are exact.
fn verify_bulk_indexes(target: &Connection, email: &str) -> Result<(), String> {
    let plain = |sql: &str| -> Result<i64, String> {
        target.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    let fts_spec = BULK.iter().find(|s| s.name == "mail_fts").expect("fts spec");
    let l = count_scoped(target, fts_spec.count, "legacy.", email)?;
    let m = plain("SELECT COUNT(*) FROM main.mail_fts")?;
    if l != m {
        return Err(format!("verify mail_fts: legacy {l} rows vs migrated {m}"));
    }
    let l: i64 = target
        .query_row(
            "SELECT COUNT(*) FROM legacy.mail_vec v
             JOIN legacy.vec_meta vm ON vm.vec_rowid = v.rowid WHERE vm.account_id = ?1",
            params![email],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let m = plain("SELECT COUNT(*) FROM main.mail_vec")?;
    if l != m {
        return Err(format!("verify mail_vec: legacy {l} vs migrated {m}"));
    }
    Ok(())
}

fn flip_small_tables(target: &Connection, email: &str) -> Result<(), String> {
    let tx = target.unchecked_transaction().map_err(|e| e.to_string())?;
    for t in FLIP_TABLES {
        tx.execute(
            &format!("INSERT OR REPLACE INTO main.{t} SELECT * FROM legacy.{t} WHERE account_id = ?1"),
            params![email],
        )
        .map_err(|e| format!("{t}: {e}"))?;
    }
    for k in KV_EXACT {
        tx.execute(
            "INSERT OR REPLACE INTO main.kv SELECT key, value FROM legacy.kv WHERE key = ?1",
            params![format!("{k}:{email}")],
        )
        .map_err(|e| e.to_string())?;
    }
    for p in KV_PREFIX {
        tx.execute(
            "INSERT OR REPLACE INTO main.kv
             SELECT key, value FROM legacy.kv WHERE key LIKE ?1 ESCAPE '\\'",
            params![format!("{p}:{}:%", like_escape(email))],
        )
        .map_err(|e| e.to_string())?;
    }
    // embed_model rides into every account file so the first embed beat
    // doesn't see a missing tag and wipe the vectors we just copied.
    tx.execute(
        "INSERT OR REPLACE INTO main.kv SELECT key, value FROM legacy.kv WHERE key = 'embed_model'",
        [],
    )
    .map_err(|e| e.to_string())?;
    // NOTE: the migrate_cursor:* keys are deliberately NOT deleted here. A
    // kill between this commit and mark_migrated resumes migrate_account from
    // the top; with the cursors intact every bulk loop sees no new rowids and
    // falls through, and this flip re-runs idempotently (all 7 flip tables
    // have PKs). Deleting the cursors inside this tx re-ran the bulk copy
    // from rowid 0 on resume — mail_fts/mail_vec reject duplicate rowids, so
    // the migration wedged permanently. Cleanup happens after mark_migrated.
    tx.commit().map_err(|e| e.to_string())
}

/// The under-guard half of verification: cheap row counts (messages,
/// attachments, vec_meta, every flip table) + spot checks. mail_fts/mail_vec
/// parity ran pre-guard in verify_bulk_indexes.
fn verify_account(target: &Connection, email: &str) -> Result<(), String> {
    for spec in &BULK {
        if spec.name == "mail_fts" {
            continue; // verified pre-guard
        }
        let l = count_scoped(target, spec.count, "legacy.", email)?;
        let m = count_scoped(target, spec.count, "main.", email)?;
        if l != m {
            return Err(format!("verify {}: legacy {l} rows vs migrated {m}", spec.name));
        }
    }
    for t in FLIP_TABLES {
        let q = |db: &str| -> Result<i64, String> {
            target
                .query_row(
                    &format!("SELECT COUNT(*) FROM {db}{t} WHERE account_id = ?1"),
                    params![email],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())
        };
        let (l, m) = (q("legacy.")?, q("main.")?);
        if l != m {
            return Err(format!("verify {t}: legacy {l} rows vs migrated {m}"));
        }
    }
    // spot checks: newest thread + longest-rowid message must match verbatim
    let spot: Option<(String, String)> = target
        .query_row(
            "SELECT id, subject FROM legacy.threads WHERE account_id = ?1
             ORDER BY last_date DESC LIMIT 1",
            params![email],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    if let Some((tid, subject)) = spot {
        let got: String = target
            .query_row("SELECT subject FROM main.threads WHERE id = ?1", params![tid], |r| r.get(0))
            .map_err(|e| format!("spot thread {tid}: {e}"))?;
        if got != subject {
            return Err(format!("spot thread {tid}: subject mismatch"));
        }
    }
    let spot: Option<(String, i64)> = target
        .query_row(
            "SELECT m.id, length(m.body_text) FROM legacy.messages m
             JOIN legacy.threads t ON t.id = m.thread_id
             WHERE t.account_id = ?1 ORDER BY m.rowid DESC LIMIT 1",
            params![email],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    if let Some((mid, len)) = spot {
        let got: i64 = target
            .query_row(
                "SELECT length(body_text) FROM main.messages WHERE id = ?1",
                params![mid],
                |r| r.get(0),
            )
            .map_err(|e| format!("spot message {mid}: {e}"))?;
        if got != len {
            return Err(format!("spot message {mid}: body length {got} vs {len}"));
        }
    }
    Ok(())
}

/// When every registered account has verified: checkpoint + release the
/// legacy connection and rename `fission.db` → `fission.db.bak`. The `.bak`
/// (and sidecars) are deleted by `delete_bak_if_verified` on a later boot.
pub fn finish_if_complete(reg: &DbRegistry) -> Result<bool, String> {
    let emails = reg.registered_emails();
    {
        let g = reg.global();
        let g = g.lock().unwrap();
        for e in &emails {
            if super::get_json::<bool>(&g, &format!("migrated:{e}")) != Some(true) {
                return Ok(false);
            }
        }
    }
    if let Some(l) = reg.legacy() {
        let c = l.lock().unwrap();
        let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        drop(c);
        reg.drop_legacy();
        drop(l); // in-flight command clones may briefly outlive this — rename retries below
    }
    let path = reg.legacy_db_path();
    if path.exists() {
        let bak = path.with_extension("db.bak");
        let mut renamed = false;
        for _ in 0..20 {
            match std::fs::rename(&path, &bak) {
                Ok(()) => {
                    renamed = true;
                    break;
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(250)),
            }
        }
        if !renamed {
            return Err("legacy db still busy — will retry on next boot".into());
        }
        for side in ["-wal", "-shm"] {
            let mut p = path.clone().into_os_string();
            p.push(side);
            let _ = std::fs::remove_file(std::path::PathBuf::from(p));
        }
    }
    let g = reg.global();
    let g = g.lock().unwrap();
    super::set_json(&g, "migration_done", &true)?;
    Ok(true)
}

/// Boot cleanup: the `.bak` is only deleted once a later boot re-verifies
/// that migration finished and every registered account's file exists.
pub fn delete_bak_if_verified(reg: &DbRegistry) {
    let bak = reg.data_dir.join("fission.db.bak");
    if !bak.exists() {
        return;
    }
    {
        let g = reg.global();
        let g = g.lock().unwrap();
        if super::get_json::<bool>(&g, "migration_done") != Some(true) {
            return;
        }
    }
    if reg.registered_emails().iter().all(|e| reg.account_db_path(e).exists()) {
        let _ = std::fs::remove_file(&bak);
    }
}

/// Migrate every registered account, then finish. Returns Ok(true) when the
/// whole split completed (or nothing needed migrating).
pub fn migrate_all(
    reg: &DbRegistry,
    opts: &MigrateOpts,
    progress: &mut dyn FnMut(MigrateProgress),
) -> Result<bool, String> {
    if reg.legacy().is_none() {
        return Ok(true);
    }
    for email in reg.registered_emails() {
        if !migrate_account(reg, &email, opts, progress)? {
            return Ok(false);
        }
    }
    finish_if_complete(reg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AccountInfo, AccountsState, Message, Thread};

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "snail-migrate-{tag}-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed_mail(conn: &Connection, acct: &str, n: usize) {
        let user = acct.split('@').next().unwrap();
        for i in 0..n {
            let id = format!("{user}-t{i}");
            let t = Thread {
                id: id.clone(),
                subject: format!("Subject {i} zebra"),
                snippet: "s".into(),
                participants: vec![format!("Ann <ann@{user}.test>")],
                recipients: vec![],
                message_count: 1,
                last_date: 1_000 + i as i64,
                unread: false,
                starred: false,
                labels: vec!["Work".into()],
                in_inbox: true,
                snoozed_until: None,
                split: String::new(),
                also_in: vec![],
            };
            let m = Message {
                id: format!("{id}-m1"),
                thread_id: id.clone(),
                from: format!("ann@{user}.test"),
                from_name: "Ann".into(),
                to: vec![],
                cc: vec![],
                subject: t.subject.clone(),
                snippet: "s".into(),
                body_text: format!("body {i} quokka"),
                body_html: None,
                date: t.last_date,
                unread: false,
                attachments: vec![],
            };
            crate::store::upsert_thread(
                conn,
                acct,
                &t,
                &[(m, None, None, None, vec![])],
                &crate::store::split_config(conn),
            )
            .unwrap();
            conn.execute(
                "INSERT INTO attachments(id, message_id, filename, mime_type, size_bytes)
                 VALUES (?1, ?2, 'f.pdf', 'application/pdf', 10)",
                params![format!("{id}-att"), format!("{id}-m1")],
            )
            .unwrap();
            let mut v = vec![0f32; 384];
            v[i % 384] = 1.0;
            crate::store::vec::insert(conn, &format!("{id}-m1"), &id, acct, "local:test", &v)
                .unwrap();
        }
        // per-account satellites
        conn.execute(
            "INSERT INTO drafts(account_id, payload, updated_at) VALUES (?1, '{}', 1)",
            params![acct],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO outbox(account_id, payload, send_at, attempts, claimed)
             VALUES (?1, '{}', 99, 0, 0)",
            params![acct],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO labels(account_id, id, name) VALUES (?1, 'L1', 'Work')",
            params![acct],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO people_contacts(account_id, source, email, display_name, photo_url, updated_at)
             VALUES (?1, 'contacts', ?2, 'Ann', NULL, 1)",
            params![acct, format!("ann@{user}.test")],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO events(account_id, calendar_id, id, calendar, color, title,
                start_ms, end_ms, all_day, location, description, html_link, etag, status,
                organizer_email, organizer_self, recurring_event_id, hangout_link, attendees,
                access_role, ical_uid)
             VALUES (?1, 'primary', 'ev1', 'Cal', NULL, 'Standup', 1, 2, 0, NULL, NULL, NULL,
                NULL, 'confirmed', NULL, 1, NULL, NULL, '[]', 'owner', 'uid-1')",
            params![acct],
        )
        .unwrap();
        crate::store::set_json(conn, &format!("history:{acct}"), &"h-123").unwrap();
        crate::store::set_json(conn, &format!("granted_scopes:{acct}"), &"scope-a scope-b").unwrap();
        crate::store::set_json(conn, &format!("cal_sync:{acct}:primary"), &"tok").unwrap();
    }

    fn build_legacy(dir: &std::path::Path, accounts: &[&str], threads_each: usize) {
        let legacy = crate::store::open(&dir.join("fission.db")).unwrap();
        // one transaction for the whole seed — per-row autocommit means six
        // fsyncs per thread, which makes the perf variant take minutes
        legacy.execute_batch("BEGIN").unwrap();
        let state = AccountsState {
            accounts: accounts
                .iter()
                .map(|e| AccountInfo {
                    email: (*e).into(),
                    provider: "gmail".into(),
                    connected: true,
                    removing: false,
                })
                .collect(),
            active: accounts[0].into(),
        };
        crate::store::save_accounts(&legacy, &state).unwrap();
        crate::store::set_json(&legacy, "settings", &serde_json::json!({"theme":"dark"})).unwrap();
        crate::store::set_json(&legacy, "embed_model", &"local:test").unwrap();
        for a in accounts {
            seed_mail(&legacy, a, threads_each);
        }
        legacy.execute_batch("COMMIT").unwrap();
    }

    fn table_count(conn: &Connection, sql: &str, acct: &str) -> i64 {
        conn.query_row(sql, params![acct], |r| r.get(0)).unwrap()
    }

    #[test]
    fn round_trip_two_accounts() {
        let dir = tmp_dir("roundtrip");
        build_legacy(&dir, &["a@x.test", "b@y.test"], 7);
        let reg = DbRegistry::open(&dir).unwrap();
        let mut events = 0;
        assert!(migrate_all(&reg, &MigrateOpts::default(), &mut |_| events += 1).unwrap());
        assert!(events > 0, "progress must be reported");
        assert!(dir.join("fission.db.bak").exists());
        assert!(!dir.join("fission.db").exists());

        for acct in ["a@x.test", "b@y.test"] {
            let conn = reg.account(acct).unwrap();
            let c = conn.lock().unwrap();
            assert_eq!(table_count(&c, "SELECT COUNT(*) FROM threads WHERE account_id=?1", acct), 7);
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0)).unwrap(),
                7,
                "{acct}: exactly its own messages"
            );
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get::<_, i64>(0)).unwrap(),
                7
            );
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM mail_fts", [], |r| r.get::<_, i64>(0)).unwrap(),
                7
            );
            assert_eq!(
                c.query_row("SELECT COUNT(*) FROM mail_vec", [], |r| r.get::<_, i64>(0)).unwrap(),
                7
            );
            for t in ["drafts", "outbox", "labels", "people_contacts", "events"] {
                assert_eq!(
                    table_count(&c, &format!("SELECT COUNT(*) FROM {t} WHERE account_id=?1"), acct),
                    1,
                    "{acct}.{t}"
                );
            }
            // per-account kv came along, with suffixes intact
            assert_eq!(
                crate::store::get_json::<String>(&c, &format!("history:{acct}")).as_deref(),
                Some("h-123")
            );
            assert_eq!(
                crate::store::get_json::<String>(&c, &format!("cal_sync:{acct}:primary")).as_deref(),
                Some("tok")
            );
            // embed_model fanned in so the first embed beat can't wipe vectors
            assert_eq!(
                crate::store::get_json::<String>(&c, "embed_model").as_deref(),
                Some("local:test")
            );
            // FTS is queryable in the new file
            let hits: i64 = c
                .query_row("SELECT COUNT(*) FROM mail_fts WHERE mail_fts MATCH 'quokka'", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(hits, 7);
            // no cross-account bleed
            let other = if acct == "a@x.test" { "b@y.test" } else { "a@x.test" };
            assert_eq!(
                table_count(&c, "SELECT COUNT(*) FROM threads WHERE account_id=?1", other),
                0
            );
            assert!(crate::store::get_json::<String>(&c, &format!("history:{other}")).is_none());
        }
        // second boot deletes the .bak once everything re-verifies
        drop(reg);
        let reg2 = DbRegistry::open(&dir).unwrap();
        delete_bak_if_verified(&reg2);
        assert!(!dir.join("fission.db.bak").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn killed_migration_resumes_without_duplicates() {
        let dir = tmp_dir("resume");
        build_legacy(&dir, &["a@x.test"], 9);
        let reg = DbRegistry::open(&dir).unwrap();
        // tiny chunks + a budget that dies mid-messages
        let starved = MigrateOpts { chunk_rows: 2, max_chunks: Some(2) };
        let done =
            migrate_account(&reg, "a@x.test", &starved, &mut |_| {}).unwrap();
        assert!(!done, "budget exhaustion must report incomplete");
        assert!(!reg.is_migrated("a@x.test"));
        // resume with a second starved pass, then finish fully
        let done = migrate_account(&reg, "a@x.test", &starved, &mut |_| {}).unwrap();
        assert!(!done);
        assert!(migrate_account(&reg, "a@x.test", &MigrateOpts::default(), &mut |_| {}).unwrap());
        assert!(reg.is_migrated("a@x.test"));
        let conn = reg.account("a@x.test").unwrap();
        let c = conn.lock().unwrap();
        for (t, expect) in
            [("threads", 9i64), ("messages", 9), ("attachments", 9), ("mail_fts", 9), ("mail_vec", 9)]
        {
            let n: i64 =
                c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, expect, "{t} after resume");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The other kill window: after the flip transaction commits but before
    /// `migrated:<email>` lands in global.db. On-disk that state is: all rows
    /// copied + flipped, migrate_cursor:* keys still present (cleanup runs
    /// after the mark), flag absent. Resume must complete cleanly — with the
    /// old in-tx cursor deletion it re-copied from rowid 0 and wedged on
    /// mail_fts/mail_vec duplicate rowids forever.
    #[test]
    fn kill_between_flip_and_mark_migrated_resumes_clean() {
        let dir = tmp_dir("flipwindow");
        build_legacy(&dir, &["u@x.test"], 11);
        let email = "u@x.test";
        {
            let reg = DbRegistry::open(&dir).unwrap();
            assert!(migrate_account(&reg, email, &MigrateOpts::default(), &mut |_| {}).unwrap());
            // reconstruct the kill-window state: the flag write never landed…
            let g = reg.global();
            g.lock()
                .unwrap()
                .execute("DELETE FROM kv WHERE key = ?1", params![format!("migrated:{email}")])
                .unwrap();
            // …and neither did the post-mark cursor cleanup: restore each
            // cursor to its end-of-copy position (max copied rowid).
            let t = crate::store::open(&reg.account_db_path(email)).unwrap();
            for spec in &BULK {
                let (table, col) = match spec.name {
                    "vec" => ("vec_meta", "vec_rowid"),
                    other => (other, "rowid"),
                };
                let hi: i64 = t
                    .query_row(&format!("SELECT COALESCE(MAX({col}), 0) FROM {table}"), [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                crate::store::set_json(&t, &cursor_key(spec.name), &hi).unwrap();
            }
        }
        // next boot: resume must finish the bookkeeping, not wedge
        let reg = DbRegistry::open(&dir).unwrap();
        assert!(reg.legacy().is_some(), "legacy still routes until the flag lands");
        assert!(!reg.is_migrated(email));
        assert!(
            migrate_account(&reg, email, &MigrateOpts::default(), &mut |_| {}).unwrap(),
            "resume from the flip window must complete"
        );
        assert!(reg.is_migrated(email));
        let conn = reg.account(email).unwrap();
        let c = conn.lock().unwrap();
        for (t, expect) in [
            ("threads", 11i64),
            ("messages", 11),
            ("attachments", 11),
            ("mail_fts", 11),
            ("mail_vec", 11),
        ] {
            let n: i64 =
                c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap();
            assert_eq!(n, expect, "{t} must not duplicate on flip-window resume");
        }
        drop(c);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Phase-1 acceptance measurement: while an account migrates, the app's
    /// list_threads path (against whatever conn the registry serves) must stay
    /// responsive. Run with:
    ///   cargo test --release -- --ignored perf_migration --nocapture
    #[test]
    #[ignore]
    fn perf_migration_responsiveness() {
        let dir = tmp_dir("perf");
        let n: usize = std::env::var("SNAIL_PERF_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5_000);
        let t0 = std::time::Instant::now();
        build_legacy(&dir, &["a@x.test"], n);
        println!("seeded {n} threads (+msgs/fts/vec/attachments) in {:?}", t0.elapsed());
        let reg = DbRegistry::open(&dir).unwrap();
        let mut lat_ms: Vec<f64> = vec![];
        std::thread::scope(|s| {
            let reg_ref = &reg;
            let mig = s.spawn(move || {
                let t = std::time::Instant::now();
                migrate_account(reg_ref, "a@x.test", &MigrateOpts::default(), &mut |_| {})
                    .unwrap();
                t.elapsed()
            });
            // hammer list_threads the way the UI would while the split runs
            while !mig.is_finished() {
                let t = std::time::Instant::now();
                let db = reg.account("a@x.test").unwrap();
                let conn = db.lock().unwrap();
                let rows = crate::store::list_threads(&conn, "inbox", "a@x.test").unwrap();
                drop(conn);
                assert!(!rows.is_empty());
                lat_ms.push(t.elapsed().as_secs_f64() * 1000.0);
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            let wall = mig.join().unwrap();
            lat_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let pick = |q: f64| lat_ms[((lat_ms.len() - 1) as f64 * q) as usize];
            println!(
                "migration wall-time {wall:?}; list_threads during migration: {} samples, median {:.2}ms, p95 {:.2}ms, max {:.2}ms",
                lat_ms.len(),
                pick(0.5),
                pick(0.95),
                lat_ms[lat_ms.len() - 1],
            );
        });
        assert!(reg.is_migrated("a@x.test"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Phase-2 acceptance measurement: account removal before (chunked
    /// thread purge, the v0.22 shipped path) vs after (close + delete file).
    /// Run with: cargo test --release -- --ignored perf_disconnect --nocapture
    #[test]
    #[ignore]
    fn perf_disconnect_old_vs_new() {
        let dir = tmp_dir("perfdisc");
        let n: usize = std::env::var("SNAIL_PERF_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5_000);
        build_legacy(&dir, &["a@x.test"], n);
        let reg = DbRegistry::open(&dir).unwrap();
        assert!(migrate_all(&reg, &MigrateOpts::default(), &mut |_| {}).unwrap());
        // duplicate the migrated file so both paths tear down identical data
        let orig = reg.account_db_path("a@x.test");
        {
            // checkpoint so the copy is self-contained
            let db = reg.account("a@x.test").unwrap();
            let _ = db.lock().unwrap().execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        let victim = dir.join("victim.db");
        std::fs::copy(&orig, &victim).unwrap();

        // OLD PATH: the shipped chunked purge (200-thread pages; six deletes
        // per batch incl. the by-thread_id FTS delete that full-scans).
        let conn = crate::store::open(&victim).unwrap();
        let t0 = std::time::Instant::now();
        loop {
            let ids = crate::store::thread_ids_page(&conn, "a@x.test", 200).unwrap();
            if ids.is_empty() {
                break;
            }
            crate::store::delete_threads(&conn, &ids).unwrap();
        }
        let old_time = t0.elapsed();
        drop(conn);

        // NEW PATH: close the connection, delete the file.
        let t1 = std::time::Instant::now();
        reg.close_and_delete("a@x.test").unwrap();
        let new_time = t1.elapsed();
        println!(
            "disconnect teardown for {n} threads: old chunked purge {old_time:?} vs new close+delete {new_time:?} ({}x faster)",
            (old_time.as_secs_f64() / new_time.as_secs_f64()).round()
        );
        assert!(!orig.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verify_failure_blocks_the_flip() {
        let dir = tmp_dir("verifyfail");
        build_legacy(&dir, &["a@x.test"], 3);
        let reg = DbRegistry::open(&dir).unwrap();
        // sabotage: pre-create the target with a conflicting message row so
        // counts can't reconcile (same id, different thread linkage)
        {
            let t = crate::store::open(&reg.account_db_path("a@x.test")).unwrap();
            t.execute(
                "INSERT INTO messages(id, thread_id, date) VALUES ('a-t0-m1', 'ghost', 1)",
                [],
            )
            .unwrap();
        }
        let err = migrate_account(&reg, "a@x.test", &MigrateOpts::default(), &mut |_| {});
        assert!(err.is_err(), "verification must fail: {err:?}");
        assert!(!reg.is_migrated("a@x.test"), "flag must stay unset on verify failure");
        std::fs::remove_dir_all(&dir).ok();
    }
}
