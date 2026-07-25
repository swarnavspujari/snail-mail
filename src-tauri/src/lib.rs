//! Snail Mail core: IPC surface, app state, and the background loop.
//! Every command validates its inputs; every secret stays in the keychain.
mod ai;
pub mod badge;
mod embed;
mod harper;
mod mail;
mod search;
mod secrets;
mod splits;
mod store;
mod types;
mod unsplash;

use mail::gmail::GmailSession;
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use types::*;

pub struct AppState {
    /// global.db + one file per account. Every handle is an
    /// Arc<Mutex<Connection>> so blocking beats can own one across threads.
    dbs: store::registry::DbRegistry,
    /// True while the legacy fission.db is being split into per-account
    /// files; the periodic loops sit out until the cutover completes.
    migrating: AtomicBool,
    http: reqwest::Client,
    /// One live session per connected Gmail account, keyed by email.
    gmail: tokio::sync::Mutex<HashMap<String, GmailSession>>,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    /// In-flight resumable Drive uploads, keyed by the id handed to the
    /// webview at drive_upload_begin. Compose state is in-memory, so entries
    /// abandoned by a crash/quit just expire server-side (~1 week).
    drive_uploads: Mutex<HashMap<u64, DriveUpload>>,
    drive_upload_seq: std::sync::atomic::AtomicU64,
    /// Overlap guard for the history crawl: a throttled beat can outlast the
    /// 30s sync tick, and later ticks must skip instead of stacking beats.
    crawl_busy: AtomicBool,
    /// Last `sync:activity` tick of the pass currently in flight, or None when
    /// nothing is downloading. Served by `get_sync_activity` so a UI that
    /// mounts mid-pass (onboarding, a reopened window) doesn't have to wait for
    /// the next beat to learn a download is running.
    activity: Mutex<Option<mail::sync::SyncTick>>,
    /// App data dir (model cache lives under it).
    data_dir: std::path::PathBuf,
    /// Lazy local embedding model for semantic search.
    embedder: tokio::sync::Mutex<embed::Slot>,
}

struct DriveUpload {
    session_uri: String,
    account: String,
    sent: i64,
    total: i64,
}

impl AppState {
    /// The app-wide db: settings, accounts registry, streaks, kb.
    fn global(&self) -> Arc<Mutex<Connection>> {
        self.dbs.global()
    }

    fn active_email(&self) -> String {
        store::get_accounts(&self.dbs.global().lock().unwrap()).active
    }

    /// The active account's db — what most list/mutate commands operate on.
    fn active_db(&self) -> Result<Arc<Mutex<Connection>>, String> {
        let email = self.active_email();
        if email.is_empty() {
            return Err("no active account".into());
        }
        self.dbs.account(&email)
    }

    fn account_db(&self, email: &str) -> Result<Arc<Mutex<Connection>>, String> {
        self.dbs.account(email)
    }

    /// Resolve which account owns a thread: the active account's file almost
    /// always has it, so probe that first, then the rest of the registry.
    /// Returns the OWNING email (the row's account_id — during the migration
    /// window a legacy-conn probe can surface another account's thread).
    fn thread_db(&self, thread_id: &str) -> Result<(String, Arc<Mutex<Connection>>), String> {
        let active = self.active_email();
        let mut emails = vec![];
        if !active.is_empty() {
            emails.push(active.clone());
        }
        for e in self.dbs.registered_emails() {
            if e != active {
                emails.push(e);
            }
        }
        for email in emails {
            let db = self.dbs.account(&email)?;
            let owner: Option<String> = {
                let conn = db.lock().unwrap();
                conn.query_row(
                    "SELECT account_id FROM threads WHERE id = ?1",
                    rusqlite::params![thread_id],
                    |r| r.get(0),
                )
                .ok()
            };
            if let Some(owner) = owner {
                let db = if owner == email { db } else { self.dbs.account(&owner)? };
                return Ok((owner, db));
            }
        }
        Err("unknown thread".into())
    }
}

/// The single door `mail:updated` leaves through. Everything that changes the
/// mailbox — sync, triage, send, reclassify, disconnect, migration — funnels
/// here rather than calling `emit` directly, so anything that must track the
/// mailbox is wired once instead of at every producer.
///
/// Today that's the taskbar badge: hanging it off the funnel is what makes it
/// impossible for a new emit site to leave a stale count on the taskbar.
fn emit_mail_updated(app: &AppHandle) {
    let _ = app.emit("mail:updated", ());
    badge::refresh(app);
}

// A Google OAuth "Desktop app" client baked in at build time (CI secrets), so
// beta testers connect without creating their own client. Desktop clients
// cannot keep secrets by design — Google's model accepts an embedded id/secret
// for installed apps (PKCE still guards the flow). Keychain-pasted credentials
// always win over these.
// Prefer the SNAIL_* build-time env; fall back to the legacy FISSION_* then
// ZENBOX_* so the existing CI repo secrets keep working through the renames.
const BAKED_GMAIL_CLIENT_ID: Option<&str> = match option_env!("SNAIL_GMAIL_CLIENT_ID") {
    Some(v) => Some(v),
    None => match option_env!("FISSION_GMAIL_CLIENT_ID") {
        Some(v) => Some(v),
        None => option_env!("ZENBOX_GMAIL_CLIENT_ID"),
    },
};
const BAKED_GMAIL_CLIENT_SECRET: Option<&str> = match option_env!("SNAIL_GMAIL_CLIENT_SECRET") {
    Some(v) => Some(v),
    None => match option_env!("FISSION_GMAIL_CLIENT_SECRET") {
        Some(v) => Some(v),
        None => option_env!("ZENBOX_GMAIL_CLIENT_SECRET"),
    },
};

const BUNDLED_CELEBRATIONS: [&str; 4] = [
    "/inbox-zero/dawn-ridge.svg",
    "/inbox-zero/quiet-lake.svg",
    "/inbox-zero/night-dunes.svg",
    "/inbox-zero/aurora-field.svg",
];

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn is_mock_id(id: &str) -> bool {
    id.starts_with("t-") || id.starts_with("t2-")
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid id".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- accounts

#[tauri::command]
async fn get_accounts(state: State<'_, AppState>) -> Result<AccountsState, String> {
    // boot breadcrumb: proves the webview⇄core IPC round-trip in dev logs
    #[cfg(debug_assertions)]
    eprintln!("[ipc] get_accounts");
    Ok(store::get_accounts(&state.global().lock().unwrap()))
}

#[tauri::command]
async fn switch_account(state: State<'_, AppState>, email: String) -> Result<AccountsState, String> {
    let db = state.global();
    let conn = db.lock().unwrap();
    let mut accounts = store::get_accounts(&conn);
    let Some(a) = accounts.accounts.iter().find(|a| a.email == email) else {
        return Err("unknown account".into());
    };
    if a.removing {
        return Err("that account is being removed".into());
    }
    accounts.active = email;
    store::save_accounts(&conn, &accounts)?;
    Ok(accounts)
}

#[tauri::command]
async fn reorder_accounts(state: State<'_, AppState>, emails: Vec<String>) -> Result<AccountsState, String> {
    let db = state.global();
    let conn = db.lock().unwrap();
    let mut accounts = store::get_accounts(&conn);
    if emails.len() != accounts.accounts.len() {
        return Err("account list mismatch".into());
    }
    let mut reordered = vec![];
    for email in &emails {
        let a = accounts
            .accounts
            .iter()
            .find(|a| &a.email == email)
            .ok_or("unknown account in ordering")?;
        reordered.push(a.clone());
    }
    accounts.accounts = reordered;
    store::save_accounts(&conn, &accounts)?;
    Ok(accounts)
}

#[tauri::command]
fn has_gmail_client() -> bool {
    (secrets::get(secrets::GMAIL_CLIENT_ID).is_some()
        && secrets::get(secrets::GMAIL_CLIENT_SECRET).is_some())
        || (BAKED_GMAIL_CLIENT_ID.is_some() && BAKED_GMAIL_CLIENT_SECRET.is_some())
}

#[tauri::command]
async fn start_oauth(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<AccountsState, String> {
    // blank args = keychain client, else the build's baked-in beta client
    let client_id = if client_id.trim().is_empty() {
        secrets::get(secrets::GMAIL_CLIENT_ID)
            .or_else(|| BAKED_GMAIL_CLIENT_ID.map(str::to_string))
            .ok_or("no OAuth client available — paste the client ID and secret")?
    } else {
        client_id.trim().to_string()
    };
    let client_secret = if client_secret.trim().is_empty() {
        secrets::get(secrets::GMAIL_CLIENT_SECRET)
            .or_else(|| BAKED_GMAIL_CLIENT_SECRET.map(str::to_string))
            .ok_or("no OAuth client available — paste the client ID and secret")?
    } else {
        client_secret.trim().to_string()
    };
    secrets::set(secrets::GMAIL_CLIENT_ID, &client_id)?;
    secrets::set(secrets::GMAIL_CLIENT_SECRET, &client_secret)?;

    let outcome = mail::oauth::run_flow(&state.http, &app, &client_id, &client_secret).await?;
    // Non-fatal: warn about any feature scope Google skipped (per-scope
    // checkboxes on the consent screen), so the user fixes it now instead of
    // hitting a 403 later. Everything still gates on get_capabilities.
    let missing_features = missing_feature_names(outcome.granted_scope.as_deref());
    let email = GmailSession::profile_email(&state.http, &outcome.access_token).await?;
    secrets::set(&secrets::gmail_refresh_entry(&email), &outcome.refresh_token)?;

    // Persist exactly what was granted — feature gating reads this, and its
    // absence marks a pre-v0.15 grant that needs one reconnect. If Google
    // (abnormally) omitted the scope field, assume the full requested block
    // rather than misclassifying a fresh connect as a legacy grant — a wrong
    // optimistic grant just surfaces as a classified 403 with a Reconnect CTA.
    {
        let scope = outcome
            .granted_scope
            .clone()
            .unwrap_or_else(|| mail::oauth::requested_scope().to_string());
        let db = state.account_db(&email)?;
        let conn = db.lock().unwrap();
        let _ = store::set_json(&conn, &format!("granted_scopes:{email}"), &scope);
        // A fresh grant never needs the "reconnect for new features" notice.
        let _ = store::set_json(&conn, &format!("scope_notice_shown:{email}"), &true);
    }

    // Grab the display name + photo while we hold a fresh access token.
    if let Some(prof) = fetch_google_profile(&state.http, &outcome.access_token).await {
        let db = state.account_db(&email)?;
        let conn = db.lock().unwrap();
        let _ = store::set_json(&conn, &format!("profile:{email}"), &prof);
    }

    let accounts = {
        // Read under the global lock, purge fixtures outside it —
        // account_db() itself needs the global lock (migration flags), so
        // holding the guard across it would self-deadlock.
        let mut accounts = { store::get_accounts(&state.global().lock().unwrap()) };
        // first real account replaces the demo pair (and their fixture mail)
        if accounts.accounts.iter().all(|a| a.provider == "mock") {
            for a in accounts.accounts.drain(..) {
                let mock_db = state.account_db(&a.email)?;
                let mock_conn = mock_db.lock().unwrap();
                store::clear_account_mail(&mock_conn, &a.email)?;
            }
        }
        if let Some(existing) = accounts.accounts.iter_mut().find(|a| a.email == email) {
            if existing.removing {
                return Err(
                    "that account is still being removed — try again in a moment".into()
                );
            }
            // Re-consent for an account that was marked disconnected (dead
            // grant) — flip it back; the fresh token below replaces the old.
            // Its mail, sync cursors, and history are untouched: a scope
            // top-up must never cost the local mailbox.
            existing.connected = true;
        } else {
            accounts.accounts.push(AccountInfo {
                email: email.clone(),
                provider: "gmail".into(),
                connected: true,
                removing: false,
            });
        }
        accounts.active = email.clone();
        store::save_accounts(&state.global().lock().unwrap(), &accounts)?;
        accounts
    };

    // Parked sends from a dead-grant window get fresh attempts now that the
    // grant is back — the outbox pump picks them up on its next beat.
    {
        let db = state.account_db(&email)?;
        let conn = db.lock().unwrap();
        store::outbox_reset_attempts(&conn, &email);
    }
    let session = GmailSession::new_connected(email.clone(), outcome.access_token, outcome.expires_in)
        .ok_or("keychain readback failed")?;
    state.gmail.lock().await.insert(email, session);
    let _ = app.emit("accounts:updated", &accounts);
    if !missing_features.is_empty() {
        let _ = app.emit(
            "app:notice",
            format!(
                "Connected, but {} access wasn't granted — run Connect Gmail again and check every box.",
                missing_features.join(" + ")
            ),
        );
    }
    // Fresh grant in hand: pull Google contacts + send-as aliases now (each
    // no-ops gracefully if its scope was unchecked).
    spawn_people_sync(app.clone(), accounts.active.clone());
    spawn_sendas_fetch(app.clone(), accounts.active.clone());
    sync_in_background(app);
    Ok(accounts)
}

/// Does a space-separated grant string contain this exact scope URL?
fn scope_granted(granted: &str, scope: &str) -> bool {
    granted.split_whitespace().any(|s| s == scope)
}

/// Human names of the feature scopes missing from a grant (None = Google
/// didn't report the grant; assume complete rather than nag falsely).
fn missing_feature_names(granted: Option<&str>) -> Vec<&'static str> {
    let Some(g) = granted else { return vec![] };
    let mut missing = vec![];
    if !scope_granted(g, "https://www.googleapis.com/auth/calendar") {
        missing.push("Calendar");
    }
    if !scope_granted(g, "https://www.googleapis.com/auth/drive") {
        missing.push("Drive");
    }
    if !scope_granted(g, "https://www.googleapis.com/auth/contacts.readonly")
        && !scope_granted(g, "https://www.googleapis.com/auth/contacts.other.readonly")
    {
        missing.push("Contacts");
    }
    missing
}

/// What the account's persisted OAuth grant actually covers. Mock accounts
/// get nothing (the browser demo's MockBackend answers for itself); a gmail
/// account with no recorded grant predates v0.12 → legacy_grant.
#[tauri::command]
async fn get_capabilities(state: State<'_, AppState>, email: String) -> Result<Capabilities, String> {
    let is_gmail = store::get_accounts(&state.global().lock().unwrap())
        .accounts
        .iter()
        .any(|a| a.email == email && a.provider == "gmail");
    if !is_gmail {
        return Ok(Capabilities::default());
    }
    let db = state.account_db(&email)?;
    let conn = db.lock().unwrap();
    Ok(match store::get_json::<String>(&conn, &format!("granted_scopes:{email}")) {
        None => Capabilities { legacy_grant: true, ..Default::default() },
        Some(g) => Capabilities {
            drive: scope_granted(&g, "https://www.googleapis.com/auth/drive"),
            contacts: scope_granted(&g, "https://www.googleapis.com/auth/contacts.readonly")
                || scope_granted(&g, "https://www.googleapis.com/auth/contacts.other.readonly"),
            calendar_write: scope_granted(&g, "https://www.googleapis.com/auth/calendar"),
            settings_read: scope_granted(&g, "https://www.googleapis.com/auth/gmail.settings.basic"),
            legacy_grant: false,
        },
    })
}

/// Instant, honest removal: flag the account `removing` in the registry and
/// return in milliseconds; finish_removal tears everything down in the
/// background (revoke, close + delete the db file, cache/keychain/signature
/// sweep). Idempotent — a double-click or a call for an unknown account just
/// returns the current state.
#[tauri::command]
async fn disconnect_account(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
) -> Result<AccountsState, String> {
    let (accounts, started) = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let mut accounts = store::get_accounts(&conn);
        let Some(idx) = accounts.accounts.iter().position(|a| a.email == email) else {
            return Ok(accounts);
        };
        if accounts.accounts[idx].removing {
            (accounts, false)
        } else {
            accounts.accounts[idx].removing = true;
            if accounts.active == email {
                if let Some(next) =
                    accounts.accounts.iter().find(|a| a.email != email && !a.removing)
                {
                    accounts.active = next.email.clone();
                }
            }
            store::save_accounts(&conn, &accounts)?;
            (accounts, true)
        }
    };
    if started {
        let _ = app.emit("accounts:updated", &accounts);
        emit_mail_updated(&app);
        let app2 = app.clone();
        let email2 = email.clone();
        tauri::async_runtime::spawn(async move {
            finish_removal(app2, email2).await;
        });
    }
    Ok(accounts)
}

/// Background tail of disconnect_account; also re-run at boot for any account
/// still flagged `removing` (a removal the previous session never finished).
/// Every step is idempotent.
async fn finish_removal(app: AppHandle, email: String) {
    let state = app.state::<AppState>();
    // 1. Best-effort server-side revoke with a short timeout — a dead network
    //    must never wedge a removal. Only the per-account token: the shared
    //    legacy entry may be the credential another legacy account boots from.
    if let Some(rt) = secrets::get(&secrets::gmail_refresh_entry(&email)) {
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            state
                .http
                .post("https://oauth2.googleapis.com/revoke")
                .form(&[("token", rt.as_str())])
                .send(),
        )
        .await;
    }
    // 2. Drop the live session so no sync beat re-touches the account.
    state.gmail.lock().await.remove(&email);
    // 3. Collect this account's attachment-cache filenames BEFORE the db
    //    goes away (the shared cache dir is swept below; names another
    //    account still references are kept).
    let cache_names = attachment_cache_names(&state, &email);
    // 4. Drop the account from the registry + prune its signature; the demo
    //    pair comes back when the last real account leaves. From here on no
    //    command can resolve a connection to it.
    let accounts = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let mut accounts = store::get_accounts(&conn);
        accounts.accounts.retain(|a| a.email != email);
        let mut settings = store::get_settings(&conn);
        if settings.signatures.remove(&email).is_some() {
            let _ = store::set_json(&conn, "settings", &settings);
        }
        conn.execute("DELETE FROM kv WHERE key = ?1", [format!("migrated:{email}")]).ok();
        if accounts.accounts.is_empty() {
            conn.execute("DELETE FROM kv WHERE key = 'accounts'", []).ok();
            store::get_accounts(&conn) // demo-pair fallback
        } else {
            if accounts.active == email {
                accounts.active = accounts.accounts[0].email.clone();
            }
            let _ = store::save_accounts(&conn, &accounts);
            accounts
        }
    };
    // 5. Close the connection and delete the db file (+ sidecars). O(1) —
    //    this replaces the minutes-long chunked row purge.
    if let Err(e) = state.dbs.close_and_delete(&email) {
        eprintln!("[remove:{email}] {e} — the boot sweep will finish the job");
        let _ = app.emit(
            "app:notice",
            format!("Couldn't finish removing {email} — it completes on the next launch."),
        );
    }
    // 6. Swept cache files + keychain. The shared legacy gmail:refresh_token
    //    is only deleted when NO gmail account remains — deleting it eagerly
    //    could strip the one credential a legacy-provisioned account still
    //    boots from.
    if let Ok(dir) = app.path().app_cache_dir() {
        let dir = dir.join("attachments");
        for name in cache_names {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }
    secrets::delete(&secrets::gmail_refresh_entry(&email));
    if accounts.accounts.iter().all(|a| a.provider != "gmail") {
        secrets::delete(secrets::GMAIL_REFRESH_TOKEN_LEGACY);
    }
    // 7. Removing the last account leaves zero accounts, full stop. This used
    //    to re-seed the demo pair — which is exactly why a disconnect could
    //    never actually empty the app.
    #[cfg(feature = "demo-fixtures")]
    if accounts.accounts.iter().all(|a| a.provider == "mock") {
        for a in &accounts.accounts {
            if let Ok(db) = state.account_db(&a.email) {
                let conn = db.lock().unwrap();
                let _ = mail::mock::seed_account_if_empty(&conn, &a.email);
                let _ = mail::mock::ensure_demo_vectors(&conn);
            }
        }
    }
    let _ = app.emit("accounts:updated", &accounts);
    emit_mail_updated(&app);
}

/// The removed account's attachment-cache filenames, minus any name another
/// account's attachments still map to (the cache dir is shared and names
/// collide by design).
fn attachment_cache_names(state: &AppState, email: &str) -> Vec<String> {
    let names_for = |target: &str| -> Vec<String> {
        let Ok(db) = state.dbs.account(target) else { return vec![] };
        let conn = db.lock().unwrap();
        conn.prepare(
            "SELECT DISTINCT a.filename FROM attachments a
             JOIN messages m ON m.id = a.message_id
             JOIN threads t ON t.id = m.thread_id
             WHERE t.account_id = ?1",
        )
        .and_then(|mut st| {
            st.query_map([target], |r| r.get::<_, String>(0))
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default()
    };
    let mine: Vec<String> = names_for(email).iter().map(|f| safe_attachment_name(f)).collect();
    let mut kept = std::collections::HashSet::new();
    for other in state.dbs.registered_emails() {
        if other == email {
            continue;
        }
        for f in names_for(&other) {
            kept.insert(safe_attachment_name(&f));
        }
    }
    mine.into_iter().filter(|n| !kept.contains(n)).collect()
}

/// Same sanitization open_attachment applies when writing the cache file.
fn safe_attachment_name(filename: &str) -> String {
    let safe: String = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || ".-_ ".contains(c) { c } else { '_' })
        .collect();
    if safe.trim().is_empty() {
        "attachment".into()
    } else {
        safe
    }
}

/// Boot-time self-heal: delete any account db file no registered account
/// derives to (a removal that died mid-flight). Only runs once the legacy
/// split fully finished — while migration is live the legacy db is the
/// source of truth and partial files belong to the migrator.
fn spawn_account_file_sweep(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if state.dbs.legacy().is_some() {
            return;
        }
        let expected: std::collections::HashSet<String> = state
            .dbs
            .registered_emails()
            .iter()
            .map(|e| store::account_db_filename(e))
            .collect();
        let dir = state.dbs.data_dir.join("accounts");
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".db") || expected.contains(&name) {
                continue;
            }
            eprintln!("[sweep] deleting unregistered account file {name}");
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(dir.join(format!("{name}{suffix}")));
            }
        }
    });
}

