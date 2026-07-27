import { create } from "zustand";
import { backend } from "@/lib/ipc";
import { sanitizeUserHtml } from "@/lib/sanitize";
import { splitThreads, useMail, visibleThreads } from "./mail";
import { activeSignature, useSettings } from "./settings";
import type { Recipients } from "@/lib/recipients";
import type { MailAttachment, MigrationProgress, OutgoingMail, SyncProgress, ThreadId, ZeroEvent } from "@/lib/types";

export type Screen = "mail" | "settings" | "search" | "calendar";

/** Which region owns ambient keys like ←/→ (day navigation). */
export type FocusRegion = "mail" | "calendar";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface ComposeState {
  mode: ComposeMode;
  threadId: ThreadId | null;
  /** One token per recipient ("Name <a@b.c>" or a bare address), never a
   *  comma-joined string: chips exist to remove exactly that ambiguity, and a
   *  display name containing a comma has no faithful encoding in one. Legacy
   *  string drafts normalize on read — see lib/recipients. */
  to: Recipients;
  cc: Recipients;
  bcc: Recipients;
  subject: string;
  body: string; // rich HTML from the WYSIWYG editor (signature lives inside it)
  /** Read-only quoted context appended at send (new-message compose only; a
   *  reply carries its quote *inside* the editable body, behind the •••). */
  quote: string;
  attachments: MailAttachment[];
  /** Google Drive files linked as chips in the body (share-on-send reads
   *  this; chips the user deleted from the body are skipped at send). */
  driveLinks: DriveLinkRef[];
  /** Persisted-draft row backing this compose; null until first autosave. */
  draftId: number | null;
  /** The account that owns `draftId`. Draft ids are per-account autoincrement,
   *  so the id alone doesn't name a row — without the owner, an autosave after
   *  an account switch rewrites the active mailbox's row of the same number. */
  draftAccount: string | null;
}

/** One Drive file linked into the body as a chip. */
export interface DriveLinkRef {
  fileId: string;
  name: string;
  url: string;
  size: number | null;
}

/** The email-safe Drive link chip: an inline-styled anchor (renders in any
 *  mail client), tagged data-drive-chip so the send path can find it, kept
 *  intact in the editor by the extended Link mark (ComposeEditor). */
export function driveChipHtml(ref: DriveLinkRef): string {
  const style =
    "display:inline-block;padding:3px 10px;margin:2px 0;border:1px solid #dadce0;" +
    "border-radius:8px;text-decoration:none;color:#1a73e8;background:#f8f9fa;" +
    "font-size:13px;line-height:20px";
  return (
    `<a href="${escapeHtml(ref.url)}" data-drive-chip="${escapeHtml(ref.fileId)}" ` +
    `data-drive-name="${escapeHtml(ref.name)}" rel="noopener noreferrer" ` +
    `style="${style}">📄 ${escapeHtml(ref.name)}</a>`
  );
}

/** The Drive chips actually present in a compose body (the user may have
 *  deleted some since insertion): fileId → href. */
export function driveChipsInHtml(html: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!html.includes("data-drive-chip")) return out;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const a of Array.from(doc.querySelectorAll("a[data-drive-chip]"))) {
    const id = a.getAttribute("data-drive-chip");
    const href = a.getAttribute("href");
    if (id && href) out.set(id, href);
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!
  );
}

/** True when a signature is rich HTML (images, formatting) vs plain text. */
export function isHtmlSignature(sig: string): boolean {
  return /<\w+[^>]*>/.test(sig);
}

const BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE",
  "H1", "H2", "H3", "H4", "H5", "H6", "TR", "TABLE",
]);
// Table cells get a tab between them (rows already break on TR) so a quoted
// table doesn't run together in the plain-text MIME alternative.
const CELL_TAGS = new Set(["TD", "TH"]);

/** Flatten rich HTML to plain text, preserving block/line breaks so the
 *  plain-text MIME alternative reads correctly (textContent alone runs
 *  paragraphs together). Used for the send fallback and the blank check. */
