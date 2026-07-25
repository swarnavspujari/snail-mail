//! SQLite persistence: threads/messages/attachments, JSON settings blobs,
//! an FTS5 index for instant full-text search, and a sqlite-vec table for
//! semantic (vector) search.
pub mod migrate;
pub mod registry;
pub mod vec;

use crate::types::*;
use rusqlite::{params, Connection};
use std::collections::HashMap;

/// sqlite-vec's vec0 module rides every connection opened after this via
/// SQLite's process-global auto-extension hook. Every opener (account files,
/// the global db, tests) must route through here so no connection kind can
/// miss the hook.
pub fn register_vec_extension() {
    static VEC_INIT: std::sync::Once = std::sync::Once::new();
    VEC_INIT.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

/// The app-wide db (`global.db`): kv only — `settings`, `accounts`, `streaks`,
/// `kb`, and the other non-account keys. Account mail never lives here.
pub fn open_global(path: &std::path::Path) -> Result<Connection, String> {
    register_vec_extension();
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Deterministic on-disk name for an account's db: readable sanitized prefix
/// plus a stable hash, so the boot sweep can derive the expected file set
/// straight from the registry. FNV-1a by hand — std's DefaultHasher isn't
/// stable across Rust releases and these names must never change.
pub fn account_db_filename(email: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in email.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    let stem: String = email
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '_' })
        .take(40)
        .collect();
    format!("{stem}-{hash:016x}.db")
}

pub fn open(path: &std::path::Path) -> Result<Connection, String> {
    register_vec_extension();
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            subject TEXT NOT NULL DEFAULT '',
            snippet TEXT NOT NULL DEFAULT '',
            participants TEXT NOT NULL DEFAULT '[]',
            message_count INTEGER NOT NULL DEFAULT 0,
            last_date INTEGER NOT NULL DEFAULT 0,
            unread INTEGER NOT NULL DEFAULT 0,
            starred INTEGER NOT NULL DEFAULT 0,
            labels TEXT NOT NULL DEFAULT '[]',
            in_inbox INTEGER NOT NULL DEFAULT 1,
            snoozed_until INTEGER,
            history_id TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            from_addr TEXT NOT NULL DEFAULT '',
            from_name TEXT NOT NULL DEFAULT '',
            to_addrs TEXT NOT NULL DEFAULT '[]',
            cc_addrs TEXT NOT NULL DEFAULT '[]',
            subject TEXT NOT NULL DEFAULT '',
            snippet TEXT NOT NULL DEFAULT '',
            body_text TEXT NOT NULL DEFAULT '',
            body_html TEXT,
            date INTEGER NOT NULL DEFAULT 0,
            unread INTEGER NOT NULL DEFAULT 0,
            rfc_message_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

        CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime_type TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            remote_id TEXT,
            text_content TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

        CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
            thread_id UNINDEXED,
            subject,
            from_text,
            body
        );
        "#,
    )
    .map_err(|e| e.to_string())?;

    // v0.2 migration: per-account mail. Errors mean the column already exists.
    let _ = conn.execute(
        "ALTER TABLE threads ADD COLUMN account_id TEXT NOT NULL DEFAULT 'demo@fission.local'",
        [],
    );
    // v0.3 migrations: soft trash/spam, unsubscribe header, scheduled sends.
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN hidden TEXT", []);
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN list_unsubscribe TEXT", []);
    // v0.5 migrations: inline-image cids + cached attachment bytes, drafts.
    let _ = conn.execute("ALTER TABLE attachments ADD COLUMN content_id TEXT", []);
    let _ = conn.execute("ALTER TABLE attachments ADD COLUMN data BLOB", []);
    // v0.13: outbox "claimed" flag — a row is claimed before its (async) network
    // send so the 3s processor and Send-now (accelerate) can never both deliver
    // it, and Undo can't cancel a send already in flight.
    let _ = conn.execute(
        "ALTER TABLE outbox ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // v0.16: invite mail — the raw iCalendar payload (text/calendar part or
    // .ics attachment) captured at sync so the RSVP bar detects invites
    // without refetching the message.
    let _ = conn.execute("ALTER TABLE messages ADD COLUMN ics_data TEXT", []);
    // v0.23: split membership is materialized at sync time (splits.rs), and
    // threads carry their recipients so `to:` queries can match. NULL split_id
    // = not yet classified; the boot pass backfills. The composite index also
    // finally covers the hot account_id predicates (list/count/purge).
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]'", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN split_id TEXT", []);
    let _ = conn.execute("ALTER TABLE threads ADD COLUMN split_also TEXT NOT NULL DEFAULT '[]'", []);
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_threads_account_split ON threads(account_id, split_id)",
        [],
    );
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS drafts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            send_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            claimed INTEGER NOT NULL DEFAULT 0
        );",
    )
    .map_err(|e| e.to_string())?;
    // v0.9: Gmail label id → display name, refreshed on reconcile so opaque
    // Label_… ids resolve to names on read.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS labels (
            account_id TEXT NOT NULL,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            PRIMARY KEY (account_id, id)
        );",
    )
    .map_err(|e| e.to_string())?;
    // v0.9: local-first calendar — events cache read by the panel/week view,
    // refreshed in the background (mirrors the mail read/sync split).
    // v0.16: full event model + per-calendar syncToken sync. The old PRIMARY
    // KEY (account_id, id) can't key per-calendar upserts (the same event id
    // appears on every attendee's calendar), and SQLite can't ALTER a PK —
    // but events is a pure cache the next sync beat rebuilds, so the one
    // schema change that can't ride a guarded ALTER drops and recreates.
    let events_v16: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'calendar_id'")
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);
    if !events_v16 {
        conn.execute_batch("DROP TABLE IF EXISTS events;").map_err(|e| e.to_string())?;
        // stale full-window bookmarks would suppress the first refetch
        conn.execute("DELETE FROM kv WHERE key LIKE 'cal_window:%'", [])
            .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events (
            account_id TEXT NOT NULL,
            calendar_id TEXT NOT NULL DEFAULT '',
            id TEXT NOT NULL,
            calendar TEXT NOT NULL DEFAULT '',
            color TEXT,
            title TEXT NOT NULL DEFAULT '',
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            all_day INTEGER NOT NULL DEFAULT 0,
            location TEXT,
            description TEXT,
            html_link TEXT,
            etag TEXT,
            status TEXT NOT NULL DEFAULT 'confirmed',
            organizer_email TEXT,
            organizer_self INTEGER NOT NULL DEFAULT 0,
            recurring_event_id TEXT,
            hangout_link TEXT,
            attendees TEXT NOT NULL DEFAULT '[]',
            access_role TEXT NOT NULL DEFAULT 'reader',
            ical_uid TEXT,
            PRIMARY KEY (account_id, calendar_id, id)
        );
        CREATE INDEX IF NOT EXISTS idx_events_time ON events(account_id, start_ms);
        CREATE INDEX IF NOT EXISTS idx_events_ical ON events(account_id, ical_uid);",
    )
    .map_err(|e| e.to_string())?;
    // v0.9: contact index for recipient autocomplete, derived from every
    // person the account has corresponded with (senders + recipients). freq
    // ranks how often they appear; last_seen breaks ties toward recency.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS contacts (
            account_id TEXT NOT NULL,
            email TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            freq INTEGER NOT NULL DEFAULT 0,
            last_seen INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, email)
        );
        CREATE INDEX IF NOT EXISTS idx_contacts_rank ON contacts(account_id, freq);",
    )
    .map_err(|e| e.to_string())?;
    // Backfill the index once from mail that synced before this version.
    // Idempotent + gated so it doesn't rescan on every launch.
    if get_json::<bool>(&conn, "contacts_built_v1") != Some(true) {
        backfill_contacts(&conn)?;
        let _ = set_json(&conn, "contacts_built_v1", &true);
    }
    // v0.15: Google People API contacts (saved / other / directory), synced
    // per account+source and merged into recipient autocomplete alongside the
    // mail-derived index above. Replace-on-sync, so no freq/recency columns.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS people_contacts (
            account_id TEXT NOT NULL,
            source TEXT NOT NULL,
            email TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            photo_url TEXT,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, source, email)
        );",
    )
    .map_err(|e| e.to_string())?;
    // Search Phase 4: semantic vectors. mail_vec holds one normalized
    // 384-dim embedding per message; vec_meta is its plain-table bookkeeping
    // mirror (which message/thread/account a vector belongs to and which
    // model produced it) — a vec0 table can't be LEFT-JOINed efficiently to
    // answer "which messages still need embedding".
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS mail_vec USING vec0(
             embedding float[384] distance_metric=cosine
         );
         CREATE TABLE IF NOT EXISTS vec_meta (
             vec_rowid INTEGER PRIMARY KEY,
             message_id TEXT NOT NULL UNIQUE,
             thread_id TEXT NOT NULL,
             account_id TEXT NOT NULL,
             model TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_vec_meta_thread ON vec_meta(thread_id);
         CREATE INDEX IF NOT EXISTS idx_vec_meta_account ON vec_meta(account_id);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub const DEMO_ACCOUNT: &str = "demo@fission.local";
pub const DEMO_ACCOUNT_2: &str = "angel@fission.local";

pub fn get_accounts(conn: &Connection) -> AccountsState {
    if let Some(state) = get_json::<AccountsState>(conn, "accounts") {
        if !state.accounts.is_empty() {
            return state;
        }
    }
    // migrate v0.1's single-account kv, else fall back to the demo pair
    if let Some(old) = get_json::<AccountInfo>(conn, "account") {
        if old.provider == "gmail" {
            let state = AccountsState { active: old.email.clone(), accounts: vec![old] };
            let _ = set_json(conn, "accounts", &state);
            return state;
        }
    }
    AccountsState {
        accounts: vec![
            AccountInfo { email: DEMO_ACCOUNT.into(), provider: "mock".into(), connected: true },
            AccountInfo { email: DEMO_ACCOUNT_2.into(), provider: "mock".into(), connected: true },
        ],
        active: DEMO_ACCOUNT.into(),
    }
}

pub fn save_accounts(conn: &Connection, state: &AccountsState) -> Result<(), String> {
    set_json(conn, "accounts", state)
}

// ---------------------------------------------------------------- kv (JSON)

pub fn get_json<T: serde::de::DeserializeOwned>(conn: &Connection, key: &str) -> Option<T> {
    conn.query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|s| serde_json::from_str(&s).ok())
}