/// OpenID userinfo → name + photo (photo inlined as a data: URI so the UI
/// renders it with zero network access).
async fn fetch_google_profile(http: &reqwest::Client, access_token: &str) -> Option<ProfileInfo> {
    let v: serde_json::Value = http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let name = v["name"].as_str().unwrap_or_default().to_string();
    let mut picture = None;
    if let Some(url) = v["picture"].as_str() {
        if let Ok(resp) = http.get(url).send().await {
            let mime = resp
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            if let Ok(bytes) = resp.bytes().await {
                if bytes.len() <= 1_000_000 {
                    use base64::Engine;
                    picture = Some(format!(
                        "data:{mime};base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    ));
                }
            }
        }
    }
    Some(ProfileInfo { name, picture })
}

const DAY_MS: i64 = 24 * 3_600_000;

/// Calendar events for the side panel / week view. Local-first: gmail
/// accounts read the SQLite cache (refresh_calendar repopulates it in the
/// background); demo accounts get fixture events so the panel is demoable
/// with zero credentials.
#[tauri::command]
async fn list_events(
    state: State<'_, AppState>,
    start_ms: i64,
    end_ms: i64,
) -> Result<Vec<CalendarEvent>, String> {
    if end_ms <= start_ms || end_ms - start_ms > 62 * DAY_MS {
        return Err("invalid time range".into());
    }
    let active = { store::active_account(&state.global().lock().unwrap()) };
    if active.provider != "gmail" {
        #[cfg(feature = "demo-fixtures")]
        {
            let mut events = mail::mock::demo_events(start_ms, end_ms);
            // the RSVP overlay is app-wide demo state, so it lives in global.db
            apply_demo_rsvps(&state.global().lock().unwrap(), &mut events);
            return Ok(events);
        }
        // No account, no calendar. An empty week is the honest answer.
        #[cfg(not(feature = "demo-fixtures"))]
        return Ok(vec![]);
    }
    let db = state.account_db(&active.email)?;
    let conn = db.lock().unwrap();
    Ok(store::list_events(&conn, &active.email, start_ms, end_ms))
}

/// Demo mode synthesizes events on read, so RSVPs record into a kv overlay
/// (uid → response) that this re-applies — the demo's RSVP bar and popover
/// stay coherent without a real backend.
#[cfg(feature = "demo-fixtures")]
fn apply_demo_rsvps(conn: &rusqlite::Connection, events: &mut [CalendarEvent]) {
    let overlay: std::collections::HashMap<String, String> =
        store::get_json(conn, "demo_rsvp").unwrap_or_default();
    if overlay.is_empty() {
        return;
    }
    for e in events.iter_mut() {
        let Some(resp) = e.ical_uid.as_ref().and_then(|u| overlay.get(u)) else { continue };
        for a in e.attendees.iter_mut() {
            if a.self_ {
                a.response_status = resp.clone();
            }
        }
    }
}

/// The window an initial (or 410-recovery) calendar fetch covers. A Google
/// syncToken permanently encodes its initial request's time bounds, so
/// increments only ever report changes INSIDE this window — the anchor below
/// rolls the window forward monthly, and out-of-window navigation triggers a
/// one-off range fetch (see refresh_calendar).
const CAL_WINDOW_PAST: i64 = 30 * DAY_MS;
const CAL_WINDOW_FUTURE: i64 = 365 * DAY_MS;
/// Re-window this often so the fixed horizon keeps up with the passage of time.
const CAL_REANCHOR_AFTER: i64 = 30 * DAY_MS;

fn cal_sync_key(email: &str, calendar_id: &str) -> String {
    format!("cal_sync:{email}:{calendar_id}")
}

fn cal_anchor_key(email: &str, calendar_id: &str) -> String {
    format!("cal_anchor:{email}:{calendar_id}")
}

/// Initial/recovery fetch for one calendar: windowed full listing replaces
/// the cached rows and the captured nextSyncToken makes later pulls
/// incremental. `clear_all` (410 recovery) drops the calendar's rows outside
/// the window too — deletions that happened during the token gap would
/// otherwise linger as zombies forever.
async fn calendar_full_refetch(
    app: &AppHandle,
    email: &str,
    cal: &mail::calendar::CalMeta,
    bearer: &str,
    clear_all: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let now = now_ms();
    let (win_start, win_end) = (now - CAL_WINDOW_PAST, now + CAL_WINDOW_FUTURE);
    let (events, next_token) =
        mail::calendar::fetch_window(&state.http, bearer, cal, win_start, win_end).await?;
    let db = state.account_db(email)?;
    let conn = db.lock().unwrap();
    let (clear_start, clear_end) =
        if clear_all { (i64::MIN / 4, i64::MAX / 4) } else { (win_start, win_end) };
    store::replace_calendar_window(&conn, email, &cal.id, clear_start, clear_end, &events)?;
    store::set_json(&conn, &cal_anchor_key(email, &cal.id), &now)?;
    match next_token {
        Some(t) => store::set_json(&conn, &cal_sync_key(email, &cal.id), &t)?,
        // No token (page-cap overflow or a truncated listing) → stay
        // windowed-only; the next beat retries the initial fetch.
        None => {
            conn.execute("DELETE FROM kv WHERE key = ?1", [cal_sync_key(email, &cal.id)])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Sync one calendar: incremental when a syncToken is stored (410 → drop the
/// token and window-refetch), initial windowed fetch otherwise.
async fn sync_one_calendar(
    app: &AppHandle,
    email: &str,
    cal: &mail::calendar::CalMeta,
    bearer: &str,
) -> Result<(), String> {
    use mail::calendar::SyncError;
    let state = app.state::<AppState>();
    let key = cal_sync_key(email, &cal.id);
    let db = state.account_db(email)?;
    let (token, anchor): (Option<String>, Option<i64>) = {
        let conn = db.lock().unwrap();
        (store::get_json(&conn, &key), store::get_json(&conn, &cal_anchor_key(email, &cal.id)))
    };
    // The syncToken's window is pinned to its initial fetch; roll it forward
    // monthly so the -30d..+365d horizon tracks the present.
    let stale_window = anchor.map(|at| now_ms() - at > CAL_REANCHOR_AFTER).unwrap_or(true);
    let Some(token) = token.filter(|_| !stale_window) else {
        return calendar_full_refetch(app, email, cal, bearer, true).await;
    };
    match mail::calendar::sync_incremental(&state.http, bearer, cal, &token).await {
        Ok(delta) => {
            // One transaction: a large delta as per-row autocommits would hold
            // this account's DB mutex across thousands of fsyncs.
            let conn = db.lock().unwrap();
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            for e in &delta.upserts {
                store::upsert_event(&tx, email, e)?;
            }
            for id in &delta.deleted_ids {
                store::delete_event(&tx, email, &cal.id, id)?;
            }
            store::set_json(&tx, &key, &delta.next_sync_token)?;
            tx.commit().map_err(|e| e.to_string())
        }
        Err(SyncError::TokenExpired) => {
            {
                let conn = db.lock().unwrap();
                conn.execute("DELETE FROM kv WHERE key = ?1", [key.as_str()])
                    .map_err(|e| e.to_string())?;
            }
            calendar_full_refetch(app, email, cal, bearer, true).await
        }
        Err(SyncError::Other(e)) => Err(e),
    }
}

/// One account's calendar sync pass: calendarList (names/colors/accessRole),
/// prune calendars that vanished, then sync every calendar concurrently.
/// Per-calendar failures don't blank the rest — an error surfaces only when
/// nothing synced.
async fn calendar_sync(app: &AppHandle, email: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let (bearer, calendars) = {
        let mut sessions = state.gmail.lock().await;
        let Some(session) = sessions.get_mut(email) else {
            return Err("account not connected".into());
        };
        let calendars = mail::calendar::list_calendars(&state.http, session).await?;
        let bearer = session.bearer(&state.http).await?;
        (bearer, calendars)
    };
    {
        let db = state.account_db(email)?;
        let conn = db.lock().unwrap();
        let ids: Vec<String> = calendars.iter().map(|c| c.id.clone()).collect();
        store::retain_calendars(&conn, email, &ids)?;
        // Drop syncTokens/anchors for calendars gone from the list too — a
        // calendar re-selected later must do a fresh initial fetch, not
        // resume an old token against its now-empty cache.
        for prefix in ["cal_sync", "cal_anchor"] {
            let pat = format!("{prefix}:{email}:%");
            let stale: Vec<String> = conn
                .prepare("SELECT key FROM kv WHERE key LIKE ?1")
                .and_then(|mut st| {
                    st.query_map([pat.as_str()], |r| r.get::<_, String>(0))
                        .map(|rows| rows.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_default();
            let head = format!("{prefix}:{email}:");
            for key in stale {
                let cal_id = &key[head.len()..];
                if !ids.iter().any(|id| id == cal_id) {
                    let _ = conn.execute("DELETE FROM kv WHERE key = ?1", [key.as_str()]);
                }
            }
        }
    }
    let handles: Vec<_> = calendars
        .into_iter()
        .map(|cal| {
            let app = app.clone();
            let email = email.to_string();
            let bearer = bearer.clone();
            tauri::async_runtime::spawn(async move {
                sync_one_calendar(&app, &email, &cal, &bearer)
                    .await
                    .map_err(|e| (cal.name, e))
            })
        })
        .collect();
    let (mut synced, mut first_err) = (0usize, None);
    for h in handles {
        match h.await {
            Ok(Ok(())) => synced += 1,
            Ok(Err((name, e))) => {
                eprintln!("[calendar:{email}] {name}: {e}");
                first_err.get_or_insert(e);
            }
            Err(e) => {
                first_err.get_or_insert(e.to_string());
            }
        }
    }
    match first_err {
        Some(e) if synced == 0 => Err(e),
        _ => Ok(()),
    }
}

/// Fire-and-forget calendar sync for one account; emits `calendar:updated`
/// with an optional error so open panels repaint / surface guidance. Unforced
/// runs are throttled to one pass a minute (incremental pulls are cheap, but
/// the UI calls this on every panel/day/focus change).
fn spawn_calendar_sync(app: AppHandle, email: String, force: bool) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let throttle_key = format!("cal_synced_at:{email}");
        let Ok(db) = state.account_db(&email) else { return };
        if !force {
            let conn = db.lock().unwrap();
            if let Some(at) = store::get_json::<i64>(&conn, &throttle_key) {
                if now_ms() - at < 60_000 {
                    return;
                }
            }
        }
        match calendar_sync(&app, &email).await {
            Ok(()) => {
                {
                    let conn = db.lock().unwrap();
                    let _ = store::set_json(&conn, &throttle_key, &now_ms());
                }
                let _ = app.emit("calendar:updated", Option::<String>::None);
            }
            Err(e) => {
                classify_sync_error(&app, &email, &e).await;
                let _ = app.emit("calendar:updated", Some(e));
            }
        }
    });
}

/// One-off fetch of an out-of-window range (day/week navigation beyond the
/// synced -30d..+365d): pull just that range for every calendar and cache it.
/// No token capture — the sync engine's own window is untouched. Throttled
/// via a coverage bookmark like the pre-v0.16 refresh.
fn spawn_calendar_range_fetch(app: AppHandle, email: String, start_ms: i64, end_ms: i64) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let key = format!("cal_range:{email}");
        let Ok(db) = state.account_db(&email) else { return };
        {
            let conn = db.lock().unwrap();
            if let Some(w) = store::get_json::<serde_json::Value>(&conn, &key) {
                let covered = w["start"].as_i64().unwrap_or(i64::MAX) <= start_ms
                    && w["end"].as_i64().unwrap_or(0) >= end_ms;
                let fresh = now_ms() - w["at"].as_i64().unwrap_or(0) < 120_000;
                if covered && fresh {
                    return;
                }
            }
        }
        // widen so day-by-day stepping stays inside one fetched range
        let (fetch_start, fetch_end) = (start_ms - 7 * DAY_MS, end_ms + 7 * DAY_MS);
        let (bearer, calendars) = {
            let mut sessions = state.gmail.lock().await;
            let Some(session) = sessions.get_mut(&email) else { return };
            let Ok(calendars) = mail::calendar::list_calendars(&state.http, session).await else {
                return;
            };
            let Ok(bearer) = session.bearer(&state.http).await else { return };
            (bearer, calendars)
        };
        for cal in &calendars {
            if let Ok((events, _)) =
                mail::calendar::fetch_window(&state.http, &bearer, cal, fetch_start, fetch_end)
                    .await
            {
                let conn = db.lock().unwrap();
                let _ = store::replace_calendar_window(
                    &conn, &email, &cal.id, fetch_start, fetch_end, &events,
                );
            }
        }
        {
            let conn = db.lock().unwrap();
            let _ = store::set_json(
                &conn,
                &key,
                &serde_json::json!({ "start": fetch_start, "end": fetch_end, "at": now_ms() }),
            );
        }
        let _ = app.emit("calendar:updated", Option::<String>::None);
    });
}

/// Ask for fresh events around a range (the UI fires this on panel open,
/// day/week navigation, and window focus). Inside the synced window this is
/// an incremental sync pass; outside it, a one-off range fetch backfills the
/// navigated dates like the pre-v0.16 windowed refresh did.
#[tauri::command]
async fn refresh_calendar(
    app: AppHandle,
    state: State<'_, AppState>,
    start_ms: i64,
    end_ms: i64,
) -> Result<(), String> {
    if end_ms <= start_ms || end_ms - start_ms > 62 * DAY_MS {
        return Err("invalid time range".into());
    }
    let active = { store::active_account(&state.global().lock().unwrap()) };
    if active.provider != "gmail" {
        return Ok(()); // demo events are synthesized on read
    }
    let now = now_ms();
    if start_ms < now - CAL_WINDOW_PAST || end_ms > now + CAL_WINDOW_FUTURE {
        spawn_calendar_range_fetch(app, active.email, start_ms, end_ms);
    } else {
        spawn_calendar_sync(app, active.email, false);
    }
    Ok(())
}

/// The active account's Gmail address, or a calendar-flavored nudge.
fn active_gmail_cal(state: &State<'_, AppState>) -> Result<String, String> {
    let active = { store::active_account(&state.global().lock().unwrap()) };
    if active.provider != "gmail" {
        return Err("Connect a Gmail account to edit Google Calendar events".into());
    }
    Ok(active.email)
}

/// Resolve one calendar's metadata + a bearer for direct write calls.
async fn resolve_calendar(
    state: &State<'_, AppState>,
    email: &str,
    calendar_id: &str,
) -> Result<(String, mail::calendar::CalMeta), String> {
    let mut sessions = state.gmail.lock().await;
    let session = sessions.get_mut(email).ok_or("account not connected — reconnect Gmail")?;
    let calendars = mail::calendar::list_calendars(&state.http, session).await?;
    let cal = calendars
        .into_iter()
        .find(|c| c.id == calendar_id)
        .ok_or("calendar not found — it may have been removed from your Google account")?;
    let bearer = session.bearer(&state.http).await?;
    Ok((bearer, cal))
}

fn validate_event_draft(draft: &EventDraft) -> Result<(), String> {
    if draft.title.trim().is_empty() {
        return Err("Give the event a title".into());
    }
    if draft.title.len() > 1024 || draft.description.as_deref().unwrap_or("").len() > 8192 {
        return Err("Event text is too long".into());
    }
    if draft.end_ms <= draft.start_ms {
        return Err("The event must end after it starts".into());
    }
    if draft.attendees.len() > 100 {
        return Err("Too many guests (max 100)".into());
    }
    for a in &draft.attendees {
        if !a.contains('@') || a.len() > 254 {
            return Err(format!("\"{a}\" doesn't look like an email address"));
        }
    }
    Ok(())
}

fn validate_send_updates(send_updates: &str) -> Result<(), String> {
    match send_updates {
        "all" | "none" => Ok(()),
        _ => Err("invalid sendUpdates value".into()),
    }
}

/// The account's calendars for the event modal's selector (accessRole tells
/// the UI which are writable). Demo accounts get the fixture calendar.
#[tauri::command]
async fn list_calendars(state: State<'_, AppState>) -> Result<Vec<CalendarInfo>, String> {
    let active = { store::active_account(&state.global().lock().unwrap()) };
    if active.provider != "gmail" {
        return Ok(vec![CalendarInfo {
            id: "demo".into(),
            name: "Demo".into(),
            color: None,
            access_role: "owner".into(),
            primary: true,
        }]);
    }
    let mut sessions = state.gmail.lock().await;
    let session = sessions
        .get_mut(&active.email)
        .ok_or("account not connected — reconnect Gmail")?;
    let calendars = mail::calendar::list_calendars(&state.http, session).await?;
    Ok(calendars
        .into_iter()
        .map(|c| CalendarInfo {
            id: c.id,
            name: c.name,
            color: c.color,
            access_role: c.access_role,
            primary: c.primary,
        })
        .collect())
}

/// Create an event (direct Google call, online-required). The saved copy is
/// upserted locally and an incremental sync follows, so every view converges.
#[tauri::command]
async fn create_event(
    app: AppHandle,
    state: State<'_, AppState>,
    draft: EventDraft,
    send_updates: String,
) -> Result<CalendarEvent, String> {
    validate_event_draft(&draft)?;
    validate_send_updates(&send_updates)?;
    let email = active_gmail_cal(&state)?;
    let (bearer, cal) = resolve_calendar(&state, &email, &draft.calendar_id).await?;
    if !matches!(cal.access_role.as_str(), "owner" | "writer") {
        return Err("You don't have edit access to that calendar".into());
    }
    let body = mail::calendar::event_body(&draft, None);
    let ev = mail::calendar::insert_event(&state.http, &bearer, &cal, &body, &send_updates).await?;
    match finish_event_write(app, &state, &email, mail::calendar::WriteOutcome::Saved(ev))? {
        EventWriteResult { event: Some(ev), .. } => Ok(ev),
        _ => Err("create did not return the event".into()),
    }
}

/// Update an event with If-Match on its etag; a 412 comes back as
/// status="conflict" carrying the fresh copy for review-and-retry.
#[tauri::command]
async fn update_event(
    app: AppHandle,
    state: State<'_, AppState>,
    calendar_id: String,
    event_id: String,
    etag: Option<String>,
    draft: EventDraft,
    send_updates: String,
) -> Result<EventWriteResult, String> {
    validate_event_draft(&draft)?;
    validate_send_updates(&send_updates)?;
    let email = active_gmail_cal(&state)?;
    let (bearer, cal) = resolve_calendar(&state, &email, &calendar_id).await?;
    // merge base: preserve existing guests' RSVP state through the overwrite
    let existing = {
        let db = state.account_db(&email)?;
        let conn = db.lock().unwrap();
        store::get_event(&conn, &email, &calendar_id, &event_id)
    };
    let body = mail::calendar::event_body(&draft, existing.as_ref());
    let outcome = mail::calendar::patch_event(
        &state.http,
        &bearer,
        &cal,
        &event_id,
        etag.as_deref(),
        &body,
        &send_updates,
    )
    .await?;
    finish_event_write(app, &state, &email, outcome)
}

/// Delete an event (If-Match guarded like update).
#[tauri::command]
async fn delete_event(
    app: AppHandle,
    state: State<'_, AppState>,
    calendar_id: String,
    event_id: String,
    etag: Option<String>,
    send_updates: String,
) -> Result<EventWriteResult, String> {
    validate_send_updates(&send_updates)?;
    let email = active_gmail_cal(&state)?;
    let (bearer, cal) = resolve_calendar(&state, &email, &calendar_id).await?;
    let conflict = mail::calendar::delete_event(
        &state.http,
        &bearer,
        &cal,
        &event_id,
        etag.as_deref(),
        &send_updates,
    )
    .await?;
    match conflict {
        Some(fresh) => {
            {
                let db = state.account_db(&email)?;
                let conn = db.lock().unwrap();
                store::upsert_event(&conn, &email, &fresh)?;
            }
            // repaint with the fresh copy, matching finish_event_write
            let _ = app.emit("calendar:updated", Option::<String>::None);
            Ok(EventWriteResult { status: "conflict".into(), event: Some(fresh) })
        }
        None => {
            {
                let db = state.account_db(&email)?;
                let conn = db.lock().unwrap();
                store::delete_event(&conn, &email, &calendar_id, &event_id)?;
            }
            let _ = app.emit("calendar:updated", Option::<String>::None);
            spawn_calendar_sync(app, email, true);
            Ok(EventWriteResult { status: "ok".into(), event: None })
        }
    }
}

/// RSVP to an event the account is a guest on; the organizer is notified
/// (sendUpdates=all). Returns the updated event. Demo accounts record into
/// the kv overlay so the fixture calendar reflects the choice.
#[tauri::command]
async fn rsvp_event(
    app: AppHandle,
    state: State<'_, AppState>,
    calendar_id: String,
    event_id: String,
    response: String,
) -> Result<CalendarEvent, String> {
    if !matches!(response.as_str(), "accepted" | "declined" | "tentative") {
        return Err("invalid RSVP response".into());
    }
    // Demo dispatch keys off the ACCOUNT (like every other calendar command),
    // not the client-supplied calendar id — a connected Gmail account can
    // never be routed into the fixture overlay.
    let is_demo = { store::active_account(&state.global().lock().unwrap()).provider != "gmail" };
    if is_demo {
        #[cfg(not(feature = "demo-fixtures"))]
        return Err("Connect an account to RSVP.".into());
        #[cfg(feature = "demo-fixtures")]
        {
        let uid = format!("{event_id}@fission.local");
        let mut ev = mail::mock::demo_event_by_uid(&uid).ok_or("event not found")?;
        if !ev.attendees.iter().any(|a| a.self_) {
            return Err("You're not on this event's guest list".into());
        }
        {
            // the demo RSVP overlay is app-wide demo state → global.db
            let db = state.global();
            let conn = db.lock().unwrap();
            let mut overlay: std::collections::HashMap<String, String> =
                store::get_json(&conn, "demo_rsvp").unwrap_or_default();
            overlay.insert(uid, response.clone());
            store::set_json(&conn, "demo_rsvp", &overlay)?;
        }
        for a in ev.attendees.iter_mut() {
            if a.self_ {
                a.response_status = response.clone();
            }
        }
        let _ = app.emit("calendar:updated", Option::<String>::None);
        return Ok(ev);
        }
    }
    let email = active_gmail_cal(&state)?;
    let (bearer, cal) = resolve_calendar(&state, &email, &calendar_id).await?;
    let outcome = mail::calendar::rsvp(&state.http, &bearer, &cal, &event_id, &response).await?;
    match finish_event_write(app, &state, &email, outcome)? {
        EventWriteResult { event: Some(ev), .. } => Ok(ev),
        _ => Err("RSVP did not return the event".into()),
    }
}

/// Resolve an invite's iCalUID to the account's copy of the event: local
/// cache first, then a remote lookup across the calendars (primary first).
/// Copies carrying our own attendee row win — RSVP acts on those.
async fn resolve_invite_event(
    state: &State<'_, AppState>,
    email: &str,
    uid: &str,
) -> Option<CalendarEvent> {
    // Prefer the copy RSVP can act on: our own attendee row on a calendar we
    // can write (the primary), never a read-only shared-calendar copy.
    let pick = |mut rows: Vec<CalendarEvent>| -> Option<CalendarEvent> {
        if rows.is_empty() {
            return None;
        }
        let rank = |e: &CalendarEvent| -> u8 {
            let self_att = e.attendees.iter().any(|a| a.self_);
            let writable = matches!(e.access_role.as_str(), "owner" | "writer");
            match (self_att, writable) {
                (true, true) => 0,
                (true, false) => 1,
                (false, true) => 2,
                (false, false) => 3,
            }
        };
        let best = rows.iter().enumerate().min_by_key(|(_, e)| rank(e))?.0;
        Some(rows.swap_remove(best))
    };
    let miss_key = format!("invite_miss:{email}:{uid}");
    let db = state.account_db(email).ok()?;
    {
        let conn = db.lock().unwrap();
        if let Some(ev) = pick(store::events_by_ical_uid(&conn, email, uid)) {
            return Some(ev);
        }
        // A recent remote sweep found nothing — don't re-scan every calendar
        // on every open of the same thread.
        if let Some(at) = store::get_json::<i64>(&conn, &miss_key) {
            if now_ms() - at < 10 * 60_000 {
                return None;
            }
        }
    }
    let (bearer, mut calendars) = {
        let mut sessions = state.gmail.lock().await;
        let session = sessions.get_mut(email)?;
        let calendars = mail::calendar::list_calendars(&state.http, session).await.ok()?;
        let bearer = session.bearer(&state.http).await.ok()?;
        (bearer, calendars)
    };
    calendars.sort_by_key(|c| !c.primary);
    for cal in &calendars {
        let rows = mail::calendar::events_by_ical_uid(&state.http, &bearer, cal, uid)
            .await
            .unwrap_or_default();
        if let Some(ev) = pick(rows) {
            let conn = db.lock().unwrap();
            let _ = store::upsert_event(&conn, email, &ev);
            return Some(ev);
        }
    }
    {
        let conn = db.lock().unwrap();
        let _ = store::set_json(&conn, &miss_key, &now_ms());
    }
    None
}

/// Detect an invite in a thread (text/calendar part / .ics attachment
/// captured at sync) and resolve it to the account's calendar copy. None =
/// not an invite thread; event: None = unresolved (UI offers the
/// open-in-Google-Calendar fallback).
#[tauri::command]
async fn thread_invite(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Option<ThreadInvite>, String> {
    let Ok((account, db)) = state.thread_db(&thread_id) else {
        return Ok(None);
    };
    let is_gmail = store::get_accounts(&state.global().lock().unwrap())
        .accounts
        .iter()
        .any(|a| a.email == account && a.provider == "gmail");
    let raw = { store::thread_ics(&db.lock().unwrap(), &thread_id) };
    let Some(raw) = raw else { return Ok(None) };
    let Some(parsed) = mail::ics::parse(&raw) else { return Ok(None) };
    if parsed.method != "REQUEST" && parsed.method != "CANCEL" {
        return Ok(None);
    }
    let event = if parsed.method == "CANCEL" {
        None // informational strip only — nothing to RSVP to
    } else if is_gmail {
        resolve_invite_event(&state, &account, &parsed.uid).await
    } else {
        #[cfg(feature = "demo-fixtures")]
        {
            mail::mock::demo_event_by_uid(&parsed.uid).map(|mut ev| {
                apply_demo_rsvps(&state.global().lock().unwrap(), std::slice::from_mut(&mut ev));
                ev
            })
        }
        // Not a gmail account and no fixtures: the invite strip still renders
        // from the parsed .ics, there is just no live event behind it.
        #[cfg(not(feature = "demo-fixtures"))]
        None
    };
    Ok(Some(ThreadInvite {
        method: parsed.method,
        uid: parsed.uid,
        summary: parsed.summary,
        organizer_email: parsed.organizer_email,
        start_ms: parsed.start_ms,
        end_ms: parsed.end_ms,
        all_day: parsed.all_day,
        open_url: parsed.url,
        event,
    }))
}

/// Shared tail of update/RSVP: persist the outcome, repaint, follow with an
/// incremental sync pass.
fn finish_event_write(
    app: AppHandle,
    state: &State<'_, AppState>,
    email: &str,
    outcome: mail::calendar::WriteOutcome,
) -> Result<EventWriteResult, String> {
    use mail::calendar::WriteOutcome;
    let db = state.account_db(email)?;
    match outcome {
        WriteOutcome::Saved(ev) => {
            {
                let conn = db.lock().unwrap();
                store::upsert_event(&conn, email, &ev)?;
            }
            let _ = app.emit("calendar:updated", Option::<String>::None);
            spawn_calendar_sync(app, email.to_string(), true);
            Ok(EventWriteResult { status: "ok".into(), event: Some(ev) })
        }
        WriteOutcome::Conflict(fresh) => {
            // cache the fresh copy — the UI shows it in the conflict prompt
            {
                let conn = db.lock().unwrap();
                store::upsert_event(&conn, email, &fresh)?;
            }
            let _ = app.emit("calendar:updated", Option::<String>::None);
            Ok(EventWriteResult { status: "conflict".into(), event: Some(fresh) })
        }
    }
}

/// The daily Unsplash photo for empty rest states: cached 24h, stale-if-error,
/// hard-capped at 50 API requests/hour locally.
#[tauri::command]
async fn get_daily_photo(state: State<'_, AppState>) -> Result<Option<DailyPhoto>, String> {
    let (cached, key) = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        (
            store::get_json::<unsplash::CachedPhoto>(&conn, unsplash::KV_PHOTO),
            unsplash::access_key(),
        )
    };
    if let Some(c) = &cached {
        if now_ms() - c.photo.fetched_at < unsplash::DAY_MS {
            return Ok(Some(c.photo.clone()));
        }
    }
    let Some(key) = key else {
        return Ok(cached.map(|c| c.photo));
    };
    {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        if !unsplash::take_rate_token(&conn, now_ms()) {
            return Ok(cached.map(|c| c.photo));
        }
    }
    match unsplash::fetch_daily(&state.http, &key, now_ms()).await {
        Ok(photo) => {
            let db = state.global();
            let conn = db.lock().unwrap();
            let _ = store::set_json(
                &conn,
                unsplash::KV_PHOTO,
                &unsplash::CachedPhoto { photo: photo.clone(), download_triggered: false },
            );
            Ok(Some(photo))
        }
        Err(e) => {
            // stale-if-error: yesterday's photo beats an error in a rest state
            eprintln!("[unsplash] fetch failed: {e}");
            Ok(cached.map(|c| c.photo))
        }
    }
}

/// Unsplash guideline: GET links.download_location the first time a photo is
/// actually shown. Fires once per cached photo.
#[tauri::command]
async fn photo_shown(state: State<'_, AppState>) -> Result<(), String> {
    let (cached, key) = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        (
            store::get_json::<unsplash::CachedPhoto>(&conn, unsplash::KV_PHOTO),
            unsplash::access_key(),
        )
    };
    let Some(mut c) = cached else { return Ok(()) };
    if c.download_triggered {
        return Ok(());
    }
    let (Some(loc), Some(key)) = (c.photo.download_location.clone(), key) else {
        return Ok(());
    };
    c.download_triggered = true;
    {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let _ = store::set_json(&conn, unsplash::KV_PHOTO, &c);
    }
    let _ = state
        .http
        .get(&loc)
        .header("Authorization", format!("Client-ID {key}"))
        .header("Accept-Version", "v1")
        .send()
        .await;
    Ok(())
}

/// Offline spell/grammar check of compose text (harper-core). The first call
/// pays the dictionary load, so it runs on the blocking pool.
#[tauri::command]
async fn lint_text(text: String) -> Result<Vec<harper::LintHit>, String> {
    if text.len() > 100_000 {
        return Err("text too long to lint".into());
    }
    tauri::async_runtime::spawn_blocking(move || harper::lint(&text))
        .await
        .map_err(|e| e.to_string())
}

/// BYO Unsplash Access Key: stored in the OS keychain, overrides the baked
/// key; an empty string clears it.
#[tauri::command]
fn set_unsplash_key(key: String) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        secrets::delete(secrets::UNSPLASH_ACCESS_KEY);
        return Ok(());
    }
    if k.len() > 200 {
        return Err("that does not look like an Unsplash Access Key".into());
    }
    secrets::set(secrets::UNSPLASH_ACCESS_KEY, k)
}