function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  let out = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent ?? "";
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        const tag = el.tagName;
        if (tag === "BR") {
          out += "\n";
          continue;
        }
        // A Drive link chip flattens to "name — url" on its own line (the
        // glyph + styling are meaningless in the plain-text alternative).
        const chipId = el.getAttribute?.("data-drive-chip");
        if (chipId) {
          const name = el.getAttribute("data-drive-name") || el.textContent || "file";
          out += `\n${name.trim()} — ${el.getAttribute("href") ?? ""}\n`;
          continue;
        }
        walk(child);
        if (CELL_TAGS.has(tag)) out += "\t";
        else if (BLOCK_TAGS.has(tag)) out += "\n";
      }
    }
  };
  walk(doc.body);
  // Drop trailing tabs/spaces before a newline (e.g. a row's last cell).
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The active account's signature as compose-ready HTML, seeded into the
 *  editor body so it renders and edits with its real formatting (a plain-text
 *  signature becomes a line-broken paragraph). */
export function signatureHtml(): string {
  const sig = activeSignature();
  if (!sig) return "";
  return isHtmlSignature(sig)
    ? sig
    : `<p>${escapeHtml(sig).replace(/\n/g, "<br>")}</p>`;
}

/** Split the rich body into the user's message and whether the seeded
 *  signature is still present at the end. The signature is always seeded as a
 *  suffix (`…<p></p>{signature}`), so it strips off as a plain-text suffix —
 *  letting callers tell real content from an untouched signature-only body. */
export function splitBodySignature(bodyHtml: string): {
  message: string;
  hasSignature: boolean;
} {
  const full = htmlToText(bodyHtml);
  const sig = htmlToText(signatureHtml());
  if (sig && full.endsWith(sig)) {
    return { message: full.slice(0, full.length - sig.length).trim(), hasSignature: true };
  }
  return { message: full, hasSignature: false };
}

/** True when the rich body carries no content worth saving as a draft. An
 *  empty editor serializes to `<p></p>`. A new-message compose seeds the
 *  signature into the body (doesn't count); a reply body is the message alone
 *  (its signature + quote live in `quote`, not the body), so this measures the
 *  user's actual message either way. A user-inserted image does count. */
export function htmlBodyIsBlank(html: string): boolean {
  if (!html) return true;
  const { message, hasSignature } = splitBodySignature(html);
  if (message !== "") return false;
  if (/<img\b/i.test(html) && !hasSignature) return false;
  return true;
}

/** Is this compose worth persisting as a draft? For a NEW message, any of
 *  recipients / subject / body / attachments counts. For a REPLY or FORWARD the
 *  recipients and "Re:/Fwd:" subject are auto-filled, so they don't count —
 *  only a real (non-blank) message or an attachment does. This keeps an
 *  opened-then-abandoned reply from leaving a junk draft behind. */
export function composeHasContent(c: ComposeState): boolean {
  if (!htmlBodyIsBlank(c.body)) return true;
  if (c.attachments.length > 0) return true;
  if (c.mode === "new") return c.to.length > 0 || !!c.subject.trim();
  return false;
}

/** The one place a compose window turns into an outgoing message. The body is
 *  rich HTML from the editor; every message now carries an HTML alternative
 *  (build_rfc822 emits multipart/alternative when bodyHtml is set) plus a
 *  plain-text fallback. */
export function outgoingFromCompose(c: ComposeState): OutgoingMail {
  // Recipients are already tokens — the old split on [,;] is gone, and with it
  // the reason autocomplete had to discard a display name containing a comma.
  // `quote` is now rich HTML (signature + attribution + the original message),
  // so it passes through as markup — sanitized, never escaped.
  const quoteHtml = c.quote.trim() ? sanitizeUserHtml(c.quote) : "";

  // Sanitize outbound too: the editor accepts pasted rich text, and the Rust
  // core only sanitizes INBOUND mail (ammonia).
  const safeBody = sanitizeUserHtml(c.body).trim();
  const bodyPlain = htmlToText(c.body);
  const bodyText = [bodyPlain, quoteHtml ? htmlToText(quoteHtml) : ""]
    .filter(Boolean)
    .join("\n\n");

  const htmlParts = [`<div>${safeBody || "<br>"}</div>`];
  if (quoteHtml) htmlParts.push(quoteHtml);

  return {
    threadId: c.threadId,
    to: [...c.to],
    cc: [...c.cc],
    bcc: [...(c.bcc ?? [])],
    subject: c.subject || "(no subject)",
    bodyText,
    bodyHtml: htmlParts.join(""),
    replyAll: c.mode === "replyAll",
    attachments: c.attachments,
  };
}