pub fn set_json<T: serde::Serialize>(conn: &Connection, key: &str, value: &T) -> Result<(), String> {
    let s = serde_json::to_string(value).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO kv(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, s],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- defaults

pub fn default_settings() -> Settings {
    let mut shortcuts = HashMap::new();
    for (k, v) in [
        ("palette.open", "mod+k"),
        ("compose", "c"),
        ("thread.done", "e"),
        ("thread.snooze", "h"),
        ("thread.reply", "r"),
        ("thread.forward", "f"),
        ("thread.replyAllOrOpen", "enter"),
        // J/K change conversation; arrows scroll the open email (reader) or
        // move the cursor (list). v0.11 dropped down/up from list.next/prev.
        ("list.next", "j"),
        ("list.prev", "k"),
        ("list.cursorDown", "down"),
        ("list.cursorUp", "up"),
        ("reader.lineDown", "down"),
        ("reader.lineUp", "up"),
        ("reader.pageUp", "shift+space"),
        // Multi-message threads: ↓/↑ step the per-message cursor, Enter drills
        // into the focused message. Share keys with reader.lineDown/Up and
        // thread.replyAllOrOpen; the front-end `when` (>1 message) + command
        // order pick the winner. Parity with defaults.ts.
        ("thread.focusNext", "down"),
        ("thread.focusPrev", "up"),
        ("thread.focusEnter", "enter"),
        ("thread.unread", "u"),
        // V = Move, L = Add/Remove Label in Superhuman; both open our picker.
        ("thread.move", "v|l"),
        ("thread.replyAll", "a"),
        ("thread.star", "s"),
        ("thread.trash", "#|delete|backspace"),
        ("thread.spam", "!"),
        // Shift+M matches Superhuman; bare M is reserved for their Comment key.
        ("thread.mute", "shift+m"),
        ("thread.notDone", "shift+e"),
        ("thread.unsubscribe", "mod+u"),
        ("undo", "z|mod+z"),
        ("search", "/"),
        ("ai.ask", "?"),
        ("split.next", "tab"),
        ("split.prev", "shift+tab"),
        // Bare "1" mirrors calendar.open's "2": 1 = Inbox, 2 = Calendar.
        ("goto.inbox", "g i|1"),
        ("goto.other", "g o"),
        ("goto.done", "g e"),
        ("goto.reminders", "g h"),
        ("goto.starred", "g s"),
        // Superhuman's Trash chord is G-#; G-T stays ours until a Sent view lands.
        ("goto.trash", "g t|g #"),
        ("goto.drafts", "g d"),
        ("compose.ai", "mod+j"),
        ("compose.send", "mod+enter"),
        ("compose.sendDone", "mod+shift+enter"),
        ("compose.sendLater", "mod+shift+l"),
        ("compose.snippet", "mod+;"),
        ("compose.expandTo", "mod+shift+o"),
        ("compose.expandCc", "mod+shift+c"),
        ("compose.expandBcc", "mod+shift+b"),
        ("compose.expandSubject", "mod+shift+s"),
        // D = Drive (v0.15). Superhuman has no equivalent key.
        ("compose.attachDrive", "mod+shift+d"),
        // Discard the draft. Shift+"," is "<" in KeyboardEvent.key, so the
        // physical Ctrl+Shift+, arrives as "mod+<"; "mod+shift+," is the label.
        ("compose.discard", "mod+shift+,|mod+<"),
        // New-message composer nav (v0.12) — parity with defaults.ts so the
        // desktop app binds K/J, not just the header chevrons.
        ("compose.prevEmail", "k"),
        ("compose.nextEmail", "j"),
        // Accelerate a pending send (skip the Undo Send window).
        ("send.accelerate", "mod+shift+z"),
        ("theme.toggle", ""),
        // Superhuman calendar keys: 0 = day panel, 2 = week view; -/= move
        // days while the calendar owns focus (←/→ still work).
        ("calendar.toggle", "0"),
        ("calendar.open", "g c|2"),
        ("calendar.prevDay", "left|-"),
        ("calendar.nextDay", "right|="),
        ("calendar.today", ""),
        // B = Create Event, matching Superhuman (C stays Compose).
        ("calendar.newEvent", "b"),
        ("sidebar.toggle", ""),
        ("shortcutBar.toggle", ""),
        ("shortcuts.show", ""),
        ("list.selectAll", "mod+a"),
        ("list.toggleSelect", "x"),
        ("thread.cycleSuggestion", "tab"),
        ("thread.scrollDown", "space"),
        ("back", "escape"),
        ("inbox.zeroSweep", ""),
        ("sync.now", ""),
        ("sync.resync", ""),
        ("update.check", ""),
        ("settings.open", "mod+,"),
        // Alt+N leaves Ctrl+N free for browser-muscle-memory shortcuts and
        // matches the user's preference (v0.6 change; mod+N was the default
        // through v0.5 — get_settings migrates saved copies).
        ("account.1", "alt+1"),
        ("account.2", "alt+2"),
        ("account.3", "alt+3"),
        ("account.4", "alt+4"),
        ("account.5", "alt+5"),
        ("account.6", "alt+6"),
        ("account.7", "alt+7"),
        ("account.8", "alt+8"),
        ("account.9", "alt+9"),
    ] {
        shortcuts.insert(k.to_string(), v.to_string());
    }
    Settings {
        splits: vec![
            Split {
                id: "important".into(),
                name: "Important".into(),
                builtin: true,
                query: "label:IMPORTANT".into(),
                account_id: None,
                also_show: false,
                hide_when_empty: false,
                rules: vec![],
                op: "or".into(),
            },
            Split {
                id: "other".into(),
                name: "Other".into(),
                builtin: true,
                query: String::new(), // empty query = catch-all
                account_id: None,
                also_show: false,
                hide_when_empty: false,
                rules: vec![],
                op: "or".into(),
            },
            // the builtin "Calendar" split became the side panel in v0.7;
            // get_settings drops saved copies on read
        ],
        // NIM/DeepSeek is the default because it's the key the user supplied;
        // switch to Claude/OpenAI any time in Settings.
        default_ai_provider: "nim".into(),
        providers: vec![
            AiProviderConfig {
                id: "claude".into(),
                label: "Claude".into(),
                model: "claude-sonnet-5".into(),
                base_url: None,
                has_key: false,
            },
            AiProviderConfig {
                id: "openai".into(),
                label: "OpenAI".into(),
                model: "gpt-5.2".into(),
                base_url: None,
                has_key: false,
            },
            AiProviderConfig {
                id: "nim".into(),
                label: "NVIDIA NIM".into(),
                model: "deepseek-ai/deepseek-v4-pro".into(),
                base_url: Some("https://integrate.api.nvidia.com/v1".into()),
                has_key: false,
            },
        ],
        celebration_dir: None,
        shortcuts,
        signatures: HashMap::new(),
        theme: "dark".into(),
        notifications: true,
        onboarded: false,
        calendar_open: false,
        hidden_calendars: Vec::new(),
        sidebar_open: false,
        show_shortcut_bar: true,
        undo_send_seconds: 10,
        drive_auto_upload: "ask".into(),
        drive_share_mode: "recipients".into(),
        embeddings: "local".into(),
    }
}

/// Saved settings merged with defaults, so upgrades gain new shortcuts and
/// providers without wiping user customization. `has_key` always reflects
/// the keychain, not a stored flag (keys can be seeded/removed out-of-band).
pub fn get_settings(conn: &Connection) -> Settings {
    let defaults = default_settings();
    let mut s = match get_json::<Settings>(conn, "settings") {
        None => defaults,
        Some(mut s) => {
            for (k, v) in defaults.shortcuts {
                s.shortcuts.entry(k).or_insert(v);
            }
            // v0.6: account switching moved mod+N → alt+N. Migrate saved
            // copies that still hold the old default; custom remaps survive.
            for n in 1..=9 {
                let key = format!("account.{n}");
                if let Some(v) = s.shortcuts.get_mut(&key) {
                    if *v == format!("mod+{n}") {
                        *v = format!("alt+{n}");
                    }
                }
            }
            // v0.9: Delete/Backspace joined "#" as trash defaults. Upgrade
            // saved copies still on the old default; custom remaps survive.
            if let Some(v) = s.shortcuts.get_mut("thread.trash") {
                if v == "#" {
                    *v = "#|delete|backspace".into();
                }
            }
            // v0.11: arrows now scroll the reader / move the list cursor, so
            // they leave j/k. Drop the old down/up alias from saved copies on
            // the old default; custom remaps survive.
            if let Some(v) = s.shortcuts.get_mut("list.next") {
                if v == "j|down" {
                    *v = "j".into();
                }
            }
            if let Some(v) = s.shortcuts.get_mut("list.prev") {
                if v == "k|up" {
                    *v = "k".into();
                }
            }
            // v0.14: Superhuman-parity keys — Shift+M mutes (M is reserved
            // for their Comment key), L opens the label picker, G-# reaches
            // Trash, and 0/2/-/= drive the calendar. Saved copies still on
            // the old defaults upgrade; custom remaps survive.
            for (key, old, new_v) in [
                ("thread.mute", "m", "shift+m"),
                ("thread.move", "v", "v|l"),
                ("goto.trash", "g t", "g t|g #"),
                ("calendar.toggle", "", "0"),
                ("calendar.open", "g c", "g c|2"),
                ("calendar.prevDay", "left", "left|-"),
                ("calendar.nextDay", "right", "right|="),
                // v0.16.x: bare "1" = Inbox (mirrors "2" = Calendar).
                ("goto.inbox", "g i", "g i|1"),
            ] {
                if let Some(v) = s.shortcuts.get_mut(key) {
                    if v == old {
                        *v = new_v.into();
                    }
                }
            }
            for p in defaults.providers {
                if !s.providers.iter().any(|x| x.id == p.id) {
                    s.providers.push(p);
                }
            }
            // v0.7 (drop builtin Calendar) + v0.23 (rules -> query language)
            migrate_splits(&mut s.splits);
            s
        }
    };
    for p in s.providers.iter_mut() {
        if let Some(entry) = crate::secrets::ai_key_entry(&p.id) {
            p.has_key = crate::secrets::get(entry).is_some();
        }
    }
    s
}

pub fn get_kb(conn: &Connection) -> KnowledgeBase {
    get_json(conn, "kb").unwrap_or(KnowledgeBase {
        instructions: String::new(),
        snippets: vec![],
        voice_examples: vec![],
    })
}

pub fn get_streaks(conn: &Connection) -> Streaks {
    get_json(conn, "streaks").unwrap_or(Streaks { daily: 0, weekly: 0, last_zero_day: None })
}

pub fn active_account(conn: &Connection) -> AccountInfo {
    let state = get_accounts(conn);
    state
        .accounts
        .iter()
        .find(|a| a.email == state.active)
        .cloned()
        .unwrap_or_else(|| state.accounts[0].clone())
}

// ---------------------------------------------------------------- rows

fn row_to_thread(r: &rusqlite::Row) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: r.get(0)?,
        subject: r.get(1)?,
        snippet: r.get(2)?,
        participants: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
        message_count: r.get(4)?,
        last_date: r.get(5)?,
        unread: r.get::<_, i64>(6)? != 0,
        starred: r.get::<_, i64>(7)? != 0,
        labels: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
        in_inbox: r.get::<_, i64>(9)? != 0,
        snoozed_until: r.get(10)?,
        recipients: serde_json::from_str(&r.get::<_, String>(11)?).unwrap_or_default(),
        // NULL = pre-migration row the boot pass hasn't reached; the UI files
        // "" under the catch-all until then.
        split: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
        also_in: serde_json::from_str(&r.get::<_, String>(13)?).unwrap_or_default(),
    })
}

const THREAD_COLS: &str = "id, subject, snippet, participants, message_count, last_date, unread, starred, labels, in_inbox, snoozed_until, recipients, split_id, split_also";