/// Recipient autocomplete: ranked contacts matching the typed query — the
/// mail-derived history index merged with the account's Google contacts
/// (People API, synced into people_contacts).
#[tauri::command]
async fn search_contacts(state: State<'_, AppState>, query: String) -> Result<Vec<Contact>, String> {
    if query.len() > 200 {
        return Ok(vec![]);
    }
    let active = state.active_email();
    let db = state.account_db(&active)?;
    let conn = db.lock().unwrap();
    Ok(store::search_contacts(&conn, &active, &query, 8))
}

/// Pull the account's Google contacts (saved / other / directory) and replace
/// the synced slices. Sources fail independently: a missing scope or a
/// consumer account's absent directory skips that source, keeping its
/// previous rows. Returns how many rows are now synced.
async fn people_sync(app: &AppHandle, email: &str) -> Result<i64, String> {
    let state = app.state::<AppState>();
    let db = state.account_db(email)?;
    // Gate on the recorded grant — no contacts scope, no People calls.
    let granted: Option<String> = {
        let conn = db.lock().unwrap();
        store::get_json(&conn, &format!("granted_scopes:{email}"))
    };
    let has = |s: &str| granted.as_deref().map(|g| scope_granted(g, s)).unwrap_or(false);
    let saved_ok = has("https://www.googleapis.com/auth/contacts.readonly");
    let other_ok = has("https://www.googleapis.com/auth/contacts.other.readonly");
    let dir_ok = has("https://www.googleapis.com/auth/directory.readonly");
    if !saved_ok && !other_ok {
        return Err("Contacts access wasn't granted — reconnect Gmail in Settings → Account".into());
    }

    let mut results: Vec<(&str, Vec<mail::people::PersonRow>)> = vec![];
    {
        let mut sessions = state.gmail.lock().await;
        let session = sessions
            .get_mut(email)
            .ok_or("account not connected — reconnect Gmail")?;
        if saved_ok {
            match mail::people::fetch_contacts(&state.http, session).await {
                Ok(rows) => results.push(("contact", rows)),
                Err(e) => eprintln!("[people:{email}] contacts: {e}"),
            }
        }
        if other_ok {
            match mail::people::fetch_other_contacts(&state.http, session).await {
                Ok(rows) => results.push(("other", rows)),
                Err(e) => eprintln!("[people:{email}] other: {e}"),
            }
        }
        if dir_ok {
            // Consumer accounts have no directory — skip quietly on any error.
            if let Ok(rows) = mail::people::fetch_directory(&state.http, session).await {
                results.push(("directory", rows));
            }
        }
    }
    if results.is_empty() {
        return Err("could not reach Google Contacts — check that the People API is enabled".into());
    }
    let mut total = 0i64;
    {
        let conn = db.lock().unwrap();
        for (source, rows) in &results {
            let tuples: Vec<(String, String, Option<String>)> = rows
                .iter()
                .map(|r| (r.email.clone(), r.name.clone(), r.photo_url.clone()))
                .collect();
            store::replace_people(&conn, email, source, &tuples, now_ms())?;
            total += tuples.len() as i64;
        }
        let _ = store::set_json(&conn, &format!("people_synced:{email}"), &now_ms());
    }
    Ok(total)
}

/// Fire-and-forget people sync (connect time + the daily background refresh).
fn spawn_people_sync(app: AppHandle, email: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = people_sync(&app, &email).await {
            eprintln!("[people:{email}] sync skipped: {e}");
            classify_sync_error(&app, &email, &e).await;
        }
    });
}

/// Settings → Account "Refresh contacts": a synchronous people sync for the
/// active account; returns the synced row count for the toast.
#[tauri::command]
async fn refresh_contacts(app: AppHandle, state: State<'_, AppState>) -> Result<i64, String> {
    let active = { store::active_account(&state.global().lock().unwrap()) };
    if active.provider != "gmail" {
        return Err("Connect a Gmail account to sync Google contacts".into());
    }
    people_sync(&app, &active.email).await
}

// ---------------------------------------------------------------- send-as

/// Fetch the account's Gmail send-as aliases (read-only; gmail.settings.basic)
/// and persist them to kv `sendas:{email}`.
async fn sendas_fetch(app: &AppHandle, email: &str) -> Result<Vec<SendAsAlias>, String> {
    let state = app.state::<AppState>();
    let db = state.account_db(email)?;
    let granted: Option<String> = {
        let conn = db.lock().unwrap();
        store::get_json(&conn, &format!("granted_scopes:{email}"))
    };
    let ok = granted
        .as_deref()
        .map(|g| scope_granted(g, "https://www.googleapis.com/auth/gmail.settings.basic"))
        .unwrap_or(false);
    if !ok {
        return Err("Send-as access wasn't granted — reconnect Gmail in Settings → Account".into());
    }
    let v = {
        let mut sessions = state.gmail.lock().await;
        let session = sessions
            .get_mut(email)
            .ok_or("account not connected — reconnect Gmail")?;
        session
            .get_json(
                &state.http,
                "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs",
            )
            .await
            .map_err(|e| mail::classify_google_error(&e, "Gmail API", "Send-as"))?
    };
    let empty = vec![];
    let aliases: Vec<SendAsAlias> = v["sendAs"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .filter_map(|a| {
            let addr = a["sendAsEmail"].as_str()?;
            let primary = a["isPrimary"].as_bool().unwrap_or(false);
            Some(SendAsAlias {
                email: addr.to_string(),
                display_name: a["displayName"].as_str().unwrap_or("").to_string(),
                is_default: a["isDefault"].as_bool().unwrap_or(false),
                verified: primary
                    || a["verificationStatus"].as_str() == Some("accepted"),
                has_signature: a["signature"]
                    .as_str()
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false),
            })
        })
        .collect();
    {
        let conn = db.lock().unwrap();
        let _ = store::set_json(&conn, &format!("sendas:{email}"), &aliases);
    }
    Ok(aliases)
}

/// Fire-and-forget send-as fetch (connect time).
fn spawn_sendas_fetch(app: AppHandle, email: String) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sendas_fetch(&app, &email).await {
            eprintln!("[sendas:{email}] fetch skipped: {e}");
            classify_sync_error(&app, &email, &e).await;
        }
    });
}

/// The account's send-as aliases: the kv cache, refreshed on demand when
/// it's empty and the grant allows.
#[tauri::command]
async fn get_send_as(app: AppHandle, state: State<'_, AppState>, email: String) -> Result<Vec<SendAsAlias>, String> {
    let cached: Option<Vec<SendAsAlias>> = {
        let db = state.account_db(&email)?;
        let conn = db.lock().unwrap();
        store::get_json(&conn, &format!("sendas:{email}"))
    };
    if let Some(aliases) = cached {
        return Ok(aliases);
    }
    let is_gmail = {
        store::get_accounts(&state.global().lock().unwrap())
            .accounts
            .iter()
            .any(|a| a.email == email && a.provider == "gmail")
    };
    if !is_gmail {
        return Ok(vec![]);
    }
    sendas_fetch(&app, &email).await.or(Ok(vec![]))
}

#[tauri::command]
async fn get_profile(state: State<'_, AppState>, email: String) -> Result<Option<ProfileInfo>, String> {
    let db = state.account_db(&email)?;
    let conn = db.lock().unwrap();
    Ok(store::get_json(&conn, &format!("profile:{email}")))
}

/// Override (or clear) the header photo. Accepts a data: URI.
#[tauri::command]
async fn set_profile_photo(
    state: State<'_, AppState>,
    email: String,
    picture: Option<String>,
) -> Result<(), String> {
    if let Some(p) = &picture {
        if !p.starts_with("data:image/") || p.len() > 2_000_000 {
            return Err("that does not look like a reasonable image".into());
        }
    }
    let db = state.account_db(&email)?;
    let conn = db.lock().unwrap();
    let key = format!("profile:{email}");
    let mut prof: ProfileInfo = store::get_json(&conn, &key).unwrap_or_default();
    prof.picture = picture;
    store::set_json(&conn, &key, &prof)
}

