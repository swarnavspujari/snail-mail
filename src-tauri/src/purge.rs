//! Erase-all-local-data: the one routine that reaches every place Snail Mail
//! keeps state on this machine — including the place an NSIS uninstaller
//! cannot reach at all, the OS credential store.
//!
//! Two callers share it:
//!
//!   * the in-app **Erase all local data** button (`erase_all_local_data` in
//!     `lib.rs`), which runs against a live app and resets it to the
//!     zero-account state without a restart; and
//!   * **`snail-mail.exe --purge-data`**, run headless by the uninstaller's
//!     `NSIS_HOOK_PREUNINSTALL` (see `windows/hooks.nsh`).
//!
//! Why a flag on the app binary rather than pure NSIS: Windows Credential
//! Manager entries are per-user secrets with no scriptable NSIS equivalent, and
//! the entry names are derived from the account list inside the databases. The
//! binary already knows both, so the uninstaller borrows it for ten seconds
//! instead of reimplementing it in NSIS.
//!
//! Everything here is idempotent and best-effort by design: an uninstall must
//! never hang or fail because a file was locked or the network was down. Each
//! failure is recorded in the report and the purge carries on.

use std::path::{Path, PathBuf};

/// The current bundle identifier — `tauri.conf.json` `identifier`, and the
/// name of the app-data/cache directories under %APPDATA%/%LOCALAPPDATA%.
pub const IDENTIFIER: &str = "com.snail.mail";

/// Pre-rename bundle identifiers, newest first. The rename migrations copy
/// data forward and never clean up, and the installer only ever knows about
/// the *current* identifier, so these trees outlive every uninstall.
pub const LEGACY_IDENTIFIERS: [&str; 2] = ["com.fission.mail", "com.zenbox.mail"];

/// What a purge did, in the order it did it. Serialized to the webview for the
/// in-app button and printed line-by-line for `--purge-data`, so "point at the
/// deleted paths" is answerable without guessing.
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeReport {
    /// `"<service>/<entry>"` for every credential that actually existed.
    pub credentials: Vec<String>,
    /// Files and directories that existed and were removed.
    pub paths: Vec<String>,
    /// Refresh tokens successfully handed to Google's /revoke endpoint.
    pub revoked: usize,
    /// Anything that could not be removed. Never fatal.
    pub errors: Vec<String>,
    /// True when nothing was actually touched.
    pub dry_run: bool,
}

impl PurgeReport {
    /// One line per thing, for the `--purge-data` console and the app log.
    pub fn lines(&self) -> Vec<String> {
        let verb = if self.dry_run { "would remove" } else { "removed" };
        let mut out = vec![];
        for c in &self.credentials {
            out.push(format!("{verb} credential  {c}"));
        }
        for p in &self.paths {
            out.push(format!("{verb} path        {p}"));
        }
        if self.revoked > 0 {
            out.push(format!("revoked {} Google refresh token(s)", self.revoked));
        }
        for e in &self.errors {
            out.push(format!("! {e}"));
        }
        if out.is_empty() {
            out.push("nothing to remove".into());
        }
        out
    }
}

// ------------------------------------------------------------------- paths

/// Tauri's app-data and app-cache roots for a bundle identifier, resolved
/// WITHOUT an `AppHandle` — the `--purge-data` process never builds one.
///
/// This mirrors `tauri::Manager::path().app_data_dir()/app_cache_dir()`. Drift
/// would make an uninstall purge the wrong tree, so the Windows rule (the only
/// one the NSIS hook exercises) is pinned by a test below, and the in-app path
/// passes Tauri's own values in rather than calling this.
pub fn app_roots(identifier: &str) -> Option<(PathBuf, PathBuf)> {
    #[cfg(target_os = "windows")]
    {
        let data = PathBuf::from(std::env::var_os("APPDATA")?).join(identifier);
        let cache = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(identifier);
        Some((data, cache))
    }
    #[cfg(target_os = "macos")]
    {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        Some((
            home.join("Library/Application Support").join(identifier),
            home.join("Library/Caches").join(identifier),
        ))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"));
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache"));
        Some((data.join(identifier), cache.join(identifier)))
    }
}

