// Shared domain types. These mirror the Rust structs in src-tauri/src/
// (serde uses camelCase rename on every IPC-crossing struct).

export type ThreadId = string;
export type MessageId = string;

export interface Attachment {
  id: string;
  messageId: MessageId;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface Message {
  id: MessageId;
  threadId: ThreadId;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  bodyHtml: string | null;
  date: number; // unix ms
  unread: boolean;
  attachments: Attachment[];
}

export interface Thread {
  id: ThreadId;
  subject: string;
  snippet: string;
  participants: string[];
  /** Recipient participants (`Name <email>` / bare address) — union of the
   *  messages' To/Cc. Powers `to:` in split queries. */
  recipients: string[];
  messageCount: number;
  lastDate: number; // unix ms
  unread: boolean;
  starred: boolean;
  labels: string[];
  inInbox: boolean;
  snoozedUntil: number | null; // unix ms
  /** Home split id, materialized by the backend classifier at sync time.
   *  "" = not yet classified (boot backfill in flight) — files under the
   *  catch-all until the pass lands. */
  split: string;
  /** Extra split tabs this thread also surfaces in (alsoShow forwarding). */
  alsoIn: string[];
}

export interface Split {
  id: string;
  name: string;
  builtin: boolean;
  /** Gmail-style boolean query (from:/to:/subject:/label:, quotes, AND/OR,
   *  parens — see src/lib/split-query.ts). Empty = the catch-all. */
  query: string;
  /** null = the split applies to every account; else the account email. */
  accountId: string | null;
  /** Also surface matching threads where they would otherwise land
   *  (Important or the catch-all — Superhuman's "also show" toggle). */
  alsoShow: boolean;
  hideWhenEmpty: boolean;
}

export type AiProviderId = "claude" | "openai" | "nim";

export interface AiProviderConfig {
  id: AiProviderId;
  label: string;
  model: string;
  baseUrl: string | null; // used by NIM / self-hosted OpenAI-compatible
  hasKey: boolean; // key itself never crosses IPC back to the UI
}

export interface KnowledgeBase {
  instructions: string;
  snippets: { id: string; title: string; body: string }[];
  voiceExamples: { id: string; title: string; body: string }[];
}

export interface Streaks {
  daily: number;
  weekly: number;
  lastZeroDay: string | null; // YYYY-MM-DD
}

export interface AccountInfo {
  email: string;
  provider: "gmail" | "outlook" | "mock";
  connected: boolean;
  /** True while the account's data is being torn down in the background —
   *  the row shows "Removing…" and every action on it is disabled. */
  removing?: boolean;
}

/** All connected accounts in slot order (index 0 = Ctrl+1) + the active one. */
export interface AccountsState {
  accounts: AccountInfo[];
  active: string;
}

export interface Settings {
  splits: Split[];
  defaultAiProvider: AiProviderId;
  providers: AiProviderConfig[];
  celebrationDir: string | null; // user-supplied folder of images; null = bundled
  shortcuts: Record<string, string>; // commandId -> key expression
  signatures: Record<string, string>; // account email -> signature text or HTML
  theme: "dark" | "light";
  /** Desktop notifications for new mail (while the window is unfocused). */
  notifications: boolean;
  /** Welcome flow completed. */
  onboarded: boolean;
  /** Calendar side panel visible. */
  calendarOpen: boolean;
  /** Calendars unchecked in the side panel — their events hide in both
   *  calendar views. Ids, not names; filtering is client-side. */
  hiddenCalendars: string[];
  /** Folder/label sidebar visible. */
  sidebarOpen: boolean;
  /** Bottom shortcut-hint footer visible (default true). */
  showShortcutBar: boolean;
  /** Undo Send window in seconds: 0 = off (send immediately), else the delay
   *  before the message actually leaves. Default 10. */
  undoSendSeconds: number;
  /** Oversized attachments → Drive links: confirm per drop, or just do it. */
  driveAutoUpload: "ask" | "always";
  /** Remembered share-on-send choice for linked Drive files. */
  driveShareMode: DriveShareMode;
  /** Semantic-search embeddings: local ONNX model (default) or OpenAI
   *  text-embedding-3-small via the stored OpenAI key. */
  embeddings: "local" | "openai";
}

/** Which Google features this account's OAuth grant actually covers. Users
 *  can uncheck scopes on the consent screen; accounts connected before v0.15
 *  predate the new scopes entirely (legacyGrant) — every Google feature gates
 *  on this instead of assuming the full block was granted. */
export interface Capabilities {
  drive: boolean;
  contacts: boolean;
  calendarWrite: boolean;
  settingsRead: boolean;
  legacyGrant: boolean;
}

/** One Gmail send-as alias (users.settings.sendAs, read-only surface). */
export interface SendAsAlias {
  email: string;
  displayName: string;
  isDefault: boolean;
  verified: boolean;
  hasSignature: boolean;
}

/** Connected-account profile shown in the header (picture is a data: URI). */
export interface ProfileInfo {
  name: string;
  picture: string | null;
}

/** One spell/grammar finding from the local Harper linter. Offsets are
 *  UTF-16 code units into the linted string; "" in suggestions = delete. */
export interface LintHit {
  span: { start: number; end: number };
  message: string;
  suggestions: string[];
}

/** A person the account has corresponded with — recipient autocomplete. */
export interface Contact {
  name: string;
  email: string;
}

/** Daily Unsplash photo for empty rest states. Links come utm-tagged. */
export interface DailyPhoto {
  url: string;
  blurHash: string | null;
  authorName: string;
  authorLink: string | null;
  photoLink: string | null;
  downloadLocation: string | null;
  cachedDataUri: string | null;
  fetchedAt: number;
}

/** One guest on a calendar event. */
export interface EventAttendee {
  email: string;
  displayName: string | null;
  /** Optional attendance (vs required). */
  optional: boolean;
  responseStatus: "needsAction" | "declined" | "tentative" | "accepted";
  /** This attendee row is the account owner. */
  self: boolean;
  organizer: boolean;
}

/** One event in the calendar side panel / week view. */
export interface CalendarEvent {
  id: string;
  /** Raw Google calendar id the event lives on ("demo" for fixtures). */
  calendarId: string;
  /** Display name of that calendar. */
  calendar: string;
  color: string | null;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string | null;
  description: string | null;
  /** Link to the event in the Google Calendar web UI. */
  htmlLink: string | null;
  /** Concurrency handle — sent back as If-Match on update/delete. */
  etag: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  organizerEmail: string | null;
  /** The account owns this event (edit/delete vs RSVP affordances). */
  organizerSelf: boolean;
  /** Parent series id when this is one instance of a recurring event. */
  recurringEventId: string | null;
  /** Google Meet link, read-only surface. */
  hangoutLink: string | null;
  attendees: EventAttendee[];
  /** Our privilege on the parent calendar. */
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  /** RFC5545 UID — invite mail resolves to the event through this. */
  icalUid: string | null;
}

/** One calendar from the account's calendarList (event modal selector). */
export interface CalendarInfo {
  id: string;
  name: string;
  color: string | null;
  accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  /** The account's primary calendar (default target for new events). */
  primary: boolean;
}

/** Guest-notification choice for event writes (Google sendUpdates). */
export type SendUpdates = "all" | "none";

/** RSVP responses (attendee responseStatus values you can set). */
export type RsvpResponse = "accepted" | "declined" | "tentative";

/** The editable surface of an event, as the modal submits it. All-day
 *  events carry local-midnight millis with an EXCLUSIVE end. */
export interface EventDraft {
  calendarId: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location: string | null;
  description: string | null;
  /** Bare emails; existing guests keep their RSVP state on update. */
  attendees: string[];
  /** Request a Google Meet: attach one on insert, or add one on edit if the
   *  event has none yet (suppressed when a conference already exists, so an
   *  update never duplicates it). Only Gmail calendars honor this. */
  addConferencing: boolean;
}

/** Outcome of an event update/delete: saved, or refused because the event
 *  changed elsewhere (412 against our etag) — `event` then carries the
 *  fresh server copy for the review-and-retry flow. */
export interface EventWriteResult {
  status: "ok" | "conflict";
  event: CalendarEvent | null;
}

/** An invite (or cancellation) detected in a mail thread — the RSVP bar.
 *  `event` is the resolved calendar copy RSVP acts on; unresolved invites
 *  fall back to `openUrl` / Google Calendar. */
export interface ThreadInvite {
  method: "REQUEST" | "CANCEL";
  uid: string;
  summary: string | null;
  organizerEmail: string | null;
  startMs: number | null;
  endMs: number | null;
  /** The ICS start was a date (all-day; endMs is EXCLUSIVE per RFC5545). */
  allDay: boolean;
  openUrl: string | null;
  event: CalendarEvent | null;
}

export interface UnsubResult {
  kind: "opened" | "mailto" | "none";
  target: string | null;
}

export interface DraftRequest {
  threadId: ThreadId | null; // null = fresh compose
  instruction: string;
  existingText: string | null; // when editing an existing draft body
  providerId: AiProviderId | null; // null = default
}

/** One Google Drive file (picker rows, link chips, upload results). */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  webViewLink: string;
  iconLink: string | null;
  modifiedTime: string | null;
  owner: string | null;
}

