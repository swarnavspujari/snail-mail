//! Pulls Gmail state into SQLite. The DB is the single source of truth for
//! the UI; sync reconciles it with the server.
//!
//! Three paths:
//! - **incremental** (normal): users.history.list since the stored per-account
//!   historyId — cheap, catches changes to any thread, no listing caps.
//! - **reconcile** (first sync / expired historyId): paged thread listings
//!   (inbox up to 500, recent archived up to 200) diffed by per-thread
//!   historyId, then the new baseline historyId is stored.
//! - **crawl** (background): resumable full-history walk that fetches and
//!   FTS-indexes every thread past the backfill caps, one page per beat.
use crate::mail::gmail::{parse_gmail_message, GmailSession};
use crate::store;
use crate::types::*;
use futures_util::StreamExt;
use rusqlite::Connection;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const INBOX_BACKFILL: usize = 500;
const DONE_BACKFILL: usize = 200;
const TRASH_BACKFILL: usize = 100;

fn history_key(account_id: &str) -> String {
    format!("history:{account_id}")
}

// ---------------------------------------------------------------- activity
//
// Every Gmail round-trip below is exactly one `threads.get`, so "downloading X
// of N" maps 1:1 onto requests. These counts always existed here; the old
// zero-argument `Fn()` callback threw them away and the consumer re-derived a
// worse number with a SQL COUNT. The tick carries them out instead.
//
// Emission policy (throttling, coalescing, what the UI does with it) lives at
// the callback's other end in lib.rs — this module fires on every item and
// stays policy-free.

/// Which pass is doing the fetching. Serializes kebab-case to match the TS
/// `SyncStage` union.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncStage {
    /// Reconcile phase 1 — the inbox, fetched before anything else.
    ReconcileInbox,
    /// Reconcile phase 2 — done + trash, behind the now-visible inbox.
    ReconcileRest,
    /// history.list catch-up: the common case, silent until now.
    Incremental,
    /// Background full-history walk, one listing page per beat.
    Crawl,
    /// Repair Mail — a forced reconcile that re-parses every listed thread.
    Resync,
    /// "Load older" paging at the bottom of a list.
    LoadOlder,
    /// "Get me to zero" draining a split. The only stage that isn't
    /// downloading — it reports local archive progress, because a sweep over a
    /// large split takes long enough that silence reads as a hang.
    Sweep,
}

/// One beat of download activity. `done`/`total` are thread counts within the
/// current pass, not lifetime totals — `total` is the exact denominator the
/// fetch loop already holds.
#[derive(Clone, Debug, serde::Serialize)]
pub struct SyncTick {
    pub account: String,
    pub stage: SyncStage,
    pub done: usize,
    pub total: usize,
}

/// Callback shape shared by every fetching path.
pub type ProgressFn<'a> = &'a (dyn Fn(SyncTick) + Send + Sync);

/// Distinguishes Repair Mail from every other forced reconcile. `reconcile()`
/// sees only `force_reconcile: bool`, so without this a resync is
/// indistinguishable from the boot pass or the ~10-minute forced tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncPass {
    Normal,
    Resync,
}

impl SyncPass {
    /// The stage to report for a reconcile phase under this pass.
    fn stage(self, phase: SyncStage) -> SyncStage {
        match self {
            SyncPass::Resync => SyncStage::Resync,
            SyncPass::Normal => phase,
        }
    }
}

/// Sync one account. Returns true if anything changed (caller emits
/// mail:updated). `force_reconcile` ignores the stored historyId and does a full
/// listing pass — the periodic safety net that catches inbox removals the
/// incremental path missed.
///
/// `on_progress` is called as threads stream in; the caller wires it to emit
/// `mail:updated` (+ `sync:progress` and `sync:activity`) so the inbox paints
/// and fills in live instead of all-at-once at the end. Every fetching path
/// invokes it now — including the cheap incremental one, which used to be
/// silent even though it knows exactly how many threads it is about to refetch.
pub async fn full_sync(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    force_reconcile: bool,
    pass: SyncPass,
    on_progress: ProgressFn<'_>,
    splits: &[Split],
) -> Result<bool, String> {
    let key = history_key(account_id);
    let start: Option<String> = if force_reconcile {
        None
    } else {
        let conn = db.lock().unwrap();
        store::get_json(&conn, &key)
    };
    let mut changed = match start {
        Some(hid) => {
            match incremental(http, session, db, account_id, &hid, &key, on_progress, splits).await
            {
                Ok(c) => c,
                // An expired historyId (Gmail keeps ~a week) returns 404; an invalid
                // one returns 400. Either way reconcile from scratch instead of
                // pinning a dead baseline and re-failing the same window forever.
                Err(e) if e.contains("(404") || e.contains("(400") => {
                    reconcile(http, session, db, account_id, &key, pass, on_progress, splits)
                        .await?
                }
                Err(e) => return Err(e),
            }
        }
        None => reconcile(http, session, db, account_id, &key, pass, on_progress, splits).await?,
    };

    // Muted threads never sit in the inbox: any that resurfaced (new reply)
    // are re-archived, mirroring Gmail's mute semantics locally.
    let muted: Vec<String> = {
        let conn = db.lock().unwrap();
        store::muted_inbox_threads(&conn, account_id)
    };
    for id in muted {
        let _ = session.modify_thread(http, &id, &[], &["INBOX"]).await;
        let conn = db.lock().unwrap();
        store::set_in_inbox(&conn, &id, false)?;
        changed = true;
    }
    Ok(changed)
}