/// Everything Snail Mail writes under its own app-data root, in the order a
/// purge should take it. Named explicitly rather than "delete the directory"
/// so the in-app purge can keep `global.db` (its connection is open and
/// Windows will not unlink a mapped file) while the headless purge takes it.
pub fn data_targets(data: &Path, include_global: bool) -> Vec<PathBuf> {
    let mut out = vec![];
    // Pre-split single-file mailbox, still present until the split migration
    // verifies. Sidecars are separate files; a stale -wal would resurrect rows.
    // `.bak` is the renamed full mailbox the split migration parks until every
    // account verifies — it holds every body and attachment, so a purge that
    // misses it erases nothing.
    for base in ["fission.db", "zenbox.db"] {
        for suffix in ["", "-wal", "-shm", ".bak", ".bak-wal", ".bak-shm"] {
            out.push(data.join(format!("{base}{suffix}")));
        }
    }
    out.push(data.join("accounts")); // one .db per account
    out.push(data.join("models")); // ~34 MB embedding model
    if include_global {
        for suffix in ["", "-wal", "-shm"] {
            out.push(data.join(format!("global.db{suffix}")));
        }
        out.push(data.join(".window-state.json"));
    }
    out
}

/// Everything under the cache root: decrypted attachment bytes and the
/// WebView2 profile (cookies, localStorage, IndexedDB).
pub fn cache_targets(cache: &Path, include_webview: bool) -> Vec<PathBuf> {
    let mut out = vec![cache.join("attachments")];
    if include_webview {
        out.push(cache.join("EBWebView"));
    }
    out
}

/// Remove a file or directory tree if it exists, recording the outcome.
/// A missing path is success and is not reported — an idempotent re-run
/// should print nothing, not a wall of no-ops.
pub fn remove(path: &Path, dry_run: bool, report: &mut PurgeReport) {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return, // absent (or unreadable): nothing to do
    };
    if dry_run {
        report.paths.push(path.display().to_string());
        return;
    }
    let res = if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match res {
        Ok(()) => report.paths.push(path.display().to_string()),
        Err(e) => report.errors.push(format!("{}: {e}", path.display())),
    }
}

// -------------------------------------------------------------- credentials

/// Every email this machine has ever stored a Gmail refresh token for.
///
/// Read straight out of the database files with read-only SQL rather than
/// through `store::get_accounts` — a purge has to work on an install whose
/// schema the current binary cannot migrate, and `get_accounts` would fold in
/// the demo-pair fallback. Sources, in order: the accounts registry in
/// `global.db`, the same key in each legacy single-file db, and the
/// `account_id` actually stamped on rows in each per-account file (which
/// catches an account whose registry row was lost).
pub fn known_emails(data_dirs: &[PathBuf]) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut push = |e: String| {
        let e = e.trim().to_string();
        if !e.is_empty() && !out.contains(&e) {
            out.push(e);
        }
    };
    for dir in data_dirs {
        for db in ["global.db", "fission.db", "zenbox.db"] {
            for e in emails_in_registry(&dir.join(db)) {
                push(e);
            }
        }
        let Ok(entries) = std::fs::read_dir(dir.join("accounts")) else { continue };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("db") {
                for e in emails_in_threads(&p) {
                    push(e);
                }
            }
        }
    }
    out
}

/// Open a db just to read it, without running migrations or creating tables.
///
/// Read-only is tried first — the in-app caller does this against databases the
/// app itself has open. It can legitimately fail, though: a WAL database needs
/// its `-shm` file, and a read-only connection cannot create one. Falling back
/// to a read-write open matters more than it looks — if this returns None the
/// account list comes back empty and the per-account **refresh tokens are
/// silently not purged**, which is the exact failure this whole module exists
/// to prevent. At uninstall time nothing else holds the file, so the fallback
/// succeeds. Still `Option`, because a genuinely corrupt file must be a skipped
/// entry rather than a failed purge.
fn open_ro(path: &Path) -> Option<rusqlite::Connection> {
    if !path.exists() {
        return None;
    }
    use rusqlite::OpenFlags;
    rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .or_else(|_| {
        rusqlite::Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    })
    .ok()
}