/** Outcome of one uploaded chunk: not done yet, or the finished file.
 *  nextOffset is the server-acknowledged high-water mark — slice the next
 *  chunk from here (Drive may persist less than was sent). */
export interface DriveChunkResult {
  done: boolean;
  file: DriveFile | null;
  nextOffset: number;
}

/** How linked Drive files get shared when a message sends. */
export type DriveShareMode = "recipients" | "anyone" | "none";

/** A file attached to an outgoing message (base64 so the outbox survives restarts). */
export interface MailAttachment {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

export interface OutgoingMail {
  threadId: ThreadId | null; // reply target, null = new thread
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  /** HTML alternative (signatures with images); null = plain text only. */
  bodyHtml: string | null;
  replyAll: boolean;
  attachments: MailAttachment[];
}

/** A locally persisted, unsent compose draft (payload = ComposeState JSON). */
export interface DraftEntry {
  id: number;
  payload: string;
  updatedAt: number;
}

export interface SearchResult {
  threadId: ThreadId;
  subject: string;
  snippet: string;
  lastDate: number;
}

export interface ZeroEvent {
  splitId: string;
  daily: number;
  weekly: number;
  imagePath: string; // asset path or file path to show
}

/** Background mail-download progress for the status indicator. `indexed` =
 *  threads stored locally, `total` = Gmail's threadsTotal (0 when unknown),
 *  `done` = every connected account's history crawl has finished. The UI shows
 *  "Downloading mail history… N%" while `total > 0 && !done`. */
export interface SyncProgress {
  indexed: number;
  total: number;
  done: boolean;
}

/** Which pass a `sync:activity` tick belongs to. Mirrors the Rust
 *  `SyncStage` (serde kebab-case). */
export type SyncStage =
  | "reconcile-inbox"
  | "reconcile-rest"
  | "incremental"
  | "crawl"
  | "resync"
  | "load-older";

/** Live download activity — "Downloading 17 of 30…". Distinct from
 *  SyncProgress: that measures long-term crawl COMPLETENESS from persisted
 *  state, this measures what the Gmail API is doing right now. `done`/`total`
 *  are thread counts within the current pass (one thread = one `threads.get`),
 *  not lifetime totals. A tick with `done >= total` ends the pass. */
export interface SyncActivity {
  account: string;
  stage: SyncStage;
  done: number;
  total: number;
}

/** One-time per-account storage split (desktop). A payload with
 *  table === "done" means the split finished and the strip hides. */
export interface MigrationProgress {
  email: string;
  table: string;
  copied: number;
  total: number;
}
