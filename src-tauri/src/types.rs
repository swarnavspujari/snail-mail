//! Domain types crossing the IPC boundary. Field names serialize to
//! camelCase to match src/lib/types.ts exactly.
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub message_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size_bytes: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub from_name: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub snippet: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub date: i64,
    pub unread: bool,
    pub attachments: Vec<Attachment>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub subject: String,
    pub snippet: String,
    pub participants: Vec<String>,
    /// Recipient participants (`Name <email>` / bare address) — union of the
    /// messages' To/Cc. Powers `to:` in split queries.
    #[serde(default)]
    pub recipients: Vec<String>,
    pub message_count: i64,
    pub last_date: i64,
    pub unread: bool,
    pub starred: bool,
    pub labels: Vec<String>,
    pub in_inbox: bool,
    pub snoozed_until: Option<i64>,
    /// Home split id, materialized at sync/upsert time by the classifier in
    /// splits.rs. Empty = not yet classified (boot pass fills it in).
    #[serde(default)]
    pub split: String,
    /// Extra split tabs this thread also surfaces in (a home split with
    /// alsoShow set forwards the thread where it would otherwise have landed).
    #[serde(default)]
    pub also_in: Vec<String>,
}

/// Legacy (pre-v0.23) structured rule — deserialized only so saved settings
/// migrate to the query language; never written back.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SplitRule {
    pub field: String, // from | to | subject | label
    pub contains: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Split {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    /// Gmail-style boolean query (see splits.rs). Empty = the catch-all.
    #[serde(default)]
    pub query: String,
    /// None = the split applies to every account; Some(email) scopes it.
    #[serde(default)]
    pub account_id: Option<String>,
    /// Also surface matching threads where they would otherwise land
    /// (Important or the catch-all — Superhuman's "also show" toggle).
    #[serde(default)]
    pub also_show: bool,
    pub hide_when_empty: bool,
    /// Legacy pre-v0.23 fields, migrated to `query` on read in get_settings.
    #[serde(default, skip_serializing)]
    pub rules: Vec<SplitRule>,
    #[serde(default = "default_op", skip_serializing)]
    pub op: String, // and | or
}

fn default_op() -> String {
    "or".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub id: String, // claude | openai | nim
    pub label: String,
    pub model: String,
    pub base_url: Option<String>,
    pub has_key: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub splits: Vec<Split>,
    pub default_ai_provider: String,
    pub providers: Vec<AiProviderConfig>,
    pub celebration_dir: Option<String>,
    pub shortcuts: std::collections::HashMap<String, String>,
    /// account email -> signature text, appended to outgoing mail
    #[serde(default)]
    pub signatures: std::collections::HashMap<String, String>,
    /// "dark" (default) or "light"
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Desktop notifications for new mail (while the window is unfocused).
    #[serde(default = "default_true")]
    pub notifications: bool,
    /// Unread badge on the taskbar / dock / launcher — the Important split's
    /// unread count, summed across accounts.
    #[serde(default = "default_true")]
    pub show_badge: bool,
    /// Onboarding completed — the welcome flow shows until this flips.
    #[serde(default)]
    pub onboarded: bool,
    /// Calendar side panel visible.
    #[serde(default)]
    pub calendar_open: bool,
    /// Calendars unchecked in the side panel (ids) — events hide client-side.
    #[serde(default)]
    pub hidden_calendars: Vec<String>,
    /// Folder/label sidebar visible.
    #[serde(default)]
    pub sidebar_open: bool,
    /// Bottom shortcut-hint footer visible (default true, incl. older state).
    /// Governs that strip only — every other key hint answers to
    /// `show_key_hints`.
    #[serde(default = "default_true")]
    pub show_shortcut_bar: bool,
    /// Visual keycap hints everywhere else — hover hints, inline key strips,
    /// sidebar chord chips (default true, incl. older state). Surfaces that
    /// are ABOUT shortcuts keep their keys regardless.
    #[serde(default = "default_true")]
    pub show_key_hints: bool,
    /// Undo Send window in seconds (0 = off / send immediately). Default 10.
    #[serde(default = "default_undo_send")]
    pub undo_send_seconds: i64,
    /// Oversized attachments → Drive links: "ask" (confirm per drop) or
    /// "always" (upload without asking).
    #[serde(default = "default_drive_auto_upload")]
    pub drive_auto_upload: String,
    /// Remembered share-on-send choice: "recipients" | "anyone" | "none".
    #[serde(default = "default_drive_share_mode")]
    pub drive_share_mode: String,
    /// Semantic-search embeddings: "local" (bundled ONNX model, default) or
    /// "openai" (text-embedding-3-small via the stored OpenAI key —
    /// Anthropic has no embeddings API, so remote is never Claude).
    #[serde(default = "default_embeddings")]
    pub embeddings: String,
}