/// `kv["accounts"]` (and the v0.1 `kv["account"]` blob) parsed loosely: any
/// `email` field anywhere in the JSON counts, so a schema change upstream
/// cannot silently start leaving tokens behind.
fn emails_in_registry(path: &Path) -> Vec<String> {
    let Some(conn) = open_ro(path) else { return vec![] };
    let mut out = vec![];
    for key in ["accounts", "account"] {
        let raw: Option<String> =
            conn.query_row("SELECT value FROM kv WHERE key = ?1", [key], |r| r.get(0)).ok();
        let Some(raw) = raw else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
        collect_emails(&json, &mut out);
    }
    out
}

fn collect_emails(v: &serde_json::Value, out: &mut Vec<String>) {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(e)) = map.get("email") {
                out.push(e.clone());
            }
            for (_, child) in map {
                collect_emails(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                collect_emails(child, out);
            }
        }
        _ => {}
    }
}

fn emails_in_threads(path: &Path) -> Vec<String> {
    let Some(conn) = open_ro(path) else { return vec![] };
    let Ok(mut stmt) = conn.prepare("SELECT DISTINCT account_id FROM threads") else {
        return vec![];
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { return vec![] };
    rows.filter_map(|r| r.ok()).collect()
}

/// Every keychain entry name the app has ever written: the fixed ones plus one
/// refresh token per account. The list is exhaustive by construction — the
/// fixed half is the same `secrets` constants the writers use, so adding a new
/// secret without adding it here fails to compile.
pub fn credential_names(emails: &[String]) -> Vec<String> {
    let mut names: Vec<String> = crate::secrets::ALL_FIXED_ENTRIES
        .iter()
        .map(|s| (*s).to_string())
        .collect();
    for e in emails {
        names.push(crate::secrets::gmail_refresh_entry(e));
    }
    names
}

/// Delete every named entry from the primary service AND both legacy services.
/// Reports only entries that actually existed, so the output is the truth
/// about this machine rather than a list of attempts.
pub fn purge_credentials(names: &[String], dry_run: bool, report: &mut PurgeReport) {
    for name in names {
        for service in crate::secrets::purge_entry(name, dry_run) {
            report.credentials.push(format!("{service}/{name}"));
        }
    }
}

/// Best-effort server-side revoke for every refresh token still in the
/// keychain, so uninstalling actually ends Google's grant instead of merely
/// forgetting the token. Hard-capped: a dead network costs `budget`, not a
/// wedged uninstaller.
pub async fn revoke_tokens(
    http: &reqwest::Client,
    emails: &[String],
    budget: std::time::Duration,
) -> usize {
    let deadline = tokio::time::Instant::now() + budget;
    let mut revoked = 0;
    for email in emails {
        let Some(token) = crate::secrets::get(&crate::secrets::gmail_refresh_entry(email)) else {
            continue;
        };
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        let req = http
            .post("https://oauth2.googleapis.com/revoke")
            .form(&[("token", token.as_str())])
            .send();
        if let Ok(Ok(r)) = tokio::time::timeout(left.min(std::time::Duration::from_secs(5)), req).await
        {
            if r.status().is_success() {
                revoked += 1;
            }
        }
    }
    revoked
}

// ------------------------------------------------------------------ headless

/// What `--purge-data` was asked to remove.
#[derive(Clone, Copy, PartialEq)]
pub enum Scope {
    /// Credentials and legacy-brand orphans only — the uninstaller default.
    /// The current install's mailbox is the stock NSIS checkbox's business,
    /// and it is unchecked by default on purpose.
    CredentialsAndLegacy,
    /// Credentials, legacy orphans, AND this install's mail, models, caches
    /// and WebView2 profile. What the in-app button means.
    Everything,
}

pub struct Options {
    pub scope: Scope,
    pub dry_run: bool,
    /// Override the app-data root (tests and dry runs against a scratch dir).
    pub data_root: Option<PathBuf>,
    /// Override the app-cache root.
    pub cache_root: Option<PathBuf>,
    /// Hand each refresh token to Google's /revoke endpoint before deleting it.
    pub revoke: bool,
    /// Always true in production — the whole reason this binary is involved in
    /// an uninstall is that only it can reach the credential store.
    ///
    /// The switch exists for tests: credential entry names are FIXED (`ai:claude`,
    /// `gmail:client_id`, …) and do not follow `data_root`, so a file-scope test
    /// run with credentials on would delete the developer's own live Google
    /// token out of Credential Manager. Keychain behaviour is covered instead by
    /// `secrets::tests`, which uses throwaway service names.
    pub credentials: bool,
}

/// The whole headless purge. Returns the report; the caller prints it.
pub fn run(opts: &Options) -> PurgeReport {
    let mut report = PurgeReport { dry_run: opts.dry_run, ..Default::default() };

    let Some((default_data, default_cache)) = app_roots(IDENTIFIER) else {
        report.errors.push("could not resolve this user's app-data directory".into());
        return report;
    };
    let data = opts.data_root.clone().unwrap_or(default_data);
    let cache = opts.cache_root.clone().unwrap_or(default_cache);

    // Legacy identifier trees sit beside the current one. With an override in
    // play (a scratch dry run) they are siblings of the override, so a test
    // can stage them without touching the real profile.
    let legacy_roots = |root: &Path| -> Vec<PathBuf> {
        let Some(parent) = root.parent() else { return vec![] };
        LEGACY_IDENTIFIERS.iter().map(|id| parent.join(id)).collect()
    };
    let legacy_data = legacy_roots(&data);
    let legacy_cache = legacy_roots(&cache);

    // 1. Credentials first, and always. A secret must never outlive the app,
    //    and the account list it is derived from lives in files step 3 may
    //    delete. Legacy dbs are read too: an account that never migrated still
    //    has a live token under its name.
    let mut search_dirs = vec![data.clone()];
    search_dirs.extend(legacy_data.iter().cloned());
    let emails = known_emails(&search_dirs);

    if opts.credentials && opts.revoke && !opts.dry_run && !emails.is_empty() {
        match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => {
                let http = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                    .unwrap_or_default();
                report.revoked = rt.block_on(revoke_tokens(
                    &http,
                    &emails,
                    std::time::Duration::from_secs(15),
                ));
            }
            Err(e) => report.errors.push(format!("revoke skipped: {e}")),
        }
    }
    if opts.credentials {
        purge_credentials(&credential_names(&emails), opts.dry_run, &mut report);
    }

    // 2. Legacy-brand app-data and cache trees, always. Nothing else will ever
    //    remove them: the installer only knows the current identifier.
    for root in legacy_data.iter().chain(legacy_cache.iter()) {
        remove(root, opts.dry_run, &mut report);
    }

    // 3. This install's own state, only when asked.
    if opts.scope == Scope::Everything {
        for p in data_targets(&data, true) {
            remove(&p, opts.dry_run, &mut report);
        }
        for p in cache_targets(&cache, true) {
            remove(&p, opts.dry_run, &mut report);
        }
        // The roots themselves, if the above emptied them. Non-recursive on
        // purpose: anything left is something this build does not know about,
        // and silently deleting it is how you lose someone else's data.
        for root in [&data, &cache] {
            if std::fs::read_dir(root).map(|mut d| d.next().is_none()).unwrap_or(false) {
                remove(root, opts.dry_run, &mut report);
            }
        }
    }
    report
}

