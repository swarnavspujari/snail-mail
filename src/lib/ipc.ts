// The single seam between UI and backend. In the Tauri app every call goes
// to the Rust core; in a plain browser (vite dev without Tauri) the mock
// backend serves the same surface so the whole UX runs against fixtures.
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AccountsState,
  AiProviderId,
  CalendarEvent,
  CalendarInfo,
  Capabilities,
  Contact,
  DailyPhoto,
  DraftEntry,
  DraftRequest,
  DriveChunkResult,
  DriveFile,
  DriveShareMode,
  EventDraft,
  EventWriteResult,
  MailAttachment,
  MigrationProgress,
  LintHit,
  RsvpResponse,
  SendUpdates,
  ProfileInfo,
  KnowledgeBase,
  Message,
  OutgoingMail,
  SearchResult,
  SendAsAlias,
  Settings,
  Streaks,
  SyncProgress,
  Thread,
  ThreadId,
  ThreadInvite,
  UnsubResult,
  ZeroEvent,
} from "./types";
import { MockBackend } from "./mock";

export type MailView =
  | "inbox"
  | "done"
  | "reminders"
  | "starred"
  | "trash"
  | `label:${string}`;

export interface BulkArchiveOpts {
  splitId: string | null; // null = whole inbox
  olderThanDays: number; // 0 = everything
  preserveUnread: boolean;
  preserveStarred: boolean;
}

export interface DraftStreamHandlers {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export interface Backend {
  getAccounts(): Promise<AccountsState>;
  switchAccount(email: string): Promise<AccountsState>;
  reorderAccounts(emails: string[]): Promise<AccountsState>;
  hasGmailClient(): Promise<boolean>;
  /** What the account's OAuth grant covers (Drive/Contacts/…) — features
   *  gate on this; legacyGrant means "reconnect to unlock the new scopes". */
  getCapabilities(email: string): Promise<Capabilities>;
  /** Blank strings reuse the OAuth client already in the keychain. */
  startOauth(clientId: string, clientSecret: string): Promise<AccountsState>;
  disconnect(email: string): Promise<AccountsState>;
  syncNow(): Promise<void>;
  /** Repair: reconcile from scratch to re-parse frozen/empty message bodies. */
  resyncAccount(): Promise<void>;

  listThreads(view: MailView): Promise<Thread[]>;
  getThread(id: ThreadId): Promise<Message[]>;
  /** Heal a thread whose message bodies came back blank; returns updated messages. */
  refetchMessageBody(id: ThreadId): Promise<Message[]>;
  archiveThread(id: ThreadId): Promise<void>;
  moveToInbox(id: ThreadId): Promise<void>;
  /** Soft-hide: trash or spam. Undo via restoreThread. */
  hideThread(id: ThreadId, reason: "trash" | "spam"): Promise<void>;
  restoreThread(id: ThreadId): Promise<void>;
  muteThread(id: ThreadId): Promise<void>;
  unmuteThread(id: ThreadId): Promise<void>;
  unsubscribeThread(id: ThreadId): Promise<UnsubResult>;
  toggleStar(id: ThreadId): Promise<boolean>;
  snoozeThread(id: ThreadId, untilMs: number): Promise<void>;
  markUnread(id: ThreadId): Promise<void>;
  markRead(id: ThreadId): Promise<void>;
  moveLabel(id: ThreadId, label: string): Promise<void>;
  listLabels(): Promise<string[]>;
  /** Schedule a send; ~10s delay = the Undo Send window. Returns outbox id. */
  queueMail(mail: OutgoingMail, delayMs: number): Promise<number>;
  /** Undo Send: reclaim the draft before the outbox flushes. Throws if sent. */
  cancelOutbox(outboxId: number): Promise<OutgoingMail>;
  /** Send immediately, bypassing the outbox — used when Undo Send is off. */
  sendMailNow(mail: OutgoingMail): Promise<void>;
  /** Accelerate a pending send: flush it now instead of waiting the window. */
  sendOutboxNow(outboxId: number): Promise<void>;
  search(query: string): Promise<SearchResult[]>;
  /** Full-history search: local matches plus a live Gmail search for mail
   *  older than the local cache. Slower than search(); call it debounced. */
  searchAll(query: string): Promise<SearchResult[]>;
  /** Recent threads where an address was a sender or recipient (from/to/cc),
   *  newest first — the contact panel's mail history. Address-scoped, not
   *  full-text: only threads that person was actually a participant in. */
  threadsWithContact(email: string): Promise<SearchResult[]>;
  /** Fetch the next older page of a paged view (done/starred/trash) from
   *  Gmail. Returns how many new threads were added. */
  loadOlder(view: MailView): Promise<number>;
  bulkArchive(opts: BulkArchiveOpts): Promise<number>;