/// New-mail notifications: anything unread that landed in an inbox after the
/// watermark. Skipped while the window is focused or when disabled.
fn notify_new_mail(app: &AppHandle, since_ms: i64) {
    let state = app.state::<AppState>();
    let (enabled, emails) = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let settings = store::get_settings(&conn);
        let emails: Vec<String> =
            store::get_accounts(&conn).accounts.iter().map(|a| a.email.clone()).collect();
        (settings.notifications, emails)
    };
    // notifications span every account: fan out over the per-account files
    let mut rows: Vec<(i64, String, String)> = vec![];
    if enabled {
        for email in &emails {
            let Ok(db) = state.account_db(email) else { continue };
            let conn = db.lock().unwrap();
            let per: Vec<(i64, String, String)> = conn
                .prepare(
                    "SELECT last_date, participants, subject FROM threads
                     WHERE unread = 1 AND in_inbox = 1 AND hidden IS NULL AND last_date > ?1
                     ORDER BY last_date DESC LIMIT 4",
                )
                .and_then(|mut st| {
                    st.query_map([since_ms], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                        .map(|it| it.filter_map(|r| r.ok()).collect())
                })
                .unwrap_or_default();
            rows.extend(per);
        }
    }
    rows.sort_by_key(|(d, _, _)| -d);
    rows.truncate(4);
    let rows: Vec<(String, String)> = rows.into_iter().map(|(_, p, s)| (p, s)).collect();
    if !enabled || rows.is_empty() {
        return;
    }
    let focused = app
        .get_webview_window("main")
        .map(|w| w.is_focused().unwrap_or(false))
        .unwrap_or(false);
    if focused {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    for (participants, subject) in rows.iter().take(3) {
        let sender = serde_json::from_str::<Vec<String>>(participants)
            .ok()
            .and_then(|p| p.last().cloned())
            .unwrap_or_default();
        let sender = sender.split('<').next().unwrap_or("New mail").trim().to_string();
        let _ = app
            .notification()
            .builder()
            .title(if sender.is_empty() { "New mail" } else { &sender })
            .body(subject)
            .show();
    }
    if rows.len() > 3 {
        let _ = app
            .notification()
            .builder()
            .title("Snail Mail")
            .body("…and more new mail")
            .show();
    }
}

/// Download-progress payload for the "Downloading mail history… N%" indicator.
/// `indexed` = threads stored locally, `total` = Gmail's threadsTotal, `done` =
/// every connected account's history crawl has finished. Field names are single
/// words, so they serialize identically for the TS `SyncProgress`.
#[derive(Clone, serde::Serialize)]
struct SyncProgress {
    indexed: i64,
    total: i64,
    done: bool,
}

/// Emit `sync:progress` with the aggregate download state across connected Gmail
/// accounts. Cheap (a COUNT + a couple kv reads per account) — safe to call from
/// each reconcile stream beat and crawl beat. The UI hides the bar when
/// `done`, or when `total` is 0 (threadsTotal not yet known / demo desktop).
fn emit_sync_progress(app: &AppHandle) {
    let state = app.state::<AppState>();
    let gmail: Vec<String> = store::get_accounts(&state.global().lock().unwrap())
        .accounts
        .iter()
        .filter(|a| a.provider == "gmail")
        .map(|a| a.email.clone())
        .collect();
    let (mut indexed, mut total, mut all_done, mut any) = (0i64, 0i64, true, false);
    for email in &gmail {
        let Ok(db) = state.account_db(email) else { continue };
        let conn = db.lock().unwrap();
        any = true;
        // Numerator and denominator must describe the SAME population or the
        // percentage can never reach 100. Both are now the crawl's population:
        // non-hidden local threads, against threadsTotal minus spam/trash/draft.
        // (Demo threads need no exclusion — this loop is gmail-only and, since
        // the per-account split, a gmail file cannot hold mock rows.)
        indexed += store::count_threads_visible(&conn, email);
        let cur: mail::sync::CrawlCursor =
            store::get_json(&conn, &format!("crawl:{email}")).unwrap_or_default();
        // The crawl's own enumeration is ground truth for how many threads
        // exist in that population; Gmail's (adjusted) threadsTotal is only an
        // estimate. Taking the larger keeps a low estimate from parking the bar
        // just short of done.
        let estimate = store::get_json::<i64>(&conn, &format!("threads_total:{email}")).unwrap_or(0);
        total += estimate.max(cur.listed as i64);
        all_done &= cur.done;
    }
    let done = any && all_done;
    let _ = app.emit("sync:progress", SyncProgress { indexed, total, done });
}

// ------------------------------------------------------------ sync:activity
//
// The live "Downloading 17 of 30…" counter. sync.rs ticks once per thread
// fetched (one Gmail round-trip each); everything about how often that reaches
// the webview is decided here.

/// Minimum gap between `sync:activity` emits — ~4/s. A reconcile can fetch
/// hundreds of threads and the pill only needs to look alive.
const ACTIVITY_MIN_GAP_MS: u128 = 250;
/// How often a tick also triggers a repaint (`mail:updated` + `sync:progress`).
/// Matches the old STREAM_EVERY that used to live in fetch_streaming, so the
/// per-item ticking below costs no extra list refreshes or COUNT(*) beats.
const REPAINT_EVERY: usize = 25;

/// Per-pass coalescing for `sync:activity`. The callback is a `Fn`, so the
/// last-emit timestamp lives in an atomic rather than `&mut`.
struct ActivityGate {
    last_ms: std::sync::atomic::AtomicU64,
}

impl ActivityGate {
    fn new() -> Self {
        Self { last_ms: std::sync::atomic::AtomicU64::new(0) }
    }

    /// Should this tick be emitted? Terminal ticks (`done == total`) always
    /// pass: swallowing one would leave the pill frozen mid-count with no
    /// completion to fade on. `total == 0` counts as terminal — an empty pass
    /// still has to clear any pill left over from the previous one.
    fn allows(&self, tick: &mail::sync::SyncTick) -> bool {
        if tick.total == 0 || tick.done >= tick.total {
            self.last_ms.store(now_ms() as u64, Ordering::SeqCst);
            return true;
        }
        let now = now_ms() as u64;
        let last = self.last_ms.load(Ordering::SeqCst);
        if (now as u128).saturating_sub(last as u128) < ACTIVITY_MIN_GAP_MS {
            return false;
        }
        self.last_ms.store(now, Ordering::SeqCst);
        true
    }
}

/// Emit one `sync:activity` beat and park it for `get_sync_activity`. The
/// parked value is cleared on the terminal tick so a late subscriber is never
/// told a finished pass is still running.
fn emit_sync_activity(app: &AppHandle, tick: mail::sync::SyncTick) {
    let finished = tick.total == 0 || tick.done >= tick.total;
    {
        let state = app.state::<AppState>();
        let mut slot = state.activity.lock().unwrap();
        *slot = if finished { None } else { Some(tick.clone()) };
    }
    let _ = app.emit("sync:activity", tick);
}

/// Build the progress callback every fetching path shares: activity ticks at
/// ~4/s, repaints every REPAINT_EVERY threads (and at the end of each pass).
/// Returned as an owned closure so each pass gets its own gate.
fn progress_callback(app: AppHandle) -> impl Fn(mail::sync::SyncTick) + Send + Sync {
    let gate = ActivityGate::new();
    move |tick: mail::sync::SyncTick| {
        let repaint = tick.done % REPAINT_EVERY == 0 || tick.done >= tick.total;
        if gate.allows(&tick) {
            emit_sync_activity(&app, tick);
        }
        if repaint {
            emit_mail_updated(&app);
            emit_sync_progress(&app);
        }
    }
}

/// Pull the in-flight download pass, if any. Lets a UI that mounts mid-pass
/// (onboarding's first sync, a reopened window) show the counter immediately
/// instead of waiting for the next beat — or missing the pass entirely.
#[tauri::command]
fn get_sync_activity(state: State<'_, AppState>) -> Option<mail::sync::SyncTick> {
    state.activity.lock().unwrap().clone()
}

/// Google answered `invalid_grant`: the refresh token is expired or revoked
/// server-side, so every future refresh will fail identically — retrying on
/// the 30s cadence is pointless and, worse, silent.
fn is_auth_revoked(err: &str) -> bool {
    err.contains("invalid_grant")
}

/// Inside a sessions-iteration loop: does this error mean the grant is dead?
/// `invalid_grant` answers directly; a bare 401 (bearer-style calls have no
/// internal retry) probes ONE forced refresh — a dead grant turns it into a
/// classifiable `invalid_grant` in seconds instead of at token expiry. Takes
/// the session directly because callers already hold the map borrow.
async fn is_grant_dead(http: &reqwest::Client, session: &mut GmailSession, err: &str) -> bool {
    if is_auth_revoked(err) {
        return true;
    }
    if err.contains("401") {
        session.invalidate_access_token();
        if let Err(probe) = session.bearer(http).await {
            return is_auth_revoked(&probe);
        }
    }
    false
}

/// Classify a sync-surface failure from a path that does NOT already hold
/// the gmail sessions map (calendar, people, send-as, crawl, outbox). On a
/// dead grant: drop the session and flip the account to disconnected.
/// Returns true when auth was lost.
async fn classify_sync_error(app: &AppHandle, email: &str, err: &str) -> bool {
    let state = app.state::<AppState>();
    let dead = {
        let mut sessions = state.gmail.lock().await;
        match sessions.get_mut(email) {
            Some(session) => is_grant_dead(&state.http, session, err).await,
            // no session at all: only classify what the error itself proves
            None => is_auth_revoked(err),
        }
    };
    if dead {
        state.gmail.lock().await.remove(email);
        mark_auth_lost(app, email);
    }
    dead
}

/// Surface a dead grant instead of hiding it: flag the account (Settings
/// shows the amber dot) and tell the user once. The caller drops the session,
/// which stops the retry loop; a boot rebuilds one from the keychain, fails
/// once, and lands back here — but the notice only fires on the true→false
/// flip, so it never nags.
fn mark_auth_lost(app: &AppHandle, email: &str) {
    let state = app.state::<AppState>();
    let flipped = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let mut accounts = store::get_accounts(&conn);
        let mut flipped = false;
        for a in accounts.accounts.iter_mut() {
            if a.email == email && a.connected {
                a.connected = false;
                flipped = true;
            }
        }
        if flipped {
            let _ = store::save_accounts(&conn, &accounts);
        }
        flipped
    };
    if flipped {
        // push the flip so the banner/dot/settings react NOW — the accounts
        // list is otherwise pull-only and a running app never re-reads it
        let accounts = { store::get_accounts(&state.global().lock().unwrap()) };
        let _ = app.emit("accounts:updated", &accounts);
        let _ = app.emit(
            "app:notice",
            format!(
                "Google sign-in for {email} expired or was revoked — reconnect it in Settings → Account."
            ),
        );
    }
}

fn sync_in_background(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        // The inbox streams in live as reconcile fetches it (and the download
        // bar climbs) rather than appearing all-at-once when sync finishes.
        let on_progress = progress_callback(app.clone());
        let mut changed = false;
        let mut lost: Vec<String> = vec![];
        let mut sessions = state.gmail.lock().await;
        for (email, session) in sessions.iter_mut() {
            let Ok(db) = state.account_db(email) else { continue };
            match mail::sync::full_sync(
                &state.http,
                session,
                &db,
                email,
                false,
                mail::sync::SyncPass::Normal,
                &on_progress,
            )
            .await
            {
                Ok(c) => changed |= c,
                Err(e) => {
                    eprintln!("[sync:{email}] {e}");
                    if is_grant_dead(&state.http, session, &e).await {
                        lost.push(email.clone());
                    }
                }
            }
        }
        for email in &lost {
            sessions.remove(email);
        }
        drop(sessions);
        for email in &lost {
            mark_auth_lost(&app, email);
        }
        if changed {
            emit_mail_updated(&app);
        }
        emit_sync_progress(&app);
    });
}

/// Ready → clone; Idle/stale-Failed → load (blocking thread; the first run
/// downloads the model); fresh-Failed → None (backoff). Holding the slot
/// lock across the load also serializes concurrent init attempts.
async fn ensure_local_embedder(state: &AppState) -> Option<embed::SharedModel> {
    let mut slot = state.embedder.lock().await;
    match &*slot {
        embed::Slot::Ready(m) => Some(m.clone()),
        embed::Slot::Failed { at_ms } if now_ms() - at_ms < embed::RETRY_AFTER_MS => None,
        _ => {
            let dir = state.data_dir.join("models");
            match tauri::async_runtime::spawn_blocking(move || embed::load_local(dir)).await {
                Ok(Ok(m)) => {
                    let m: embed::SharedModel = Arc::new(std::sync::Mutex::new(m));
                    *slot = embed::Slot::Ready(m.clone());
                    eprintln!("[embed] local model ready");
                    Some(m)
                }
                other => {
                    let err = match other {
                        Ok(Err(e)) => e,
                        Err(e) => e.to_string(),
                        Ok(Ok(_)) => unreachable!(),
                    };
                    eprintln!("[embed] local model unavailable: {err}");
                    *slot = embed::Slot::Failed { at_ms: now_ms() };
                    None
                }
            }
        }
    }
}

/// One history-crawl beat (a single listing page per account), spawned off
/// the sync loop so a throttled beat never delays the 30s sync cadence. No
/// mail:updated is emitted — the crawl surfaces old mail, and search reads
/// the DB directly on the next keystroke. The same beat then embeds a slice
/// of whatever the crawl/sync landed (semantic indexing shares the
/// busy-guard, so beats never stack).
fn spawn_history_crawl(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if state
            .crawl_busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let emails: Vec<String> = {
            store::get_accounts(&state.global().lock().unwrap())
                .accounts
                .iter()
                .filter(|a| a.provider == "gmail")
                .map(|a| a.email.clone())
                .collect()
        };
        for email in emails {
            let Ok(db) = state.account_db(&email) else { continue };
            // Only crawl once the account's first reconcile stored its
            // baseline — never race the initial backfill for the same threads.
            let ready = {
                let conn = db.lock().unwrap();
                store::get_json::<String>(&conn, &format!("history:{email}")).is_some()
            };
            if !ready {
                continue;
            }
            // The crawl reports its page as a pass ("17 of 100") — it was
            // stderr-only before. Repaints stay off: the crawl surfaces old
            // mail that no open list is showing.
            let on_progress = {
                let app = app.clone();
                let gate = ActivityGate::new();
                move |tick: mail::sync::SyncTick| {
                    if gate.allows(&tick) {
                        emit_sync_activity(&app, tick);
                    }
                }
            };
            match mail::sync::crawl_step(&state.http, &state.gmail, &db, &email, &on_progress).await
            {
                // steady state after the walk finishes: nothing to report
                Ok(b) if b.done && b.fetched == 0 && b.skipped == 0 && b.failed == 0 => {}
                Ok(b) => eprintln!(
                    "[crawl:{email}] +{} indexed, {} already local, {} deferred — {} crawled total{}",
                    b.fetched,
                    b.skipped,
                    b.failed,
                    b.total_indexed,
                    if b.done { "; full history indexed" } else { "" }
                ),
                Err(e) => {
                    eprintln!("[crawl:{email}] {e}");
                    classify_sync_error(&app, &email, &e).await;
                }
            }
            // Semantic indexing: embed whatever the crawl/sync landed. Local
            // model by default; the optional remote provider when configured.
            let embeddings_mode = {
                let db = state.global();
            let conn = db.lock().unwrap();
                store::get_settings(&conn).embeddings
            };
            if embeddings_mode == "openai" {
                let remote = {
                    let db = state.global();
            let conn = db.lock().unwrap();
                    ai::resolve(&store::get_settings(&conn), Some("openai")).ok()
                };
                if let Some(p) = remote {
                    match mail::sync::embed_step_remote(&state.http, &db, &email, &p.base_url, &p.key).await {
                        Ok(b) if b.embedded > 0 => eprintln!("[embed:{email}] +{} embedded (remote), {} to go", b.embedded, b.remaining),
                        Ok(_) => {}
                        Err(e) => eprintln!("[embed:{email}] {e}"),
                    }
                }
            } else if let Some(m) = ensure_local_embedder(&state).await {
                let db = db.clone();
                let email2 = email.clone();
                let beat = tauri::async_runtime::spawn_blocking(move || {
                    mail::sync::embed_step(&db, &email2, embed::LOCAL_TAG, &|texts| {
                        embed::embed_passages(&m, texts)
                    })
                })
                .await;
                match beat {
                    Ok(Ok(b)) if b.embedded > 0 => eprintln!("[embed:{email}] +{} embedded, {} to go", b.embedded, b.remaining),
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => eprintln!("[embed:{email}] {e}"),
                    Err(e) => eprintln!("[embed:{email}] task: {e}"),
                }
            }
        }
        // The crawl just advanced (or confirmed done) — refresh the download
        // indicator so it climbs each beat and hides when the walk finishes.
        emit_sync_progress(&app);
        state.crawl_busy.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    for email in state.dbs.registered_emails() {
        if let Ok(db) = state.account_db(&email) {
            let conn = db.lock().unwrap();
            store::wake_due_snoozes(&conn, now_ms())?;
        }
    }
    let on_progress = progress_callback(app.clone());
    // Per-account: one failing account no longer aborts the loop and strands
    // every account after it; dead grants classify instead of just erroring.
    let mut first_err: Option<String> = None;
    let mut lost: Vec<String> = vec![];
    let mut sessions = state.gmail.lock().await;
    for (email, session) in sessions.iter_mut() {
        let db = state.account_db(email)?;
        if let Err(e) = mail::sync::full_sync(
            &state.http,
            session,
            &db,
            email,
            false,
            mail::sync::SyncPass::Normal,
            &on_progress,
        )
        .await
        {
            eprintln!("[sync-now:{email}] {e}");
            if is_grant_dead(&state.http, session, &e).await {
                lost.push(email.clone());
            }
            first_err.get_or_insert(e);
        }
    }
    for email in &lost {
        sessions.remove(email);
    }
    drop(sessions);
    for email in &lost {
        mark_auth_lost(&app, email);
    }
    emit_mail_updated(&app);
    emit_sync_progress(&app);
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Repair: forget the incremental baseline and per-thread historyIds, then
/// resync — the reconcile pass then refetches and re-parses every listed thread,
/// healing messages an older build froze with missing HTML / empty bodies.
/// Local-only state (snoozes, read/hidden flags) is preserved.
#[tauri::command]
async fn resync_account(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let emails: Vec<String> = state.gmail.lock().await.keys().cloned().collect();
    if emails.is_empty() {
        return Ok(()); // demo mode: nothing to resync
    }
    for email in &emails {
        let db = state.account_db(email)?;
        let conn = db.lock().unwrap();
        conn.execute("DELETE FROM kv WHERE key = ?1", [format!("history:{email}")]).ok();
        // Drop the crawl cursor too. `CrawlCursor.done` is terminal and nothing
        // else ever cleared it — so Repair Mail re-downloaded the entire
        // mailbox with the progress footer permanently suppressed, which is
        // exactly when a user most wants to see it.
        conn.execute("DELETE FROM kv WHERE key = ?1", [format!("crawl:{email}")]).ok();
        store::reset_history(&conn, email)?;
    }
    let on_progress = progress_callback(app.clone());
    let mut first_err: Option<String> = None;
    let mut lost: Vec<String> = vec![];
    let mut sessions = state.gmail.lock().await;
    for (email, session) in sessions.iter_mut() {
        // force a full reconcile — every thread re-parsed, bodies healed
        let db = state.account_db(email)?;
        if let Err(e) = mail::sync::full_sync(
            &state.http,
            session,
            &db,
            email,
            true,
            mail::sync::SyncPass::Resync,
            &on_progress,
        )
        .await
        {
            eprintln!("[resync:{email}] {e}");
            if is_grant_dead(&state.http, session, &e).await {
                lost.push(email.clone());
            }
            first_err.get_or_insert(e);
        }
    }
    for email in &lost {
        sessions.remove(email);
    }
    drop(sessions);
    for email in &lost {
        mark_auth_lost(&app, email);
    }
    emit_mail_updated(&app);
    emit_sync_progress(&app);
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------- reading

#[tauri::command]
async fn list_threads(state: State<'_, AppState>, view: String) -> Result<Vec<Thread>, String> {
    let active = state.active_email();
    let db = state.account_db(&active)?;
    // "label:<name>" scopes the list to one label; everything else is a
    // fixed view.
    if let Some(label) = view.strip_prefix("label:") {
        if label.is_empty() || label.len() > 100 {
            return Err("invalid label".into());
        }
        let conn = db.lock().unwrap();
        return store::list_threads_by_label(&conn, label, &active);
    }
    if !matches!(view.as_str(), "inbox" | "done" | "reminders" | "starred" | "trash") {
        return Err("invalid view".into());
    }
    let conn = db.lock().unwrap();
    store::list_threads(&conn, &view, &active)
}

#[tauri::command]
async fn get_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<Message>, String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    let mut msgs = {
        let conn = db.lock().unwrap();
        let msgs = store::get_messages(&conn, &thread_id)?;
        store::set_unread(&conn, &thread_id, false)?;
        msgs
    };

    // First paint is instant: sanitize using ONLY inline images already cached
    // locally (no network). Raw bodies never reach the UI. The Gmail UNREAD
    // removal and any un-cached inline-image fetches run in the background
    // (spawn_thread_backfill), which re-emits so images fill in progressively.
    for m in msgs.iter_mut() {
        let Some(html) = m.body_html.clone() else { continue };
        let cid_map = cached_cid_map(&db, &m.id, &html);
        m.body_html = Some(mail::render::sanitize_email_html(&html, &cid_map));
    }
    spawn_thread_backfill(app, thread_id, Some(account));
    Ok(msgs)
}

/// Build the cid→data: map for a message body from ALREADY-CACHED inline-image
/// bytes only — no network, so the first paint of a thread is instant.
fn cached_cid_map(db: &Mutex<Connection>, message_id: &str, html: &str) -> HashMap<String, String> {
    use base64::Engine;
    let mut cid_map = HashMap::new();
    let inline = {
        let conn = db.lock().unwrap();
        store::inline_cids(&conn, message_id)
    };
    for (att_id, content_id, mime, _remote, has_data) in inline {
        if !has_data || !html.contains(&format!("cid:{content_id}")) {
            continue;
        }
        let bytes = {
            let conn = db.lock().unwrap();
            store::attachment_data(&conn, &att_id)
        };
        if let Some(bytes) = bytes {
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            cid_map.insert(content_id, format!("data:{mime};base64,{b64}"));
        }
    }
    cid_map
}

/// Background work for an opened thread: drop Gmail's UNREAD label and fetch any
/// inline `cid:` images not yet cached (persisting them), then emit `thread:images`
/// so the reading pane re-reads with images resolved. Keeps opening a thread from
/// blocking on a Gmail round-trip or the sync-held gmail mutex.
fn spawn_thread_backfill(app: AppHandle, thread_id: String, account: Option<String>) {
    if is_mock_id(&thread_id) {
        return;
    }
    let Some(account) = account else { return };
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Ok(db) = state.account_db(&account) else { return };
        // 1. clear UNREAD on the server (best-effort; local already cleared)
        {
            let mut sessions = state.gmail.lock().await;
            if let Some(s) = sessions.get_mut(&account) {
                let _ = s.modify_thread(&state.http, &thread_id, &[], &["UNREAD"]).await;
            }
        }
        // 2. fetch inline images still missing their bytes
        let msgs = {
            let conn = db.lock().unwrap();
            store::get_messages(&conn, &thread_id).unwrap_or_default()
        };
        let mut fetched_any = false;
        for m in &msgs {
            let Some(html) = &m.body_html else { continue };
            let inline = {
                let conn = db.lock().unwrap();
                store::inline_cids(&conn, &m.id)
            };
            for (att_id, content_id, _mime, remote_id, has_data) in inline {
                if has_data || !html.contains(&format!("cid:{content_id}")) {
                    continue;
                }
                let Some(remote) = remote_id else { continue };
                let bytes = {
                    let mut sessions = state.gmail.lock().await;
                    match sessions.get_mut(&account) {
                        Some(s) => s.get_attachment_bytes(&state.http, &m.id, &remote).await,
                        None => Err("no session".to_string()),
                    }
                };
                if let Ok(b) = bytes {
                    if b.len() <= 2_000_000 {
                        let conn = db.lock().unwrap();
                        let _ = store::set_attachment_data(&conn, &att_id, &b);
                        fetched_any = true;
                    }
                }
            }
        }
        if fetched_any {
            let _ = app.emit("thread:images", thread_id);
        }
    });
}