fn default_theme() -> String {
    "dark".into()
}

fn default_true() -> bool {
    true
}

fn default_undo_send() -> i64 {
    10
}

fn default_drive_auto_upload() -> String {
    "ask".into()
}

fn default_drive_share_mode() -> String {
    "recipients".into()
}

fn default_embeddings() -> String {
    "local".into()
}

/// Which Google features this account's OAuth grant actually covers.
/// Users can uncheck scopes on the consent screen, and accounts connected
/// before v0.15 hold tokens that predate the new scopes entirely — every
/// feature gates on this instead of assuming the full block was granted.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Google Drive (attach from Drive, oversized→Drive-link, share-on-send).
    pub drive: bool,
    /// People API contacts (saved and/or "other" contacts autocomplete).
    pub contacts: bool,
    /// Full calendar scope (event CRUD) vs the old calendar.readonly.
    pub calendar_write: bool,
    /// gmail.settings.basic (send-as aliases).
    pub settings_read: bool,
    /// Connected before grant tracking existed — needs one reconnect to
    /// grant (and record) the new scopes.
    pub legacy_grant: bool,
}

/// One Gmail send-as alias (users.settings.sendAs, read-only surface).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SendAsAlias {
    pub email: String,
    pub display_name: String,
    /// The alias Gmail uses by default for new mail.
    pub is_default: bool,
    /// Primary address, or a verified alias (Gmail refuses unverified Froms).
    pub verified: bool,
    /// The alias has its own Gmail-side signature configured.
    pub has_signature: bool,
}

/// Connected-account profile shown in the header (photo is a data: URI).
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    pub picture: Option<String>,
}

/// A person the account has corresponded with — recipient autocomplete.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub name: String,
    pub email: String,
}

/// Daily Unsplash photo for empty rest states. Attribution links arrive
/// pre-tagged with the referral utm params; the UI hotlinks `url` and falls
/// back to `cached_data_uri` offline.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DailyPhoto {
    pub url: String,
    pub blur_hash: Option<String>,
    pub author_name: String,
    pub author_link: Option<String>,
    pub photo_link: Option<String>,
    pub download_location: Option<String>,
    pub cached_data_uri: Option<String>,
    pub fetched_at: i64,
}

/// One guest on a calendar event.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EventAttendee {
    pub email: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Optional attendance (vs required).
    #[serde(default)]
    pub optional: bool,
    /// needsAction | declined | tentative | accepted
    pub response_status: String,
    /// This attendee row is the account owner.
    #[serde(default, rename = "self")]
    pub self_: bool,
    #[serde(default)]
    pub organizer: bool,
}

/// One event in the calendar side panel / week view.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    /// Raw Google calendar id the event lives on ("demo" for fixtures).
    #[serde(default)]
    pub calendar_id: String,
    /// Display name of that calendar.
    pub calendar: String,
    pub color: Option<String>,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub location: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Link to the event in the Google Calendar web UI.
    #[serde(default)]
    pub html_link: Option<String>,
    /// Concurrency handle — sent back as If-Match on update/delete.
    #[serde(default)]
    pub etag: Option<String>,
    /// confirmed | tentative | cancelled
    #[serde(default = "default_event_status")]
    pub status: String,
    #[serde(default)]
    pub organizer_email: Option<String>,
    /// The account owns this event (edit/delete vs RSVP affordances).
    #[serde(default)]
    pub organizer_self: bool,
    /// Parent series id when this is one instance of a recurring event.
    #[serde(default)]
    pub recurring_event_id: Option<String>,
    /// Google Meet link, read-only surface.
    #[serde(default)]
    pub hangout_link: Option<String>,
    #[serde(default)]
    pub attendees: Vec<EventAttendee>,
    /// Our privilege on the parent calendar:
    /// owner | writer | reader | freeBusyReader.
    #[serde(default = "default_access_role")]
    pub access_role: String,
    /// RFC5545 UID — invite mail resolves to the event through this.
    #[serde(default)]
    pub ical_uid: Option<String>,
}

fn default_event_status() -> String {
    "confirmed".into()
}

fn default_access_role() -> String {
    "reader".into()
}