  /** Drive picker: recents (empty query) or name/full-text search. */
  driveSearch(query: string): Promise<DriveFile[]>;
  /** "Attach as copy": Drive file bytes → a normal outgoing attachment. */
  driveDownloadAttach(fileId: string): Promise<MailAttachment>;
  /** Upload a local file to the app's Drive folder (oversized-attachment
   *  flow). Chunked; onProgress fires with exact bytes handed to Drive. */
  driveUploadFile(
    file: File,
    onProgress: (sent: number, total: number) => void
  ): Promise<DriveFile>;
  /** Share-on-send. Returns addresses that couldn't be shared (send
   *  proceeds regardless). mode "none" is handled by the caller. */
  driveShare(
    fileId: string,
    mode: Exclude<DriveShareMode, "none">,
    emails: string[]
  ): Promise<string[]>;

  /** Save via OS dialog. Resolves to the path, or null if cancelled. */
  downloadAttachment(attachmentId: string): Promise<string | null>;
  /** Open with the default app. */
  openAttachment(attachmentId: string): Promise<void>;

  /** Persist an unsent draft; pass null id to create. Returns the draft id. */
  saveDraft(draftId: number | null, payload: string): Promise<number>;
  listDrafts(): Promise<DraftEntry[]>;
  deleteDraft(draftId: number): Promise<void>;

  /** The account's Gmail send-as aliases (read-only; cached at connect). */
  getSendAs(email: string): Promise<SendAsAlias[]>;

  /** Cached name + photo for a connected account (null in demo mode). */
  getProfile(email: string): Promise<ProfileInfo | null>;
  /** Override (or clear with null) the header photo. data: URI expected. */
  setProfilePhoto(email: string, picture: string | null): Promise<void>;
  /** Calendar events for the side panel / week view, [startMs, endMs).
   *  Local-first: reads the SQLite cache; refreshCalendar repopulates it. */
  listEvents(startMs: number, endMs: number): Promise<CalendarEvent[]>;
  /** Kick a background sync pass (throttled; incremental via syncToken). */
  refreshCalendar(startMs: number, endMs: number): Promise<void>;
  /** The account's calendars; accessRole owner/writer = writable. */
  listCalendars(): Promise<CalendarInfo[]>;
  /** Create an event (direct Google call; sendUpdates emails the guests). */
  createEvent(draft: EventDraft, sendUpdates: SendUpdates): Promise<CalendarEvent>;
  /** Update with If-Match on etag; status "conflict" = changed elsewhere,
   *  `event` holds the fresh copy to review and retry against. */
  updateEvent(
    calendarId: string,
    eventId: string,
    etag: string | null,
    draft: EventDraft,
    sendUpdates: SendUpdates
  ): Promise<EventWriteResult>;
  /** Delete with If-Match on etag (same conflict contract as update). */
  deleteEvent(
    calendarId: string,
    eventId: string,
    etag: string | null,
    sendUpdates: SendUpdates
  ): Promise<EventWriteResult>;
  /** RSVP as a guest; the organizer is notified. Returns the updated event. */
  rsvpEvent(
    calendarId: string,
    eventId: string,
    response: RsvpResponse
  ): Promise<CalendarEvent>;
  /** Invite detection for the open thread (null = not an invite). */
  threadInvite(threadId: ThreadId): Promise<ThreadInvite | null>;

  /** Daily Unsplash photo for empty rest states (null when unavailable). */
  getDailyPhoto(): Promise<DailyPhoto | null>;
  /** Report the photo was shown — triggers Unsplash's download event once. */
  photoShown(): Promise<void>;
  /** Store (or clear with "") a BYO Unsplash Access Key in the keychain. */
  setUnsplashKey(key: string): Promise<void>;