pub fn list_threads(conn: &Connection, view: &str, account_id: &str) -> Result<Vec<Thread>, String> {
    // Every view except trash hides soft-deleted rows; trash IS those rows.
    let where_clause = match view {
        "inbox" => "in_inbox = 1 AND snoozed_until IS NULL AND hidden IS NULL",
        "reminders" => "snoozed_until IS NOT NULL AND hidden IS NULL",
        "starred" => "starred = 1 AND hidden IS NULL",
        "trash" => "hidden = 'trash'",
        _ => "in_inbox = 0 AND snoozed_until IS NULL AND hidden IS NULL",
    };
    let sql = format!(
        "SELECT {THREAD_COLS} FROM threads WHERE {where_clause} AND account_id = ?1 ORDER BY last_date DESC LIMIT 500"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id], row_to_thread)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Threads carrying a label, by display name (json_each is quote-safe where
/// a LIKE pattern is not).
pub fn list_threads_by_label(
    conn: &Connection,
    label: &str,
    account_id: &str,
) -> Result<Vec<Thread>, String> {
    let sql = format!(
        "SELECT {THREAD_COLS} FROM threads
         WHERE account_id = ?1 AND hidden IS NULL
           AND EXISTS (SELECT 1 FROM json_each(threads.labels) WHERE json_each.value = ?2)
         ORDER BY last_date DESC LIMIT 500"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id, label], row_to_thread)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

pub fn account_of_thread(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT account_id FROM threads WHERE id = ?1", params![id], |r| r.get(0))
        .ok()
}

/// How many threads are stored locally for an account — the numerator of the
/// "downloading mail history" progress (denominator is Gmail's threadsTotal).
/// Counts every stored thread, hidden (trash) included, to track the crawl's
/// coverage against the whole mailbox.
pub fn count_threads(conn: &Connection, account_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM threads WHERE account_id = ?1",
        params![account_id],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// Any thread the classifier hasn't touched yet (pre-v0.23 rows) — the boot
/// pass checks this before spawning a backfill.
pub fn has_unclassified_threads(conn: &Connection) -> bool {
    conn.query_row("SELECT 1 FROM threads WHERE split_id IS NULL LIMIT 1", [], |_| Ok(()))
        .is_ok()
}

/// Re-run the classifier over stored threads: every thread when `only_missing`
/// is false (a split definition changed), else just NULL rows (boot backfill).
/// One page per call so callers can chunk under the DB lock; returns
/// (updated_rows, done). Resume by rowid keeps each page O(page).
pub fn reclassify_page(
    conn: &Connection,
    after_rowid: i64,
    page: usize,
    only_missing: bool,
) -> Result<(usize, i64, bool), String> {
    let filter = if only_missing { "AND split_id IS NULL" } else { "" };
    let sql = format!(
        "SELECT rowid, {THREAD_COLS}, account_id FROM threads
         WHERE rowid > ?1 {filter} ORDER BY rowid LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<(i64, Thread, String)> = stmt
        .query_map(params![after_rowid, page as i64], |r| {
            let rowid: i64 = r.get(0)?;
            // row_to_thread reads columns 0.. — shift past rowid by hand
            let t = Thread {
                id: r.get(1)?,
                subject: r.get(2)?,
                snippet: r.get(3)?,
                participants: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                message_count: r.get(5)?,
                last_date: r.get(6)?,
                unread: r.get::<_, i64>(7)? != 0,
                starred: r.get::<_, i64>(8)? != 0,
                labels: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
                in_inbox: r.get::<_, i64>(10)? != 0,
                snoozed_until: r.get(11)?,
                recipients: serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default(),
                split: r.get::<_, Option<String>>(13)?.unwrap_or_default(),
                also_in: serde_json::from_str(&r.get::<_, String>(14)?).unwrap_or_default(),
            };
            let account: String = r.get(15)?;
            Ok((rowid, t, account))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let done = rows.len() < page;
    let last_rowid = rows.last().map(|(r, _, _)| *r).unwrap_or(after_rowid);
    let splits = split_config(conn);
    // compile once per account seen in this page
    let mut specs: HashMap<String, Vec<crate::splits::SplitSpec>> = HashMap::new();
    let mut updated = 0usize;
    for (rowid, t, account) in &rows {
        let spec = specs
            .entry(account.clone())
            .or_insert_with(|| crate::splits::compile(&splits, account));
        let (home, also) = classify_thread(t, spec);
        let also_json = serde_json::to_string(&also).unwrap();
        if t.split != home || serde_json::to_string(&t.also_in).unwrap() != also_json {
            conn.execute(
                "UPDATE threads SET split_id = ?2, split_also = ?3 WHERE rowid = ?1",
                params![rowid, home, also_json],
            )
            .map_err(|e| e.to_string())?;
            updated += 1;
        }
    }
    Ok((updated, last_rowid, done))
}

/// Inbox conversation count per split for the tab row — SQL over the whole
/// mailbox, not the 500-row display window. alsoShow forwards count too.
pub fn split_counts(conn: &Connection, account_id: &str) -> Result<HashMap<String, i64>, String> {
    let mut out: HashMap<String, i64> = HashMap::new();
    let mut tally = |sql: &str| -> Result<(), String> {
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows: Vec<(String, i64)> = stmt
            .query_map(params![account_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        for (id, n) in rows {
            *out.entry(id).or_insert(0) += n;
        }
        Ok(())
    };
    tally(
        "SELECT COALESCE(split_id, ''), COUNT(*) FROM threads
         WHERE account_id = ?1 AND in_inbox = 1 AND snoozed_until IS NULL AND hidden IS NULL
         GROUP BY COALESCE(split_id, '')",
    )?;
    tally(
        "SELECT j.value, COUNT(*) FROM threads, json_each(threads.split_also) j
         WHERE account_id = ?1 AND in_inbox = 1 AND snoozed_until IS NULL AND hidden IS NULL
         GROUP BY j.value",
    )?;
    Ok(out)
}

pub fn get_thread(conn: &Connection, id: &str) -> Option<Thread> {
    let sql = format!("SELECT {THREAD_COLS} FROM threads WHERE id = ?1");
    conn.query_row(&sql, params![id], row_to_thread).ok()
}

pub fn get_messages(conn: &Connection, thread_id: &str) -> Result<Vec<Message>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, thread_id, from_addr, from_name, to_addrs, cc_addrs, subject, snippet,
                    body_text, body_html, date, unread
             FROM messages WHERE thread_id = ?1 ORDER BY date ASC",
        )
        .map_err(|e| e.to_string())?;
    let mut msgs: Vec<Message> = stmt
        .query_map(params![thread_id], |r| {
            Ok(Message {
                id: r.get(0)?,
                thread_id: r.get(1)?,
                from: r.get(2)?,
                from_name: r.get(3)?,
                to: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default(),
                cc: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or_default(),
                subject: r.get(6)?,
                snippet: r.get(7)?,
                body_text: r.get(8)?,
                body_html: r.get(9)?,
                date: r.get(10)?,
                unread: r.get::<_, i64>(11)? != 0,
                attachments: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    for m in &mut msgs {
        let mut astmt = conn
            .prepare(
                "SELECT id, message_id, filename, mime_type, size_bytes
                 FROM attachments WHERE message_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        m.attachments = astmt
            .query_map(params![m.id], |r| {
                Ok(Attachment {
                    id: r.get(0)?,
                    message_id: r.get(1)?,
                    filename: r.get(2)?,
                    mime_type: r.get(3)?,
                    size_bytes: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
    }
    Ok(msgs)
}

/// One message row bound for upsert: (message, rfc Message-ID,
/// List-Unsubscribe header, raw iCalendar payload for invite mail,
/// attachments as (meta, remote id, Content-ID, cached text)).
pub type MsgRow = (
    Message,
    Option<String>,
    Option<String>,
    Option<String>,
    Vec<(Attachment, Option<String>, Option<String>, Option<String>)>,
);

/// The splits config as classification needs it: raw settings JSON (no
/// keychain lookups, unlike get_settings) with the legacy-rules migration
/// applied. Falls back to the defaults on a fresh store.
pub fn split_config(conn: &Connection) -> Vec<Split> {
    let mut splits = get_json::<Settings>(conn, "settings")
        .map(|s| s.splits)
        .unwrap_or_else(|| default_settings().splits);
    migrate_splits(&mut splits);
    splits
}

/// v0.7 + v0.23 split migrations, shared by get_settings and split_config:
/// drop the retired builtin Calendar split, convert legacy rules to a query.
fn migrate_splits(splits: &mut Vec<Split>) {
    splits.retain(|sp| !(sp.builtin && sp.id == "calendar"));
    for sp in splits.iter_mut() {
        if sp.query.trim().is_empty() && !sp.rules.is_empty() {
            sp.query = crate::splits::query_from_rules(&sp.rules, &sp.op);
        }
        sp.rules.clear();
    }
}

/// Classify one thread against the account's compiled splits.
fn classify_thread(t: &Thread, specs: &[crate::splits::SplitSpec]) -> (String, Vec<String>) {
    let facts = crate::splits::Facts {
        senders: &t.participants,
        recipients: &t.recipients,
        subject: &t.subject,
        labels: &t.labels,
    };
    crate::splits::classify(specs, &facts)
}

/// Upsert a thread and its messages (used by both mock seeding and Gmail sync).
/// Split membership is (re)materialized here — every sync refetch reclassifies,
/// so label/participant changes move threads between splits on their own.
pub fn upsert_thread(
    conn: &Connection,
    account_id: &str,
    t: &Thread,
    msgs: &[MsgRow],
) -> Result<(), String> {
    let specs = crate::splits::compile(&split_config(conn), account_id);
    let (split_id, split_also) = classify_thread(t, &specs);
    conn.execute(
        "INSERT INTO threads (id, subject, snippet, participants, message_count, last_date,
                              unread, starred, labels, in_inbox, snoozed_until, account_id,
                              recipients, split_id, split_also)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(id) DO UPDATE SET
            subject=excluded.subject, snippet=excluded.snippet,
            participants=excluded.participants, message_count=excluded.message_count,
            last_date=excluded.last_date, unread=excluded.unread, starred=excluded.starred,
            labels=excluded.labels, in_inbox=excluded.in_inbox, account_id=excluded.account_id,
            recipients=excluded.recipients, split_id=excluded.split_id,
            split_also=excluded.split_also",
        params![
            t.id,
            t.subject,
            t.snippet,
            serde_json::to_string(&t.participants).unwrap(),
            t.message_count,
            t.last_date,
            t.unread as i64,
            t.starred as i64,
            serde_json::to_string(&t.labels).unwrap(),
            t.in_inbox as i64,
            t.snoozed_until,
            account_id,
            serde_json::to_string(&t.recipients).unwrap(),
            split_id,
            serde_json::to_string(&split_also).unwrap(),
        ],
    )
    .map_err(|e| e.to_string())?;

    let mut any_healed = false;
    for (m, rfc_id, list_unsub, ics, atts) in msgs {
        // The current body tells us (a) new vs. existing and (b) whether this
        // upsert heals a previously empty/frozen body — which the search index
        // must then be told about (its per-message insert only fires for new rows).
        let existing_body: Option<String> = conn
            .query_row("SELECT body_text FROM messages WHERE id = ?1", params![m.id], |r| r.get(0))
            .ok();
        let is_new = existing_body.is_none();
        conn.execute(
            "INSERT INTO messages (id, thread_id, from_addr, from_name, to_addrs, cc_addrs,
                                   subject, snippet, body_text, body_html, date, unread,
                                   rfc_message_id, list_unsubscribe, ics_data)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
             ON CONFLICT(id) DO UPDATE SET
                unread=excluded.unread,
                subject=excluded.subject,
                snippet=excluded.snippet,
                to_addrs=excluded.to_addrs,
                cc_addrs=excluded.cc_addrs,
                rfc_message_id=excluded.rfc_message_id,
                list_unsubscribe=excluded.list_unsubscribe,
                ics_data=COALESCE(excluded.ics_data, messages.ics_data),
                -- Gmail message bodies are immutable, so a non-empty re-parse is
                -- always the correct value. This heals rows an older build (or a
                -- first sync that couldn't fetch the HTML) froze with NULL/empty
                -- HTML — but never clobber a good cached body with an empty one.
                body_text=CASE WHEN excluded.body_text <> '' THEN excluded.body_text ELSE messages.body_text END,
                body_html=COALESCE(excluded.body_html, messages.body_html)",
            params![
                m.id,
                m.thread_id,
                m.from,
                m.from_name,
                serde_json::to_string(&m.to).unwrap(),
                serde_json::to_string(&m.cc).unwrap(),
                m.subject,
                m.snippet,
                m.body_text,
                m.body_html,
                m.date,
                m.unread as i64,
                rfc_id,
                list_unsub,
                ics,
            ],
        )
        .map_err(|e| e.to_string())?;

        if is_new {
            conn.execute(
                "INSERT INTO mail_fts (thread_id, subject, from_text, body) VALUES (?1,?2,?3,?4)",
                params![m.thread_id, m.subject, format!("{} {}", m.from_name, m.from), m.body_text],
            )
            .map_err(|e| e.to_string())?;
            // Index everyone on a first-seen message so freq counts distinct
            // messages (re-syncs of the same message never double-count).
            index_contact(conn, account_id, &m.from_name, &m.from, m.date);
            for addr in m.to.iter().chain(m.cc.iter()) {
                if let Some((name, email)) = parse_addr(addr) {
                    index_contact(conn, account_id, &name, &email, m.date);
                }
            }
        } else if existing_body.as_deref().map(str::trim).unwrap_or("").is_empty()
            && !m.body_text.trim().is_empty()
        {
            any_healed = true;
        }

        for (a, remote_id, content_id, text) in atts {
            conn.execute(
                "INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, remote_id, content_id, text_content)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
                 ON CONFLICT(id) DO NOTHING",
                params![a.id, a.message_id, a.filename, a.mime_type, a.size_bytes, remote_id, content_id, text],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Rebuild this thread's FTS rows when a body healed, so recovered text is
    // searchable. `msgs` is the full thread on the sync/seed path. Healed
    // bodies must re-embed too — drop vectors; the embed beat re-adds them.
    if any_healed {
        vec::delete_thread_vectors(conn, &t.id)?;
        conn.execute("DELETE FROM mail_fts WHERE thread_id = ?1", params![t.id])
            .map_err(|e| e.to_string())?;
        for (m, _, _, _, _) in msgs {
            conn.execute(
                "INSERT INTO mail_fts (thread_id, subject, from_text, body) VALUES (?1,?2,?3,?4)",
                params![m.thread_id, m.subject, format!("{} {}", m.from_name, m.from), m.body_text],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- mutations

pub fn set_in_inbox(conn: &Connection, id: &str, in_inbox: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE threads SET in_inbox = ?2, snoozed_until = NULL WHERE id = ?1",
        params![id, in_inbox as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_snoozed(conn: &Connection, id: &str, until_ms: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE threads SET snoozed_until = ?2, in_inbox = 0 WHERE id = ?1",
        params![id, until_ms],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns ids of threads whose snooze expired (they are moved back to inbox).
pub fn wake_due_snoozes(conn: &Connection, now_ms: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM threads WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?1")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map(params![now_ms], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for id in &ids {
        conn.execute(
            "UPDATE threads SET snoozed_until = NULL, in_inbox = 1, unread = 1 WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(ids)
}

pub fn set_starred(conn: &Connection, id: &str, starred: bool) -> Result<(), String> {
    conn.execute("UPDATE threads SET starred = ?2 WHERE id = ?1", params![id, starred as i64])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Soft-hide (trash/spam). The row stays so undo can restore it instantly.
pub fn set_hidden(conn: &Connection, id: &str, reason: Option<&str>) -> Result<(), String> {
    match reason {
        Some(r) => conn.execute(
            "UPDATE threads SET hidden = ?2, in_inbox = 0, snoozed_until = NULL WHERE id = ?1",
            params![id, r],
        ),
        None => conn.execute(
            "UPDATE threads SET hidden = NULL, in_inbox = 1, snoozed_until = NULL WHERE id = ?1",
            params![id],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Sync-side unhide: clears the flag without forcing in_inbox back on —
/// the listing diff owns where a restored thread actually lives.
pub fn clear_hidden(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE threads SET hidden = NULL WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn hidden_reason(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT hidden FROM threads WHERE id = ?1", params![id], |r| {
        r.get::<_, Option<String>>(0)
    })
    .ok()
    .flatten()
}

/// Inbox threads carrying the Muted label — sync auto-archives these.
pub fn muted_inbox_threads(conn: &Connection, account_id: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id FROM threads
         WHERE account_id = ?1 AND in_inbox = 1 AND hidden IS NULL AND labels LIKE '%\"Muted\"%'",
    ) else {
        return vec![];
    };
    stmt.query_map(params![account_id], |r| r.get(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

/// Most recent iCalendar payload in a thread (invite detection). The newest
/// invite wins — a reschedule or cancellation supersedes the original mail.
pub fn thread_ics(conn: &Connection, thread_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT ics_data FROM messages
         WHERE thread_id = ?1 AND ics_data IS NOT NULL
         ORDER BY date DESC LIMIT 1",
        params![thread_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

/// Most recent List-Unsubscribe header in a thread, if any message has one.
pub fn unsubscribe_header(conn: &Connection, thread_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT list_unsubscribe FROM messages
         WHERE thread_id = ?1 AND list_unsubscribe IS NOT NULL
         ORDER BY date DESC LIMIT 1",
        params![thread_id],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

// ---------------------------------------------------------------- attachments

/// Everything needed to fetch/serve one attachment's bytes.
pub struct AttachmentRow {
    pub message_id: String,
    pub filename: String,
    pub mime_type: String,
    pub remote_id: Option<String>,
    pub data: Option<Vec<u8>>,
}

pub fn get_attachment(conn: &Connection, id: &str) -> Option<AttachmentRow> {
    conn.query_row(
        "SELECT message_id, filename, mime_type, remote_id, data FROM attachments WHERE id = ?1",
        params![id],
        |r| {
            Ok(AttachmentRow {
                message_id: r.get(0)?,
                filename: r.get(1)?,
                mime_type: r.get(2)?,
                remote_id: r.get(3)?,
                data: r.get(4)?,
            })
        },
    )
    .ok()
}

pub fn set_attachment_data(conn: &Connection, id: &str, data: &[u8]) -> Result<(), String> {
    conn.execute("UPDATE attachments SET data = ?2 WHERE id = ?1", params![id, data])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Inline-image candidates for a message: (attachment id, Content-ID,
/// mime type, remote id, cached bytes present).
pub fn inline_cids(conn: &Connection, message_id: &str) -> Vec<(String, String, String, Option<String>, bool)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, content_id, mime_type, remote_id, data IS NOT NULL
         FROM attachments WHERE message_id = ?1 AND content_id IS NOT NULL",
    ) else {
        return vec![];
    };
    stmt.query_map(params![message_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, i64>(4)? != 0,
        ))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub fn attachment_data(conn: &Connection, id: &str) -> Option<Vec<u8>> {
    conn.query_row("SELECT data FROM attachments WHERE id = ?1", params![id], |r| {
        r.get::<_, Option<Vec<u8>>>(0)
    })
    .ok()
    .flatten()
}

// ---------------------------------------------------------------- drafts

pub fn draft_save(
    conn: &Connection,
    id: Option<i64>,
    account_id: &str,
    payload: &str,
    now_ms: i64,
) -> Result<i64, String> {
    match id {
        Some(id) => {
            let n = conn
                .execute(
                    "UPDATE drafts SET payload = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, payload, now_ms],
                )
                .map_err(|e| e.to_string())?;
            if n > 0 {
                return Ok(id);
            }
            // row vanished (sent elsewhere) — recreate rather than lose work
            draft_save(conn, None, account_id, payload, now_ms)
        }
        None => {
            conn.execute(
                "INSERT INTO drafts (account_id, payload, updated_at) VALUES (?1, ?2, ?3)",
                params![account_id, payload, now_ms],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

pub fn draft_list(conn: &Connection, account_id: &str) -> Vec<(i64, String, i64)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, payload, updated_at FROM drafts WHERE account_id = ?1 ORDER BY updated_at DESC LIMIT 100",
    ) else {
        return vec![];
    };
    stmt.query_map(params![account_id], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}

pub fn draft_delete(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM drafts WHERE id = ?1", params![id]);
}

// ---------------------------------------------------------------- outbox

pub fn outbox_add(
    conn: &Connection,
    account_id: &str,
    mail: &OutgoingMail,
    send_at: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO outbox (account_id, payload, send_at) VALUES (?1, ?2, ?3)",
        params![account_id, serde_json::to_string(mail).map_err(|e| e.to_string())?, send_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// Remove a pending send and hand the draft back (None = already sent). Only an
/// UNCLAIMED row can be pulled back — a claimed row is mid-flight, so Undo
/// returns None ("already sent") rather than silently failing to stop it. The
/// caller holds the DB lock, so this SELECT+DELETE is atomic w.r.t. the outbox
/// processor and accelerate.
pub fn outbox_cancel(conn: &Connection, id: i64) -> Option<OutgoingMail> {
    let payload: String = conn
        .query_row(
            "SELECT payload FROM outbox WHERE id = ?1 AND claimed = 0",
            params![id],
            |r| r.get(0),
        )
        .ok()?;
    conn.execute("DELETE FROM outbox WHERE id = ?1", params![id]).ok()?;
    serde_json::from_str(&payload).ok()
}

/// Read a pending send (account + draft) WITHOUT removing it — the caller
/// (send_outbox_now) deletes it only after delivery succeeds, so a failed flush
/// leaves it queued for the processor to retry.
pub fn outbox_get(conn: &Connection, id: i64) -> Option<(String, OutgoingMail)> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT account_id, payload FROM outbox WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .ok();
    row.and_then(|(acc, p)| serde_json::from_str(&p).ok().map(|m| (acc, m)))
}

/// Atomically mark a pending row as in-flight (claimed 0→1). Returns true only
/// for the single caller that wins the flip, so exactly one of {processor,
/// accelerate} ever delivers a given row — the DB lock serializes the UPDATE.
pub fn outbox_claim(conn: &Connection, id: i64) -> bool {
    conn.execute(
        "UPDATE outbox SET claimed = 1 WHERE id = ?1 AND claimed = 0",
        params![id],
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// Release a claim so a failed delivery can be retried (or cancelled).
pub fn outbox_unclaim(conn: &Connection, id: i64) {
    let _ = conn.execute("UPDATE outbox SET claimed = 0 WHERE id = ?1", params![id]);
}

pub fn outbox_due(conn: &Connection, now_ms: i64) -> Vec<(i64, String, OutgoingMail)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, account_id, payload FROM outbox WHERE send_at <= ?1 AND attempts < 5 AND claimed = 0",
    ) else {
        return vec![];
    };
    stmt.query_map(params![now_ms], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })
    .map(|rows| {
        rows.filter_map(|r| r.ok())
            .filter_map(|(id, acc, p)| serde_json::from_str(&p).ok().map(|m| (id, acc, m)))
            .collect()
    })
    .unwrap_or_default()
}

pub fn outbox_delete(conn: &Connection, id: i64) {
    let _ = conn.execute("DELETE FROM outbox WHERE id = ?1", params![id]);
}

pub fn outbox_bump_attempts(conn: &Connection, id: i64) {
    let _ = conn.execute("UPDATE outbox SET attempts = attempts + 1 WHERE id = ?1", params![id]);
    // rows that exhausted their retries are dropped so they can't loop forever
    let _ = conn.execute("DELETE FROM outbox WHERE attempts >= 5", []);
}

/// Trash = remove the thread from the local cache entirely (Gmail keeps it
/// recoverable server-side for 30 days).
pub fn delete_thread(conn: &Connection, id: &str) -> Result<(), String> {
    vec::delete_thread_vectors(conn, id)?;
    conn.execute("DELETE FROM mail_fts WHERE thread_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?1)",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM messages WHERE thread_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM threads WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Clear the per-thread `history_id` for an account so the next reconcile
/// treats every listed thread as changed and refetches it — used by the resync
/// repair to re-parse and heal frozen message bodies without dropping local
/// state (snoozes, read/hidden flags survive).
pub fn reset_history(conn: &Connection, account_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE threads SET history_id = NULL WHERE account_id = ?1",
        params![account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// One page of an account's thread ids. The chunked account-clear (see
/// disconnect_account) walks these a batch at a time so the db lock can be
/// released between transactions — a fully-crawled account is tens of
/// thousands of threads in a multi-GB db, and clearing it in one hold froze
/// every other command for minutes.
pub fn thread_ids_page(
    conn: &Connection,
    account_id: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM threads WHERE account_id = ?1 LIMIT ?2")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map(params![account_id, limit], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

/// Delete a batch of threads — vectors, FTS rows, attachments, messages, and
/// the thread rows — in one all-or-nothing transaction.
pub fn delete_threads(conn: &Connection, ids: &[String]) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let ph = vec!["?"; ids.len()].join(",");
    for sql in [
        format!("DELETE FROM mail_vec WHERE rowid IN (SELECT vec_rowid FROM vec_meta WHERE thread_id IN ({ph}))"),
        format!("DELETE FROM vec_meta WHERE thread_id IN ({ph})"),
        format!("DELETE FROM mail_fts WHERE thread_id IN ({ph})"),
        format!("DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE thread_id IN ({ph}))"),
        format!("DELETE FROM messages WHERE thread_id IN ({ph})"),
        format!("DELETE FROM threads WHERE id IN ({ph})"),
    ] {
        tx.execute(&sql, rusqlite::params_from_iter(ids.iter()))
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn clear_account_mail(conn: &Connection, account_id: &str) -> Result<(), String> {
    loop {
        let ids = thread_ids_page(conn, account_id, 400)?;
        if ids.is_empty() {
            return Ok(());
        }
        delete_threads(conn, &ids)?;
    }
}

pub fn set_unread(conn: &Connection, id: &str, unread: bool) -> Result<(), String> {
    conn.execute("UPDATE threads SET unread = ?2 WHERE id = ?1", params![id, unread as i64])
        .map_err(|e| e.to_string())?;
    if !unread {
        conn.execute("UPDATE messages SET unread = 0 WHERE thread_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle a label; returns true if the label is now present.
pub fn toggle_label(conn: &Connection, id: &str, label: &str) -> Result<bool, String> {
    let t = get_thread(conn, id).ok_or("unknown thread")?;
    let mut labels = t.labels;
    let added = if labels.iter().any(|l| l == label) {
        labels.retain(|l| l != label);
        false
    } else {
        labels.push(label.to_string());
        true
    };
    conn.execute(
        "UPDATE threads SET labels = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(&labels).unwrap()],
    )
    .map_err(|e| e.to_string())?;
    Ok(added)
}

/// Refresh the persisted id→name label map for one account.
pub fn upsert_labels(
    conn: &Connection,
    account_id: &str,
    pairs: &[(String, String)],
) -> Result<(), String> {
    for (id, name) in pairs {
        conn.execute(
            "INSERT INTO labels(account_id, id, name) VALUES(?1, ?2, ?3)
             ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name",
            params![account_id, id, name],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// id → display name for one account's Gmail labels.
pub fn label_map(conn: &Connection, account_id: &str) -> HashMap<String, String> {
    let Ok(mut stmt) = conn.prepare("SELECT id, name FROM labels WHERE account_id = ?1") else {
        return HashMap::new();
    };
    stmt.query_map(params![account_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

/// One-time repair: rewrite opaque label ids already persisted in
/// threads.labels to their display names (older syncs stored ids verbatim).
pub fn rename_thread_labels(
    conn: &Connection,
    account_id: &str,
    map: &HashMap<String, String>,
) -> Result<bool, String> {
    if map.is_empty() {
        return Ok(false);
    }
    let mut stmt = conn
        .prepare("SELECT id, labels FROM threads WHERE account_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![account_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let mut changed = false;
    for (id, raw) in rows {
        let Ok(labels) = serde_json::from_str::<Vec<String>>(&raw) else { continue };
        let renamed: Vec<String> =
            labels.iter().map(|l| map.get(l).unwrap_or(l).clone()).collect();
        if renamed != labels {
            let json = serde_json::to_string(&renamed).map_err(|e| e.to_string())?;
            conn.execute("UPDATE threads SET labels = ?2 WHERE id = ?1", params![id, json])
                .map_err(|e| e.to_string())?;
            changed = true;
        }
    }
    Ok(changed)
}

// ---------------------------------------------------------------- contacts

/// Parse a recipient header value into (name, email). Handles "Name <email>",
/// "<email>", and a bare address; returns None if there's no address.
fn parse_addr(raw: &str) -> Option<(String, String)> {
    let raw = raw.trim();
    if let Some(lt) = raw.rfind('<') {
        if let Some(rel_gt) = raw[lt..].find('>') {
            let email = raw[lt + 1..lt + rel_gt].trim().to_lowercase();
            if email.contains('@') {
                let name = raw[..lt].trim().trim_matches('"').trim().to_string();
                return Some((name, email));
            }
        }
    }
    if raw.contains('@') && !raw.contains(char::is_whitespace) {
        return Some((String::new(), raw.to_lowercase()));
    }
    None
}

/// Record one appearance of a contact: bump freq, keep the most recent
/// last_seen, and fill in a name if we didn't have one.
fn index_contact(conn: &Connection, account_id: &str, name: &str, email: &str, date: i64) {
    let email = email.trim().to_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return;
    }
    let name = name.trim();
    let _ = conn.execute(
        "INSERT INTO contacts (account_id, email, name, freq, last_seen)
         VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(account_id, email) DO UPDATE SET
            freq = freq + 1,
            last_seen = MAX(last_seen, excluded.last_seen),
            name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE contacts.name END",
        params![account_id, email, name, date],
    );
}

/// One-time build of the contact index from mail synced before v0.9.
fn backfill_contacts(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.account_id, m.from_name, m.from_addr, m.to_addrs, m.cc_addrs, m.date
             FROM messages m JOIN threads t ON t.id = m.thread_id",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, String, String, i64)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for (account_id, from_name, from_addr, to_json, cc_json, date) in rows {
        index_contact(conn, &account_id, &from_name, &from_addr, date);
        for json in [&to_json, &cc_json] {
            if let Ok(addrs) = serde_json::from_str::<Vec<String>>(json) {
                for addr in addrs {
                    if let Some((name, email)) = parse_addr(&addr) {
                        index_contact(conn, &account_id, &name, &email, date);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Replace one account+source slice of the People-API contacts (a sync is a
/// full listing, so replace — never merge — but only for sources that
/// actually fetched, so a failed source keeps its previous rows).
pub fn replace_people(
    conn: &Connection,
    account_id: &str,
    source: &str,
    rows: &[(String, String, Option<String>)], // (email, name, photo_url)
    now_ms: i64,
) -> Result<(), String> {
    // One transaction: thousands of per-row autocommit INSERTs would each
    // fsync while the global DB mutex is held (seconds of frozen IPC), and a
    // mid-loop failure must not leave the source half-replaced.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM people_contacts WHERE account_id = ?1 AND source = ?2",
        params![account_id, source],
    )
    .map_err(|e| e.to_string())?;
    for (email, name, photo) in rows {
        tx.execute(
            "INSERT OR REPLACE INTO people_contacts
                (account_id, source, email, display_name, photo_url, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![account_id, source, email, name, photo, now_ms],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Ranked recipient suggestions for a typed query, merged from two sources:
/// the mail-derived index (freq/recency — the strongest signal: people you
/// actually correspond with) and the People-API tables (saved contacts >
/// other contacts > directory). Prefix matches always beat substring
/// matches; within each band, history beats address book. Dedup by email
/// (history wins). The account's own address is excluded.
pub fn search_contacts(
    conn: &Connection,
    account_id: &str,
    query: &str,
    limit: usize,
) -> Vec<Contact> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return vec![];
    }
    let esc = q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let sub = format!("%{esc}%");
    let pre = format!("{esc}%");

    let history: Vec<Contact> = conn
        .prepare(
            "SELECT email, name FROM contacts
             WHERE account_id = ?1 AND email <> ?2
               AND (lower(name) LIKE ?3 ESCAPE '\\' OR email LIKE ?3 ESCAPE '\\')
             ORDER BY
               CASE WHEN lower(name) LIKE ?4 ESCAPE '\\' OR email LIKE ?4 ESCAPE '\\'
                    THEN 0 ELSE 1 END,
               freq DESC, last_seen DESC
             LIMIT ?5",
        )
        .and_then(|mut st| {
            st.query_map(
                params![account_id, account_id.to_lowercase(), sub, pre, limit as i64],
                |r| Ok(Contact { email: r.get(0)?, name: r.get(1)? }),
            )
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let people: Vec<Contact> = conn
        .prepare(
            "SELECT email, display_name FROM people_contacts
             WHERE account_id = ?1 AND email <> ?2
               AND (lower(display_name) LIKE ?3 ESCAPE '\\' OR email LIKE ?3 ESCAPE '\\')
             ORDER BY
               CASE WHEN lower(display_name) LIKE ?4 ESCAPE '\\' OR email LIKE ?4 ESCAPE '\\'
                    THEN 0 ELSE 1 END,
               CASE source WHEN 'contact' THEN 0 WHEN 'other' THEN 1 ELSE 2 END,
               display_name
             LIMIT ?5",
        )
        .and_then(|mut st| {
            st.query_map(
                params![account_id, account_id.to_lowercase(), sub, pre, (limit * 2) as i64],
                |r| Ok(Contact { email: r.get(0)?, name: r.get(1)? }),
            )
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();

    let is_prefix =
        |c: &Contact| c.name.to_lowercase().starts_with(&q) || c.email.starts_with(&q);
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Contact> = vec![];
    let (h_pre, h_sub): (Vec<_>, Vec<_>) = history.into_iter().partition(&is_prefix);
    let (p_pre, p_sub): (Vec<_>, Vec<_>) = people.into_iter().partition(&is_prefix);
    for c in h_pre.into_iter().chain(p_pre).chain(h_sub).chain(p_sub) {
        if seen.insert(c.email.clone()) {
            out.push(c);
            if out.len() >= limit {
                break;
            }
        }
    }
    out
}

/// Locally-trashed thread ids for one account (sync diffs these against the
/// server's in:trash listing).
pub fn trashed_thread_ids(conn: &Connection, account_id: &str) -> Vec<String> {
    let Ok(mut stmt) =
        conn.prepare("SELECT id FROM threads WHERE account_id = ?1 AND hidden = 'trash'")
    else {
        return vec![];
    };
    stmt.query_map(params![account_id], |r| r.get(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------- calendar

const EVENT_COLS: &str = "id, calendar_id, calendar, color, title, start_ms, end_ms, all_day, \
     location, description, html_link, etag, status, organizer_email, organizer_self, \
     recurring_event_id, hangout_link, attendees, access_role, ical_uid";

fn row_to_event(r: &rusqlite::Row) -> rusqlite::Result<CalendarEvent> {
    Ok(CalendarEvent {
        id: r.get(0)?,
        calendar_id: r.get(1)?,
        calendar: r.get(2)?,
        color: r.get(3)?,
        title: r.get(4)?,
        start_ms: r.get(5)?,
        end_ms: r.get(6)?,
        all_day: r.get::<_, i64>(7)? != 0,
        location: r.get(8)?,
        description: r.get(9)?,
        html_link: r.get(10)?,
        etag: r.get(11)?,
        status: r.get(12)?,
        organizer_email: r.get(13)?,
        organizer_self: r.get::<_, i64>(14)? != 0,
        recurring_event_id: r.get(15)?,
        hangout_link: r.get(16)?,
        attendees: serde_json::from_str(&r.get::<_, String>(17)?).unwrap_or_default(),
        access_role: r.get(18)?,
        ical_uid: r.get(19)?,
    })
}

/// Rank a calendar privilege for cross-calendar dedup: the copy the user can
/// act on (own calendar) beats a shared read-only copy of the same event.
fn access_rank(role: &str) -> u8 {
    match role {
        "owner" => 0,
        "writer" => 1,
        "reader" => 2,
        _ => 3,
    }
}

/// Cached events overlapping [start_ms, end_ms), sorted by start. The same
/// Google event id can be cached once per visible calendar (the attendee's
/// copy + the organizer's shared calendar) — dedup to the most-privileged
/// copy so the panel doesn't stack duplicates.
pub fn list_events(
    conn: &Connection,
    account_id: &str,
    start_ms: i64,
    end_ms: i64,
) -> Vec<CalendarEvent> {
    let sql = format!(
        "SELECT {EVENT_COLS} FROM events
         WHERE account_id = ?1 AND start_ms < ?3 AND end_ms > ?2
         ORDER BY start_ms"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return vec![];
    };
    let rows: Vec<CalendarEvent> = stmt
        .query_map(params![account_id, start_ms, end_ms], row_to_event)
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<CalendarEvent> = vec![];
    for e in rows {
        match index.get(&e.id) {
            Some(&i) => {
                if access_rank(&e.access_role) < access_rank(&out[i].access_role) {
                    out[i] = e;
                }
            }
            None => {
                index.insert(e.id.clone(), out.len());
                out.push(e);
            }
        }
    }
    out
}

/// One cached event by its calendar-scoped key.
pub fn get_event(
    conn: &Connection,
    account_id: &str,
    calendar_id: &str,
    id: &str,
) -> Option<CalendarEvent> {
    let sql =
        format!("SELECT {EVENT_COLS} FROM events WHERE account_id = ?1 AND calendar_id = ?2 AND id = ?3");
    conn.query_row(&sql, params![account_id, calendar_id, id], row_to_event).ok()
}

/// Cached events carrying an RFC5545 UID — local fast path for invite-mail
/// RSVP resolution (the remote iCalUID lookup is the fallback).
pub fn events_by_ical_uid(conn: &Connection, account_id: &str, uid: &str) -> Vec<CalendarEvent> {
    let sql = format!("SELECT {EVENT_COLS} FROM events WHERE account_id = ?1 AND ical_uid = ?2");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return vec![];
    };
    stmt.query_map(params![account_id, uid], row_to_event)
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

pub fn upsert_event(conn: &Connection, account_id: &str, e: &CalendarEvent) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO events
            (account_id, calendar_id, id, calendar, color, title, start_ms, end_ms, all_day,
             location, description, html_link, etag, status, organizer_email, organizer_self,
             recurring_event_id, hangout_link, attendees, access_role, ical_uid)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
        params![
            account_id,
            e.calendar_id,
            e.id,
            e.calendar,
            e.color,
            e.title,
            e.start_ms,
            e.end_ms,
            e.all_day as i64,
            e.location,
            e.description,
            e.html_link,
            e.etag,
            e.status,
            e.organizer_email,
            e.organizer_self as i64,
            e.recurring_event_id,
            e.hangout_link,
            serde_json::to_string(&e.attendees).map_err(|e| e.to_string())?,
            e.access_role,
            e.ical_uid,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_event(
    conn: &Connection,
    account_id: &str,
    calendar_id: &str,
    id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM events WHERE account_id = ?1 AND calendar_id = ?2 AND id = ?3",
        params![account_id, calendar_id, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Replace ONE calendar's cached slice of a fetched window: everything of its
/// rows overlapping the window is dropped, then the fresh listing lands. Used
/// by the initial (windowed) sync and the 410 token-reset refetch; incremental
/// sync upserts/deletes row-by-row instead.
pub fn replace_calendar_window(
    conn: &Connection,
    account_id: &str,
    calendar_id: &str,
    window_start: i64,
    window_end: i64,
    events: &[CalendarEvent],
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM events
         WHERE account_id = ?1 AND calendar_id = ?2 AND start_ms < ?4 AND end_ms > ?3",
        params![account_id, calendar_id, window_start, window_end],
    )
    .map_err(|e| e.to_string())?;
    for e in events {
        upsert_event(&tx, account_id, e)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Drop every cached event for calendars that vanished from calendarList
/// (unsubscribed / deleted), so they stop painting forever.
pub fn retain_calendars(
    conn: &Connection,
    account_id: &str,
    calendar_ids: &[String],
) -> Result<(), String> {
    let keep = serde_json::to_string(calendar_ids).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM events
         WHERE account_id = ?1
           AND calendar_id NOT IN (SELECT value FROM json_each(?2))",
        params![account_id, keep],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_labels(conn: &Connection) -> Result<Vec<String>, String> {
    let mut set = std::collections::BTreeSet::new();
    set.insert("IMPORTANT".to_string());
    set.insert("STARRED".to_string());
    let mut stmt = conn.prepare("SELECT labels FROM threads").map_err(|e| e.to_string())?;
    let rows: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    for raw in rows {
        if let Ok(labels) = serde_json::from_str::<Vec<String>>(&raw) {
            for l in labels {
                if !l.starts_with("CATEGORY_") && l != "INBOX" && l != "UNREAD" {
                    set.insert(l);
                }
            }
        }
    }
    Ok(set.into_iter().collect())
}

/// Instant local search: deterministic operator-aware parse, then the
/// planned query below. Always lexical-only (no query vector) — this runs
/// per keystroke; the semantic leg is search_all's one-per-search job.
pub fn search(conn: &Connection, query: &str, account_id: &str) -> Result<Vec<SearchResult>, String> {
    search_planned(conn, &crate::search::parse_deterministic(query), account_id, None)
}

/// FTS5 match expression from planned terms: single terms as quoted prefix
/// queries, multi-word terms as exact phrases — cleaned per word so raw user
/// input can't break the match syntax. None = nothing searchable.
fn fts_match_expr(terms: &[String]) -> Option<String> {
    let parts: Vec<String> = terms
        .iter()
        .filter_map(|t| {
            let words: Vec<String> = t
                .split_whitespace()
                .map(|w| w.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
                .filter(|w| !w.is_empty())
                .collect();
            match words.len() {
                0 => None,
                1 => Some(format!("\"{}\"*", words[0])),
                _ => Some(format!("\"{}\"", words.join(" "))),
            }
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

/// Escape LIKE wildcards in user text; pair with ESCAPE '\'.
pub(crate) fn like_pattern(needle: &str) -> String {
    let mut esc = String::with_capacity(needle.len() + 2);
    for c in needle.chars() {
        if c == '\\' || c == '%' || c == '_' {
            esc.push('\\');
        }
        esc.push(c);
    }
    format!("%{esc}%")
}

/// Cap on vector-leg threads folded into a fused result: bounds the
/// "semantically-nearest" tail a query can pull in past its exact matches
/// (brute-force KNN always returns k rows, however weak the neighbors).
const VEC_LEG_LIMIT: usize = 20;

fn run_search_sql(
    conn: &Connection,
    sql: &str,
    params_v: Vec<rusqlite::types::Value>,
) -> Result<Vec<SearchResult>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    // Collect row errors instead of swallowing them: a step-time SQL error
    // must surface as a failed search, never as silently-empty results.
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_v), |r| {
            Ok(SearchResult {
                thread_id: r.get(0)?,
                subject: r.get(1)?,
                snippet: r.get(2)?,
                last_date: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Reciprocal Rank Fusion (k=60). Each leg contributes 1/(60+rank); a
/// thread on both legs sums them, so an exact-term hit always outranks the
/// same-rank semantic-only neighbor — the vector leg extends recall below
/// the exact matches instead of displacing them. Ties fall back to recency.
fn rrf_fuse(lexical: Vec<SearchResult>, vector: Vec<SearchResult>) -> Vec<SearchResult> {
    const RRF_K: f64 = 60.0;
    let mut fused: HashMap<String, (f64, SearchResult)> = HashMap::new();
    for (i, r) in lexical.into_iter().enumerate() {
        fused.insert(r.thread_id.clone(), (1.0 / (RRF_K + 1.0 + i as f64), r));
    }
    for (i, r) in vector.into_iter().enumerate() {
        let s = 1.0 / (RRF_K + 1.0 + i as f64);
        fused.entry(r.thread_id.clone()).and_modify(|e| e.0 += s).or_insert((s, r));
    }
    let mut out: Vec<(f64, SearchResult)> = fused.into_values().collect();
    out.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.last_date.cmp(&a.1.last_date))
    });
    out.into_iter().map(|(_, r)| r).take(60).collect()
}

/// Routed local search over a parsed plan:
/// - terms → bm25-ranked FTS (with people/date narrowing), fused with a
///   vector-KNN leg by RRF when a query embedding is supplied — qvec = None
///   (model absent, still downloading, or per-keystroke path) degrades to
///   exactly the lexical behavior;
/// - people only → that contact's threads, from-matches (they wrote) above
///   to-matches (user wrote to them), most recent first;
/// - dates only → the window, most recent first.
pub fn search_planned(
    conn: &Connection,
    plan: &crate::search::SearchPlan,
    account_id: &str,
    qvec: Option<&[f32]>,
) -> Result<Vec<SearchResult>, String> {
    use rusqlite::types::Value;
    if plan.is_empty() {
        return Ok(vec![]);
    }

    let mut sql: String;
    let mut params_v: Vec<Value> = vec![];
    let mut has_terms = false;

    if let Some(match_expr) = fts_match_expr(&plan.terms) {
        has_terms = true;
        // bm25 is only valid directly inside the full-text query — SQLite
        // rejects it as an aggregate argument, and the query flattener
        // hoists it out of a plain subquery — so the MATERIALIZED CTE pins
        // per-message scores first and everything downstream touches only
        // plain values. Weights are positional over ALL declared columns
        // (thread_id UNINDEXED gets the 0.0 placeholder): subject 10× and
        // from_text 5× outrank body 1×. bm25 is negative-better → MIN is
        // each thread's best match and ASC sorts best-first; ties fall back
        // to recency.
        sql = String::from(
            "WITH f AS MATERIALIZED (
                 SELECT thread_id, bm25(mail_fts, 0.0, 10.0, 5.0, 1.0) AS score
                 FROM mail_fts WHERE mail_fts MATCH ?)
             SELECT t.id, t.subject, t.snippet, t.last_date
             FROM (SELECT thread_id, MIN(score) AS score FROM f GROUP BY thread_id) g
             JOIN threads t ON t.id = g.thread_id
             WHERE t.account_id = ? AND t.hidden IS NULL",
        );
        params_v.push(Value::Text(match_expr));
        params_v.push(Value::Text(account_id.to_string()));
        if let Some(ms) = plan.after {
            sql.push_str(" AND t.last_date >= ?");
            params_v.push(Value::Integer(ms));
        }
        if let Some(ms) = plan.before {
            sql.push_str(" AND t.last_date < ?");
            params_v.push(Value::Integer(ms));
        }
        for p in &plan.people {
            sql.push_str(
                " AND EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id
                   AND (m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\'
                        OR m.to_addrs LIKE ? ESCAPE '\\' OR m.cc_addrs LIKE ? ESCAPE '\\'))",
            );
            let pat = like_pattern(p);
            for _ in 0..4 {
                params_v.push(Value::Text(pat.clone()));
            }
        }
        sql.push_str(" ORDER BY g.score ASC, t.last_date DESC LIMIT 60");
    } else if !plan.people.is_empty() {
        // Most-recent-per-contact: sender matches (2) outrank recipient
        // matches (1); several people are OR'd (any of them qualifies).
        let from_cond: Vec<&str> = plan
            .people
            .iter()
            .map(|_| "(m.from_addr LIKE ? ESCAPE '\\' OR m.from_name LIKE ? ESCAPE '\\')")
            .collect();
        let rcpt_cond: Vec<&str> = plan
            .people
            .iter()
            .map(|_| "(m.to_addrs LIKE ? ESCAPE '\\' OR m.cc_addrs LIKE ? ESCAPE '\\')")
            .collect();
        sql = format!(
            "SELECT t.id, t.subject, t.snippet, t.last_date,
                    MAX(CASE WHEN {} THEN 2 WHEN {} THEN 1 ELSE 0 END) AS pscore
             FROM threads t JOIN messages m ON m.thread_id = t.id
             WHERE t.account_id = ? AND t.hidden IS NULL",
            from_cond.join(" OR "),
            rcpt_cond.join(" OR "),
        );
        for p in &plan.people {
            let pat = like_pattern(p);
            params_v.push(Value::Text(pat.clone()));
            params_v.push(Value::Text(pat));
        }
        for p in &plan.people {
            let pat = like_pattern(p);
            params_v.push(Value::Text(pat.clone()));
            params_v.push(Value::Text(pat));
        }
        params_v.push(Value::Text(account_id.to_string()));
        if let Some(ms) = plan.after {
            sql.push_str(" AND t.last_date >= ?");
            params_v.push(Value::Integer(ms));
        }
        if let Some(ms) = plan.before {
            sql.push_str(" AND t.last_date < ?");
            params_v.push(Value::Integer(ms));
        }
        sql.push_str(
            " GROUP BY t.id HAVING pscore > 0
              ORDER BY pscore DESC, t.last_date DESC LIMIT 60",
        );
    } else {
        // Date window only ("in March") — recent threads in range.
        sql = String::from(
            "SELECT id, subject, snippet, last_date FROM threads
             WHERE account_id = ? AND hidden IS NULL AND last_date >= ? AND last_date < ?
             ORDER BY last_date DESC LIMIT 60",
        );
        params_v.push(Value::Text(account_id.to_string()));
        params_v.push(Value::Integer(plan.after.unwrap_or(i64::MIN)));
        params_v.push(Value::Integer(plan.before.unwrap_or(i64::MAX)));
    }

    let lexical = run_search_sql(conn, &sql, params_v)?;
    if let (Some(q), true) = (qvec, has_terms) {
        let vhits = vec::knn_threads(conn, q, account_id, plan, VEC_LEG_LIMIT)?;
        if !vhits.is_empty() {
            return Ok(rrf_fuse(lexical, vhits));
        }
    }
    Ok(lexical)
}

/// Recent threads where `email` was a sender or recipient (from/to/cc),
/// newest first — the reading-pane contact panel's mail history. Matches the
/// stored address columns only (never the body / FTS index), so it returns
/// just the conversations a person was actually on, not every message that
/// happens to mention their name. Excludes hidden (trash/spam) like `search`.
pub fn threads_with_contact(
    conn: &Connection,
    email: &str,
    account_id: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, String> {
    use rusqlite::types::Value;
    let needle = email.trim().to_lowercase();
    if !needle.contains('@') {
        return Ok(vec![]);
    }
    // lower() both sides so a mixed-case stored header still matches; the
    // needle is the full address, so this can't collapse into a name/body FTS.
    let pat = like_pattern(&needle);
    let sql = "SELECT t.id, t.subject, t.snippet, t.last_date
               FROM threads t
               WHERE t.account_id = ? AND t.hidden IS NULL
                 AND EXISTS (
                   SELECT 1 FROM messages m
                   WHERE m.thread_id = t.id
                     AND (lower(m.from_addr) LIKE ? ESCAPE '\\'
                          OR lower(m.to_addrs)   LIKE ? ESCAPE '\\'
                          OR lower(m.cc_addrs)   LIKE ? ESCAPE '\\'))
               ORDER BY t.last_date DESC LIMIT ?";
    let params_v = vec![
        Value::Text(account_id.to_string()),
        Value::Text(pat.clone()),
        Value::Text(pat.clone()),
        Value::Text(pat),
        Value::Integer(limit as i64),
    ];
    run_search_sql(conn, sql, params_v)
}

/// One thread as a SearchResult (used to fold remote full-history matches in
/// beside the local FTS results). Excludes hidden (trash/spam) like `search`.
pub fn get_search_result(conn: &Connection, id: &str) -> Option<SearchResult> {
    conn.query_row(
        "SELECT id, subject, snippet, last_date FROM threads
         WHERE id = ?1 AND hidden IS NULL",
        params![id],
        |r| {
            Ok(SearchResult {
                thread_id: r.get(0)?,
                subject: r.get(1)?,
                snippet: r.get(2)?,
                last_date: r.get(3)?,
            })
        },
    )
    .ok()
}

/// Oldest locally-synced thread date for a paged view — the cursor for
/// fetching the next, older page from Gmail. None if the view is empty or
/// doesn't page.
pub fn oldest_thread_date(conn: &Connection, view: &str, account_id: &str) -> Option<i64> {
    let where_clause = match view {
        "done" => "in_inbox = 0 AND snoozed_until IS NULL AND hidden IS NULL",
        "starred" => "starred = 1 AND hidden IS NULL",
        "trash" => "hidden = 'trash'",
        _ => return None,
    };
    conn.query_row(
        &format!("SELECT MIN(last_date) FROM threads WHERE {where_clause} AND account_id = ?1"),
        params![account_id],
        |r| r.get::<_, Option<i64>>(0),
    )
    .ok()
    .flatten()
}

/// Threads eligible for "Get Me To Zero"; the split filter runs in the caller
/// (split semantics live with the settings, not the store).
pub fn inbox_threads_for_sweep(conn: &Connection, account_id: &str) -> Result<Vec<Thread>, String> {
    list_threads(conn, "inbox", account_id)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Message, Thread};

    const ACCT: &str = "acct@x.test";

    pub fn seed(conn: &Connection, id: &str, subject: &str, body: &str, from: &str, date: i64) {
        let t = Thread {
            id: id.into(),
            subject: subject.into(),
            snippet: body.chars().take(50).collect(),
            participants: vec![from.into()],
            recipients: vec![],
            message_count: 1,
            last_date: date,
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
            from: format!("{}@x.test", from.to_lowercase()),
            from_name: from.into(),
            to: vec!["you@x.test".into()],
            cc: vec![],
            subject: subject.into(),
            snippet: String::new(),
            body_text: body.into(),
            body_html: None,
            date,
            unread: false,
            attachments: vec![],
        };
        upsert_thread(conn, ACCT, &t, &[(m, None, None, None, vec![])]).unwrap();
    }

    fn travel_split() -> Split {
        Split {
            id: "travel".into(),
            name: "Travel".into(),
            builtin: false,
            query: "from:thriftytraveler.com OR from:thepointsguy.com".into(),
            account_id: None,
            also_show: false,
            hide_when_empty: false,
            rules: vec![],
            op: "or".into(),
        }
    }

    #[test]
    fn upsert_materializes_split_membership() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        let mut s = default_settings();
        s.splits.insert(0, travel_split());
        set_json(&conn, "settings", &s).unwrap();

        seed(&conn, "t-deal", "Flash sale", "40k to Europe", "Thrifty Traveler <deals@thriftytraveler.com>", 2_000);
        seed(&conn, "t-plain", "Hello", "no split matches this", "Bob <bob@plain.io>", 1_000);
        let rows = list_threads(&conn, "inbox", ACCT).unwrap();
        let by_id = |id: &str| rows.iter().find(|t| t.id == id).unwrap();
        assert_eq!(by_id("t-deal").split, "travel");
        assert_eq!(by_id("t-plain").split, "other");

        let counts = split_counts(&conn, ACCT).unwrap();
        assert_eq!(counts.get("travel"), Some(&1));
        assert_eq!(counts.get("other"), Some(&1));
    }

    #[test]
    fn changing_splits_reclassifies_stored_threads() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        // classified under the defaults first — lands in the catch-all
        seed(&conn, "t-deal", "Flash sale", "body", "Thrifty Traveler <deals@thriftytraveler.com>", 2_000);
        assert_eq!(list_threads(&conn, "inbox", ACCT).unwrap()[0].split, "other");

        // owner creates the travel split → the background pass re-files it
        let mut s = default_settings();
        s.splits.insert(0, travel_split());
        set_json(&conn, "settings", &s).unwrap();
        let mut after = 0i64;
        loop {
            let (_, last, done) = reclassify_page(&conn, after, 100, false).unwrap();
            after = last;
            if done {
                break;
            }
        }
        assert_eq!(list_threads(&conn, "inbox", ACCT).unwrap()[0].split, "travel");
    }

    #[test]
    fn also_show_counts_forward_to_the_catch_all() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        let mut s = default_settings();
        let mut sp = travel_split();
        sp.also_show = true;
        s.splits.insert(0, sp);
        set_json(&conn, "settings", &s).unwrap();
        seed(&conn, "t-deal", "Flash sale", "body", "Thrifty Traveler <deals@thriftytraveler.com>", 2_000);
        let rows = list_threads(&conn, "inbox", ACCT).unwrap();
        assert_eq!(rows[0].split, "travel");
        assert_eq!(rows[0].also_in, vec!["other".to_string()]);
        let counts = split_counts(&conn, ACCT).unwrap();
        assert_eq!(counts.get("travel"), Some(&1));
        assert_eq!(counts.get("other"), Some(&1)); // forwarded, not moved
    }

    #[test]
    fn legacy_settings_blob_migrates_rules_to_query() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        // a pre-v0.23 settings blob: splits carry rules/op and no query
        let mut v = serde_json::to_value(default_settings()).unwrap();
        v["splits"] = serde_json::json!([
            { "id": "important", "name": "Important", "builtin": true,
              "rules": [{ "field": "label", "contains": "IMPORTANT" }],
              "op": "or", "hideWhenEmpty": false },
            { "id": "custom-1", "name": "Deals", "builtin": false,
              "rules": [{ "field": "from", "contains": "thriftytraveler.com" },
                         { "field": "subject", "contains": "flash sale" }],
              "op": "or", "hideWhenEmpty": true },
            { "id": "other", "name": "Other", "builtin": true,
              "rules": [], "op": "or", "hideWhenEmpty": false }
        ]);
        set_json(&conn, "settings", &v).unwrap();

        let s = get_settings(&conn);
        assert_eq!(s.splits[0].query, "label:IMPORTANT");
        assert_eq!(s.splits[1].query, "from:thriftytraveler.com OR subject:\"flash sale\"");
        assert!(s.splits[1].hide_when_empty);
        assert_eq!(s.splits[2].query, "");
        // classification sees the same migrated config
        let cfg = split_config(&conn);
        assert_eq!(cfg[1].query, "from:thriftytraveler.com OR subject:\"flash sale\"");
    }

    #[test]
    fn bm25_ranks_subject_matches_over_body_matches() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        // The body-only match is NEWER — the old last_date ordering would
        // have put it first; weighted bm25 must not.
        seed(&conn, "t-body", "Quarterly plans", "the roadmap deck is attached", "Ann", 2_000);
        seed(&conn, "t-subj", "Roadmap review", "see you tomorrow", "Bob", 1_000);
        let hits = search(&conn, "roadmap", ACCT).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].thread_id, "t-subj");
        assert_eq!(hits[1].thread_id, "t-body");
    }

    #[test]
    fn equal_relevance_falls_back_to_recency() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        seed(&conn, "t-old", "Invoice March", "amount due", "Ann", 1_000);
        seed(&conn, "t-new", "Invoice April", "amount due", "Ann", 2_000);
        let hits = search(&conn, "invoice", ACCT).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].thread_id, "t-new");
        assert_eq!(hits[1].thread_id, "t-old");
    }

    #[test]
    fn clear_account_mail_removes_only_that_account() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        seed(&conn, "t-keep", "Quarterly plans", "the roadmap deck", "Ann", 1_000);
        let t = Thread {
            id: "t-gone".into(),
            subject: "Disconnect me".into(),
            snippet: String::new(),
            participants: vec!["Bob".into()],
            recipients: vec![],
            message_count: 1,
            last_date: 2_000,
            unread: false,
            starred: false,
            labels: vec![],
            in_inbox: true,
            snoozed_until: None,
            split: String::new(),
            also_in: vec![],
        };
        let m = Message {
            id: "t-gone-m1".into(),
            thread_id: "t-gone".into(),
            from: "bob@x.test".into(),
            from_name: "Bob".into(),
            to: vec!["you@x.test".into()],
            cc: vec![],
            subject: "Disconnect me".into(),
            snippet: String::new(),
            body_text: "unsubscribed farewell".into(),
            body_html: None,
            date: 2_000,
            unread: false,
            attachments: vec![],
        };
        upsert_thread(&conn, "other@x.test", &t, &[(m, None, None, None, vec![])]).unwrap();

        clear_account_mail(&conn, "other@x.test").unwrap();

        assert_eq!(count_threads(&conn, "other@x.test"), 0);
        assert_eq!(count_threads(&conn, ACCT), 1);
        // FTS rows follow their account: the cleared account's text is gone,
        // the kept account still searches.
        assert_eq!(search(&conn, "farewell", "other@x.test").unwrap().len(), 0);
        assert_eq!(search(&conn, "roadmap", ACCT).unwrap().len(), 1);
        let msgs: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages WHERE thread_id = 't-gone'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(msgs, 0);
    }

    #[test]
    fn person_query_ranks_senders_over_recipients() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        // Maya sent this one (older)…
        seed(&conn, "t-from", "Deck feedback", "here are my notes", "Maya", 1_000);
        // …and the user wrote TO Maya in this newer one: the recipient match
        // must still rank below the sender match.
        let t = Thread {
            id: "t-to".into(),
            subject: "Intro thread".into(),
            snippet: String::new(),
            participants: vec!["You".into()],
            recipients: vec![],
            message_count: 1,
            last_date: 2_000,
            unread: false,
            starred: false,
            labels: vec![],
            in_inbox: true,
            snoozed_until: None,
            split: String::new(),
            also_in: vec![],
        };
        let m = Message {
            id: "t-to-m1".into(),
            thread_id: "t-to".into(),
            from: "you@x.test".into(),
            from_name: "You".into(),
            to: vec!["Maya <maya@x.test>".into()],
            cc: vec![],
            subject: "Intro thread".into(),
            snippet: String::new(),
            body_text: "hi both".into(),
            body_html: None,
            date: 2_000,
            unread: false,
            attachments: vec![],
        };
        upsert_thread(&conn, ACCT, &t, &[(m, None, None, None, vec![])]).unwrap();

        let plan = crate::search::SearchPlan { people: vec!["maya".into()], ..Default::default() };
        let hits = search_planned(&conn, &plan, ACCT, None).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].thread_id, "t-from");
        assert_eq!(hits[1].thread_id, "t-to");
    }

    #[test]
    fn date_window_narrows_term_search() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        seed(&conn, "t-mar", "Invoice March", "amount due", "Ann", 3_000);
        seed(&conn, "t-apr", "Invoice April", "amount due", "Ann", 5_000);
        let plan = crate::search::SearchPlan {
            terms: vec!["invoice".into()],
            after: Some(4_000),
            ..Default::default()
        };
        let hits = search_planned(&conn, &plan, ACCT, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].thread_id, "t-apr");
    }

    #[test]
    fn hybrid_surfaces_semantic_match_lexical_misses() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        // "bill"/"receipt" body — the word "invoice" appears nowhere
        seed(&conn, "t-bill", "Wire receipt", "your bill payment receipt is attached", "Mercury", 1_000);
        seed(&conn, "t-noise", "Picnic", "sunny weather saturday", "Ann", 2_000);
        // toy space: dim0 = money concept, dim1 = leisure
        let mut money = vec![0f32; 384];
        money[0] = 1.0;
        let mut leisure = vec![0f32; 384];
        leisure[1] = 1.0;
        vec::insert(&conn, "t-bill-m1", "t-bill", ACCT, "test", &money).unwrap();
        vec::insert(&conn, "t-noise-m1", "t-noise", ACCT, "test", &leisure).unwrap();
        let plan = crate::search::SearchPlan { terms: vec!["invoice".into()], ..Default::default() };
        // lexical alone: nothing
        assert!(search_planned(&conn, &plan, ACCT, None).unwrap().is_empty());
        // hybrid: the money-space thread surfaces first
        let hits = search_planned(&conn, &plan, ACCT, Some(&money)).unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].thread_id, "t-bill");
    }

    #[test]
    fn exact_term_hits_stay_on_top_of_semantic_neighbors() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        seed(&conn, "t-exact", "Invoice April", "amount due", "Ann", 1_000);
        seed(&conn, "t-sem", "Wire receipt", "payment receipt", "Mercury", 2_000);
        let mut money = vec![0f32; 384];
        money[0] = 1.0;
        // BOTH threads sit in money-space; only t-exact contains the term
        vec::insert(&conn, "t-exact-m1", "t-exact", ACCT, "test", &money).unwrap();
        vec::insert(&conn, "t-sem-m1", "t-sem", ACCT, "test", &money).unwrap();
        let plan = crate::search::SearchPlan { terms: vec!["invoice".into()], ..Default::default() };
        let hits = search_planned(&conn, &plan, ACCT, Some(&money)).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].thread_id, "t-exact", "dual-leg must beat vector-only");
        // and with no vector at all, behavior is exactly the old lexical path
        let lex = search_planned(&conn, &plan, ACCT, None).unwrap();
        assert_eq!(lex.len(), 1);
        assert_eq!(lex[0].thread_id, "t-exact");
    }

    #[test]
    fn knn_leg_honors_date_narrowing() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        seed(&conn, "t-in", "Wire receipt", "payment receipt", "Mercury", 5_000);
        seed(&conn, "t-out", "Old wire", "payment receipt", "Mercury", 1_000);
        let mut money = vec![0f32; 384];
        money[0] = 1.0;
        vec::insert(&conn, "t-in-m1", "t-in", ACCT, "test", &money).unwrap();
        vec::insert(&conn, "t-out-m1", "t-out", ACCT, "test", &money).unwrap();
        let plan = crate::search::SearchPlan {
            terms: vec!["invoice".into()],
            after: Some(4_000),
            ..Default::default()
        };
        let hits = search_planned(&conn, &plan, ACCT, Some(&money)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].thread_id, "t-in");
    }

    #[test]
    fn operator_query_routes_through_search() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        seed(&conn, "t-maya", "Deck feedback", "notes attached", "Maya", 1_000);
        seed(&conn, "t-ann", "Deck outline", "first cut", "Ann", 2_000);
        // The old sanitizer degenerated "from:maya" into the term "frommaya"
        // (zero hits); the operator-aware parse must route it as a person.
        let hits = search(&conn, "from:maya deck", ACCT).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].thread_id, "t-maya");
    }

    #[test]
    fn threads_with_contact_matches_addresses_not_body() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        // Maya is the SENDER here — must match.
        seed(&conn, "t-from", "Deck feedback", "notes attached", "Maya", 3_000);
        // Her address only appears in the BODY here — must NOT match (the bug).
        seed(&conn, "t-body", "Logistics", "please cc maya@x.test next time", "Bob", 4_000);
        // Maya is a RECIPIENT here — must match.
        let t = Thread {
            id: "t-to".into(),
            subject: "Intro".into(),
            snippet: String::new(),
            participants: vec!["You".into()],
            recipients: vec![],
            message_count: 1,
            last_date: 2_000,
            unread: false,
            starred: false,
            labels: vec![],
            in_inbox: true,
            snoozed_until: None,
            split: String::new(),
            also_in: vec![],
        };
        let m = Message {
            id: "t-to-m1".into(),
            thread_id: "t-to".into(),
            from: "you@x.test".into(),
            from_name: "You".into(),
            to: vec!["Maya <maya@x.test>".into()],
            cc: vec![],
            subject: "Intro".into(),
            snippet: String::new(),
            body_text: "hi".into(),
            body_html: None,
            date: 2_000,
            unread: false,
            attachments: vec![],
        };
        upsert_thread(&conn, ACCT, &t, &[(m, None, None, None, vec![])]).unwrap();

        // recency desc; the body-only mention (t-body) is excluded.
        let hits = threads_with_contact(&conn, "maya@x.test", ACCT, 10).unwrap();
        assert_eq!(
            hits.iter().map(|r| r.thread_id.as_str()).collect::<Vec<_>>(),
            vec!["t-from", "t-to"]
        );
        // case-insensitive against the stored address.
        assert_eq!(threads_with_contact(&conn, "MAYA@X.TEST", ACCT, 10).unwrap().len(), 2);
        // a non-correspondent surfaces nothing, not full-text noise.
        assert!(threads_with_contact(&conn, "ghost@x.test", ACCT, 10).unwrap().is_empty());
    }

    // ------------------------------------------------------------ vectors

    #[test]
    fn vec0_loads_and_knn_returns_hand_inserted_vector() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        let v: String = conn.query_row("SELECT vec_version()", [], |r| r.get(0)).unwrap();
        assert!(v.starts_with('v'));
        let mut a = vec![0f32; 384];
        a[0] = 1.0;
        let mut b = vec![0f32; 384];
        b[1] = 1.0;
        vec::insert(&conn, "m-a", "t-a", ACCT, "test", &a).unwrap();
        vec::insert(&conn, "m-b", "t-b", ACCT, "test", &b).unwrap();
        // query near a: a must come back first at ~0 cosine distance
        let mut q = vec![0f32; 384];
        q[0] = 1.0;
        let hits: Vec<(i64, f64)> = conn
            .prepare("SELECT rowid, distance FROM mail_vec WHERE embedding MATCH ?1 AND k = 2")
            .unwrap()
            .query_map(rusqlite::params![vec::vec_to_blob(&q)], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits[0].1 < 0.001 && hits[1].1 > 0.9, "distances: {hits:?}");
    }

    #[test]
    fn deleting_a_thread_drops_its_vectors_and_missing_finds_unembedded() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        seed(&conn, "t-1", "Invoice", "amount due", "Ann", 1_000);
        let missing = vec::missing(&conn, ACCT, 10).unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].0, "t-1-m1");
        assert!(missing[0].2.starts_with("Invoice\namount due"), "text: {:?}", missing[0].2);
        let mut v = vec![0f32; 384];
        v[3] = 1.0;
        vec::insert(&conn, "t-1-m1", "t-1", ACCT, "test", &v).unwrap();
        assert_eq!(vec::count_missing(&conn, ACCT).unwrap(), 0);
        assert_eq!(vec::count_embedded(&conn, ACCT).unwrap(), 1);
        delete_thread(&conn, "t-1").unwrap();
        assert_eq!(vec::count_embedded(&conn, ACCT).unwrap(), 0);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM mail_vec", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    // ------------------------------------------------- per-account files

    #[test]
    fn account_db_filename_is_stable_safe_and_distinct() {
        let a = account_db_filename("ssp@pujariventurepartners.com");
        assert_eq!(a, account_db_filename("ssp@pujariventurepartners.com"));
        assert!(a.ends_with(".db"), "{a}");
        let stem = a.trim_end_matches(".db");
        assert!(
            stem.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'),
            "{stem}"
        );
        assert_ne!(account_db_filename("a@x.test"), account_db_filename("b@x.test"));
        // the hash disambiguates emails that sanitize to the same prefix
        assert_ne!(account_db_filename("a.b@x.test"), account_db_filename("a_b@x.test"));
        // unicode/path-hostile input stays a bounded, plain-ascii name
        let odd = account_db_filename("Ünïcode+weird/..\\name@Ex.Test");
        assert!(odd.len() <= 60, "{odd}");
        assert!(!odd.contains('.') || odd.ends_with(".db"));
    }

    #[test]
    fn open_global_creates_only_kv() {
        let conn = open_global(std::path::Path::new(":memory:")).unwrap();
        set_json(&conn, "probe", &42).unwrap();
        assert_eq!(get_json::<i32>(&conn, "probe"), Some(42));
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'
                 AND name IN ('threads','messages','attachments','outbox','drafts','events')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "global db must not carry account tables");
    }

    #[test]
    fn model_tag_change_wipes_all_but_demo_vectors() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        let v = {
            let mut v = vec![0f32; 384];
            v[0] = 1.0;
            v
        };
        vec::insert(&conn, "m-real", "t-r", ACCT, "local:x", &v).unwrap();
        vec::insert(&conn, "m-demo", "t-d", "demo@fission.local", "demo", &v).unwrap();
        assert!(vec::ensure_model_tag(&conn, "local:y").unwrap());
        assert_eq!(vec::count_embedded(&conn, ACCT).unwrap(), 0);
        assert_eq!(vec::count_embedded(&conn, "demo@fission.local").unwrap(), 1);
        // same tag again: no wipe
        assert!(!vec::ensure_model_tag(&conn, "local:y").unwrap());
    }
}