/// history.list-driven catch-up: collect affected thread ids, refetch those.
async fn incremental(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    start_history_id: &str,
    key: &str,
    on_progress: ProgressFn<'_>,
    splits: &[Split],
) -> Result<bool, String> {
    let mut affected: HashSet<String> = HashSet::new();
    let mut latest = start_history_id.to_string();
    let mut page_token: Option<String> = None;
    let empty: Vec<Value> = vec![];
    loop {
        let v = session
            .history_page(http, start_history_id, page_token.as_deref())
            .await?; // 404 propagates to the caller for fallback
        if let Some(hid) = v["historyId"].as_str() {
            latest = hid.to_string();
        }
        for h in v["history"].as_array().unwrap_or(&empty) {
            for kind in ["messagesAdded", "messagesDeleted", "labelsAdded", "labelsRemoved"] {
                for entry in h[kind].as_array().unwrap_or(&empty) {
                    if let Some(tid) = entry["message"]["threadId"].as_str() {
                        affected.insert(tid.to_string());
                    }
                }
            }
        }
        page_token = v["nextPageToken"].as_str().map(str::to_string);
        if page_token.is_none() {
            break;
        }
    }

    let mut changed = false;
    // `affected.len()` is the exact denominator for this pass — the common-case
    // 30s tick, which reported nothing at all before.
    let total = affected.len();
    for (i, tid) in affected.iter().enumerate() {
        match refetch_thread(http, session, db, account_id, tid, splits).await {
            Ok(c) => changed |= c,
            // One thread failing (rate-limit, transient network, an unexpected
            // body) must NOT abort the loop — otherwise the advanced historyId
            // below is never stored, pinning the account to a stale window that
            // re-fails every cycle. Log it and keep going.
            Err(e) => eprintln!("[sync:{account_id}] refetch {tid} failed: {e}"),
        }
        // Tick after the fetch (failures included): the count tracks round-trips
        // spent, so it always reaches `total` and the terminal tick fires.
        on_progress(SyncTick {
            account: account_id.to_string(),
            stage: SyncStage::Incremental,
            done: i + 1,
            total,
        });
    }
    if latest != start_history_id {
        let conn = db.lock().unwrap();
        store::set_json(&conn, key, &latest)?;
    }
    Ok(changed)
}