  /** Offline Harper spell/grammar check of compose text. */
  lintText(text: string): Promise<LintHit[]>;

  /** Ranked recipient suggestions for a typed query: mail-derived history
   *  merged with the account's Google contacts. */
  searchContacts(query: string): Promise<Contact[]>;
  /** Re-sync Google contacts for the active account; resolves to the synced
   *  row count. */
  refreshContacts(): Promise<number>;

  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  /** Inbox conversation count per split id for the active account — SQL over
   *  the whole mailbox, so tab counts aren't capped at the display window. */
  splitCounts(): Promise<Record<string, number>>;
  /** Live validation + match preview for the split editor. `error` doubles as
   *  an informational note when ok (e.g. the empty catch-all query). */
  previewSplit(query: string): Promise<{ ok: boolean; error: string | null; count: number }>;
  getKnowledgeBase(): Promise<KnowledgeBase>;
  saveKnowledgeBase(kb: KnowledgeBase): Promise<void>;

  setAiKey(provider: AiProviderId, key: string): Promise<void>;
  testAiProvider(provider: AiProviderId): Promise<{ ok: boolean; message: string }>;
  /** Returns a cancel function. Handlers fire as the draft streams in. */
  aiDraft(req: DraftRequest, handlers: DraftStreamHandlers): () => void;
  aiSuggestReplies(threadId: ThreadId): Promise<string[]>;

  getStreaks(): Promise<Streaks>;
  recordZero(splitId: string): Promise<ZeroEvent | null>;
  listCelebrationImages(): Promise<string[]>;