/// Heal messages persisted with an empty body (body_text='' AND body_html IS
/// NULL) — e.g. a large HTML body that lived behind body.attachmentId on first
/// sync, or a row an older build froze. Refetches the thread (hydrating
/// attachment-hosted bodies) so upsert re-parses and fills it, then returns the
/// freshly sanitized messages. No network for mock threads or when nothing is
/// blank. The frontend calls this only when it sees a blank card, and applies
/// the result only if the user is still on the thread. (BUG 5 empty-body)
#[tauri::command]
async fn refetch_message_body(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<Message>, String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    let has_empty = {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE thread_id = ?1 AND body_text = '' AND body_html IS NULL)",
            [thread_id.as_str()],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n != 0)
        .unwrap_or(false)
    };
    if has_empty && !is_mock_id(&thread_id) {
        let mut sessions = state.gmail.lock().await;
        if let Some(sess) = sessions.get_mut(&account) {
            let _ = mail::sync::refetch_thread(&state.http, sess, &db, &account, &thread_id).await;
        }
    }
    let mut msgs = {
        let conn = db.lock().unwrap();
        store::get_messages(&conn, &thread_id)?
    };
    for m in msgs.iter_mut() {
        let Some(html) = m.body_html.clone() else { continue };
        let cid_map = cached_cid_map(&db, &m.id, &html);
        m.body_html = Some(mail::render::sanitize_email_html(&html, &cid_map));
    }
    Ok(msgs)
}

// ---------------------------------------------------------------- attachments

/// Attachment bytes from cache, demo fixture text, or Gmail (cached after).
/// Bare attachment ids carry no account, so probe the active account's file
/// first, then the rest of the registry.
async fn attachment_bytes(
    state: &State<'_, AppState>,
    attachment_id: &str,
) -> Result<(store::AttachmentRow, Vec<u8>), String> {
    let (row, account, db) = {
        let active = state.active_email();
        let mut emails = vec![];
        if !active.is_empty() {
            emails.push(active.clone());
        }
        for e in state.dbs.registered_emails() {
            if e != active {
                emails.push(e);
            }
        }
        let mut found = None;
        for email in emails {
            let db = state.account_db(&email)?;
            let hit = { store::get_attachment(&db.lock().unwrap(), attachment_id) };
            if let Some(row) = hit {
                // the true owner comes from the row's thread, not probe order
                // (during migration the legacy conn serves several accounts)
                let owner: Option<String> = {
                    let conn = db.lock().unwrap();
                    conn.query_row(
                        "SELECT account_id FROM threads WHERE id = (SELECT thread_id FROM messages WHERE id = ?1)",
                        [row.message_id.as_str()],
                        |r| r.get(0),
                    )
                    .ok()
                };
                found = Some((row, owner.unwrap_or(email), db));
                break;
            }
        }
        found.ok_or("unknown attachment")?
    };
    if let Some(data) = row.data.clone() {
        return Ok((row, data));
    }
    let fixture_text: Option<String> = {
        let conn = db.lock().unwrap();
        conn.query_row(
            "SELECT text_content FROM attachments WHERE id = ?1",
            [attachment_id],
            |r| r.get(0),
        )
        .ok()
        .flatten()
    };
    if row.remote_id.is_none() {
        if let Some(t) = fixture_text {
            return Ok((row, t.into_bytes()));
        }
        return Err("this demo attachment has no file contents".into());
    }
    let remote = row.remote_id.clone().unwrap();
    let mut sessions = state.gmail.lock().await;
    let s = sessions
        .get_mut(&account)
        .ok_or("account not connected — reconnect Gmail to download")?;
    let bytes = s.get_attachment_bytes(&state.http, &row.message_id, &remote).await?;
    if bytes.len() <= 25_000_000 {
        let conn = db.lock().unwrap();
        let _ = store::set_attachment_data(&conn, attachment_id, &bytes);
    }
    Ok((row, bytes))
}

/// Save an attachment via the OS file dialog. None = user cancelled.
#[tauri::command]
async fn download_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    attachment_id: String,
) -> Result<Option<String>, String> {
    valid_id(&attachment_id)?;
    let (row, bytes) = attachment_bytes(&state, &attachment_id).await?;
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_file_name(&row.filename).blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| format!("could not write the file: {e}"))?;
    Ok(Some(path.display().to_string()))
}

/// Open an attachment with its default app (written to the app cache first).
#[tauri::command]
async fn open_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    attachment_id: String,
) -> Result<(), String> {
    valid_id(&attachment_id)?;
    let (row, bytes) = attachment_bytes(&state, &attachment_id).await?;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(safe_attachment_name(&row.filename));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    tauri_plugin_opener::open_path(&path, None::<String>)
        .map_err(|_| "could not open the attachment".to_string())
}

// ---------------------------------------------------------------- drive

/// The active account's email if it's a connected Gmail account, else a
/// friendly error — every Drive command starts here.
fn active_gmail(state: &State<'_, AppState>) -> Result<String, String> {
    let active = { store::active_account(&state.global().lock().unwrap()) };
    if active.provider != "gmail" {
        return Err("Connect a Gmail account to use Google Drive".into());
    }
    Ok(active.email)
}

#[tauri::command]
async fn drive_search(
    state: State<'_, AppState>,
    query: String,
    page_token: Option<String>,
) -> Result<DriveSearchPage, String> {
    if query.len() > 200 {
        return Err("query too long".into());
    }
    let email = active_gmail(&state)?;
    let mut sessions = state.gmail.lock().await;
    let session = sessions
        .get_mut(&email)
        .ok_or("account not connected — reconnect Gmail")?;
    let (files, next_page_token) =
        mail::drive::search(&state.http, session, &query, page_token.as_deref()).await?;
    Ok(DriveSearchPage { files, next_page_token })
}

/// "Attach as copy": Drive file bytes → a normal outgoing attachment.
#[tauri::command]
async fn drive_download_attach(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<MailAttachment, String> {
    valid_id(&file_id)?;
    let email = active_gmail(&state)?;
    let mut sessions = state.gmail.lock().await;
    let session = sessions
        .get_mut(&email)
        .ok_or("account not connected — reconnect Gmail")?;
    mail::drive::download(&state.http, session, &file_id).await
}

/// The account's "Snail Mail Attachments" folder id (a pre-rename "Fission
/// Mail Attachments" folder keeps being found and used), kv-cached and
/// re-created if the cached one was deleted.
async fn drive_app_folder(
    state: &State<'_, AppState>,
    email: &str,
    session: &mut GmailSession,
) -> Result<String, String> {
    let kv_key = format!("drive_folder:{email}");
    let db = state.account_db(email)?;
    let cached: Option<String> = { store::get_json(&db.lock().unwrap(), &kv_key) };
    if let Some(id) = cached {
        if mail::drive::folder_alive(&state.http, session, &id).await {
            return Ok(id);
        }
    }
    let id = mail::drive::find_or_create_app_folder(&state.http, session).await?;
    {
        let conn = db.lock().unwrap();
        let _ = store::set_json(&conn, &kv_key, &id);
    }
    Ok(id)
}

/// Open a resumable upload into the app folder. Returns the upload id the
/// webview passes back with each raw-body chunk.
#[tauri::command]
async fn drive_upload_begin(
    state: State<'_, AppState>,
    filename: String,
    mime: String,
    size: i64,
) -> Result<u64, String> {
    if filename.is_empty() || filename.len() > 255 {
        return Err("invalid filename".into());
    }
    if size <= 0 || size > 2_000_000_000 {
        return Err("files up to 2 GB can be uploaded to Drive from here".into());
    }
    let mime = if mime.trim().is_empty() { "application/octet-stream".into() } else { mime };
    let email = active_gmail(&state)?;
    let session_uri = {
        let mut sessions = state.gmail.lock().await;
        let session = sessions
            .get_mut(&email)
            .ok_or("account not connected — reconnect Gmail")?;
        let folder = drive_app_folder(&state, &email, session).await?;
        mail::drive::upload_begin(&state.http, session, &folder, &filename, &mime, size).await?
    };
    let id = state
        .drive_upload_seq
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.drive_uploads.lock().unwrap().insert(
        id,
        DriveUpload { session_uri, account: email, sent: 0, total: size },
    );
    Ok(id)
}

/// One chunk of an in-flight upload. Raw invoke body (no JSON/base64);
/// the upload id rides in the `upload-id` request header.
#[tauri::command]
async fn drive_upload_chunk(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<DriveChunkResult, String> {
    let upload_id: u64 = request
        .headers()
        .get("upload-id")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or("missing upload-id header")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("chunk must be a raw request body".into());
    };
    let bytes = bytes.clone();
    let len = bytes.len() as i64;
    if bytes.is_empty() {
        return Err("empty chunk".into());
    }
    let (session_uri, account, sent, total) = {
        let uploads = state.drive_uploads.lock().unwrap();
        let u = uploads.get(&upload_id).ok_or("unknown upload")?;
        (u.session_uri.clone(), u.account.clone(), u.sent, u.total)
    };
    if sent + len > total {
        return Err("chunk overruns the declared file size".into());
    }
    let token = {
        let mut sessions = state.gmail.lock().await;
        let session = sessions
            .get_mut(&account)
            .ok_or("account not connected — reconnect Gmail")?;
        session.bearer(&state.http).await?
    };
    let result =
        mail::drive::upload_chunk(&state.http, &token, &session_uri, sent, total, bytes).await;
    match result {
        Ok(mail::drive::ChunkOutcome::Done(file)) => {
            state.drive_uploads.lock().unwrap().remove(&upload_id);
            Ok(DriveChunkResult { done: true, file: Some(file), next_offset: total })
        }
        Ok(mail::drive::ChunkOutcome::Continue { next_offset }) => {
            // The server's Range high-water mark is authoritative — it may
            // have persisted fewer bytes than we sent. The webview slices the
            // next chunk from next_offset, so a short write self-heals.
            let next = next_offset.unwrap_or(sent + len).clamp(0, total);
            let mut uploads = state.drive_uploads.lock().unwrap();
            if let Some(u) = uploads.get_mut(&upload_id) {
                u.sent = next;
            }
            Ok(DriveChunkResult { done: false, file: None, next_offset: next })
        }
        Err(e) => {
            // Unrecoverable (transient errors already retried inside
            // upload_chunk): drop the entry and abandon the session
            // server-side so it doesn't linger for a week.
            state.drive_uploads.lock().unwrap().remove(&upload_id);
            mail::drive::upload_cancel(&state.http, &session_uri).await;
            Err(e)
        }
    }
}

/// Abandon an in-flight upload (user removed the pending chip / send failed).
#[tauri::command]
async fn drive_upload_cancel(state: State<'_, AppState>, upload_id: u64) -> Result<(), String> {
    let entry = state.drive_uploads.lock().unwrap().remove(&upload_id);
    if let Some(u) = entry {
        mail::drive::upload_cancel(&state.http, &u.session_uri).await;
    }
    Ok(())
}

/// Share-on-send: grant recipients (or anyone-with-link) read access to a
/// linked file. Returns addresses that couldn't be shared — the send
/// proceeds regardless, mirroring Gmail.
#[tauri::command]
async fn drive_share(
    state: State<'_, AppState>,
    file_id: String,
    mode: String,
    emails: Vec<String>,
) -> Result<Vec<String>, String> {
    valid_id(&file_id)?;
    if !matches!(mode.as_str(), "recipients" | "anyone") {
        return Err("invalid share mode".into());
    }
    if emails.len() > 100 {
        return Err("too many recipients".into());
    }
    for e in &emails {
        if !e.contains('@') || e.len() > 254 || e.contains(['\r', '\n']) {
            return Err(format!("\"{e}\" is not a valid address"));
        }
    }
    let email = active_gmail(&state)?;
    let mut sessions = state.gmail.lock().await;
    let session = sessions
        .get_mut(&email)
        .ok_or("account not connected — reconnect Gmail")?;
    mail::drive::share(&state.http, session, &file_id, &mode, &emails).await
}

// ---------------------------------------------------------------- drafts

#[tauri::command]
async fn save_draft(
    state: State<'_, AppState>,
    draft_id: Option<i64>,
    payload: String,
) -> Result<i64, String> {
    if payload.len() > 40_000_000 {
        return Err("draft is too large".into());
    }
    let account = state.active_email();
    let db = state.account_db(&account)?;
    let conn = db.lock().unwrap();
    store::draft_save(&conn, draft_id, &account, &payload, now_ms())
}

#[tauri::command]
async fn list_drafts(state: State<'_, AppState>) -> Result<Vec<DraftEntry>, String> {
    let account = state.active_email();
    let db = state.account_db(&account)?;
    let conn = db.lock().unwrap();
    Ok(store::draft_list(&conn, &account)
        .into_iter()
        .map(|(id, payload, updated_at)| DraftEntry { id, payload, updated_at })
        .collect())
}

#[tauri::command]
async fn delete_draft(state: State<'_, AppState>, draft_id: i64) -> Result<(), String> {
    // draft ids are per-file; the active account wrote it in practice, but
    // sweep the registry so a stale id can't strand a row after a switch
    let active = state.active_email();
    let mut emails = vec![];
    if !active.is_empty() {
        emails.push(active.clone());
    }
    for e in state.dbs.registered_emails() {
        if e != active {
            emails.push(e);
        }
    }
    for email in emails {
        let db = state.account_db(&email)?;
        let conn = db.lock().unwrap();
        let hit: bool = conn
            .query_row("SELECT 1 FROM drafts WHERE id = ?1", [draft_id], |_| Ok(true))
            .unwrap_or(false);
        if hit {
            store::draft_delete(&conn, draft_id);
            return Ok(());
        }
    }
    Ok(())
}

#[tauri::command]
async fn search_threads(state: State<'_, AppState>, query: String) -> Result<Vec<SearchResult>, String> {
    if query.len() > 200 {
        return Err("query too long".into());
    }
    let active = state.active_email();
    let db = state.account_db(&active)?;
    let conn = db.lock().unwrap();
    store::search(&conn, &query, &active)
}

/// Recent threads a contact (by email) was a sender or recipient on — the
/// reading-pane contact panel's mail history. Address-scoped (from/to/cc), so
/// it lists only conversations that person was actually a participant in, not
/// every message that mentions their name. The UI drops the open thread and
/// shows the top 5.
#[tauri::command]
async fn threads_with_contact(
    state: State<'_, AppState>,
    email: String,
) -> Result<Vec<SearchResult>, String> {
    if email.len() > 254 {
        return Err("email too long".into());
    }
    let active = state.active_email();
    let db = state.account_db(&active)?;
    let conn = db.lock().unwrap();
    store::threads_with_contact(&conn, &email, &active, 20)
}

/// Embed a search query, or None when semantic search isn't ready (model
/// still downloading, no key, offline, or the embedder is mid-load — a
/// search never waits on any of that).
async fn query_vector(state: &State<'_, AppState>, text: &str) -> Option<Vec<f32>> {
    let (mode, remote) = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let settings = store::get_settings(&conn);
        let remote = if settings.embeddings == "openai" {
            ai::resolve(&settings, Some("openai")).ok()
        } else {
            None
        };
        (settings.embeddings.clone(), remote)
    };
    if mode == "openai" {
        let p = remote?;
        let texts = vec![text.to_string()];
        return tokio::time::timeout(
            std::time::Duration::from_secs(3),
            ai::openai::embed(&state.http, &p.base_url, &p.key, embed::REMOTE_MODEL, &texts, embed::DIM),
        )
        .await
        .ok()?
        .ok()?
        .pop();
    }
    // local: use a ready model; never load/download on the search path
    let m = match state.embedder.try_lock() {
        Ok(slot) => match &*slot {
            embed::Slot::Ready(m) => m.clone(),
            _ => return None,
        },
        Err(_) => return None,
    };
    let text = text.to_string();
    tauri::async_runtime::spawn_blocking(move || embed::embed_query(&m, &text).ok())
        .await
        .ok()
        .flatten()
}

/// Full-history search: plan the query (AI for natural language when a
/// provider is configured, deterministic otherwise), run the planned local
/// search, then a live Gmail pass so mail older than the local cache is
/// findable. Matched threads are fetched + indexed so later local searches
/// include them.
#[tauri::command]
async fn search_all(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    if query.trim().is_empty() || query.len() > 200 {
        return Ok(vec![]);
    }
    let (active, is_gmail, provider) = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let acct = store::active_account(&conn);
        // AI planning only pays off for natural-language phrasings; a
        // missing/unkeyed provider silently means deterministic.
        let provider = if search::looks_natural(&query) {
            ai::resolve(&store::get_settings(&conn), None).ok()
        } else {
            None
        };
        (acct.email.clone(), acct.provider == "gmail", provider)
    };
    let db = state.account_db(&active)?;
    // The parse call is capped well under the http client's 120s timeout —
    // a slow provider must degrade to the deterministic plan, not stall the
    // whole search pass.
    let mut plan: Option<search::SearchPlan> = None;
    if let Some(p) = provider {
        let today = chrono::Local::now().format("%Y-%m-%d (%A)").to_string();
        let sys = search::ai_system_prompt(&today);
        if let Ok(Ok(raw)) = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            ai::complete(&state.http, &p, &sys, &query),
        )
        .await
        {
            plan = search::parse_ai_plan(&raw);
        }
    }
    let ai_planned = plan.is_some();
    let plan = plan.unwrap_or_else(|| search::parse_deterministic(&query));
    // One query embedding per search (never per keystroke — the instant
    // search_threads path stays lexical-only). Demo accounts use the toy
    // concept embedder; real accounts an already-ready local model or the
    // remote endpoint. Any failure = no semantic leg, lexical unchanged.
    let qvec: Option<Vec<f32>> = if plan.terms.is_empty() {
        None
    } else if !is_gmail {
        #[cfg(feature = "demo-fixtures")]
        {
            mail::mock::demo_embed(&plan.terms.join(" "))
        }
        // No fixtures, no toy embedder — search stays lexical, as it already
        // does whenever the embedder is unavailable.
        #[cfg(not(feature = "demo-fixtures"))]
        None
    } else {
        query_vector(&state, &plan.terms.join(" ")).await
    };
    let local = {
        let conn = db.lock().unwrap();
        store::search_planned(&conn, &plan, &active, qvec.as_deref())?
    };
    if !is_gmail {
        return Ok(local); // demo mode has no server to reach past
    }
    // Remote pass: AI plans are rebuilt as operator syntax (terms + from:/
    // to: + after:/before:) — Gmail searches structure better than prose.
    // Deterministic queries go through raw, preserving operators the local
    // plan can't honor (has:, in:, label:, …).
    let remote_q = if ai_planned { search::to_remote_query(&plan) } else { query.clone() };
    if remote_q.trim().is_empty() {
        return Ok(local);
    }
    // Live Gmail search (Gmail's q excludes trash/spam by default, matching
    // the local `hidden IS NULL` filter). Network failure → local-only.
    let remote_ids: Vec<String> = {
        let mut sessions = state.gmail.lock().await;
        let Some(session) = sessions.get_mut(&active) else { return Ok(local) };
        match session.list_thread_ids_paged(&state.http, &remote_q, 50).await {
            Ok(v) => v.into_iter().map(|(id, _)| id).collect(),
            Err(_) => return Ok(local),
        }
    };
    let mut seen: std::collections::HashSet<String> =
        local.iter().map(|r| r.thread_id.clone()).collect();
    let mut results = local;
    {
        let mut sessions = state.gmail.lock().await;
        if let Some(session) = sessions.get_mut(&active) {
            for id in remote_ids {
                if seen.contains(&id) {
                    continue;
                }
                // fetch+index the thread if we don't have it, then fold it in
                let have = { store::get_thread(&db.lock().unwrap(), &id).is_some() };
                if !have {
                    let _ = mail::sync::refetch_thread(&state.http, session, &db, &active, &id)
                        .await;
                }
                if let Some(r) = store::get_search_result(&db.lock().unwrap(), &id) {
                    seen.insert(id);
                    results.push(r);
                }
            }
        }
    }
    results.sort_by(|a, b| b.last_date.cmp(&a.last_date));
    results.truncate(80);
    Ok(results)
}