/// Full listing pass; also the initial backfill. Stores the new baseline
/// historyId (captured BEFORE listing, so nothing in between is missed).
///
/// Inbox-first: the inbox is listed, diffed, and fetched **before** done/trash,
/// and `on_progress` fires once per thread, so the inbox paints
/// and fills in live while the rest of history backfills behind it (the crawler
/// takes the tail past the caps). The per-folder caps are unchanged — the
/// "archived elsewhere" flip below assumes the inbox listing is complete, which
/// the 500-cap upholds.
async fn reconcile(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    key: &str,
    pass: SyncPass,
    on_progress: ProgressFn<'_>,
    splits: &[Split],
) -> Result<bool, String> {
    // Captured BEFORE the listings so a thread the user trashes mid-reconcile
    // isn't mistaken for a server-side restore and resurrected below.
    let locally_trashed: Vec<String> = {
        let conn = db.lock().unwrap();
        store::trashed_thread_ids(&conn, account_id)
    };

    let prof = session.profile(http).await?;
    let baseline = prof["historyId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| prof["historyId"].as_u64().map(|n| n.to_string()))
        .unwrap_or_default();
    // threadsTotal is the denominator for the "downloading mail history"
    // indicator (see emit_sync_progress). Gmail may report it as a number or a
    // string; keep any prior value if this profile omitted it.
    //
    // profile.threadsTotal counts the WHOLE mailbox — spam, trash and drafts
    // included — while both the crawl (CRAWL_QUERY) and the local numerator
    // exclude them. Mismatched populations are why the bar asymptoted below
    // 100% and had to be clamped. labels.list carries no counts, so subtract
    // the three excluded labels' own threadsTotal via labels.get.
    let threads_total = prof["threadsTotal"]
        .as_i64()
        .or_else(|| prof["threadsTotal"].as_str().and_then(|s| s.parse().ok()));
    if let Some(total) = threads_total.filter(|&t| t > 0) {
        let excluded = session.excluded_thread_totals(http).await;
        // Never let a bad subtraction invert the denominator.
        let net = (total - excluded).max(1);
        let conn = db.lock().unwrap();
        let _ = store::set_json(&conn, &format!("threads_total:{account_id}"), &net);
    }

    // Refresh the label id→name map; older syncs stored opaque ids in
    // threads.labels, so repair those rows once the map is known.
    let mut changed = false;
    match session.list_labels(http).await {
        Ok(pairs) => {
            let conn = db.lock().unwrap();
            store::upsert_labels(&conn, account_id, &pairs)?;
            let map = store::label_map(&conn, account_id);
            changed |= store::rename_thread_labels(&conn, account_id, &map)?;
        }
        Err(e) => eprintln!("[sync:{account_id}] label listing failed: {e}"),
    }

    // ---- Phase 1: inbox, so it paints before done/trash are even listed ----
    let inbox = session
        .list_thread_ids_paged(http, "in:inbox", INBOX_BACKFILL)
        .await?;
    let inbox_ids: HashSet<&str> = inbox.iter().map(|(id, _)| id.as_str()).collect();
    let mut inbox_to_fetch: Vec<String> = vec![];
    {
        let conn = db.lock().unwrap();
        for (id, history_id) in &inbox {
            if !thread_history_matches(&conn, id, history_id) {
                inbox_to_fetch.push(id.clone());
            }
        }
        // Threads we think are in the inbox but the server no longer does
        // (archived elsewhere) — flip them locally.
        let local_inbox: Vec<String> = store::list_threads(&conn, "inbox", account_id)?
            .into_iter()
            .map(|t| t.id)
            .collect();
        for id in local_inbox {
            // mock-era ids (t-… / t2-…) are never reconciled against Gmail
            if !id.starts_with("t-") && !id.starts_with("t2-") && !inbox_ids.contains(id.as_str()) {
                store::set_in_inbox(&conn, &id, false)?;
                changed = true;
            }
        }
    }
    // The extra repaint that used to sit here is gone: fetch_streaming now ends
    // every phase on a terminal tick, and the caller repaints on those, so the
    // last sub-batch of inbox threads still shows before the slower done/trash
    // backfill starts. Re-emitting it would restart the pill on a pass that had
    // just completed.
    changed |= fetch_streaming(
        http,
        session,
        db,
        account_id,
        &inbox_to_fetch,
        pass.stage(SyncStage::ReconcileInbox),
        on_progress,
        splits,
    )
    .await;

    // ---- Phase 2: done + trash behind the now-visible inbox ----
    let done = session
        .list_thread_ids_paged(http, "-in:inbox -in:spam -in:trash -in:draft", DONE_BACKFILL)
        .await?;
    let trash = session
        .list_thread_ids_paged(http, "in:trash", TRASH_BACKFILL)
        .await?;

    let live_ids: HashSet<&str> =
        inbox.iter().chain(done.iter()).map(|(id, _)| id.as_str()).collect();
    let trash_ids: HashSet<&str> = trash.iter().map(|(id, _)| id.as_str()).collect();

    let mut rest_to_fetch: Vec<String> = vec![];
    {
        let conn = db.lock().unwrap();
        for (id, history_id) in done.iter().chain(trash.iter()) {
            if !thread_history_matches(&conn, id, history_id) {
                rest_to_fetch.push(id.clone());
            }
        }
    }
    changed |= fetch_streaming(
        http,
        session,
        db,
        account_id,
        &rest_to_fetch,
        pass.stage(SyncStage::ReconcileRest),
        on_progress,
        splits,
    )
    .await;

    // Two-way trash: threads the server has in trash get hidden locally
    // (upsert never touches the hidden column), and threads restored on the
    // server side come back out. Gmail's "empty trash" deletes threads, which
    // the refetch 404 path above already drops.
    {
        let conn = db.lock().unwrap();
        for (id, _) in &trash {
            if store::get_thread(&conn, id).is_some()
                && store::hidden_reason(&conn, id).as_deref() != Some("trash")
            {
                store::set_hidden(&conn, id, Some("trash"))?;
                changed = true;
            }
        }
        // Restore only threads the server affirmatively lists live again —
        // absence from the (capped) trash listing alone isn't proof.
        for id in &locally_trashed {
            if !id.starts_with("t-")
                && !id.starts_with("t2-")
                && !trash_ids.contains(id.as_str())
                && live_ids.contains(id.as_str())
            {
                store::clear_hidden(&conn, id)?;
                changed = true;
            }
        }
    }

    if !baseline.is_empty() {
        let conn = db.lock().unwrap();
        store::set_json(&conn, key, &baseline)?;
    }
    Ok(changed)
}

/// Does the locally-stored thread already carry this exact history_id? (A miss
/// — new thread or a moved history_id — means it needs a full refetch.)
fn thread_history_matches(conn: &Connection, id: &str, history_id: &str) -> bool {
    let known: Option<String> = conn
        .query_row(
            "SELECT COALESCE(history_id, '') FROM threads WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .ok();
    known.as_deref() == Some(history_id)
}

/// Refetch a batch of threads, pinging `on_progress` after every one so the UI
/// can count them live and reveal them as they land instead of all-at-once at
/// the end. Returns true if anything was fetched. One poison thread is logged
/// and skipped — it must not abort the pass (which would skip storing the
/// reconcile baseline and pin the account to re-run the full listing every
/// cycle).
///
/// Ticking per item is deliberate: the caller decides how often that becomes a
/// repaint and how often it becomes a `sync:activity` emit (see `ActivityGate`
/// and `REPAINT_EVERY` in lib.rs). The old `STREAM_EVERY` batching lived here
/// and coupled the two.
async fn fetch_streaming(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    ids: &[String],
    stage: SyncStage,
    on_progress: ProgressFn<'_>,
    splits: &[Split],
) -> bool {
    let mut changed = false;
    let total = ids.len();
    for (i, id) in ids.iter().enumerate() {
        match refetch_thread(http, session, db, account_id, id, splits).await {
            Ok(_) => changed = true,
            Err(e) => eprintln!("[sync:{account_id}] reconcile refetch {id} failed: {e}"),
        }
        on_progress(SyncTick {
            account: account_id.to_string(),
            stage,
            done: i + 1,
            total,
        });
    }
    changed
}

/// Fetch one thread and apply it locally. Handles deletion (404 → drop the
/// local row), snooze preservation, and hidden threads. Returns true if the
/// local DB changed.
pub async fn refetch_thread(
    http: &reqwest::Client,
    session: &mut GmailSession,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    id: &str,
    splits: &[Split],
) -> Result<bool, String> {
    let mut v = match session.get_thread_full(http, id).await {
        Ok(v) => v,
        Err(e) if e.contains("(404") => return apply_gone(db, id),
        Err(e) => return Err(e),
    };

    // Pull in large text bodies stored behind body.attachmentId so the parse
    // below captures them (otherwise those messages persist an empty body).
    crate::mail::gmail::hydrate_body_data(http, session, &mut v).await;

    apply_thread(db, account_id, id, &v, splits)
}

/// The thread is gone server-side (permanent delete) — drop the local row.
/// Returns whether anything changed.
pub fn apply_gone(db: &std::sync::Mutex<Connection>, id: &str) -> Result<bool, String> {
    let conn = db.lock().unwrap();
    let existed = store::get_thread(&conn, id).is_some();
    if existed {
        store::delete_thread(&conn, id)?;
    }
    Ok(existed)
}

/// Apply an already-fetched thread JSON locally — the half of `refetch_thread`
/// that needs no network. Split out so the crawl can fetch several threads at
/// once and then land them one at a time (the db mutex serializes writes
/// anyway, and parsing off the request path is what makes concurrency pay).
pub fn apply_thread(
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    id: &str,
    v: &Value,
    splits: &[Split],
) -> Result<bool, String> {
    let history_id = v["historyId"].as_str().unwrap_or_default().to_string();
    let empty = vec![];
    let in_inbox = v["messages"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .any(|m| {
            m["labelIds"]
                .as_array()
                .map(|ls| ls.iter().any(|l| l.as_str() == Some("INBOX")))
                .unwrap_or(false)
        });
    let (mut thread, msgs) = thread_from_json(id, v, in_inbox);
    {
        let conn = db.lock().unwrap();
        // Gmail sends user labels as opaque ids — resolve them to display
        // names via the map persisted at reconcile (unknown ids pass through
        // until the next label listing catches up).
        let label_names = store::label_map(&conn, account_id);
        if !label_names.is_empty() {
            thread.labels = thread
                .labels
                .iter()
                .map(|l| label_names.get(l).unwrap_or(l).clone())
                .collect();
        }
        // A snoozed thread that grew a new message wakes up immediately.
        let existing = store::get_thread(&conn, id);
        let was_snoozed = existing.as_ref().and_then(|t| t.snoozed_until).is_some();
        // The local "Muted" marker is a display name; Gmail stores user labels as
        // opaque ids, so a refetch's labels=excluded.labels overwrites it. Remember
        // it and re-assert below so muted_inbox_threads keeps matching and new
        // replies to a muted thread are still auto-archived.
        let was_muted = existing
            .as_ref()
            .map(|t| t.labels.iter().any(|l| l == "Muted"))
            .unwrap_or(false);
        let grew = existing
            .as_ref()
            .map(|t| t.message_count < thread.message_count)
            .unwrap_or(false);
        store::upsert_thread(&conn, account_id, &thread, &msgs, splits)?;
        if was_muted {
            let _ = store::toggle_label(&conn, id, "Muted");
        }
        if was_snoozed && !grew {
            // keep the local snooze: sync would otherwise resurface it
            conn.execute(
                "UPDATE threads SET in_inbox = 0, snoozed_until = (SELECT snoozed_until FROM threads WHERE id = ?1) WHERE id = ?1",
                [id],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "UPDATE threads SET history_id = ?2 WHERE id = ?1",
            rusqlite::params![id, history_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(true)
}

pub fn thread_from_json(id: &str, v: &Value, in_inbox: bool) -> (Thread, Vec<store::MsgRow>) {
    let empty = vec![];
    let raw_msgs = v["messages"].as_array().unwrap_or(&empty);
    let mut msgs: Vec<store::MsgRow> = vec![];
    let mut participants: Vec<String> = vec![];
    let mut recipients: Vec<String> = vec![];
    let mut labels: HashSet<String> = HashSet::new();
    let mut unread = false;
    let mut last_date = 0i64;
    let mut subject = String::new();
    let mut snippet = String::new();

    for m in raw_msgs {
        let parsed = parse_gmail_message(m, id);
        for l in &parsed.label_ids {
            labels.insert(l.clone());
        }
        unread |= parsed.message.unread;
        if parsed.message.date >= last_date {
            last_date = parsed.message.date;
            snippet = parsed.message.snippet.clone();
        }
        if subject.is_empty() && !parsed.message.subject.is_empty() {
            subject = parsed.message.subject.clone();
        }
        let p = format!("{} <{}>", parsed.message.from_name, parsed.message.from);
        if !participants.contains(&p) {
            participants.push(p);
        }
        // Recipient union across the thread powers `to:` split queries.
        // Capped so a huge CC blast can't bloat the row.
        for addr in parsed.message.to.iter().chain(parsed.message.cc.iter()) {
            let a = addr.trim().to_string();
            if !a.is_empty() && !recipients.contains(&a) && recipients.len() < 40 {
                recipients.push(a);
            }
        }
        let atts = parsed
            .attachments
            .into_iter()
            .map(|(a, remote, content_id)| (a, remote, content_id, None))
            .collect();
        msgs.push((parsed.message, parsed.rfc_message_id, parsed.list_unsubscribe, parsed.ics, atts));
    }

    let starred = labels.contains("STARRED");
    let thread = Thread {
        id: id.to_string(),
        subject: if subject.is_empty() { "(no subject)".into() } else { subject },
        snippet,
        participants,
        recipients,
        message_count: msgs.len() as i64,
        last_date,
        unread,
        starred,
        // CATEGORY_* stays (v0.23) so category-driven splits are expressible;
        // the UI filters them from label chips.
        labels: labels
            .into_iter()
            .filter(|l| l != "INBOX" && l != "UNREAD" && l != "STARRED")
            .collect(),
        in_inbox,
        snoozed_until: None,
        split: String::new(),   // materialized by upsert_thread
        also_in: vec![],
    };
    (thread, msgs)
}

// ------------------------------------------------------------------ crawl
//
// Background full-history search indexing. reconcile() caps its listings, so
// mail older than the caps never entered mail_fts and the first search for it
// paid a live Gmail round-trip. The crawl walks the whole mailbox once,
// newest to oldest, fetching + indexing whatever isn't local yet. The cursor
// lives in kv so the walk survives restarts, and re-anchors with before: when
// a persisted page token expires. Once done, incremental sync keeps the index
// current — done is terminal.
//
// It used to fetch one thread per request, one listing page per 30-second
// tick, serially: ~3.3 threads/second of wall clock, so tens of thousands of
// threads took hours. Two things changed, and neither of them is batching.
//
//   * Concurrency. A page resolves ONE bearer and fetches its threads several
//     at a time. (Batching via POST /batch was considered and dropped: it
//     saves round-trips, not quota, and concurrency already collects most of
//     that win for none of the multipart/partial-failure complexity.)
//   * A loop of its own. The crawl no longer waits for the sync tick, so the
//     duty cycle stops being the bottleneck.
//
// What did NOT change is format=full. `format=metadata` would make the tail
// arrive faster, but it returns no body: old mail would be searchable by
// subject and snippet only, and — worse — `store::vec::missing` only selects
// rows with NO vector, so embedding a snippet-only row once means a later
// body pass never re-embeds it. That damage is permanent.

/// Gmail's default search scope (no spam/trash), minus drafts — the same
/// population local search exposes (`hidden IS NULL`, reconcile skips drafts).
const CRAWL_QUERY: &str = "-in:spam -in:trash -in:draft";
/// Re-anchor overlap: a day of re-listed (and then history_id-skipped)
/// threads absorbs before:'s coarse granularity at the boundary.
const ANCHOR_OVERLAP_SECS: i64 = 86_400;
/// How long to wait out a throttled page before trying again.
const THROTTLE_BACKOFF_MS: u64 = 2_000;

fn crawl_key(account_id: &str) -> String {
    format!("crawl:{account_id}")
}

/// Persisted crawl position (kv: crawl:<account>).
#[derive(serde::Serialize, serde::Deserialize, Clone, Default, Debug, PartialEq)]
pub struct CrawlCursor {
    /// Next listing page. None at the start of a (re-)listing.
    #[serde(default)]
    pub page_token: Option<String>,
    /// Unix seconds the current listing is anchored at (`before:anchor`);
    /// None = listing from the newest thread.
    #[serde(default)]
    pub anchor: Option<i64>,
    /// Oldest thread date (ms) seen so far — the next anchor if the page
    /// token expires.
    #[serde(default)]
    pub oldest_ms: Option<i64>,
    /// Threads fetched + indexed by the crawl (progress logging).
    #[serde(default)]
    pub indexed: u64,
    /// Threads the crawl has ENUMERATED (fetched + already-local), across every
    /// page so far. This is the walk's own measure of the mailbox population —
    /// exactly the CRAWL_QUERY population the local numerator counts — so
    /// emit_sync_progress floors its denominator here and a low estimate from
    /// profile.threadsTotal can never pin the bar at 99%.
    #[serde(default)]
    pub listed: u64,
    /// Whole history walked; nothing left to do.
    #[serde(default)]
    pub done: bool,
}

fn crawl_query(anchor: Option<i64>) -> String {
    match anchor {
        Some(secs) => format!("{CRAWL_QUERY} before:{secs}"),
        None => CRAWL_QUERY.to_string(),
    }
}

/// A dead page token can't be resumed — restart the listing just past the
/// oldest indexed thread (or from the top if nothing was indexed yet).
fn reanchor(cur: &mut CrawlCursor) {
    cur.page_token = None;
    cur.anchor = cur.oldest_ms.map(|ms| ms / 1000 + ANCHOR_OVERLAP_SECS);
}

/// Adaptive in-flight limit. Gmail's per-user budget is 250 quota units per
/// second and `threads.get` costs 10 of them, so ~25/s is the hard ceiling;
/// eight concurrent leaves the user's own traffic real headroom. A page that
/// saw any throttling halves the limit, a clean one earns a slot back — so a
/// global 429 slows the whole walk instead of producing a thundering herd of
/// independent per-request retries.
#[derive(Debug, PartialEq, Eq)]
pub struct Governor {
    limit: usize,
}

impl Default for Governor {
    fn default() -> Self {
        Self { limit: Self::START }
    }
}

impl Governor {
    const MIN: usize = 1;
    const MAX: usize = 8;
    const START: usize = 6;

    pub fn limit(&self) -> usize {
        self.limit
    }

    /// Fold one page's throttling count into the limit.
    pub fn observe(&mut self, throttled: usize) {
        self.limit = if throttled > 0 {
            (self.limit / 2).max(Self::MIN)
        } else {
            (self.limit + 1).min(Self::MAX)
        };
    }
}

/// Which account gets the next slice: the first one AFTER `last` that still
/// has work, wrapping. Round-robin so a 60k-thread mailbox can't starve a
/// 500-thread one — with a plain loop over the account list, the first
/// account's whole history would land before the second one began.
pub fn next_account(accounts: &[(String, bool)], last: Option<&str>) -> Option<String> {
    if accounts.is_empty() {
        return None;
    }
    let start = last
        .and_then(|l| accounts.iter().position(|(a, _)| a == l))
        .map(|i| i + 1)
        .unwrap_or(0);
    (0..accounts.len())
        .map(|k| &accounts[(start + k) % accounts.len()])
        .find(|(_, pending)| *pending)
        .map(|(a, _)| a.clone())
}

/// What one page did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PageOutcome {
    /// Threads enumerated, fetched or already local.
    pub listed: usize,
    pub fetched: usize,
    pub skipped: usize,
    pub failed: usize,
    /// Fetches that came back 429/5xx — the governor's input.
    pub throttled: usize,
    pub oldest_ms: Option<i64>,
    pub next_token: Option<String>,
}

/// Fold a processed page into the cursor. Extracted from the page loop so the
/// resume property is testable without a network: a test can drive the same
/// function the live crawl uses across a simulated kill and assert the walk
/// picks up where it left off rather than restarting.
pub fn advance_cursor(cur: &mut CrawlCursor, page: &PageOutcome) {
    if let Some(d) = page.oldest_ms {
        cur.oldest_ms = Some(cur.oldest_ms.map_or(d, |o| o.min(d)));
    }
    cur.indexed += page.fetched as u64;
    // Everything on this page was enumerated, whether it needed fetching or was
    // already local — that's what makes `listed` a population size rather than a
    // work count.
    cur.listed += page.listed as u64;
    cur.page_token = page.next_token.clone();
    if cur.page_token.is_none() {
        cur.done = true; // listing exhausted: full history is indexed
    }
}

/// What one crawl beat did, for the caller's log line.
pub struct CrawlBeat {
    pub fetched: usize,
    pub skipped: usize,
    pub failed: usize,
    pub total_indexed: u64,
    pub done: bool,
}

/// The history_ids this account already has for the given thread ids — one
/// query for the whole page instead of two per thread (the old loop also
/// re-read `last_date` per thread; both are hoisted).
fn known_history_ids(conn: &Connection, ids: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return out;
    }
    let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, COALESCE(history_id, ''), COALESCE(last_date, 0) FROM threads WHERE id IN ({placeholders})"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else { return out };
    let params = rusqlite::params_from_iter(ids.iter());
    if let Ok(rows) = stmt.query_map(params, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
    }) {
        for row in rows.flatten() {
            out.insert(row.0, format!("{}\u{1}{}", row.1, row.2));
        }
    }
    out
}

/// Split a packed "history_id\u{1}last_date" value.
fn unpack_known(v: &str) -> (&str, i64) {
    match v.split_once('\u{1}') {
        Some((h, d)) => (h, d.parse().unwrap_or(0)),
        None => (v, 0),
    }
}

/// One beat of the crawl: process a single listing page (≤100 threads), then
/// persist the advanced cursor. Locks the session map only to list the page
/// and resolve a bearer — never across the fetches — so user-triggered Gmail
/// traffic interleaves with a crawl, and the page's threads download several
/// at a time instead of one every 200ms.
pub async fn crawl_step(
    http: &reqwest::Client,
    gmail: &tokio::sync::Mutex<HashMap<String, GmailSession>>,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    governor: &mut Governor,
    on_progress: ProgressFn<'_>,
    splits: &[Split],
) -> Result<CrawlBeat, String> {
    let key = crawl_key(account_id);
    let mut cur: CrawlCursor = {
        let conn = db.lock().unwrap();
        store::get_json(&conn, &key).unwrap_or_default()
    };
    if cur.done {
        return Ok(CrawlBeat {
            fetched: 0,
            skipped: 0,
            failed: 0,
            total_indexed: cur.indexed,
            done: true,
        });
    }

    let query = crawl_query(cur.anchor);
    // One lock: list the page AND resolve the bearer the fetches will share.
    let listed = {
        let mut sessions = gmail.lock().await;
        let Some(session) = sessions.get_mut(account_id) else {
            return Err("account disconnected".into());
        };
        match session.list_threads_page(http, &query, cur.page_token.as_deref()).await {
            Ok(page) => session.bearer(http).await.map(|tok| (page, tok)),
            Err(e) => Err(e),
        }
    };
    let ((page, next), token) = match listed {
        Ok(v) => v,
        // Gmail 400s a stale page token; retrying it is hopeless. Re-anchor
        // and continue from the oldest indexed thread on the next beat.
        Err(e) if e.contains("(400") && cur.page_token.is_some() => {
            reanchor(&mut cur);
            let conn = db.lock().unwrap();
            store::set_json(&conn, &key, &cur)?;
            return Err(format!(
                "page token expired; re-anchored at before:{:?}",
                cur.anchor
            ));
        }
        Err(e) => return Err(e), // transient — same cursor retries next beat
    };

    let page_total = page.len();
    let ids: Vec<String> = page.iter().map(|(id, _)| id.clone()).collect();
    let known = {
        let conn = db.lock().unwrap();
        known_history_ids(&conn, &ids)
    };

    let mut out = PageOutcome { listed: page_total, next_token: next, ..Default::default() };
    // Already-local threads cost nothing but still count toward the walk, and
    // their stored date still anchors a re-listing.
    let mut to_fetch: Vec<String> = vec![];
    for (id, history_id) in &page {
        match known.get(id).map(|v| unpack_known(v)) {
            Some((h, d)) if h == history_id.as_str() => {
                out.skipped += 1;
                if d > 0 {
                    out.oldest_ms = Some(out.oldest_ms.map_or(d, |o: i64| o.min(d)));
                }
            }
            _ => to_fetch.push(id.clone()),
        }
    }

    // The mailbox is the pass the user is watching, not this page. "Indexing
    // 96 of 100" showing one page of tens of thousands was the observation
    // that opened this whole item.
    let estimate = {
        let conn = db.lock().unwrap();
        store::get_json::<i64>(&conn, &format!("threads_total:{account_id}")).unwrap_or(0)
    };
    let mailbox_total = estimate.max((cur.listed + page_total as u64) as i64) as usize;
    let mut settled = out.skipped;
    let tick = |done: usize| SyncTick {
        account: account_id.to_string(),
        stage: SyncStage::Crawl,
        done: (cur.listed as usize + done).min(mailbox_total),
        total: mailbox_total,
    };
    if settled > 0 {
        on_progress(tick(settled));
    }

    // Concurrent fetch, sequential apply: the network is the bottleneck, and
    // the db mutex serializes writes regardless.
    let limit = governor.limit().max(1);
    // Owned ids into each future, and the shared &Client / &str copied in:
    // mapping over borrowed items here needs a closure that is generic over
    // lifetimes, which a plain `|id| async move {}` is not.
    let token_ref: &str = token.as_str();
    let futures: Vec<_> = to_fetch
        .into_iter()
        .map(|id| async move {
            let mut r = crate::mail::gmail::fetch_thread_full(http, token_ref, &id).await;
            if let Ok(v) = r.as_mut() {
                crate::mail::gmail::hydrate_body_data_with_token(http, token_ref, v).await;
            }
            (id, r)
        })
        .collect();
    let mut stream = futures_util::stream::iter(futures).buffer_unordered(limit);

    let mut unauthorized = false;
    while let Some((id, res)) = stream.next().await {
        match res {
            Ok(v) => {
                let date = v["messages"]
                    .as_array()
                    .and_then(|ms| ms.last())
                    .and_then(|m| m["internalDate"].as_str())
                    .and_then(|s| s.parse::<i64>().ok());
                match apply_thread(db, account_id, &id, &v, splits) {
                    Ok(_) => out.fetched += 1,
                    Err(e) => {
                        out.failed += 1;
                        eprintln!("[crawl:{account_id}] deferred {id}: {e}");
                    }
                }
                if let Some(d) = date {
                    out.oldest_ms = Some(out.oldest_ms.map_or(d, |o: i64| o.min(d)));
                }
            }
            Err(crate::mail::gmail::FetchErr::Gone) => {
                let _ = apply_gone(db, &id);
                out.fetched += 1; // resolved, just not by storing anything
            }
            Err(crate::mail::gmail::FetchErr::Throttled) => out.throttled += 1,
            Err(crate::mail::gmail::FetchErr::Unauthorized) => {
                out.throttled += 1;
                unauthorized = true;
            }
            // One bad thread must not wedge the walk — log it and move on;
            // the live search_all path can still surface it.
            Err(e) => {
                out.failed += 1;
                eprintln!("[crawl:{account_id}] deferred {id}: {e}");
            }
        }
        settled += 1;
        on_progress(tick(settled));
    }

    governor.observe(out.throttled);
    if out.throttled > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(THROTTLE_BACKOFF_MS)).await;
    }
    // A 401 means the token, not the thread. Surface it so the caller can
    // classify a dead grant; the cursor stays put and the page retries.
    if unauthorized {
        return Err("Gmail API error (401): token rejected".into());
    }
    // Every fetch failing looks like an outage, not poison threads — keep the
    // cursor unchanged so the same page retries instead of holing the index.
    if out.fetched == 0 && (out.failed > 0 || out.throttled > 0) {
        return Err(format!(
            "page made no progress ({} failed, {} throttled); will retry",
            out.failed, out.throttled
        ));
    }

    advance_cursor(&mut cur, &out);
    {
        let conn = db.lock().unwrap();
        store::set_json(&conn, &key, &cur)?;
    }
    if cur.done {
        // The walk is over. `done` can't be relied on to have caught `total` —
        // threadsTotal is an estimate and may over-count — so fire the terminal
        // tick explicitly, or the pill freezes at "38,000 of 40,000" forever.
        on_progress(SyncTick {
            account: account_id.to_string(),
            stage: SyncStage::Crawl,
            done: mailbox_total,
            total: mailbox_total,
        });
    }
    Ok(CrawlBeat {
        fetched: out.fetched,
        skipped: out.skipped,
        failed: out.failed,
        total_indexed: cur.indexed,
        done: cur.done,
    })
}

// ------------------------------------------------------------------ embed
//
// Semantic indexing rides the same background cadence as the crawl: every
// beat embeds a few batches of messages that have no vector yet (newest
// first), so it backfills existing mail AND keeps up with new mail through
// one mechanism. Inference runs on the caller's blocking thread; the DB
// lock is held only around short reads and batched writes.

pub const EMBED_BATCH: usize = 32;
/// Per-beat wall-clock budget: a beat embeds until this runs out, so a cold
/// 50k-message backfill converges in hours without ever pinning the CPU.
const EMBED_BEAT_BUDGET_MS: u128 = 4_000;

pub struct EmbedBeat {
    pub embedded: usize,
    pub remaining: i64,
}

/// Write one embedded batch inside a transaction (a crash mid-batch must
/// not leave vec_meta/mail_vec half-paired).
fn write_batch(
    conn: &Connection,
    batch: &[(String, String, String)],
    vecs: &[Vec<f32>],
    account_id: &str,
    model_tag: &str,
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    let write = (|| -> Result<(), String> {
        for ((mid, tid, _), v) in batch.iter().zip(vecs) {
            store::vec::insert(conn, mid, tid, account_id, model_tag, v)?;
        }
        Ok(())
    })();
    match write {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// One local-model beat. Blocking (model inference) — call on a blocking
/// thread. `embed` maps texts → normalized vectors (the fastembed closure).
pub fn embed_step(
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    model_tag: &str,
    embed: &dyn Fn(Vec<String>) -> Result<Vec<Vec<f32>>, String>,
) -> Result<EmbedBeat, String> {
    let start = std::time::Instant::now();
    {
        let conn = db.lock().unwrap();
        store::vec::ensure_model_tag(&conn, model_tag)?;
    }
    let mut embedded = 0usize;
    while start.elapsed().as_millis() < EMBED_BEAT_BUDGET_MS {
        let batch = {
            let conn = db.lock().unwrap();
            store::vec::missing(&conn, account_id, EMBED_BATCH)?
        };
        if batch.is_empty() {
            break;
        }
        let texts: Vec<String> = batch.iter().map(|(_, _, t)| t.clone()).collect();
        let vecs = embed(texts)?;
        {
            let conn = db.lock().unwrap();
            write_batch(&conn, &batch, &vecs, account_id, model_tag)?;
        }
        embedded += vecs.len();
    }
    let remaining = {
        let conn = db.lock().unwrap();
        store::vec::count_missing(&conn, account_id)?
    };
    Ok(EmbedBeat { embedded, remaining })
}

/// The remote flavor (settings.embeddings = "openai"): same loop, awaited
/// HTTP embedding instead of local inference. Kept separate because the
/// closure-driven local path must stay synchronous for spawn_blocking.
pub async fn embed_step_remote(
    http: &reqwest::Client,
    db: &std::sync::Mutex<Connection>,
    account_id: &str,
    base_url: &str,
    key: &str,
) -> Result<EmbedBeat, String> {
    let start = std::time::Instant::now();
    {
        let conn = db.lock().unwrap();
        store::vec::ensure_model_tag(&conn, crate::embed::REMOTE_TAG)?;
    }
    let mut embedded = 0usize;
    while start.elapsed().as_millis() < EMBED_BEAT_BUDGET_MS {
        let batch = {
            let conn = db.lock().unwrap();
            store::vec::missing(&conn, account_id, EMBED_BATCH)?
        };
        if batch.is_empty() {
            break;
        }
        let texts: Vec<String> = batch.iter().map(|(_, _, t)| t.clone()).collect();
        let vecs = crate::ai::openai::embed(
            http,
            base_url,
            key,
            crate::embed::REMOTE_MODEL,
            &texts,
            crate::embed::DIM,
        )
        .await?;
        {
            let conn = db.lock().unwrap();
            write_batch(&conn, &batch, &vecs, account_id, crate::embed::REMOTE_TAG)?;
        }
        embedded += vecs.len();
    }
    let remaining = {
        let conn = db.lock().unwrap();
        store::vec::count_missing(&conn, account_id)?
    };
    Ok(EmbedBeat { embedded, remaining })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crawl_query_anchors_with_before() {
        assert_eq!(crawl_query(None), "-in:spam -in:trash -in:draft");
        assert_eq!(
            crawl_query(Some(1_700_000_000)),
            "-in:spam -in:trash -in:draft before:1700000000"
        );
    }

    #[test]
    fn crawl_cursor_roundtrips_through_kv() {
        let conn = store::open(std::path::Path::new(":memory:")).unwrap();
        let cur = CrawlCursor {
            page_token: Some("tok123".into()),
            anchor: Some(1_700_000_000),
            oldest_ms: Some(1_699_999_999_000),
            indexed: 4200,
            listed: 4600,
            done: false,
        };
        store::set_json(&conn, &crawl_key("a@b.c"), &cur).unwrap();
        let back: CrawlCursor = store::get_json(&conn, &crawl_key("a@b.c")).unwrap();
        assert_eq!(back, cur);
        // a fresh account has no cursor row → the crawl starts from default
        let missing: Option<CrawlCursor> = store::get_json(&conn, &crawl_key("new@b.c"));
        assert!(missing.is_none());
    }

    #[test]
    fn reanchor_restarts_past_oldest_indexed() {
        let mut cur = CrawlCursor {
            page_token: Some("stale".into()),
            anchor: None,
            oldest_ms: Some(1_699_999_999_123),
            indexed: 7,
            listed: 12,
            done: false,
        };
        reanchor(&mut cur);
        assert_eq!(cur.page_token, None);
        assert_eq!(cur.anchor, Some(1_699_999_999 + ANCHOR_OVERLAP_SECS));

        // token expired before anything was indexed → restart from the top
        let mut fresh = CrawlCursor { page_token: Some("stale".into()), ..Default::default() };
        reanchor(&mut fresh);
        assert_eq!(fresh.anchor, None);
        assert_eq!(fresh.page_token, None);
    }

    const ACCT: &str = "acct@x.test";

    fn seed(conn: &Connection, id: &str, subject: &str, body: &str, date: i64) {
        let t = Thread {
            id: id.into(),
            subject: subject.into(),
            snippet: body.chars().take(50).collect(),
            participants: vec!["Ann".into()],
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
            from: "ann@x.test".into(),
            from_name: "Ann".into(),
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
        store::upsert_thread(conn, ACCT, &t, &[(m, None, None, None, vec![])], &store::split_config(conn))
            .unwrap();
    }

    // ---------------------------------------------------------- governor

    #[test]
    fn governor_halves_on_throttling_and_recovers_one_slot_at_a_time() {
        let mut g = Governor::default();
        assert_eq!(g.limit(), 6);
        g.observe(0);
        g.observe(0);
        assert_eq!(g.limit(), 8, "clean pages climb to the ceiling and stop");
        g.observe(3);
        assert_eq!(g.limit(), 4, "any throttling halves it");
        g.observe(1);
        g.observe(1);
        g.observe(1);
        assert_eq!(g.limit(), 1, "sustained throttling bottoms out at one, not zero");
        g.observe(0);
        assert_eq!(g.limit(), 2, "recovery is gradual, not a jump back to the ceiling");
    }

    // ------------------------------------------------------- round-robin

    #[test]
    fn next_account_rotates_instead_of_draining_the_first() {
        let accounts = vec![("a".to_string(), true), ("b".to_string(), true)];
        assert_eq!(next_account(&accounts, None).as_deref(), Some("a"));
        assert_eq!(next_account(&accounts, Some("a")).as_deref(), Some("b"));
        assert_eq!(next_account(&accounts, Some("b")).as_deref(), Some("a"));
    }

    #[test]
    fn next_account_skips_finished_walks_and_wraps() {
        let accounts = vec![
            ("a".to_string(), false),
            ("b".to_string(), true),
            ("c".to_string(), false),
        ];
        assert_eq!(next_account(&accounts, Some("b")).as_deref(), Some("b"));
        assert_eq!(next_account(&accounts, None).as_deref(), Some("b"));
    }

    #[test]
    fn next_account_answers_nothing_when_every_walk_is_done() {
        let accounts = vec![("a".to_string(), false), ("b".to_string(), false)];
        assert_eq!(next_account(&accounts, None), None);
        assert_eq!(next_account(&[], None), None);
    }

    // ------------------------------------------------------ cursor folding

    fn page(listed: usize, fetched: usize, oldest: Option<i64>, next: Option<&str>) -> PageOutcome {
        PageOutcome {
            listed,
            fetched,
            skipped: listed - fetched,
            failed: 0,
            throttled: 0,
            oldest_ms: oldest,
            next_token: next.map(str::to_string),
        }
    }

    #[test]
    fn advance_cursor_accumulates_and_terminates_on_an_exhausted_listing() {
        let mut cur = CrawlCursor::default();
        advance_cursor(&mut cur, &page(100, 90, Some(500), Some("tok2")));
        assert_eq!((cur.indexed, cur.listed, cur.done), (90, 100, false));
        assert_eq!(cur.oldest_ms, Some(500));

        advance_cursor(&mut cur, &page(40, 40, Some(700), None));
        assert_eq!((cur.indexed, cur.listed), (130, 140));
        assert_eq!(cur.oldest_ms, Some(500), "oldest only ever moves older");
        assert!(cur.done, "no next token means the whole history is walked");
    }

    // -------------------------------------------- multi-account resumption
    //
    // The property the deferred item asked for, and the one nothing covered:
    // several accounts crawling at once must survive a kill, resume where they
    // stopped, and not starve each other. Driven through the same
    // advance_cursor + kv persistence the live crawl uses, with the process
    // kill simulated by closing the connections and reopening the files.

    fn temp_db(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("snail-crawl-test-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    /// One account's turn: read its cursor, fold a page in, persist. Exactly
    /// what one live beat does to the cursor.
    fn take_turn(conn: &Connection, account: &str, out: &PageOutcome) -> CrawlCursor {
        let key = crawl_key(account);
        let mut cur: CrawlCursor = store::get_json(conn, &key).unwrap_or_default();
        advance_cursor(&mut cur, out);
        store::set_json(conn, &key, &cur).unwrap();
        cur
    }

    #[test]
    fn two_accounts_resume_where_they_stopped_and_neither_starves() {
        let (pa, pb) = (temp_db("a"), temp_db("b"));
        let mut served: Vec<String> = vec![];
        let mut last: Option<String> = None;
        let accounts = vec![("a@x.test".to_string(), true), ("b@x.test".to_string(), true)];

        {
            let ca = store::open(&pa).unwrap();
            let cb = store::open(&pb).unwrap();
            // three turns before the kill: a, b, a
            for i in 0..3 {
                let who = next_account(&accounts, last.as_deref()).unwrap();
                let conn = if who == "a@x.test" { &ca } else { &cb };
                take_turn(conn, &who, &page(100, 100, Some(9_000 - i), Some("tok-next")));
                served.push(who.clone());
                last = Some(who);
            }
        } // both connections dropped — the process is gone

        assert_eq!(served, vec!["a@x.test", "b@x.test", "a@x.test"], "strict rotation");

        // relaunch
        let ca = store::open(&pa).unwrap();
        let cb = store::open(&pb).unwrap();
        let ra: CrawlCursor = store::get_json(&ca, &crawl_key("a@x.test")).unwrap();
        let rb: CrawlCursor = store::get_json(&cb, &crawl_key("b@x.test")).unwrap();

        assert_eq!(ra.listed, 200, "A resumes at two pages in, not from zero");
        assert_eq!(rb.listed, 100, "B resumes at one page in, not from zero");
        assert_eq!(ra.page_token.as_deref(), Some("tok-next"));
        assert_eq!(rb.page_token.as_deref(), Some("tok-next"));
        assert!(!ra.done && !rb.done);

        // the account mid-turn when the process died is not the one served next
        let resumed = next_account(&accounts, last.as_deref()).unwrap();
        assert_eq!(resumed, "b@x.test", "B is owed the next slice, not A again");

        // and finishing off keeps accumulating rather than restarting
        let fin = take_turn(&cb, "b@x.test", &page(60, 60, Some(8_000), None));
        assert_eq!(fin.listed, 160);
        assert_eq!(fin.indexed, 160);
        assert!(fin.done);
        // A's walk is untouched by B finishing
        let still: CrawlCursor = store::get_json(&ca, &crawl_key("a@x.test")).unwrap();
        assert_eq!(still.listed, 200);
        assert!(!still.done);

        drop(ca);
        drop(cb);
        let _ = std::fs::remove_file(&pa);
        let _ = std::fs::remove_file(&pb);
    }

    #[test]
    fn embed_step_converges_to_full_coverage_and_stops() {
        let conn = store::open(std::path::Path::new(":memory:")).unwrap();
        for i in 0..5 {
            seed(&conn, &format!("t-{i}"), "Subject", "body words", 1_000 + i);
        }
        let db = std::sync::Mutex::new(conn);
        let fake = |texts: Vec<String>| -> Result<Vec<Vec<f32>>, String> {
            Ok(texts
                .iter()
                .map(|_| {
                    let mut v = vec![0f32; 384];
                    v[0] = 1.0;
                    v
                })
                .collect())
        };
        let b1 = embed_step(&db, ACCT, "test", &fake).unwrap();
        assert_eq!(b1.embedded, 5);
        assert_eq!(b1.remaining, 0);
        // second beat: nothing left — already-embedded rows are skipped
        let b2 = embed_step(&db, ACCT, "test", &fake).unwrap();
        assert_eq!(b2.embedded, 0);
        let conn = db.lock().unwrap();
        assert_eq!(store::vec::count_embedded(&conn, ACCT).unwrap(), 5);
    }
}