  /** Backend pushes when sync/reminders change mail state. Returns unsubscribe. */
  onMailUpdated(cb: () => void): () => void;
  /** Fires as background mail history downloads (initial reconcile + crawl).
   *  Drives the "Downloading mail history… N%" indicator. Returns unsubscribe. */
  onSyncProgress(cb: (p: SyncProgress) => void): () => void;
  /** Fires when a calendar refresh lands (payload = error message or null). */
  onCalendarUpdated(cb: (error: string | null) => void): () => void;
  /** Fires when an opened thread's inline images finish resolving (threadId). */
  onThreadImages(cb: (threadId: string) => void): () => void;
  /** Fires when a background triage sync to Gmail failed (message). */
  onTriageError(cb: (message: string) => void): () => void;
  /** General user-facing notice from the core (e.g. a partial OAuth grant). */
  onNotice(cb: (message: string) => void): () => void;
  /** Fires while the one-time per-account storage split runs (desktop only).
   *  A payload with table === "done" means the split finished. */
  onMigrationProgress(cb: (p: MigrationProgress) => void): () => void;
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Open a URL in the system browser (Tauri) or a new tab (browser demo). */
export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

let aiRequestSeq = 1;

class TauriBackend implements Backend {
  getAccounts() {
    return invoke<AccountsState>("get_accounts");
  }
  switchAccount(email: string) {
    return invoke<AccountsState>("switch_account", { email });
  }
  reorderAccounts(emails: string[]) {
    return invoke<AccountsState>("reorder_accounts", { emails });
  }
  hasGmailClient() {
    return invoke<boolean>("has_gmail_client");
  }
  getCapabilities(email: string) {
    return invoke<Capabilities>("get_capabilities", { email });
  }
  startOauth(clientId: string, clientSecret: string) {
    return invoke<AccountsState>("start_oauth", { clientId, clientSecret });
  }
  disconnect(email: string) {
    return invoke<AccountsState>("disconnect_account", { email });
  }
  syncNow() {
    return invoke<void>("sync_now");
  }
  resyncAccount() {
    return invoke<void>("resync_account");
  }
  listThreads(view: MailView) {
    return invoke<Thread[]>("list_threads", { view });
  }
  getThread(id: ThreadId) {
    return invoke<Message[]>("get_thread", { threadId: id });
  }
  refetchMessageBody(id: ThreadId) {
    return invoke<Message[]>("refetch_message_body", { threadId: id });
  }
  archiveThread(id: ThreadId) {
    return invoke<void>("archive_thread", { threadId: id });
  }
  moveToInbox(id: ThreadId) {
    return invoke<void>("move_to_inbox", { threadId: id });
  }
  hideThread(id: ThreadId, reason: "trash" | "spam") {
    return invoke<void>("hide_thread", { threadId: id, reason });
  }
  restoreThread(id: ThreadId) {
    return invoke<void>("restore_thread", { threadId: id });
  }
  muteThread(id: ThreadId) {
    return invoke<void>("mute_thread", { threadId: id });
  }
  unmuteThread(id: ThreadId) {
    return invoke<void>("unmute_thread", { threadId: id });
  }
  unsubscribeThread(id: ThreadId) {
    return invoke<UnsubResult>("unsubscribe_thread", { threadId: id });
  }
  toggleStar(id: ThreadId) {
    return invoke<boolean>("toggle_star", { threadId: id });
  }
  snoozeThread(id: ThreadId, untilMs: number) {
    return invoke<void>("snooze_thread", { threadId: id, untilMs });
  }
  markUnread(id: ThreadId) {
    return invoke<void>("mark_unread", { threadId: id });
  }
  markRead(id: ThreadId) {
    return invoke<void>("mark_read", { threadId: id });
  }
  moveLabel(id: ThreadId, label: string) {
    return invoke<void>("move_label", { threadId: id, label });
  }
  listLabels() {
    return invoke<string[]>("list_labels");
  }
  queueMail(mail: OutgoingMail, delayMs: number) {
    return invoke<number>("queue_mail", { mail, delayMs });
  }
  cancelOutbox(outboxId: number) {
    return invoke<OutgoingMail>("cancel_outbox", { outboxId });
  }
  sendMailNow(mail: OutgoingMail) {
    return invoke<void>("send_mail_now", { mail });
  }
  sendOutboxNow(outboxId: number) {
    return invoke<void>("send_outbox_now", { outboxId });
  }
  search(query: string) {
    return invoke<SearchResult[]>("search_threads", { query });
  }
  searchAll(query: string) {
    return invoke<SearchResult[]>("search_all", { query });
  }
  threadsWithContact(email: string) {
    return invoke<SearchResult[]>("threads_with_contact", { email });
  }
  loadOlder(view: MailView) {
    return invoke<number>("load_older", { view });
  }
  bulkArchive(opts: BulkArchiveOpts) {
    return invoke<number>("bulk_archive", { opts });
  }
  driveSearch(query: string) {
    return invoke<{ files: DriveFile[]; nextPageToken: string | null }>(
      "drive_search",
      { query, pageToken: null }
    ).then((page) => page.files);
  }
  driveDownloadAttach(fileId: string) {
    return invoke<MailAttachment>("drive_download_attach", { fileId });
  }
  async driveUploadFile(
    file: File,
    onProgress: (sent: number, total: number) => void
  ): Promise<DriveFile> {
    const uploadId = await invoke<number>("drive_upload_begin", {
      filename: file.name,
      mime: file.type || "application/octet-stream",
      size: file.size,
    });
    // 4 MiB chunks (Google requires a multiple of 256 KiB) as raw invoke
    // bodies — no base64 JSON, bounded memory, exact progress. The next
    // slice starts at the SERVER's acknowledged offset (nextOffset): Drive
    // may persist less than was sent, and resyncing makes that self-heal.
    const CHUNK = 4 * 1024 * 1024;
    let offset = 0;
    let stalls = 0;
    try {
      for (;;) {
        const end = Math.min(offset + CHUNK, file.size);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        const res = await invoke<DriveChunkResult>("drive_upload_chunk", bytes, {
          headers: { "upload-id": String(uploadId) },
        });
        if (res.done) {
          onProgress(file.size, file.size);
          if (!res.file) throw new Error("upload finished without file metadata");
          return res.file;
        }
        // no forward progress twice in a row = a wedged session; bail rather
        // than loop forever re-sending the same range
        stalls = res.nextOffset > offset ? 0 : stalls + 1;
        if (stalls >= 2) throw new Error("Drive stopped accepting upload data");
        offset = res.nextOffset;
        onProgress(offset, file.size);
      }
    } catch (e) {
      void invoke("drive_upload_cancel", { uploadId }).catch(() => {});
      throw e;
    }
  }
  driveShare(
    fileId: string,
    mode: Exclude<DriveShareMode, "none">,
    emails: string[]
  ) {
    return invoke<string[]>("drive_share", { fileId, mode, emails });
  }
  downloadAttachment(attachmentId: string) {
    return invoke<string | null>("download_attachment", { attachmentId });
  }
  openAttachment(attachmentId: string) {
    return invoke<void>("open_attachment", { attachmentId });
  }
  saveDraft(draftId: number | null, payload: string) {
    return invoke<number>("save_draft", { draftId, payload });
  }
  listDrafts() {
    return invoke<DraftEntry[]>("list_drafts");
  }
  deleteDraft(draftId: number) {
    return invoke<void>("delete_draft", { draftId });
  }
  getSendAs(email: string) {
    return invoke<SendAsAlias[]>("get_send_as", { email });
  }
  getProfile(email: string) {
    return invoke<ProfileInfo | null>("get_profile", { email });
  }
  setProfilePhoto(email: string, picture: string | null) {
    return invoke<void>("set_profile_photo", { email, picture });
  }
  listEvents(startMs: number, endMs: number) {
    return invoke<CalendarEvent[]>("list_events", { startMs, endMs });
  }
  refreshCalendar(startMs: number, endMs: number) {
    return invoke<void>("refresh_calendar", { startMs, endMs });
  }
  listCalendars() {
    return invoke<CalendarInfo[]>("list_calendars");
  }
  createEvent(draft: EventDraft, sendUpdates: SendUpdates) {
    return invoke<CalendarEvent>("create_event", { draft, sendUpdates });
  }
  updateEvent(
    calendarId: string,
    eventId: string,
    etag: string | null,
    draft: EventDraft,
    sendUpdates: SendUpdates
  ) {
    return invoke<EventWriteResult>("update_event", {
      calendarId,
      eventId,
      etag,
      draft,
      sendUpdates,
    });
  }
  deleteEvent(
    calendarId: string,
    eventId: string,
    etag: string | null,
    sendUpdates: SendUpdates
  ) {
    return invoke<EventWriteResult>("delete_event", {
      calendarId,
      eventId,
      etag,
      sendUpdates,
    });
  }
  rsvpEvent(calendarId: string, eventId: string, response: RsvpResponse) {
    return invoke<CalendarEvent>("rsvp_event", { calendarId, eventId, response });
  }
  threadInvite(threadId: ThreadId) {
    return invoke<ThreadInvite | null>("thread_invite", { threadId });
  }
  getDailyPhoto() {
    return invoke<DailyPhoto | null>("get_daily_photo");
  }
  photoShown() {
    return invoke<void>("photo_shown");
  }
  setUnsplashKey(key: string) {
    return invoke<void>("set_unsplash_key", { key });
  }
  lintText(text: string) {
    return invoke<LintHit[]>("lint_text", { text });
  }
  searchContacts(query: string) {
    return invoke<Contact[]>("search_contacts", { query });
  }
  refreshContacts() {
    return invoke<number>("refresh_contacts");
  }
  getSettings() {
    return invoke<Settings>("get_settings");
  }
  saveSettings(settings: Settings) {
    return invoke<void>("save_settings", { settings });
  }
  splitCounts() {
    return invoke<Record<string, number>>("split_counts");
  }
  previewSplit(query: string) {
    return invoke<{ ok: boolean; error: string | null; count: number }>("preview_split", {
      query,
    });
  }
  getKnowledgeBase() {
    return invoke<KnowledgeBase>("get_knowledge_base");
  }
  saveKnowledgeBase(kb: KnowledgeBase) {
    return invoke<void>("save_knowledge_base", { kb });
  }
  setAiKey(provider: AiProviderId, key: string) {
    return invoke<void>("set_ai_key", { provider, key });
  }
  testAiProvider(provider: AiProviderId) {
    return invoke<{ ok: boolean; message: string }>("test_ai_provider", {
      provider,
    });
  }
  aiDraft(req: DraftRequest, handlers: DraftStreamHandlers): () => void {
    const requestId = aiRequestSeq++;
    let cancelled = false;
    const channel = new Channel<string>();
    channel.onmessage = (chunk) => {
      if (!cancelled) handlers.onChunk(chunk);
    };
    invoke<void>("ai_draft", { req, requestId, onChunk: channel })
      .then(() => {
        if (!cancelled) handlers.onDone();
      })
      .catch((err) => {
        if (!cancelled) handlers.onError(String(err));
      });
    return () => {
      cancelled = true;
      void invoke("cancel_ai", { requestId }).catch(() => {});
    };
  }
  aiSuggestReplies(threadId: ThreadId) {
    return invoke<string[]>("ai_suggest_replies", { threadId });
  }
  getStreaks() {
    return invoke<Streaks>("get_streaks");
  }
  recordZero(splitId: string) {
    return invoke<ZeroEvent | null>("record_zero", { splitId });
  }
  listCelebrationImages() {
    return invoke<string[]>("list_celebration_images");
  }
  onMailUpdated(cb: () => void): () => void {
    const un = listen("mail:updated", cb);
    return () => {
      void un.then((f) => f());
    };
  }
  onSyncProgress(cb: (p: SyncProgress) => void): () => void {
    const un = listen<SyncProgress>("sync:progress", (e) => cb(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }
  onCalendarUpdated(cb: (error: string | null) => void): () => void {
    const un = listen<string | null>("calendar:updated", (e) => cb(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }
  onThreadImages(cb: (threadId: string) => void): () => void {
    const un = listen<string>("thread:images", (e) => cb(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }
  onTriageError(cb: (message: string) => void): () => void {
    const un = listen<string>("triage:error", (e) => cb(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }
  onNotice(cb: (message: string) => void): () => void {
    const un = listen<string>("app:notice", (e) => cb(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }
  onMigrationProgress(cb: (p: MigrationProgress) => void): () => void {
    const un = listen<MigrationProgress>("migration:progress", (e) => cb(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }
}

// --- IPC instrumentation ---------------------------------------------------
// Records every backend call (count + duration per method) on window.__ipc so
// slow navigations can be traced to their round-trips — in the demo AND the
// desktop app (open devtools and inspect __ipc.stats / __ipc.log). In the
// browser demo the mock resolves in ~0 ms, which real IPC does not; setting
// localStorage["snail-ipc-latency"] to a millisecond count delays every mock
// call by that much to approximate desktop latency. No-op by default.
interface IpcStat {
  calls: number;
  totalMs: number;
  lastMs: number;
}

function instrument(real: Backend): Backend {
  if (typeof window === "undefined") return real;
  const stats: Record<string, IpcStat> = {};
  const log: { m: string; start: number; ms: number }[] = [];
  (window as unknown as Record<string, unknown>).__ipc = {
    stats,
    log,
    reset() {
      for (const k of Object.keys(stats)) delete stats[k];
      log.length = 0;
    },
  };
  const latency = () =>
    isTauri ? 0 : Number(localStorage.getItem("snail-ipc-latency") ?? 0) || 0;
  // MessageChannel hops instead of setTimeout: hidden tabs clamp timers to
  // ~1s, which would turn a 30ms simulated latency into a second.
  const hopDelay = (ms: number) =>
    new Promise<void>((resolve) => {
      const deadline = performance.now() + ms;
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        if (performance.now() >= deadline) resolve();
        else ch.port2.postMessage(0);
      };
      ch.port2.postMessage(0);
    });
  const record = (m: string, start: number) => {
    const ms = performance.now() - start;
    const s = (stats[m] ??= { calls: 0, totalMs: 0, lastMs: 0 });
    s.calls++;
    s.totalMs += ms;
    s.lastMs = ms;
    if (log.length < 2000) log.push({ m, start, ms });
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        const start = performance.now();
        const out = (v as (...a: unknown[]) => unknown).apply(target, args);
        // Only data calls (promises) are timed; aiDraft's cancel fn and the
        // on* unsubscribe fns pass through untouched.
        if (!(out instanceof Promise)) return out;
        const lat = latency();
        const delayed =
          lat > 0
            ? out.then(
                async (r) => {
                  await hopDelay(lat);
                  return r;
                },
                async (e) => {
                  await hopDelay(lat);
                  throw e;
                }
              )
            : out;
        return delayed.finally(() => record(prop as string, start));
      };
    },
  });
}

export const backend: Backend = instrument(
  isTauri ? new TauriBackend() : new MockBackend()
);