/// Intercept `--purge-data` before Tauri builds anything. Returns true when
/// the process handled a purge and should exit — no window, no webview, no
/// database connection.
///
/// Flags:
///   `--purge-data`         run the purge (required; everything else is a modifier)
///   `--all`                also delete this install's mail, models and caches
///   `--dry-run`            print what would go; touch nothing
///   `--no-revoke`          skip the Google /revoke calls (offline machines)
///   `--no-credentials`     leave the keychain alone. Diagnostics only — the
///                          uninstaller never passes this, and passing it is
///                          what "uninstall leaves a live token behind" means.
///                          It exists so a file-level purge can be exercised
///                          against a scratch directory without deleting the
///                          real machine's Google token (credential names are
///                          fixed and do not follow `--app-data`).
///   `--app-data <dir>`     override the app-data root
///   `--app-cache <dir>`    override the app-cache root
pub fn maybe_run_cli() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.iter().any(|a| a == "--purge-data") {
        return false;
    }
    // A present flag with a missing or flag-shaped value must ABORT, not fall
    // back: `--app-data --dry-run` silently retargeting the purge at the real
    // profile is how a scratch test deletes someone's mailbox.
    let value_after = |flag: &str| -> Result<Option<PathBuf>, String> {
        let Some(i) = args.iter().position(|a| a == flag) else {
            return Ok(None);
        };
        match args.get(i + 1) {
            Some(v) if !v.starts_with('-') => Ok(Some(PathBuf::from(v))),
            _ => Err(format!("{flag} needs a directory argument — nothing was deleted")),
        }
    };
    let (data_root, cache_root) = match (value_after("--app-data"), value_after("--app-cache")) {
        (Ok(d), Ok(c)) => (d, c),
        (Err(e), _) | (_, Err(e)) => {
            #[cfg(target_os = "windows")]
            attach_parent_console();
            eprintln!("[purge] {e}");
            return true; // handled: exit without touching anything
        }
    };
    let opts = Options {
        scope: if args.iter().any(|a| a == "--all") {
            Scope::Everything
        } else {
            Scope::CredentialsAndLegacy
        },
        dry_run: args.iter().any(|a| a == "--dry-run"),
        data_root,
        cache_root,
        revoke: !args.iter().any(|a| a == "--no-revoke"),
        credentials: !args.iter().any(|a| a == "--no-credentials"),
    };
    let report = run(&opts);
    // Release builds are `windows_subsystem = "windows"` and have no console
    // of their own; attaching to the uninstaller's makes the output visible
    // when one exists and is a harmless no-op when it does not.
    #[cfg(target_os = "windows")]
    attach_parent_console();
    // A dry run is a diagnostic, so it also shows what was LOOKED FOR, not just
    // what was found. Without this an empty credential list is ambiguous —
    // "nothing stored" and "I never derived your address" print identically,
    // and those are very different bugs.
    if opts.dry_run {
        let (d, c) = app_roots(IDENTIFIER).unwrap_or_default();
        let data = opts.data_root.clone().unwrap_or(d);
        let cache = opts.cache_root.clone().unwrap_or(c);
        let mut dirs = vec![data.clone()];
        if let Some(parent) = data.parent() {
            dirs.extend(LEGACY_IDENTIFIERS.iter().map(|id| parent.join(id)));
        }
        let emails = known_emails(&dirs);
        println!("app-data  {}", data.display());
        println!("app-cache {}", cache.display());
        println!("accounts found ({}): {}", emails.len(), emails.join(", "));
        println!("keychain entries probed, in each of {:?}:", crate::secrets::all_services());
        for n in credential_names(&emails) {
            println!("  {n}");
        }
        println!("--");
    }
    println!("snail-mail --purge-data ({} item(s))", report.lines().len());
    for line in report.lines() {
        println!("  {line}");
    }
    true
}