/// One calendar from the account's calendarList — the event modal's
/// calendar selector (writable = accessRole owner/writer).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    /// owner | writer | reader | freeBusyReader
    pub access_role: String,
    pub primary: bool,
}

/// The editable surface of an event, as the modal submits it. All-day events
/// carry local-midnight millis with an EXCLUSIVE end (Google's date/date
/// convention); attendees are bare emails — the core preserves existing
/// guests' RSVP state on update by merging against the cached copy.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EventDraft {
    pub calendar_id: String,
    pub title: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub location: Option<String>,
    pub description: Option<String>,
    pub attendees: Vec<String>,
    /// Request a Google Meet: on insert, attach one; on edit, add one if the
    /// event has none yet. Suppressed when a conference already exists, so an
    /// update never duplicates it. Only Gmail calendars honor this.
    #[serde(default)]
    pub add_conferencing: bool,
}

/// An invite (or cancellation) detected in a mail thread, powering the RSVP
/// bar. `event` is the matching Google Calendar event when the iCalUID
/// resolves — RSVP acts on it; unresolved invites fall back to `open_url`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInvite {
    /// REQUEST (invite/update) | CANCEL
    pub method: String,
    pub uid: String,
    pub summary: Option<String>,
    pub organizer_email: Option<String>,
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    /// The ICS start was a date (all-day; end_ms is EXCLUSIVE per RFC5545).
    pub all_day: bool,
    pub open_url: Option<String>,
    pub event: Option<CalendarEvent>,
}

/// Outcome of an event update/delete: saved, or refused because the event
/// changed elsewhere (HTTP 412 against our If-Match etag) — `event` then
/// carries the fresh server copy for the review-and-retry flow.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EventWriteResult {
    /// "ok" | "conflict"
    pub status: String,
    pub event: Option<CalendarEvent>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UnsubResult {
    pub kind: String, // opened | mailto | none
    pub target: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KbItem {
    pub id: String,
    pub title: String,
    pub body: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    pub instructions: String,
    pub snippets: Vec<KbItem>,
    pub voice_examples: Vec<KbItem>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Streaks {
    pub daily: i64,
    pub weekly: i64,
    pub last_zero_day: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
    pub email: String,
    pub provider: String, // gmail | outlook | mock
    pub connected: bool,
    /// True while the account's data is being torn down in the background —
    /// the UI shows "Removing…" and no command may act on it.
    #[serde(default)]
    pub removing: bool,
}

/// All connected accounts, in slot order (index 0 = Ctrl+1), plus the active one.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AccountsState {
    pub accounts: Vec<AccountInfo>,
    pub active: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftRequest {
    pub thread_id: Option<String>,
    pub instruction: String,
    pub existing_text: Option<String>,
    pub provider_id: Option<String>,
}

/// One Google Drive file (picker rows, link chips, upload results).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: Option<i64>,
    pub web_view_link: String,
    pub icon_link: Option<String>,
    pub modified_time: Option<String>,
    pub owner: Option<String>,
}

/// One page of Drive search results.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveSearchPage {
    pub files: Vec<DriveFile>,
    pub next_page_token: Option<String>,
}

/// Outcome of one uploaded chunk: not done yet, or the finished file.
/// `next_offset` is the server-acknowledged high-water mark — the webview
/// slices the next chunk from here (Drive may persist less than was sent).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DriveChunkResult {
    pub done: bool,
    pub file: Option<DriveFile>,
    pub next_offset: i64,
}

/// A file attached to an outgoing message (bytes travel base64 over IPC and
/// sit in the outbox payload so scheduled sends survive restarts).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachment {
    pub filename: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMail {
    pub thread_id: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub body_text: String,
    /// HTML alternative (signatures with images); None = plain text only.
    #[serde(default)]
    pub body_html: Option<String>,
    pub reply_all: bool,
    #[serde(default)]
    pub attachments: Vec<MailAttachment>,
}

/// A locally persisted, unsent compose draft. `payload` is the frontend's
/// compose state as opaque JSON — the core only stores and lists it.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftEntry {
    pub id: i64,
    pub payload: String,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub thread_id: String,
    pub subject: String,
    pub snippet: String,
    pub last_date: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ZeroEvent {
    pub split_id: String,
    pub daily: i64,
    pub weekly: i64,
    pub image_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BulkArchiveOpts {
    pub split_id: Option<String>,
    pub older_than_days: i64,
    pub preserve_unread: bool,
    pub preserve_starred: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
}