/// Fetch the next, older page of a paged view (Done / Starred / Trash) from
/// Gmail using the oldest local thread as the cursor. Returns how many new
/// threads were added; emits mail:updated so the list re-reads.
#[tauri::command]
async fn load_older(
    app: AppHandle,
    state: State<'_, AppState>,
    view: String,
) -> Result<i64, String> {
    let base = match view.as_str() {
        "done" => "-in:inbox -in:spam -in:trash -in:draft",
        "starred" => "is:starred",
        "trash" => "in:trash",
        // inbox is fully backfilled; reminders/labels don't page here
        _ => return Ok(0),
    };
    let active_acct = { store::active_account(&state.global().lock().unwrap()) };
    let db = state.account_db(&active_acct.email)?;
    let (active, is_gmail, oldest) = {
        let conn = db.lock().unwrap();
        let oldest = store::oldest_thread_date(&conn, &view, &active_acct.email);
        (active_acct.email.clone(), active_acct.provider == "gmail", oldest)
    };
    let Some(oldest_ms) = oldest else { return Ok(0) };
    if !is_gmail {
        return Ok(0);
    }
    // Gmail's before: accepts a unix-seconds cursor — everything strictly older
    // than the oldest thread we already hold.
    let query = format!("{base} before:{}", oldest_ms / 1000);
    let ids: Vec<String> = {
        let mut sessions = state.gmail.lock().await;
        let Some(session) = sessions.get_mut(&active) else { return Ok(0) };
        // one page per scroll; each thread is fetched individually below, so
        // keep it modest for a responsive load-more
        session
            .list_thread_ids_paged(&state.http, &query, 50)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    };
    let mut added = 0i64;
    {
        let mut sessions = state.gmail.lock().await;
        if let Some(session) = sessions.get_mut(&active) {
            // Paging older mail is a user-initiated download of a known size —
            // report it like any other pass so a slow page isn't a dead scroll.
            let gate = ActivityGate::new();
            let total = ids.len();
            for (i, id) in ids.iter().enumerate() {
                let have = { store::get_thread(&db.lock().unwrap(), id).is_some() };
                if !have
                    && mail::sync::refetch_thread(&state.http, session, &db, &active, id)
                        .await
                        .is_ok()
                {
                    added += 1;
                }
                let tick = mail::sync::SyncTick {
                    account: active.clone(),
                    stage: mail::sync::SyncStage::LoadOlder,
                    done: i + 1,
                    total,
                };
                if gate.allows(&tick) {
                    emit_sync_activity(&app, tick);
                }
            }
        }
    }
    if added > 0 {
        emit_mail_updated(&app);
    }
    Ok(added)
}

#[tauri::command]
async fn list_labels(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    // Per-account by construction now: the active account's file only holds
    // its own threads. (The old single-db query unioned every account's
    // labels into every picker — that leak ends here.)
    let db = state.active_db()?;
    let labels = store::list_labels(&db.lock().unwrap());
    labels
}

// ---------------------------------------------------------------- triage

/// A pending Gmail-side triage change, applied in the background after the local
/// store write. Label names (not ids) so user labels like "Muted" work alongside
/// system labels (resolved via ensure_label_id, which returns system labels as-is).
enum RemoteTriage {
    Modify { add: Vec<String>, remove: Vec<String> },
    Trash,
    /// Untrash, then add these labels (restore from Trash → back to the inbox).
    UntrashAdd(Vec<String>),
}

fn s(v: &str) -> String {
    v.to_string()
}

/// Instant, non-blocking check that a triage action can reach Gmail: Ok for mock
/// threads and real threads whose account has a live session; Err (before any
/// local write) when a real thread's account has no live session, so the UI can't
/// silently diverge from Gmail. Uses try_lock so a sync holding the gmail mutex
/// never stalls triage — if we can't peek instantly we assume connected and let
/// the background op surface any failure. (BUG 3a)
fn ensure_remote_capable(state: &State<'_, AppState>, thread_id: &str, account: &str) -> Result<(), String> {
    if is_mock_id(thread_id) {
        return Ok(());
    }
    if let Ok(sessions) = state.gmail.try_lock() {
        if !sessions.contains_key(account) {
            return Err("account not connected — reconnect Gmail in Settings → Account, then try again".into());
        }
    }
    Ok(())
}

/// Apply a triage change on Gmail in the background so the command returns as soon
/// as the local store write lands. On failure, surface it (never silent) and
/// reconcile the affected thread so the optimistic local change is corrected
/// rather than diverging. (BUG 2 #2 / BUG 3)
fn spawn_remote(app: AppHandle, thread_id: String, op: RemoteTriage) {
    if is_mock_id(&thread_id) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Ok((account, db)) = state.thread_db(&thread_id) else { return };
        let result: Result<(), String> = async {
            let mut sessions = state.gmail.lock().await;
            let sess = sessions
                .get_mut(&account)
                .ok_or("account not connected — reconnect Gmail")?;
            match &op {
                RemoteTriage::Modify { add, remove } => {
                    let mut add_ids = Vec::with_capacity(add.len());
                    for name in add {
                        add_ids.push(sess.ensure_label_id(&state.http, name).await?);
                    }
                    let mut rem_ids = Vec::with_capacity(remove.len());
                    for name in remove {
                        rem_ids.push(sess.ensure_label_id(&state.http, name).await?);
                    }
                    let add_refs: Vec<&str> = add_ids.iter().map(String::as_str).collect();
                    let rem_refs: Vec<&str> = rem_ids.iter().map(String::as_str).collect();
                    sess.modify_thread(&state.http, &thread_id, &add_refs, &rem_refs).await
                }
                RemoteTriage::Trash => sess.trash_thread(&state.http, &thread_id).await,
                RemoteTriage::UntrashAdd(add) => {
                    sess.untrash_thread(&state.http, &thread_id).await?;
                    let mut add_ids = Vec::with_capacity(add.len());
                    for name in add {
                        add_ids.push(sess.ensure_label_id(&state.http, name).await?);
                    }
                    let add_refs: Vec<&str> = add_ids.iter().map(String::as_str).collect();
                    sess.modify_thread(&state.http, &thread_id, &add_refs, &[]).await
                }
            }
        }
        .await;
        if let Err(e) = result {
            eprintln!("[triage:{account}] remote update failed: {e}");
            let _ = app.emit("triage:error", format!("Couldn't sync to Gmail: {e}"));
            // reconcile the thread so local state matches the server
            let mut sessions = state.gmail.lock().await;
            if let Some(sess) = sessions.get_mut(&account) {
                let _ = mail::sync::refetch_thread(&state.http, sess, &db, &account, &thread_id).await;
            }
            drop(sessions);
            emit_mail_updated(&app);
        }
    });
}

#[tauri::command]
async fn archive_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    store::set_in_inbox(&db.lock().unwrap(), &thread_id, false)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![], remove: vec![s("INBOX")] });
    Ok(())
}

#[tauri::command]
async fn move_to_inbox(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    store::set_in_inbox(&db.lock().unwrap(), &thread_id, true)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![s("INBOX")], remove: vec![] });
    Ok(())
}

/// Trash or spam a thread. Soft-hide locally (so Z can restore instantly);
/// server-side it goes to Gmail's Trash / Spam (in the background).
#[tauri::command]
async fn hide_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    reason: String,
) -> Result<(), String> {
    valid_id(&thread_id)?;
    if !matches!(reason.as_str(), "trash" | "spam") {
        return Err("invalid reason".into());
    }
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    store::set_hidden(&db.lock().unwrap(), &thread_id, Some(&reason))?;
    let op = if reason == "trash" {
        RemoteTriage::Trash
    } else {
        RemoteTriage::Modify { add: vec![s("SPAM")], remove: vec![s("INBOX")] }
    };
    spawn_remote(app, thread_id, op);
    Ok(())
}

/// Undo for hide_thread: untrash/unspam remotely, resurface locally.
#[tauri::command]
async fn restore_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    let reason = store::hidden_reason(&db.lock().unwrap(), &thread_id);
    ensure_remote_capable(&state, &thread_id, &account)?;
    store::set_hidden(&db.lock().unwrap(), &thread_id, None)?;
    match reason.as_deref() {
        Some("trash") => spawn_remote(app, thread_id, RemoteTriage::UntrashAdd(vec![s("INBOX")])),
        Some("spam") => spawn_remote(
            app,
            thread_id,
            RemoteTriage::Modify { add: vec![s("INBOX")], remove: vec![s("SPAM")] },
        ),
        _ => {}
    }
    Ok(())
}

/// Mute: archive now and keep auto-archiving new replies (via the sync pass).
#[tauri::command]
async fn mute_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    let already_muted = {
        let conn = db.lock().unwrap();
        let muted = store::get_thread(&conn, &thread_id)
            .map(|t| t.labels.iter().any(|l| l == "Muted"))
            .unwrap_or(false);
        if !muted {
            store::toggle_label(&conn, &thread_id, "Muted")?;
        }
        store::set_in_inbox(&conn, &thread_id, false)?;
        muted
    };
    let add = if already_muted { vec![] } else { vec![s("Muted")] };
    spawn_remote(app, thread_id, RemoteTriage::Modify { add, remove: vec![s("INBOX")] });
    Ok(())
}

#[tauri::command]
async fn unmute_thread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    let was_muted = {
        let conn = db.lock().unwrap();
        let muted = store::get_thread(&conn, &thread_id)
            .map(|t| t.labels.iter().any(|l| l == "Muted"))
            .unwrap_or(false);
        if muted {
            store::toggle_label(&conn, &thread_id, "Muted")?;
        }
        store::set_in_inbox(&conn, &thread_id, true)?;
        muted
    };
    let remove = if was_muted { vec![s("Muted")] } else { vec![] };
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![s("INBOX")], remove });
    Ok(())
}

#[tauri::command]
async fn unsubscribe_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<UnsubResult, String> {
    valid_id(&thread_id)?;
    let (_, db) = state.thread_db(&thread_id)?;
    let header = store::unsubscribe_header(&db.lock().unwrap(), &thread_id);
    let Some(header) = header else {
        return Ok(UnsubResult { kind: "none".into(), target: None });
    };
    match mail::gmail::parse_unsubscribe_target(&header) {
        Some((kind, target)) if kind == "opened" => {
            let _ = app; // opener plugin is app-scoped
            tauri_plugin_opener::open_url(&target, None::<String>)
                .map_err(|_| "could not open the unsubscribe page".to_string())?;
            Ok(UnsubResult { kind, target: Some(target) })
        }
        Some((kind, target)) => Ok(UnsubResult { kind, target: Some(target) }),
        None => Ok(UnsubResult { kind: "none".into(), target: None }),
    }
}

#[tauri::command]
async fn toggle_star(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<bool, String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    let starred = {
        let conn = db.lock().unwrap();
        let t = store::get_thread(&conn, &thread_id).ok_or("unknown thread")?;
        let starred = !t.starred;
        store::set_starred(&conn, &thread_id, starred)?;
        starred
    };
    let op = if starred {
        RemoteTriage::Modify { add: vec![s("STARRED")], remove: vec![] }
    } else {
        RemoteTriage::Modify { add: vec![], remove: vec![s("STARRED")] }
    };
    spawn_remote(app, thread_id, op);
    Ok(starred)
}

#[tauri::command]
async fn snooze_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    until_ms: i64,
) -> Result<(), String> {
    valid_id(&thread_id)?;
    if until_ms <= now_ms() {
        return Err("snooze time must be in the future".into());
    }
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    store::set_snoozed(&db.lock().unwrap(), &thread_id, until_ms)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![], remove: vec![s("INBOX")] });
    Ok(())
}

#[tauri::command]
async fn mark_unread(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    store::set_unread(&db.lock().unwrap(), &thread_id, true)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![s("UNREAD")], remove: vec![] });
    Ok(())
}

#[tauri::command]
async fn mark_read(app: AppHandle, state: State<'_, AppState>, thread_id: String) -> Result<(), String> {
    valid_id(&thread_id)?;
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    store::set_unread(&db.lock().unwrap(), &thread_id, false)?;
    spawn_remote(app, thread_id, RemoteTriage::Modify { add: vec![], remove: vec![s("UNREAD")] });
    Ok(())
}

#[tauri::command]
async fn move_label(
    app: AppHandle,
    state: State<'_, AppState>,
    thread_id: String,
    label: String,
) -> Result<(), String> {
    valid_id(&thread_id)?;
    if label.is_empty() || label.len() > 100 {
        return Err("invalid label".into());
    }
    let (account, db) = state.thread_db(&thread_id)?;
    ensure_remote_capable(&state, &thread_id, &account)?;
    let added = {
        let conn = db.lock().unwrap();
        store::toggle_label(&conn, &thread_id, &label)?
    };
    let op = if added {
        RemoteTriage::Modify { add: vec![label], remove: vec![] }
    } else {
        RemoteTriage::Modify { add: vec![], remove: vec![label] }
    };
    spawn_remote(app, thread_id, op);
    Ok(())
}

#[tauri::command]
async fn bulk_archive(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: BulkArchiveOpts,
) -> Result<i64, String> {
    let active = state.active_email();
    let db = state.account_db(&active)?;
    let targets = { store::inbox_threads_for_sweep(&db.lock().unwrap(), &active)? };
    let cutoff = now_ms() - opts.older_than_days * 24 * 3_600_000;
    let mut ids: Vec<String> = vec![];
    for t in targets {
        if opts.older_than_days > 0 && t.last_date > cutoff {
            continue;
        }
        if opts.preserve_unread && t.unread {
            continue;
        }
        if opts.preserve_starred && t.starred {
            continue;
        }
        if let Some(split_id) = &opts.split_id {
            // Membership is the materialized split_id column — the same value
            // the UI renders, so the sweep can never disagree with the tabs.
            if t.split != *split_id && !t.also_in.contains(split_id) {
                continue;
            }
        }
        ids.push(t.id);
    }
    // Local writes are synchronous (instant); archive on Gmail in the background.
    {
        let conn = db.lock().unwrap();
        for id in &ids {
            store::set_in_inbox(&conn, id, false)?;
        }
    }
    let n = ids.len() as i64;
    let remote_ids: Vec<String> = ids.into_iter().filter(|id| !is_mock_id(id)).collect();
    if !remote_ids.is_empty() {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app2.state::<AppState>();
            let mut sessions = state.gmail.lock().await;
            if let Some(sess) = sessions.get_mut(&active) {
                for id in remote_ids {
                    if let Err(e) = sess.modify_thread(&state.http, &id, &[], &["INBOX"]).await {
                        eprintln!("[bulk_archive:{active}] {id}: {e}");
                    }
                }
            }
        });
    }
    emit_mail_updated(&app);
    Ok(n)
}

/// Reclassify stored threads in the background — chunked so each DB lock hold
/// stays short (the crawl-beat pattern). Runs after a split definition changes
/// (`only_missing = false`) and as the boot backfill for pre-v0.23 rows
/// (`only_missing = true`). Emits mail:updated once anything moved.
fn spawn_reclassify(app: AppHandle, only_missing: bool) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let mut moved = 0usize;
        // one pass per account file — the rowid walk is per-db now
        for email in state.dbs.registered_emails() {
            let Ok(db) = state.account_db(&email) else { continue };
            let mut after = 0i64;
            loop {
                let step = {
                    let conn = db.lock().unwrap();
                    store::reclassify_page(&conn, after, 500, only_missing)
                };
                match step {
                    Ok((updated, last, done)) => {
                        moved += updated;
                        after = last;
                        if done {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("[splits:{email}] reclassify failed: {e}");
                        break;
                    }
                }
                tokio::task::yield_now().await;
            }
        }
        if moved > 0 {
            emit_mail_updated(&app);
        }
    });
}

// ---------------------------------------------------------------- send

fn validate_mail(mail: &OutgoingMail) -> Result<(), String> {
    if mail.to.is_empty() {
        return Err("add at least one recipient".into());
    }
    for addr in mail.to.iter().chain(mail.cc.iter()) {
        if !addr.contains('@') || addr.len() > 254 || addr.contains(['\r', '\n']) {
            return Err(format!("\"{addr}\" is not a valid address"));
        }
    }
    // Gmail rejects raw messages over ~25 MB; base64 inflates by ~4/3.
    let total: usize = mail.attachments.iter().map(|a| a.data_base64.len()).sum();
    if total > 33_000_000 {
        return Err("attachments exceed the 25 MB limit".into());
    }
    for a in &mail.attachments {
        if a.filename.is_empty() || a.filename.len() > 255 {
            return Err("attachment has an invalid filename".into());
        }
    }
    Ok(())
}

/// Actually deliver a message for a given account: Gmail send for connected
/// accounts, local append in demo mode. Used by the outbox processor.
async fn deliver_mail(app: &AppHandle, account_email: &str, mail: &OutgoingMail) -> Result<(), String> {
    let state = app.state::<AppState>();
    let provider = {
        store::get_accounts(&state.global().lock().unwrap())
            .accounts
            .iter()
            .find(|a| a.email == account_email)
            .map(|a| a.provider.clone())
            .unwrap_or_else(|| "mock".into())
    };
    let db = state.account_db(account_email)?;

    if provider == "gmail" && !mail.thread_id.as_deref().map(is_mock_id).unwrap_or(false) {
        let in_reply_to: Option<String> = mail.thread_id.as_ref().and_then(|tid| {
            let conn = db.lock().unwrap();
            conn.query_row(
                "SELECT rfc_message_id FROM messages WHERE thread_id = ?1 AND rfc_message_id IS NOT NULL ORDER BY date DESC LIMIT 1",
                [tid.as_str()],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        });
        let raw = mail::gmail::build_rfc822(account_email, mail, in_reply_to.as_deref());
        let mut sessions = state.gmail.lock().await;
        let session = sessions
            .get_mut(account_email)
            .ok_or("Gmail session unavailable for this account")?;
        session.send(&state.http, &raw, mail.thread_id.as_deref()).await?;
        drop(sessions);
        return Ok(());
    }

    // mock mode: append locally so the flow is fully demoable
    let conn = db.lock().unwrap();
    let now = now_ms();
    let (tid, subject) = match &mail.thread_id {
        Some(tid) => (tid.clone(), mail.subject.clone()),
        None => (format!("t-sent-{now}"), mail.subject.clone()),
    };
    let mid = format!("{tid}-m{now}");
    let msg = Message {
        id: mid,
        thread_id: tid.clone(),
        from: account_email.to_string(),
        from_name: "You".into(),
        to: mail.to.clone(),
        cc: mail.cc.clone(),
        subject: subject.clone(),
        snippet: mail.body_text.chars().take(120).collect::<String>().replace('\n', " "),
        body_text: mail.body_text.clone(),
        body_html: None,
        date: now,
        unread: false,
        attachments: vec![],
    };
    let existing = store::get_thread(&conn, &tid);
    let thread = match existing {
        Some(mut t) => {
            t.message_count += 1;
            t.last_date = now;
            t.snippet = msg.snippet.clone();
            t
        }
        None => Thread {
            id: tid.clone(),
            subject: if subject.is_empty() { "(no subject)".into() } else { subject },
            snippet: msg.snippet.clone(),
            participants: vec![format!("You <{account_email}>")],
            recipients: mail.to.iter().chain(mail.cc.iter()).cloned().collect(),
            message_count: 1,
            last_date: now,
            unread: false,
            starred: false,
            labels: vec![],
            in_inbox: false,
            snoozed_until: None,
            split: String::new(), // materialized by upsert_thread
            also_in: vec![],
        },
    };
    store::upsert_thread(&conn, account_email, &thread, &[(msg, None, None, None, vec![])])?;
    Ok(())
}

/// Queue a message. delay_ms ≈ 10s gives the Undo Send window; larger values
/// are Send Later. The outbox survives app restarts.
#[tauri::command]
async fn queue_mail(state: State<'_, AppState>, mail: OutgoingMail, delay_ms: i64) -> Result<i64, String> {
    validate_mail(&mail)?;
    if !(0..=90 * 24 * 3_600_000).contains(&delay_ms) {
        return Err("invalid send delay".into());
    }
    let account = state.active_email();
    let db = state.account_db(&account)?;
    let conn = db.lock().unwrap();
    store::outbox_add(&conn, &account, &mail, now_ms() + delay_ms)
}

/// Which account file holds this outbox row. Active first — undo/accelerate
/// always fire from the account that queued moments ago.
fn outbox_db(state: &AppState, outbox_id: i64) -> Result<(String, Arc<Mutex<Connection>>), String> {
    let active = state.active_email();
    let mut emails = vec![];
    if !active.is_empty() {
        emails.push(active.clone());
    }
    for e in state.dbs.registered_emails() {
        if e != active {
            emails.push(e);
        }
    }
    for email in emails {
        let db = state.account_db(&email)?;
        let hit: bool = {
            let conn = db.lock().unwrap();
            conn.query_row("SELECT 1 FROM outbox WHERE id = ?1", [outbox_id], |_| Ok(true))
                .unwrap_or(false)
        };
        if hit {
            return Ok((email, db));
        }
    }
    Err("already sent".into())
}

/// Undo Send: pull a message back before the outbox flushes it.
#[tauri::command]
async fn cancel_outbox(state: State<'_, AppState>, outbox_id: i64) -> Result<OutgoingMail, String> {
    let (_, db) = outbox_db(&state, outbox_id)?;
    let cancelled = store::outbox_cancel(&db.lock().unwrap(), outbox_id);
    cancelled.ok_or("already sent".to_string())
}

/// Send a message immediately, bypassing the outbox — used when Undo Send is
/// off (no window to wait out, nothing to undo). Grabs state via the handle so
/// the DB lock is never held across the network await.
#[tauri::command]
async fn send_mail_now(app: AppHandle, mail: OutgoingMail) -> Result<(), String> {
    validate_mail(&mail)?;
    let account = {
        let state = app.state::<AppState>();
        let email = state.active_email();
        email
    };
    deliver_mail(&app, &account, &mail).await?;
    emit_mail_updated(&app);
    Ok(())
}

/// Accelerate a pending send: deliver it now instead of waiting out the Undo
/// Send window. The row is deleted only after delivery succeeds, so a failed
/// flush leaves it queued for the processor to retry. Its send_at is still in
/// the future, so the processor won't double-send it in the meantime.
#[tauri::command]
async fn send_outbox_now(app: AppHandle, outbox_id: i64) -> Result<(), String> {
    // Claim the row before the (async) network send so the 3s outbox processor
    // can never also deliver it. The claim + read run under one lock, so they're
    // atomic; a claimed row is invisible to outbox_due and to cancel_outbox.
    let db = {
        let state = app.state::<AppState>();
        outbox_db(&state, outbox_id)?.1
    };
    let (account, mail) = {
        let conn = db.lock().unwrap();
        if !store::outbox_claim(&conn, outbox_id) {
            return Err("already sent".into());
        }
        store::outbox_get(&conn, outbox_id)
    }
    .ok_or_else(|| "already sent".to_string())?;
    match deliver_mail(&app, &account, &mail).await {
        Ok(()) => {
            let conn = db.lock().unwrap();
            store::outbox_delete(&conn, outbox_id);
            drop(conn);
            emit_mail_updated(&app);
            Ok(())
        }
        Err(e) => {
            // Delivery failed — release the claim so the processor retries it.
            let conn = db.lock().unwrap();
            store::outbox_unclaim(&conn, outbox_id);
            Err(e)
        }
    }
}

// ---------------------------------------------------------------- settings

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(store::get_settings(&state.global().lock().unwrap()))
}