#[cfg(target_os = "windows")]
fn attach_parent_console() {
    // ATTACH_PARENT_PROCESS = 0xFFFF_FFFF. Declared here rather than pulling in
    // the whole windows-sys crate for one call.
    extern "system" {
        fn AttachConsole(dwProcessId: u32) -> i32;
    }
    unsafe {
        AttachConsole(0xFFFF_FFFF);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "snail-purge-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_roots_are_the_two_identifier_dirs() {
        let (data, cache) = app_roots("com.snail.mail").unwrap();
        assert!(data.ends_with("com.snail.mail"), "{}", data.display());
        assert!(cache.ends_with("com.snail.mail"), "{}", cache.display());
        // %APPDATA% is roaming, %LOCALAPPDATA% is not — swapping them would
        // purge the wrong tree and leave the mailbox behind.
        assert_ne!(data, cache);
        assert!(data.starts_with(std::env::var("APPDATA").unwrap()));
        assert!(cache.starts_with(std::env::var("LOCALAPPDATA").unwrap()));
    }

    #[test]
    fn data_targets_cover_every_db_sidecar() {
        let d = Path::new("/x");
        let all: Vec<String> =
            data_targets(d, true).iter().map(|p| p.display().to_string()).collect();
        for want in [
            "global.db",
            "global.db-wal",
            "global.db-shm",
            "fission.db-wal",
            // the split migration's parked full mailbox — missing this made
            // "Erase all local data" leave every body/attachment on disk
            "fission.db.bak",
            "zenbox.db.bak",
        ] {
            assert!(all.iter().any(|p| p.ends_with(want)), "missing {want} in {all:?}");
        }
        // the in-app erase (include_global=false) must also take the .bak
        let live_bak: Vec<String> =
            data_targets(d, false).iter().map(|p| p.display().to_string()).collect();
        assert!(live_bak.iter().any(|p| p.ends_with("fission.db.bak")));
        assert!(all.iter().any(|p| p.ends_with("accounts")));
        assert!(all.iter().any(|p| p.ends_with("models")));
        // the in-app variant must leave the open connection's file alone
        let live: Vec<String> =
            data_targets(d, false).iter().map(|p| p.display().to_string()).collect();
        assert!(!live.iter().any(|p| p.ends_with("global.db")));
        assert!(live.iter().any(|p| p.ends_with("accounts")));
    }

    #[test]
    fn remove_is_idempotent_and_reports_only_real_deletions() {
        let dir = tmp("rm");
        let f = dir.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let mut r = PurgeReport::default();
        remove(&f, false, &mut r);
        assert_eq!(r.paths.len(), 1);
        assert!(!f.exists());
        // second pass: absent is success and stays silent
        remove(&f, false, &mut r);
        assert_eq!(r.paths.len(), 1);
        assert!(r.errors.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dry_run_lists_without_deleting() {
        let dir = tmp("dry");
        let f = dir.join("keep.db");
        std::fs::write(&f, "x").unwrap();
        let mut r = PurgeReport { dry_run: true, ..Default::default() };
        remove(&f, true, &mut r);
        assert_eq!(r.paths.len(), 1);
        assert!(f.exists(), "a dry run must not delete anything");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn known_emails_reads_the_registry_and_the_thread_rows() {
        let dir = tmp("emails");
        std::fs::create_dir_all(dir.join("accounts")).unwrap();
        {
            let g = crate::store::open(&dir.join("global.db")).unwrap();
            crate::store::set_json(
                &g,
                "accounts",
                &serde_json::json!({
                    "accounts": [{"email": "a@x.test", "provider": "gmail",
                                  "connected": true, "removing": false}],
                    "active": "a@x.test"
                }),
            )
            .unwrap();
        }
        {
            // an account file whose registry row was lost
            let path = dir.join("accounts").join(crate::store::account_db_filename("b@x.test"));
            let c = crate::store::open(&path).unwrap();
            c.execute(
                "INSERT INTO threads (id, subject, account_id) VALUES ('t-1', 'Hi', 'b@x.test')",
                [],
            )
            .unwrap();
        }
        let found = known_emails(&[dir.clone()]);
        assert!(found.contains(&"a@x.test".to_string()), "{found:?}");
        assert!(found.contains(&"b@x.test".to_string()), "{found:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn credential_names_cover_every_fixed_secret_plus_one_per_account() {
        let names = credential_names(&["a@x.test".into(), "b@x.test".into()]);
        for fixed in crate::secrets::ALL_FIXED_ENTRIES {
            assert!(names.iter().any(|n| n == fixed), "missing {fixed}");
        }
        assert!(names.iter().any(|n| n == "gmail:refresh_token:a@x.test"));
        assert!(names.iter().any(|n| n == "gmail:refresh_token:b@x.test"));
        // the shared v0.1 entry is a fixed name, not a per-account one
        assert!(names.iter().any(|n| n == "gmail:refresh_token"));
    }

    /// The uninstaller default must never touch the current mailbox — that is
    /// the stock checkbox's job, and getting this wrong wipes mail on people
    /// who did not tick it.
    #[test]
    fn credentials_scope_leaves_this_installs_mail_alone() {
        let root = tmp("scope");
        let data = root.join("com.snail.mail");
        let cache = root.join("cache").join("com.snail.mail");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(data.join("global.db"), "db").unwrap();
        std::fs::create_dir_all(data.join("models")).unwrap();
        // a legacy orphan beside it
        let legacy = root.join("com.zenbox.mail");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("zenbox.db"), "old").unwrap();

        let report = run(&Options {
            scope: Scope::CredentialsAndLegacy,
            dry_run: false,
            data_root: Some(data.clone()),
            cache_root: Some(cache.clone()),
            revoke: false,
            credentials: false,
        });
        assert!(data.join("global.db").exists(), "mailbox must survive");
        assert!(data.join("models").exists(), "models must survive");
        assert!(!legacy.exists(), "legacy orphan must go unconditionally");
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn everything_scope_takes_the_mailbox_models_and_caches() {
        let root = tmp("all");
        let data = root.join("com.snail.mail");
        let cache = root.join("cache").join("com.snail.mail");
        std::fs::create_dir_all(data.join("accounts")).unwrap();
        std::fs::create_dir_all(data.join("models")).unwrap();
        std::fs::create_dir_all(cache.join("attachments")).unwrap();
        std::fs::create_dir_all(cache.join("EBWebView")).unwrap();
        for f in ["global.db", "global.db-wal", "fission.db"] {
            std::fs::write(data.join(f), "x").unwrap();
        }
        let report = run(&Options {
            scope: Scope::Everything,
            dry_run: false,
            data_root: Some(data.clone()),
            cache_root: Some(cache.clone()),
            revoke: false,
            credentials: false,
        });
        assert!(!data.exists(), "emptied data root should go too");
        assert!(!cache.join("attachments").exists());
        assert!(!cache.join("EBWebView").exists());
        // The sidecar is gone — but do NOT assert it appears in the report.
        // known_emails opens each db (open_ro falls back to read-write), and
        // on close SQLite checkpoints and unlinks a stray -wal itself, so on
        // Linux the purge finds it already absent and stays silent. That the
        // sidecars are *enumerated* is pinned by data_targets_cover_every_db_
        // sidecar; what matters here is the end state.
        assert!(!data.join("global.db-wal").exists());
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_root_with_unknown_files_is_kept() {
        let root = tmp("stranger");
        let data = root.join("com.snail.mail");
        let cache = root.join("cache").join("com.snail.mail");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(data.join("global.db"), "x").unwrap();
        std::fs::write(data.join("someone-elses-notes.txt"), "keep me").unwrap();
        run(&Options {
            scope: Scope::Everything,
            dry_run: false,
            data_root: Some(data.clone()),
            cache_root: Some(cache.clone()),
            revoke: false,
            credentials: false,
        });
        assert!(!data.join("global.db").exists());
        assert!(data.join("someone-elses-notes.txt").exists(), "unknown files must survive");
        std::fs::remove_dir_all(&root).ok();
    }
}