export type Picker =
  | "none"
  | "snooze"
  | "move"
  | "zeroSweep"
  | "sendLater"
  | "snippet"
  | "drafts"
  | "drivePicker";

interface UiState {
  screen: Screen;
  focusRegion: FocusRegion;
  paletteOpen: boolean;
  picker: Picker;
  compose: ComposeState | null;
  celebration: ZeroEvent | null;
  toast: string | null;
  /** Background mail-download progress (initial reconcile + history crawl);
   *  drives the "Downloading mail history… N%" footer strip. Null until the
   *  first sync:progress arrives. */
  syncProgress: SyncProgress | null;
  /** One-time per-account storage split (desktop update path); drives the
   *  "Optimizing mail storage… N%" footer strip. Null before it starts and
   *  after the `table === "done"` payload clears it. */
  migration: MigrationProgress | null;
  /** A message queued in the Undo Send window: drives the bottom-left bar with
   *  its countdown, Z-to-undo, and Send-now (accelerate). Null when nothing is
   *  pending or the window has elapsed. */
  pendingSend: PendingSend | null;
  settingsTab: string;
  /** Instant Reply suggestions for the open thread. */
  suggestions: string[];
  suggestionIndex: number | null;
  /** Write-with-AI instruction bar inside compose (Ctrl+J). */
  aiBarOpen: boolean;
  /** Ask-AI overlay over the current thread (?). */
  askAiOpen: boolean;
  /** Keyboard-shortcuts reference panel in the right-hand dock (Ctrl+K →
   *  "Keyboard Shortcuts"). Session state, deliberately not persisted. */
  shortcutsOpen: boolean;
  /** In-flight oversized-attachment uploads to Drive — the pending chips in
   *  the composer's attachment row. Cleared when compose closes. */
  driveUploads: DriveUploadUi[];
  /** "Too big to attach — upload to Drive?" confirm (file names shown;
   *  the File objects wait in useComposeController). */
  drivePrompt: { names: string[] } | null;
  /** Share-on-send dialog (linked-file count; resolver waits in
   *  useComposeController). */
  sharePrompt: { count: number } | null;
  /** Monotonic id of the CURRENT compose session — bumps on every
   *  startCompose. Async work (Drive uploads) captures it and checks it on
   *  completion, so a result from one compose never lands in another. */
  composeSeq: number;

  setScreen: (s: Screen) => void;
  setFocusRegion: (r: FocusRegion) => void;
  openPalette: () => void;
  closePalette: () => void;
  openPicker: (p: Picker) => void;
  closePicker: () => void;
  startCompose: (c: ComposeState) => void;
  closeCompose: () => void;
  setSettingsTab: (t: string) => void;
  showToast: (msg: string) => void;
  dismissCelebration: () => void;
  setSuggestions: (s: string[]) => void;
  cycleSuggestion: () => void;
  setAiBarOpen: (open: boolean) => void;
  setAskAiOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setPendingSend: (p: PendingSend | null) => void;
  clearPendingSend: () => void;
  setSyncProgress: (p: SyncProgress) => void;
  setMigration: (p: MigrationProgress) => void;
  /** Called after any archive-ish action: fires the celebration if the
   *  active split just hit zero. */
  checkInboxZero: () => Promise<void>;
}

/** One oversized attachment mid-upload to Drive (a pending chip). */
export interface DriveUploadUi {
  id: number;
  name: string;
  sent: number;
  total: number;
}