#[tauri::command]
async fn save_settings(app: AppHandle, state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    if settings.splits.len() > 24 {
        return Err("too many splits".into());
    }
    for sp in &settings.splits {
        if sp.query.len() > 500 {
            return Err(format!("split \"{}\": query is too long", sp.name));
        }
        if let Err(e) = splits::parse(&sp.query) {
            return Err(format!("split \"{}\": {e}", sp.name));
        }
    }
    if let Some(dir) = &settings.celebration_dir {
        let path = std::path::Path::new(dir);
        if path.is_dir() {
            let _ = app.asset_protocol_scope().allow_directory(path, false);
        }
    }
    let splits_changed = {
        let gdb = state.global();
        let conn = gdb.lock().unwrap();
        let before = serde_json::to_value(store::split_config(&conn)).unwrap_or_default();
        store::set_json(&conn, "settings", &settings)?;
        before != serde_json::to_value(&settings.splits).unwrap_or_default()
    };
    // Not on the mail:updated funnel: toggling showBadge (or renaming the
    // Important split out from under it) changes the badge without changing
    // any mail.
    badge::refresh(&app);
    // A changed definition re-files the whole mailbox in the background; the
    // tabs repaint on the mail:updated it emits when done.
    if splits_changed {
        spawn_reclassify(app, false);
    }
    Ok(())
}