/** A send waiting out its Undo Send window (see UndoSendBar). */
export interface PendingSend {
  /** The outbox row to cancel (Z) or flush now (Ctrl/Cmd+Shift+Z). */
  outboxId: number;
  /** The account that owns `outboxId` — ids are per-account, so both are
   *  needed or Z can cancel another mailbox's identically-numbered send. */
  outboxAccount: string;
  /** Epoch ms when the message actually leaves; drives the countdown. */
  expiresAt: number;
  /** Bar label, e.g. "Sent" or "Sent & marked done". */
  label: string;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useUi = create<UiState>((set, get) => ({
  screen: "mail",
  focusRegion: "mail",
  paletteOpen: false,
  picker: "none",
  compose: null,
  celebration: null,
  toast: null,
  syncProgress: null,
  migration: null,
  pendingSend: null,
  settingsTab: "account",
  suggestions: [],
  suggestionIndex: null,
  aiBarOpen: false,
  askAiOpen: false,
  shortcutsOpen: false,
  driveUploads: [],
  drivePrompt: null,
  sharePrompt: null,
  composeSeq: 0,

  setScreen: (s) =>
    set({
      screen: s,
      paletteOpen: false,
      picker: "none",
      focusRegion: s === "calendar" ? "calendar" : "mail",
    }),
  setFocusRegion: (r) => set({ focusRegion: r }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  openPicker: (p) => set({ picker: p }),
  closePicker: () => set({ picker: "none" }),
  startCompose: (c) =>
    set((s) => ({
      compose: c,
      composeSeq: s.composeSeq + 1,
      screen: "mail",
      aiBarOpen: false,
      askAiOpen: false,
    })),
  closeCompose: () =>
    set({
      compose: null,
      aiBarOpen: false,
      // In-flight uploads have nowhere to land once the composer is gone —
      // drop the pending chips (the Drive-side session just expires).
      driveUploads: [],
      drivePrompt: null,
      sharePrompt: null,
    }),
  setSettingsTab: (t) => set({ settingsTab: t }),
  setSuggestions: (s) => set({ suggestions: s, suggestionIndex: null }),
  cycleSuggestion: () =>
    set((st) => {
      if (st.suggestions.length === 0) return {};
      const next =
        st.suggestionIndex === null
          ? 0
          : (st.suggestionIndex + 1) % st.suggestions.length;
      return { suggestionIndex: next };
    }),
  setAiBarOpen: (open) => set({ aiBarOpen: open }),
  setAskAiOpen: (open) => set({ askAiOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setPendingSend: (p) => set({ pendingSend: p }),
  clearPendingSend: () => set({ pendingSend: null }),
  setSyncProgress: (p) => set({ syncProgress: p }),
  setMigration: (p) => set({ migration: p.table === "done" ? null : p }),

  showToast: (msg) => {
    set({ toast: msg });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },

  dismissCelebration: () => set({ celebration: null }),

  checkInboxZero: async () => {
    const mail = useMail.getState();
    if (mail.listView !== "inbox" || !mail.loaded) return;
    if (get().celebration) return;
    const remaining = splitThreads(mail.inbox, mail.activeSplitId).length;
    if (remaining > 0) return;
    const event = await backend.recordZero(mail.activeSplitId);
    if (event) {
      // refresh streaks shown in settings
      void useSettings.getState().load();
      set({ celebration: event });
    }
  },
}));

/** The thread the user is acting on: the open one, else the list selection. */
export function actionTargetThreadId(): ThreadId | null {
  const mail = useMail.getState();
  if (mail.openThreadId) return mail.openThreadId;
  const list = visibleThreads(mail);
  return list[mail.selectedIndex]?.id ?? null;
}

/** Bulk-aware targets: the open thread, else the multi-selection, else the
 *  cursor row. Order follows the visible list so undo restores top-down. */
export function actionTargetThreadIds(): ThreadId[] {
  const mail = useMail.getState();
  if (mail.openThreadId) return [mail.openThreadId];
  if (mail.selectedIds.size > 0) {
    return visibleThreads(mail)
      .map((t) => t.id)
      .filter((id) => mail.selectedIds.has(id));
  }
  const single = actionTargetThreadId();
  return single ? [single] : [];
}