/// Inbox conversation count per split (active account) — SQL over the whole
/// mailbox, so tab counts don't stop at the 500-row display window.
#[tauri::command]
async fn split_counts(state: State<'_, AppState>) -> Result<std::collections::HashMap<String, i64>, String> {
    let active = state.active_email();
    let db = state.account_db(&active)?;
    let conn = db.lock().unwrap();
    store::split_counts(&conn, &active)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitPreview {
    ok: bool,
    error: Option<String>,
    /// Matching conversations among the active account's recent inbox.
    count: i64,
}

/// Live validation + match preview for the split editor. Counts over the
/// recent inbox window (500) — a hint, not the classifier.
#[tauri::command]
async fn preview_split(state: State<'_, AppState>, query: String) -> Result<SplitPreview, String> {
    if query.len() > 500 {
        return Ok(SplitPreview { ok: false, error: Some("query is too long".into()), count: 0 });
    }
    let node = match splits::parse(&query) {
        Err(e) => return Ok(SplitPreview { ok: false, error: Some(e), count: 0 }),
        Ok(None) => {
            return Ok(SplitPreview {
                ok: true,
                error: Some("empty query — this split would catch everything unmatched".into()),
                count: 0,
            })
        }
        Ok(Some(n)) => n,
    };
    let active = state.active_email();
    let db = state.account_db(&active)?;
    let conn = db.lock().unwrap();
    let threads = store::list_threads(&conn, "inbox", &active)?;
    let count = threads
        .iter()
        .filter(|t| {
            splits::matches(
                &node,
                &splits::Facts {
                    senders: &t.participants,
                    recipients: &t.recipients,
                    subject: &t.subject,
                    labels: &t.labels,
                },
            )
        })
        .count() as i64;
    Ok(SplitPreview { ok: true, error: None, count })
}

#[tauri::command]
async fn get_knowledge_base(state: State<'_, AppState>) -> Result<KnowledgeBase, String> {
    Ok(store::get_kb(&state.global().lock().unwrap()))
}

#[tauri::command]
async fn save_knowledge_base(state: State<'_, AppState>, kb: KnowledgeBase) -> Result<(), String> {
    if kb.instructions.len() > 50_000 {
        return Err("instructions are too long".into());
    }
    store::set_json(&state.global().lock().unwrap(), "kb", &kb)
}

// ---------------------------------------------------------------- AI

#[tauri::command]
async fn set_ai_key(state: State<'_, AppState>, provider: String, key: String) -> Result<(), String> {
    let entry = secrets::ai_key_entry(&provider).ok_or("unknown AI provider")?;
    let key = key.trim();
    if key.is_empty() {
        secrets::delete(entry);
    } else {
        if key.len() > 512 {
            return Err("that does not look like an API key".into());
        }
        secrets::set(entry, key)?;
    }
    let gdb = state.global();
    let conn = gdb.lock().unwrap();
    let mut settings = store::get_settings(&conn);
    for p in settings.providers.iter_mut() {
        if p.id == provider {
            p.has_key = !key.is_empty();
        }
    }
    store::set_json(&conn, "settings", &settings)
}

#[tauri::command]
async fn test_ai_provider(state: State<'_, AppState>, provider: String) -> Result<TestResult, String> {
    let settings = store::get_settings(&state.global().lock().unwrap());
    let resolved = match ai::resolve(&settings, Some(&provider)) {
        Ok(r) => r,
        Err(message) => return Ok(TestResult { ok: false, message }),
    };
    Ok(ai::test_provider(&state.http, &resolved).await)
}

#[tauri::command]
async fn ai_draft(
    state: State<'_, AppState>,
    req: DraftRequest,
    request_id: u64,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    if req.instruction.trim().is_empty() {
        return Err("tell the AI what to write".into());
    }
    if req.instruction.len() > 8_000 {
        return Err("instruction is too long".into());
    }
    if let Some(tid) = &req.thread_id {
        valid_id(tid)?;
    }
    let settings = store::get_settings(&state.global().lock().unwrap());
    let resolved = ai::resolve(&settings, req.provider_id.as_deref())?;

    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(request_id, cancel.clone());

    let db = match &req.thread_id {
        Some(tid) => state.thread_db(tid)?.1,
        None => state.active_db()?,
    };
    let global = state.global();
    let ctx = ai::context::assemble(
        &global,
        &db,
        &state.http,
        &state.gmail,
        &req,
        ai::supports_images(&resolved.id),
    )
    .await?;

    let result = ai::stream_draft(
        &state.http,
        &resolved,
        &ctx,
        |chunk| {
            let _ = on_chunk.send(chunk);
        },
        cancel,
    )
    .await;

    state.cancels.lock().unwrap().remove(&request_id);
    result
}

#[tauri::command]
fn cancel_ai(state: State<'_, AppState>, request_id: u64) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
async fn ai_suggest_replies(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<Vec<String>, String> {
    valid_id(&thread_id)?;
    let settings = store::get_settings(&state.global().lock().unwrap());
    let resolved = ai::resolve(&settings, None)?; // errs (and hides UI) when no key
    let db = state.thread_db(&thread_id)?.1;
    let req = DraftRequest {
        thread_id: Some(thread_id),
        instruction: "Suggest up to 3 short, distinct replies the user might send to the latest message. \
                      Each under 30 words, in the user's voice per the instructions. \
                      Respond with ONLY a JSON array of strings — no other text."
            .into(),
        existing_text: None,
        provider_id: None,
    };
    let global = state.global();
    let ctx = ai::context::assemble(&global, &db, &state.http, &state.gmail, &req, false).await?;
    let raw = ai::complete(&state.http, &resolved, &ctx.system, &ctx.user_text).await?;
    Ok(ai::parse_suggestions(&raw))
}

// ---------------------------------------------------------------- inbox zero

#[tauri::command]
async fn get_streaks(state: State<'_, AppState>) -> Result<Streaks, String> {
    Ok(store::get_streaks(&state.global().lock().unwrap()))
}

fn celebration_pool(app: &AppHandle, settings: &Settings) -> Vec<String> {
    if let Some(dir) = &settings.celebration_dir {
        let path = std::path::Path::new(dir);
        if let Ok(entries) = std::fs::read_dir(path) {
            let imgs: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    matches!(
                        p.extension().and_then(|x| x.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
                        Some("png" | "jpg" | "jpeg" | "webp" | "gif" | "svg")
                    )
                })
                .filter_map(|p| p.to_str().map(str::to_string))
                .collect();
            if !imgs.is_empty() {
                let _ = app.asset_protocol_scope().allow_directory(path, false);
                return imgs;
            }
        }
    }
    BUNDLED_CELEBRATIONS.iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
async fn record_zero(app: AppHandle, state: State<'_, AppState>, split_id: String) -> Result<Option<ZeroEvent>, String> {
    let db = state.global();
    let conn = db.lock().unwrap();
    let mut s = store::get_streaks(&conn);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if s.last_zero_day.as_deref() != Some(today.as_str()) {
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        s.daily = if s.last_zero_day.as_deref() == Some(yesterday.as_str()) { s.daily + 1 } else { 1 };
        s.weekly = s.daily / 7;
        s.last_zero_day = Some(today);
        store::set_json(&conn, "streaks", &s)?;
    }
    let settings = store::get_settings(&conn);
    drop(conn);
    let pool = celebration_pool(&app, &settings);
    let idx = (now_ms() as usize) % pool.len();
    Ok(Some(ZeroEvent {
        split_id,
        daily: s.daily,
        weekly: s.weekly,
        image_path: pool[idx].clone(),
    }))
}

#[tauri::command]
async fn list_celebration_images(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = store::get_settings(&state.global().lock().unwrap());
    Ok(celebration_pool(&app, &settings))
}

// ---------------------------------------------------------------- bootstrap

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            // Migrate a pre-rename install: each earlier bundle identifier
            // (com.fission.mail, and com.zenbox.mail before it) had its own
            // app-data dir. Copy the db + WAL sidecars once so accounts +
            // cached mail carry over. Keychain secrets migrate lazily in
            // secrets::get.
            migrate_legacy_db(&data_dir);
            // global.db + per-account files; a legacy fission.db keeps serving
            // account reads until the backgrounded split migration verifies.
            let dbs = store::registry::DbRegistry::open(&data_dir).map_err(std::io::Error::other)?;

            // One-shot: strip demo data that pre-cut builds seeded into this
            // user's real databases. Must run BEFORE the registry is read, so
            // the rest of boot never sees the demo pair. Flag-guarded, because
            // a real account that happens to look like a fixture must not be
            // re-examined on every launch.
            {
                let gdb = dbs.global();
                let purge_needed = {
                    let conn = gdb.lock().unwrap();
                    !store::demo_purge::already_purged(&conn)
                };
                if purge_needed {
                    // Narrow lock scopes: close_and_delete takes the registry's
                    // own lock, so the global guard must be released first.
                    let removed = {
                        let conn = gdb.lock().unwrap();
                        let _ = store::demo_purge::sweep_demo_kv(&conn);
                        store::demo_purge::purge_registry(&conn).unwrap_or_default()
                    };
                    for email in &removed {
                        if let Err(e) = dbs.close_and_delete(email) {
                            eprintln!("[demo-purge] {email}: {e}");
                        }
                    }
                    // Pre-split installs kept every account's mail in one file.
                    if let Some(legacy) = dbs.legacy() {
                        let conn = legacy.lock().unwrap();
                        match store::demo_purge::sweep_demo_rows(&conn) {
                            Ok(n) if n > 0 => eprintln!("[demo-purge] legacy db: {n} threads"),
                            Err(e) => eprintln!("[demo-purge] legacy db: {e}"),
                            _ => {}
                        }
                    }
                    let conn = gdb.lock().unwrap();
                    let _ = store::demo_purge::mark_purged(&conn);
                }
            }

            let accounts = { store::get_accounts(&dbs.global().lock().unwrap()) };
            let mut sessions = HashMap::new();
            let mut lost_accounts = vec![];
            for a in &accounts.accounts {
                if a.provider == "gmail" {
                    match GmailSession::from_keychain(a.email.clone()) {
                        Some(s) => {
                            sessions.insert(a.email.clone(), s);
                        }
                        None => lost_accounts.push(a.email.clone()),
                    }
                }
            }
            // tokens removed out-of-band: drop those accounts gracefully
            if !lost_accounts.is_empty() {
                let g = dbs.global();
                let conn = g.lock().unwrap();
                let mut acc = accounts.clone();
                acc.accounts.retain(|a| !lost_accounts.contains(&a.email));
                if acc.accounts.is_empty() {
                    conn.execute("DELETE FROM kv WHERE key = 'accounts'", []).ok();
                } else {
                    if !acc.accounts.iter().any(|a| a.email == acc.active) {
                        acc.active = acc.accounts[0].email.clone();
                    }
                    let _ = store::save_accounts(&conn, &acc);
                }
            }
            // Demo fixtures: each mock account seeds into its own file
            // (re-read — the lost-token path may have fallen back to the
            // demo pair). Idempotent per account; heal + stand-in vectors
            // cover demo dbs from older builds. Shipped builds seed nothing:
            // a fresh install has no accounts and shows the connect screen.
            let accounts = { store::get_accounts(&dbs.global().lock().unwrap()) };
            #[cfg(feature = "demo-fixtures")]
            for a in &accounts.accounts {
                if a.provider == "gmail" {
                    continue;
                }
                let db = dbs.account(&a.email).map_err(std::io::Error::other)?;
                let conn = db.lock().unwrap();
                mail::mock::seed_account_if_empty(&conn, &a.email).map_err(std::io::Error::other)?;
                mail::mock::heal_demo_ics(&conn);
                mail::mock::ensure_demo_vectors(&conn).map_err(std::io::Error::other)?;
            }

            // One-time notice for accounts whose grant predates the v0.12
            // scope expansion (no recorded granted_scopes): they need a single
            // Disconnect → Connect to unlock Drive/Contacts/Calendar-write.
            // Delayed so the webview's notice listener is up.
            let mut legacy_grant_accounts: Vec<String> = vec![];
            for a in &accounts.accounts {
                if a.provider != "gmail" {
                    continue;
                }
                let db = dbs.account(&a.email).map_err(std::io::Error::other)?;
                let conn = db.lock().unwrap();
                let has_grant =
                    store::get_json::<String>(&conn, &format!("granted_scopes:{}", a.email))
                        .is_some();
                let shown =
                    store::get_json::<bool>(&conn, &format!("scope_notice_shown:{}", a.email))
                        == Some(true);
                if !has_grant && !shown {
                    let _ = store::set_json(&conn, &format!("scope_notice_shown:{}", a.email), &true);
                    legacy_grant_accounts.push(a.email.clone());
                }
            }
            if !legacy_grant_accounts.is_empty() {
                let notice_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                    let _ = notice_handle.emit(
                        "app:notice",
                        format!(
                            "New in this update: Drive attachments + contacts autocomplete. Reconnect {} in Settings → Account to grant access.",
                            legacy_grant_accounts.join(", ")
                        ),
                    );
                });
            }

            // allow a previously-configured celebration folder
            let settings = { store::get_settings(&dbs.global().lock().unwrap()) };
            if let Some(dir) = &settings.celebration_dir {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    let _ = app.asset_protocol_scope().allow_directory(p, false);
                }
            }

            let http = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .expect("http client");

            app.manage(AppState {
                dbs,
                migrating: AtomicBool::new(false),
                http,
                gmail: tokio::sync::Mutex::new(sessions),
                cancels: Mutex::new(HashMap::new()),
                drive_uploads: Mutex::new(HashMap::new()),
                drive_upload_seq: std::sync::atomic::AtomicU64::new(1),
                crawl_busy: AtomicBool::new(false),
                activity: Mutex::new(None),
                data_dir: data_dir.clone(),
                embedder: tokio::sync::Mutex::new(embed::Slot::Idle),
            });

            // Paint the badge from what's already on disk, before the first
            // sync lands — the taskbar shouldn't sit empty through boot when
            // the mailbox is right there.
            badge::refresh(app.handle());

            // Dev-only: SNAIL_AI_SMOKE=1 (legacy FISSION_AI_SMOKE) streams one
            // real draft at startup and logs the result — end-to-end proof of
            // context assembly + adapter + SSE parsing against the configured
            // default provider.
            #[cfg(debug_assertions)]
            if std::env::var("SNAIL_AI_SMOKE")
                .or_else(|_| std::env::var("FISSION_AI_SMOKE"))
                .is_ok()
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<AppState>();
                    let settings = store::get_settings(&state.global().lock().unwrap());
                    let p = match ai::resolve(&settings, None) {
                        Ok(p) => p,
                        Err(e) => return eprintln!("[ai-smoke] resolve: {e}"),
                    };
                    let req = DraftRequest {
                        thread_id: Some("t-term-sheet".into()),
                        instruction: "Summarize this thread in one short sentence.".into(),
                        existing_text: None,
                        provider_id: None,
                    };
                    let Ok((_, db)) = state.thread_db("t-term-sheet") else {
                        return eprintln!("[ai-smoke] demo thread not found");
                    };
                    let global = state.global();
                    let ctx = match ai::context::assemble(&global, &db, &state.http, &state.gmail, &req, false).await {
                        Ok(c) => c,
                        Err(e) => return eprintln!("[ai-smoke] assemble: {e}"),
                    };
                    let mut acc = String::new();
                    match ai::stream_draft(
                        &state.http,
                        &p,
                        &ctx,
                        |c| acc.push_str(&c),
                        Arc::new(AtomicBool::new(false)),
                    )
                    .await
                    {
                        Ok(()) => eprintln!(
                            "[ai-smoke] OK {} / {} — {} chars streamed: {}",
                            p.id,
                            p.model,
                            acc.len(),
                            acc.replace('\n', " ").chars().take(140).collect::<String>()
                        ),
                        Err(e) => eprintln!("[ai-smoke] stream: {e}"),
                    }
                });
            }

            // outbox processor: flushes due sends every 3s (10s undo window,
            // Send Later, and retry with a 5-attempt cap)
            let outbox_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let state = outbox_handle.state::<AppState>();
                    if state.migrating.load(Ordering::SeqCst) {
                        continue; // sends resume the moment the split finishes
                    }
                    let mut sent_any = false;
                    let snapshot = { store::get_accounts(&state.global().lock().unwrap()) };
                    for email in state.dbs.registered_emails() {
                        // A dead grant PARKS the account's queue: rows stay,
                        // attempts don't burn, and delivery resumes the moment
                        // a reconnect flips `connected` back. (The old loop
                        // burned 5 attempts in ~15s and silently deleted the
                        // mail.)
                        let deliverable = snapshot.accounts.iter().any(|a| {
                            a.email == email && !a.removing && (a.connected || a.provider != "gmail")
                        });
                        if !deliverable {
                            continue;
                        }
                        let Ok(db) = state.account_db(&email) else { continue };
                        let due = {
                            let conn = db.lock().unwrap();
                            store::outbox_due(&conn, now_ms())
                        };
                        for (id, account, mail) in due {
                            // While the legacy db still serves several accounts
                            // this loop sees every row once per email — only the
                            // owning pass may act.
                            if account != email {
                                continue;
                            }
                            // Claim before the async send so a concurrent
                            // Send-now (accelerate) can't also deliver this row.
                            let won = {
                                let conn = db.lock().unwrap();
                                store::outbox_claim(&conn, id)
                            };
                            if !won {
                                continue;
                            }
                            match deliver_mail(&outbox_handle, &account, &mail).await {
                                Ok(()) => {
                                    let conn = db.lock().unwrap();
                                    store::outbox_delete(&conn, id);
                                    sent_any = true;
                                }
                                Err(e) => {
                                    eprintln!("[outbox] send failed (will retry): {e}");
                                    let auth_dead =
                                        classify_sync_error(&outbox_handle, &account, &e).await;
                                    let attempts = {
                                        let conn = db.lock().unwrap();
                                        store::outbox_unclaim(&conn, id);
                                        // auth failures park without burning
                                        // attempts — the message isn't at fault
                                        if auth_dead {
                                            0
                                        } else {
                                            store::outbox_bump_attempts(&conn, id)
                                        }
                                    };
                                    if attempts == 5 {
                                        let _ = outbox_handle.emit(
                                            "app:notice",
                                            format!(
                                                "A message from {account} couldn't send after 5 tries — it stays queued and retries after a reconnect."
                                            ),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    if sent_any {
                        emit_mail_updated(&outbox_handle);
                    }
                }
            });

            // Split the legacy db first (progress-visible, resumable), then the
            // forced boot reconcile — the split never races live sync writes.
            let boot = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = boot.state::<AppState>();
                // Removals the previous session never finished complete FIRST,
                // so the migration below never copies an account that's being
                // torn down.
                let unfinished: Vec<String> = {
                    store::get_accounts(&state.global().lock().unwrap())
                        .accounts
                        .iter()
                        .filter(|a| a.removing)
                        .map(|a| a.email.clone())
                        .collect()
                };
                for email in unfinished {
                    eprintln!("[remove:{email}] finishing removal from the previous session");
                    finish_removal(boot.clone(), email).await;
                }
                let needs = {
                    let g = state.dbs.global();
                    let needs = {
                        let conn = g.lock().unwrap();
                        store::migrate::needs_migration(&conn, &state.dbs.data_dir)
                    };
                    needs
                };
                if needs {
                    state.migrating.store(true, Ordering::SeqCst);
                    let mig_handle = boot.clone();
                    let res = tauri::async_runtime::spawn_blocking(move || {
                        let state = mig_handle.state::<AppState>();
                        store::migrate::migrate_all(
                            &state.dbs,
                            &store::migrate::MigrateOpts::default(),
                            &mut |p| {
                                let _ = mig_handle.emit("migration:progress", &p);
                            },
                        )
                    })
                    .await;
                    match res {
                        Ok(Ok(true)) => eprintln!("[migrate] legacy db split complete"),
                        Ok(Ok(false)) => eprintln!("[migrate] incomplete — resumes next boot"),
                        Ok(Err(e)) => eprintln!("[migrate] {e} — will retry next boot"),
                        Err(e) => eprintln!("[migrate] task: {e}"),
                    }
                    state.migrating.store(false, Ordering::SeqCst);
                    let _ = boot.emit(
                        "migration:progress",
                        store::migrate::MigrateProgress {
                            email: String::new(),
                            table: "done".into(),
                            copied: 1,
                            total: 1,
                        },
                    );
                    emit_mail_updated(&boot);
                } else {
                    store::migrate::delete_bak_if_verified(&state.dbs);
                }
                // Remove account files no registered account derives to.
                spawn_account_file_sweep(boot.clone());
                // v0.23 backfill: pre-split-materialization rows classify in
                // the background (after the split so the two never compete).
                let needs_backfill = state.dbs.registered_emails().iter().any(|email| {
                    state
                        .account_db(email)
                        .map(|db| store::has_unclassified_threads(&db.lock().unwrap()))
                        .unwrap_or(false)
                });
                if needs_backfill {
                    spawn_reclassify(boot.clone(), true);
                }
                // One forced reconcile: refreshes the inbox immediately on
                // launch and sweeps server-side removals missed while closed.
                let on_progress = progress_callback(boot.clone());
                let mut changed = false;
                let mut lost: Vec<String> = vec![];
                {
                    let mut sessions = state.gmail.lock().await;
                    for (email, session) in sessions.iter_mut() {
                        let Ok(db) = state.account_db(email) else { continue };
                        match mail::sync::full_sync(
                            &state.http,
                            session,
                            &db,
                            email,
                            true,
                            mail::sync::SyncPass::Normal,
                            &on_progress,
                        )
                        .await
                        {
                            Ok(c) => changed |= c,
                            // The boot reconcile used to swallow this — a dead
                            // grant was invisible until the first 30s tick.
                            Err(e) => {
                                eprintln!("[boot-sync:{email}] {e}");
                                if is_grant_dead(&state.http, session, &e).await {
                                    lost.push(email.clone());
                                }
                            }
                        }
                    }
                    for email in &lost {
                        sessions.remove(email);
                    }
                }
                for email in &lost {
                    mark_auth_lost(&boot, email);
                }
                if changed {
                    emit_mail_updated(&boot);
                }
                emit_sync_progress(&boot);
            });

            // background loop: snooze wake-ups + Gmail sync every 30s, with a
            // full reconcile every ~10 min as the inbox-removal safety net
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut tick: u64 = 0;
                // only mail that arrives after boot notifies — no backlog blast
                let mut notify_watermark = now_ms();
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    tick += 1;
                    let state = handle.state::<AppState>();
                    if state.migrating.load(Ordering::SeqCst) {
                        continue; // the split owns the db this beat
                    }
                    // snooze wake-ups fan out per account file
                    let mut woke: Vec<(String, String)> = vec![];
                    for email in state.dbs.registered_emails() {
                        let Ok(db) = state.account_db(&email) else { continue };
                        let conn = db.lock().unwrap();
                        for id in store::wake_due_snoozes(&conn, now_ms()).unwrap_or_default() {
                            let owner = store::account_of_thread(&conn, &id).unwrap_or_else(|| email.clone());
                            if owner == email || !woke.iter().any(|(_, w)| w == &id) {
                                woke.push((owner, id));
                            }
                        }
                    }
                    woke.dedup_by(|a, b| a.1 == b.1);
                    let mut changed = !woke.is_empty();
                    let mut lost: Vec<String> = vec![];
                    {
                        let mut sessions = state.gmail.lock().await;
                        for (account, id) in &woke {
                            if is_mock_id(id) {
                                continue;
                            }
                            if let Some(session) = sessions.get_mut(account) {
                                let _ = session
                                    .modify_thread(&state.http, id, &["INBOX", "UNREAD"], &[])
                                    .await;
                            }
                        }
                        // Sync every tick (30s) for responsive two-way sync; a
                        // full reconcile every 20th tick (~10 min) sweeps inbox
                        // removals the incremental path can miss.
                        let force = tick % 20 == 0;
                        // A forced reconcile re-lists the whole inbox — stream it
                        // in (and keep the download bar live) like the boot pass.
                        // The plain incremental tick now reports too: it's the
                        // common case, and it was completely silent before.
                        let on_progress = progress_callback(handle.clone());
                        for (email, session) in sessions.iter_mut() {
                            let Ok(db) = state.account_db(email) else { continue };
                            match mail::sync::full_sync(
                                &state.http,
                                session,
                                &db,
                                email,
                                force,
                                mail::sync::SyncPass::Normal,
                                &on_progress,
                            )
                            .await
                            {
                                Ok(c) => changed |= c,
                                // Errors were silently discarded here — a dead
                                // refresh token meant mail just stopped, with
                                // no log line and no UI signal.
                                Err(e) => {
                                    eprintln!("[sync:{email}] {e}");
                                    if is_grant_dead(&state.http, session, &e).await {
                                        lost.push(email.clone());
                                    }
                                }
                            }
                        }
                        for email in &lost {
                            sessions.remove(email);
                        }
                    }
                    for email in &lost {
                        mark_auth_lost(&handle, email);
                    }
                    // History crawl: one page per tick toward a fully-indexed
                    // mailbox (guarded against overlap; skips reconcile ticks
                    // to leave them their quota headroom).
                    if tick % 20 != 0 {
                        spawn_history_crawl(handle.clone());
                    }
                    // Calendar sync: 30s after boot, then every ~5 min — an
                    // incremental syncToken pull per calendar (initial pass
                    // fetches -30d..+365d), so the panel paints instantly
                    // from SQLite. The same beat checks whether each
                    // account's Google contacts are >24h stale.
                    if tick % 10 == 1 {
                        let emails: Vec<String> = {
                            store::get_accounts(&state.global().lock().unwrap())
                                .accounts
                                .iter()
                                // a dead grant can't sync calendars/contacts;
                                // spawning doomed passes just spams the panel
                                .filter(|a| a.provider == "gmail" && a.connected && !a.removing)
                                .map(|a| a.email.clone())
                                .collect()
                        };
                        for email in &emails {
                            let Ok(db) = state.account_db(email) else { continue };
                            let (stale, has_contacts_scope) = {
                                let conn = db.lock().unwrap();
                                let stale = store::get_json::<i64>(
                                    &conn,
                                    &format!("people_synced:{email}"),
                                )
                                .map(|at| now_ms() - at > DAY_MS)
                                .unwrap_or(true);
                                // No contacts grant → a sync can never succeed;
                                // don't re-spawn a doomed call every 5 minutes.
                                let has_scope = store::get_json::<String>(
                                    &conn,
                                    &format!("granted_scopes:{email}"),
                                )
                                .map(|g| {
                                    scope_granted(&g, "https://www.googleapis.com/auth/contacts.readonly")
                                        || scope_granted(&g, "https://www.googleapis.com/auth/contacts.other.readonly")
                                })
                                .unwrap_or(false);
                                (stale, has_scope)
                            };
                            if stale && has_contacts_scope {
                                spawn_people_sync(handle.clone(), email.clone());
                            }
                        }
                        for email in emails {
                            spawn_calendar_sync(handle.clone(), email, true);
                        }
                    }
                    if changed {
                        emit_mail_updated(&handle);
                        notify_new_mail(&handle, notify_watermark);
                        notify_watermark = now_ms();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_accounts,
            switch_account,
            reorder_accounts,
            get_capabilities,
            has_gmail_client,
            start_oauth,
            disconnect_account,
            sync_now,
            resync_account,
            get_sync_activity,
            list_threads,
            get_thread,
            refetch_message_body,
            search_threads,
            threads_with_contact,
            list_labels,
            archive_thread,
            move_to_inbox,
            hide_thread,
            restore_thread,
            mute_thread,
            unmute_thread,
            unsubscribe_thread,
            toggle_star,
            snooze_thread,
            mark_unread,
            mark_read,
            move_label,
            bulk_archive,
            queue_mail,
            cancel_outbox,
            send_mail_now,
            send_outbox_now,
            download_attachment,
            open_attachment,
            drive_search,
            drive_download_attach,
            drive_upload_begin,
            drive_upload_chunk,
            drive_upload_cancel,
            drive_share,
            save_draft,
            list_drafts,
            delete_draft,
            get_profile,
            set_profile_photo,
            list_events,
            refresh_calendar,
            list_calendars,
            create_event,
            update_event,
            delete_event,
            rsvp_event,
            thread_invite,
            get_daily_photo,
            photo_shown,
            set_unsplash_key,
            lint_text,
            search_contacts,
            refresh_contacts,
            get_send_as,
            search_all,
            load_older,
            get_settings,
            save_settings,
            split_counts,
            preview_split,
            get_knowledge_base,
            save_knowledge_base,
            set_ai_key,
            test_ai_provider,
            ai_draft,
            cancel_ai,
            ai_suggest_replies,
            get_streaks,
            record_zero,
            list_celebration_images,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Snail Mail");
}

// ------------------------------------------------------------- db migration

/// One-time data-dir hop across bundle-identifier renames. When `data_dir`
/// (com.snail.mail) has no fission.db yet, copy the db + WAL sidecars from the
/// most recent previous identifier's dir that has one: com.fission.mail first,
/// then com.zenbox.mail (whose files were still named zenbox.db*). The db
/// filename intentionally stays fission.db — renaming it buys nothing and
/// risks live data. Keychain secrets migrate lazily in secrets::get.
fn migrate_legacy_db(data_dir: &std::path::Path) {
    if data_dir.join("fission.db").exists() {
        return;
    }
    let Some(parent) = data_dir.parent() else { return };
    // Newest identifier first: a machine that lived through the previous
    // rename has both dirs, and com.fission.mail holds the current data.
    for (dir, base) in [("com.fission.mail", "fission.db"), ("com.zenbox.mail", "zenbox.db")] {
        let old_dir = parent.join(dir);
        if !old_dir.join(base).exists() {
            continue;
        }
        for suffix in ["", "-wal", "-shm"] {
            let src = old_dir.join(format!("{base}{suffix}"));
            if src.exists() {
                let _ = std::fs::copy(&src, data_dir.join(format!("fission.db{suffix}")));
            }
        }
        return;
    }
}

#[cfg(test)]
mod activity_gate_tests {
    use super::{ActivityGate, ACTIVITY_MIN_GAP_MS};
    use crate::mail::sync::{SyncStage, SyncTick};

    fn tick(done: usize, total: usize) -> SyncTick {
        SyncTick {
            account: "a@x.test".into(),
            stage: SyncStage::ReconcileInbox,
            done,
            total,
        }
    }

    #[test]
    fn coalesces_mid_pass_ticks() {
        let gate = ActivityGate::new();
        // first tick of a pass always lands (last_ms starts at 0)
        assert!(gate.allows(&tick(1, 500)));
        // the burst behind it is dropped — a 500-thread reconcile must not
        // push 500 events at the webview
        assert!(!gate.allows(&tick(2, 500)));
        assert!(!gate.allows(&tick(3, 500)));
    }

    #[test]
    fn terminal_tick_always_emits() {
        let gate = ActivityGate::new();
        assert!(gate.allows(&tick(1, 30)));
        assert!(!gate.allows(&tick(2, 30)), "mid-pass tick should be coalesced");
        // Swallowing this one would freeze the pill at "2 of 30" forever with
        // no completion to fade on — it must pass the gate no matter how
        // recently we emitted.
        assert!(gate.allows(&tick(30, 30)));
    }

    #[test]
    fn empty_pass_reports_so_a_stale_pill_clears() {
        let gate = ActivityGate::new();
        assert!(gate.allows(&tick(0, 0)));
    }

    #[test]
    fn gap_is_a_sane_cadence() {
        // ~4/s: fast enough to read as live, slow enough to be free
        assert!((100..=500).contains(&(ACTIVITY_MIN_GAP_MS as u64)));
    }
}

#[cfg(test)]
mod auth_classification_tests {
    use super::is_auth_revoked;

    #[test]
    fn invalid_grant_classifies_regardless_of_wrapper() {
        // the refresh endpoint's error, as oauth::refresh_access_token formats it
        assert!(is_auth_revoked(
            r#"token refresh failed (400 Bad Request): {"error": "invalid_grant", "error_description": "Token has been expired or revoked."}"#
        ));
        // the same marker surviving inside another surface's wrapper
        assert!(is_auth_revoked("calendar sync: token refresh failed (400): invalid_grant"));
    }

    #[test]
    fn non_auth_failures_do_not_classify() {
        // a bare 401 alone is NOT proof of a dead grant — only the forced
        // refresh probe (is_grant_dead) may promote it
        assert!(!is_auth_revoked(r#"Gmail API error (401 Unauthorized): {"error": {"code": 401, "message": "Invalid Credentials", "status": "UNAUTHENTICATED"}}"#));
        assert!(!is_auth_revoked("Gmail API error (403 Forbidden): accessNotConfigured"));
        assert!(!is_auth_revoked("Gmail request failed (network)"));
        assert!(!is_auth_revoked("Gmail API rate-limited; try again shortly"));
        // a scope problem is fixable by re-consent, not a revoked grant
        assert!(!is_auth_revoked("token refresh failed (400): invalid_scope"));
    }

    #[test]
    fn outbox_rows_park_instead_of_being_destroyed() {
        let conn = crate::store::open(std::path::Path::new(":memory:")).unwrap();
        let mail = crate::types::OutgoingMail {
            to: vec!["x@y.test".into()],
            cc: vec![],
            bcc: vec![],
            subject: "s".into(),
            body_text: "b".into(),
            body_html: None,
            reply_all: false,
            attachments: vec![],
            thread_id: None,
        };
        let id = crate::store::outbox_add(&conn, "a@x.test", &mail, 0).unwrap();
        // five failed deliveries: the row must survive (the old code deleted it)
        for want in 1..=5i64 {
            assert_eq!(crate::store::outbox_bump_attempts(&conn, id), want);
        }
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "parked, not destroyed");
        // at the cap it is no longer offered for delivery…
        assert!(crate::store::outbox_due(&conn, now()).is_empty());
        // …until a reconnect resets it
        crate::store::outbox_reset_attempts(&conn, "a@x.test");
        assert_eq!(crate::store::outbox_due(&conn, now()).len(), 1);
    }

    fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

#[cfg(test)]
mod migration_tests {
    use super::migrate_legacy_db;
    use std::fs;
    use std::path::PathBuf;

    /// Fresh scratch parent dir per test, mimicking the OS app-data root that
    /// holds one subdir per bundle identifier.
    fn appdata_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join("snail-db-hop-tests").join(name);
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn seed(root: &PathBuf, identifier: &str, files: &[(&str, &str)]) {
        let dir = root.join(identifier);
        fs::create_dir_all(&dir).unwrap();
        for (name, content) in files {
            fs::write(dir.join(name), content).unwrap();
        }
    }

    fn read(root: &PathBuf, rel: &str) -> Option<String> {
        fs::read_to_string(root.join("com.snail.mail").join(rel)).ok()
    }

    #[test]
    fn copies_fission_db_and_sidecars_from_previous_identifier_dir() {
        let root = appdata_root("from-fission");
        seed(&root, "com.fission.mail", &[
            ("fission.db", "db-bytes"),
            ("fission.db-wal", "wal-bytes"),
            ("fission.db-shm", "shm-bytes"),
        ]);
        let data_dir = root.join("com.snail.mail");
        fs::create_dir_all(&data_dir).unwrap();
        migrate_legacy_db(&data_dir);
        assert_eq!(read(&root, "fission.db").as_deref(), Some("db-bytes"));
        assert_eq!(read(&root, "fission.db-wal").as_deref(), Some("wal-bytes"));
        assert_eq!(read(&root, "fission.db-shm").as_deref(), Some("shm-bytes"));
    }

    #[test]
    fn chains_back_to_zenbox_when_no_fission_dir_exists() {
        let root = appdata_root("from-zenbox");
        seed(&root, "com.zenbox.mail", &[
            ("zenbox.db", "zen-db"),
            ("zenbox.db-wal", "zen-wal"),
        ]);
        let data_dir = root.join("com.snail.mail");
        fs::create_dir_all(&data_dir).unwrap();
        migrate_legacy_db(&data_dir);
        // zenbox files land under the current fission.db name
        assert_eq!(read(&root, "fission.db").as_deref(), Some("zen-db"));
        assert_eq!(read(&root, "fission.db-wal").as_deref(), Some("zen-wal"));
        // missing sidecar is tolerated, not invented
        assert_eq!(read(&root, "fission.db-shm"), None);
    }

    #[test]
    fn prefers_fission_over_zenbox_when_both_exist() {
        let root = appdata_root("prefers-fission");
        seed(&root, "com.zenbox.mail", &[("zenbox.db", "stale")]);
        seed(&root, "com.fission.mail", &[("fission.db", "current")]);
        let data_dir = root.join("com.snail.mail");
        fs::create_dir_all(&data_dir).unwrap();
        migrate_legacy_db(&data_dir);
        assert_eq!(read(&root, "fission.db").as_deref(), Some("current"));
    }

    #[test]
    fn never_overwrites_an_existing_db() {
        let root = appdata_root("no-overwrite");
        seed(&root, "com.fission.mail", &[("fission.db", "old-machine-state")]);
        seed(&root, "com.snail.mail", &[("fission.db", "live")]);
        migrate_legacy_db(&root.join("com.snail.mail"));
        assert_eq!(read(&root, "fission.db").as_deref(), Some("live"));
    }

    #[test]
    fn fresh_install_with_no_legacy_dirs_is_a_no_op() {
        let root = appdata_root("fresh");
        let data_dir = root.join("com.snail.mail");
        fs::create_dir_all(&data_dir).unwrap();
        migrate_legacy_db(&data_dir);
        assert_eq!(read(&root, "fission.db"), None);
    }
}
