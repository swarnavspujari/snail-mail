// Every user action, defined once. The command palette lists these; the
// keyboard engine binds them via the (remappable) shortcut map in settings.
import { backend } from "./ipc";
import { useUpdater } from "./updater";
import type { Binding } from "./keyboard";
import { popUndo, pushUndo } from "./undo";
import { DAY_MS, startOfToday, useCalendar } from "@/stores/calendar";
import { useMail, visibleThreads } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import {
  actionTargetThreadId,
  actionTargetThreadIds,
  composeHasContent,
  escapeHtml,
  signatureHtml,
  useUi,
  type ComposeState,
} from "@/stores/ui";
import type { Message, ThreadId } from "./types";

export interface Command {
  id: string;
  title: string;
  /** Section header in the palette. */
  group: string;
  /** Where this command's key is live, as a short label ("in thread",
   *  "compose", …). Declarative twin of `when`: the keyboard engine resolves
   *  overlaps with `when` + registration order, and the shortcuts editor uses
   *  this to tell a legitimate context-shared key ("↓" is three commands)
   *  apart from a real conflict (two global commands on the same key).
   *  Absent = the key is live everywhere the engine allows. */
  context?: string;
  /** Extra search terms (space-separated) the palette matches besides the
   *  title — e.g. "dark mode light mode" for the theme command. */
  keywords?: string;
  hidden?: boolean;
  when?: () => boolean;
  run: () => void | Promise<void>;
}

// ---- context predicates ----------------------------------------------------

const ui = () => useUi.getState();
const mail = () => useMail.getState();

const inCompose = () => ui().compose !== null;
const onMailScreen = () => ui().screen === "mail" && !inCompose();
const inThread = () => onMailScreen() && mail().openThreadId !== null;
const inList = () => onMailScreen() && mail().openThreadId === null;
const hasTarget = () => actionTargetThreadId() !== null;
/** ←/→ move calendar days only when the calendar owns focus AND is visible:
 *  the week view screen, or the day panel next to the list while it is open
 *  and focused. An open thread hides the panel, so arrows go inert there. */
const calendarFocused = () =>
  !inCompose() &&
  (ui().screen === "calendar" ||
    (inList() &&
      useSettings.getState().settings.calendarOpen &&
      ui().focusRegion === "calendar"));

// ---- compose helpers --------------------------------------------------------

/** The reply's "trimmed content" behind the •••: the signature + an attribution
 *  line + the ORIGINAL message as rich HTML. It is rendered faithfully in a
 *  sandboxed frame (ProseMirror would strip a newsletter's tables/layout) and
 *  appended at send. Prefer the original's HTML so it keeps its images/layout;
 *  fall back to text only when there is no HTML part. */
function replyTrailerHtml(m: Message): string {
  const sig = signatureHtml();
  const when = new Date(m.date).toLocaleString();
  const attribution = `<p class="fm-quote-attr">On ${escapeHtml(when)}, ${escapeHtml(
    m.fromName
  )} &lt;${escapeHtml(m.from)}&gt; wrote:</p>`;
  const original =
    m.bodyHtml && m.bodyHtml.trim()
      ? m.bodyHtml
      : `<div>${escapeHtml(m.bodyText).replace(/\n/g, "<br>")}</div>`;
  return `${sig}${attribution}<blockquote class="fm-quote">${original}</blockquote>`;
}

async function messagesFor(id: ThreadId): Promise<Message[]> {
  const m = mail();
  if (m.openThreadId === id && m.openMessages.length) return m.openMessages;
  return backend.getThread(id);
}

function myAddress(): string {
  return useSettings.getState().accounts.active ?? "";
}

export async function startReply(
  mode: "reply" | "replyAll" | "forward",
  presetBody?: string,
  targetMessageId?: string
) {
  const id = actionTargetThreadId();
  if (!id) return;
  const msgs = await messagesFor(id);
  if (msgs.length === 0) return;
  const me = myAddress().toLowerCase();
  // Default target: the most recent message that isn't ours. When the reader's
  // per-message cursor supplies a specific message (Enter on a focused email),
  // reply to THAT one instead — its sender, recipients, and quoted body.
  const target =
    (targetMessageId && msgs.find((m) => m.id === targetMessageId)) ||
    [...msgs].reverse().find((m) => m.from.toLowerCase() !== me) ||
    msgs[msgs.length - 1];

  const subject = msgs[0].subject;
  // Superhuman-style: the reply body opens empty with the caret on top. The
  // signature + quoted history live in `quote` (rich HTML) — rendered faithfully
  // behind the ••• in the dock and appended at send, NOT crammed into the
  // schema-limited editor (which would strip a real email's layout).
  const body = presetBody
    ? `<p>${escapeHtml(presetBody).replace(/\n/g, "<br>")}</p>`
    : "<p></p>";
  const base: ComposeState = {
    mode,
    threadId: id,
    to: "",
    cc: "",
    bcc: "",
    attachments: [],
    driveLinks: [],
    draftId: null,
    subject:
      mode === "forward"
        ? subject.startsWith("Fwd:")
          ? subject
          : `Fwd: ${subject}`
        : subject.startsWith("Re:")
          ? subject
          : `Re: ${subject}`,
    body,
    quote: replyTrailerHtml(target),
  };
  if (mode === "reply") {
    base.to = target.from;
  } else if (mode === "replyAll") {
    const others = new Set<string>();
    others.add(target.from);
    for (const a of [...target.to, ...target.cc]) {
      if (a.toLowerCase() !== me) others.add(a);
    }
    const [first, ...rest] = [...others];
    base.to = first ?? "";
    base.cc = rest.join(", ");
  }
  // The composer docks inline in the reader, so make sure the thread is open
  // (e.g. when replying straight from a list selection).
  if (mail().openThreadId !== id) await mail().openThread(id);
  ui().startCompose(base);
}

function pickedSuggestion(): string | undefined {
  const u = ui();
  return u.suggestionIndex === null
    ? undefined
    : u.suggestions[u.suggestionIndex];
}

/** Scroll the open thread's reading pane by a fraction of its viewport.
 *  Instant (not smooth) so it feels immediate and works in headless tests. */
function scrollReader(fraction: number) {
  const el = document.querySelector<HTMLElement>("[data-thread-scroll]");
  el?.scrollBy({ top: el.clientHeight * fraction });
}

/** Ask the open reply dock to reveal + focus one of its recipient/subject
 *  fields (Ctrl+Shift+O/C/B/S). The dock owns the field DOM, so this is an
 *  event rather than store state. */
function focusComposeField(field: "to" | "cc" | "bcc" | "subject") {
  window.dispatchEvent(
    new CustomEvent("fission:compose-field", { detail: { field } })
  );
}

/** Move the list cursor; while a thread is open, open the newly-selected one
 *  too so j/k reads straight through the list (Superhuman-style). */
function advanceConversation(dir: 1 | -1) {
  const m = mail();
  m.moveSelection(dir);
  if (m.openThreadId) {
    const t = visibleThreads(useMail.getState())[useMail.getState().selectedIndex];
    if (t) void m.openThread(t.id);
  }
}

/** Snapshot the cursor position of the thread(s) about to be triaged, BEFORE
 *  they're removed from the list. Reading = the open thread is one of the
 *  targets; idx is its row (so we can land on whatever slides into that row). */
export function triageAnchor(ids: ThreadId[]): { wasReading: boolean; idx: number } {
  const m = mail();
  const openId = m.openThreadId;
  const wasReading = openId != null && ids.includes(openId);
  const idx = wasReading
    ? visibleThreads(m).findIndex((t) => t.id === openId)
    : m.selectedIndex;
  return { wasReading, idx };
}

/** After a triage action removes its target(s), keep the user in flow: if they
 *  were reading, open the email that slid into the removed one's place (the
 *  Superhuman "next email down"); if the section is now empty, drop to the list
 *  so the inbox-zero / rest state shows. In list mode this just re-anchors the
 *  cursor so it never strands past the end of a shortened list. Call AFTER the
 *  optimistic removal has completed. */
export async function advanceAfterTriage(anchor: { wasReading: boolean; idx: number }) {
  const list = visibleThreads(useMail.getState());
  if (list.length === 0) {
    mail().closeThread();
    return;
  }
  const next = Math.max(0, Math.min(anchor.idx, list.length - 1));
  mail().select(next);
  if (anchor.wasReading) await mail().openThread(list[next].id);
}

/** The new-message composer's ↑/↓ header chevrons (and K/J): background the
 *  in-progress draft and jump to the previous/next email, opening it full-screen
 *  — the Superhuman "flip through the inbox from compose" move. Unlike
 *  advanceConversation, this ALWAYS opens the target thread (a new compose has
 *  no thread open behind it), and first force-saves so nothing is lost. */
export function composeGoToEmail(dir: 1 | -1) {
  const u = ui();
  const c = u.compose;
  if (!c) return;
  // Resolve the target BEFORE tearing down the composer: if the visible list is
  // empty (empty split, empty label/Trash view, just-switched account) there's
  // nothing to open, so keep the draft up rather than dead-ending on a blank
  // list. Mirrors advanceConversation's `if (t)` guard.
  const m = mail();
  m.moveSelection(dir);
  const t = visibleThreads(useMail.getState())[useMail.getState().selectedIndex];
  if (!t) return;
  // closeCompose keeps (never deletes) the draft, but the last keystrokes may
  // predate the 800ms autosave — flush them so the draft is truly in Drafts.
  if (composeHasContent(c)) {
    const { draftId, ...payload } = c;
    void backend.saveDraft(draftId, JSON.stringify(payload)).catch(() => {});
  }
  u.closeCompose();
  void m.openThread(t.id);
}

/** Standard undo entry for a triage action: run the inverse, refresh, toast. */
export function pushTriageUndo(label: string, inverse: () => Promise<void>) {
  pushUndo({
    label,
    run: async () => {
      await inverse();
      await mail().refresh();
      ui().showToast(`Undone — ${label}`);
    },
  });
}

/** "Mark Done" or "Mark Done (12)" — bulk actions label their undo entry. */
function bulkLabel(base: string, n: number): string {
  return n > 1 ? `${base} (${n})` : base;
}

// ---- the registry -----------------------------------------------------------

export function allCommands(): Command[] {
  return [
    {
      id: "palette.open",
      title: "Command Palette",
      group: "General",
      run: () => (ui().paletteOpen ? ui().closePalette() : ui().openPalette()),
    },
    {
      id: "compose",
      title: "Compose New Email",
      group: "Compose",
      when: () => !inCompose(),
      run: () => {
        // Seed the signature (rich HTML) into the editable body, an empty
        // paragraph above it for the message. Nothing is appended at send.
        const sig = signatureHtml();
        return ui().startCompose({
          mode: "new",
          threadId: null,
          to: "",
          cc: "",
          bcc: "",
          subject: "",
          body: sig ? `<p></p>${sig}` : "",
          quote: "",
          attachments: [],
          driveLinks: [],
          draftId: null,
        });
      },
    },
    {
      id: "thread.done",
      title: "Mark Done (archive)",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const ids = actionTargetThreadIds();
        if (ids.length === 0) return;
        const anchor = triageAnchor(ids);
        for (const id of ids) await mail().archive(id);
        mail().clearSelection();
        await advanceAfterTriage(anchor);
        const label = bulkLabel("Mark Done", ids.length);
        pushTriageUndo(label, async () => {
          for (const id of ids) await mail().moveToInbox(id);
        });
        ui().showToast(ids.length > 1 ? `Done — ${ids.length} conversations` : "Done");
        await ui().checkInboxZero();
      },
    },
    {
      id: "thread.notDone",
      title: "Mark Not Done (back to inbox)",
      group: "Triage",
      when: () => hasTarget() && !inCompose() && mail().listView !== "inbox",
      run: async () => {
        const ids = actionTargetThreadIds();
        if (ids.length === 0) return;
        if (ids.includes(mail().openThreadId ?? "")) mail().closeThread();
        // In Trash, "not done" means restore (unhide + back to inbox).
        const fromTrash = mail().listView === "trash";
        for (const id of ids) {
          if (fromTrash) await mail().restore(id);
          else await mail().moveToInbox(id);
        }
        mail().clearSelection();
        if (fromTrash) await mail().refresh();
        const label = bulkLabel(fromTrash ? "Restore" : "Mark Not Done", ids.length);
        pushTriageUndo(label, async () => {
          for (const id of ids) {
            if (fromTrash) await mail().hide(id, "trash");
            else await mail().archive(id);
          }
        });
        ui().showToast(fromTrash ? "Restored" : "Moved to inbox");
      },
    },
    {
      id: "thread.trash",
      title: "Trash",
      group: "Triage",
      when: () => hasTarget() && !inCompose() && mail().listView !== "trash",
      run: async () => {
        const ids = actionTargetThreadIds();
        if (ids.length === 0) return;
        const anchor = triageAnchor(ids);
        for (const id of ids) await mail().hide(id, "trash");
        mail().clearSelection();
        await advanceAfterTriage(anchor);
        const label = bulkLabel("Trash", ids.length);
        pushTriageUndo(label, async () => {
          for (const id of ids) await mail().restore(id);
        });
        ui().showToast(
          ids.length > 1
            ? `Moved ${ids.length} to trash — Z to undo`
            : "Moved to trash — Z to undo"
        );
        await ui().checkInboxZero();
      },
    },
    {
      id: "thread.spam",
      title: "Mark Spam",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        const anchor = triageAnchor([id]);
        await mail().hide(id, "spam");
        await advanceAfterTriage(anchor);
        pushTriageUndo("Mark Spam", () => mail().restore(id));
        ui().showToast("Marked spam — Z to undo");
        await ui().checkInboxZero();
      },
    },
    {
      id: "thread.mute",
      title: "Mute (archive + auto-archive replies)",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        const anchor = triageAnchor([id]);
        await mail().mute(id);
        await advanceAfterTriage(anchor);
        pushTriageUndo("Mute", () => mail().unmute(id));
        ui().showToast("Muted — Z to undo");
        await ui().checkInboxZero();
      },
    },
    {
      id: "thread.unsubscribe",
      title: "Unsubscribe",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        const r = await backend.unsubscribeThread(id);
        if (r.kind === "opened") {
          ui().showToast("Unsubscribe page opened in your browser");
        } else if (r.kind === "mailto" && r.target) {
          ui().startCompose({
            mode: "new",
            threadId: null,
            to: r.target,
            cc: "",
            bcc: "",
            subject: "Unsubscribe",
            body: "<p>Please unsubscribe me from this list.</p>",
            quote: "",
            attachments: [],
            driveLinks: [],
            draftId: null,
          });
        } else {
          ui().showToast("No unsubscribe link in this thread");
        }
      },
    },
    {
      id: "undo",
      title: "Undo",
      group: "General",
      when: () => !inCompose(),
      run: async () => {
        const handled = await popUndo();
        if (!handled) ui().showToast("Nothing to undo");
      },
    },
    {
      id: "thread.star",
      title: "Star / Unstar",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        await mail().toggleStar(id);
        pushTriageUndo("Star", () => mail().toggleStar(id));
      },
    },
    {
      id: "thread.snooze",
      title: "Remind Me / Snooze…",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: () => ui().openPicker("snooze"),
    },
    {
      id: "thread.reply",
      title: "Reply",
      group: "Compose",
      when: () => hasTarget() && !inCompose(),
      run: () => startReply("reply", pickedSuggestion()),
    },
    {
      id: "thread.forward",
      title: "Forward",
      group: "Compose",
      when: () => hasTarget() && !inCompose(),
      run: () => startReply("forward"),
    },
    // Multi-message threads only: ↓/↑ move a per-message cursor (highlight +
    // scroll into view) and Enter drills into the focused message (open it, or
    // reply-all to it once open). ThreadView owns the cursor — these just emit
    // the intent (like focusComposeField). Gated on >1 message and ordered
    // before reader.lineDown/Up (down/up) and thread.replyAllOrOpen (enter), so
    // in the reader they win, while single-message threads fall straight
    // through to today's scroll / Reply-All.
    {
      id: "thread.focusNext",
      title: "Next Message in Thread",
      group: "Navigate",
      context: "multi-message",
      hidden: true,
      when: () => inThread() && mail().openMessages.length > 1,
      run: () =>
        window.dispatchEvent(
          new CustomEvent("fission:thread-step", { detail: { dir: 1 } })
        ),
    },
    {
      id: "thread.focusPrev",
      title: "Previous Message in Thread",
      group: "Navigate",
      context: "multi-message",
      hidden: true,
      when: () => inThread() && mail().openMessages.length > 1,
      run: () =>
        window.dispatchEvent(
          new CustomEvent("fission:thread-step", { detail: { dir: -1 } })
        ),
    },
    {
      id: "thread.focusEnter",
      title: "Open / Reply to Focused Message",
      group: "Navigate",
      context: "multi-message",
      hidden: true,
      when: () => inThread() && mail().openMessages.length > 1,
      run: () => window.dispatchEvent(new CustomEvent("fission:thread-enter")),
    },
    {
      id: "thread.replyAllOrOpen",
      title: "Open / Reply All",
      group: "Compose",
      hidden: true,
      when: () => (inList() && hasTarget()) || inThread(),
      run: async () => {
        if (inList()) {
          const id = actionTargetThreadId();
          if (id) await mail().openThread(id);
        } else {
          await startReply("replyAll", pickedSuggestion());
        }
      },
    },
    {
      id: "thread.replyAll",
      title: "Reply All",
      group: "Compose",
      when: () => hasTarget() && !inCompose(),
      run: () => startReply("replyAll", pickedSuggestion()),
    },
    {
      id: "list.next",
      title: "Next Conversation",
      group: "Navigate",
      // Works in the list AND while reading: in a thread, j/k advances to the
      // next conversation and opens it (Superhuman-style), matching how people
      // actually triage. Space (thread.scrollDown) handles scrolling a message.
      when: () => onMailScreen(),
      run: () => advanceConversation(1),
    },
    {
      id: "list.prev",
      title: "Previous Conversation",
      group: "Navigate",
      when: () => onMailScreen(),
      run: () => advanceConversation(-1),
    },
    {
      id: "thread.unread",
      title: "Mark Read / Unread",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        const m = mail();
        const t =
          m.inbox.find((t) => t.id === id) ??
          m.done.find((t) => t.id === id) ??
          m.reminders.find((t) => t.id === id);
        if (t?.unread) {
          await m.markRead(id);
          ui().showToast("Marked read");
        } else {
          await m.markUnread(id);
          if (m.openThreadId === id) m.closeThread();
          ui().showToast("Marked unread");
        }
      },
    },
    {
      id: "thread.move",
      title: "Move to Folder / Label…",
      group: "Triage",
      when: () => hasTarget() && !inCompose(),
      run: () => ui().openPicker("move"),
    },
    {
      id: "search",
      title: "Search",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => ui().setScreen("search"),
    },
    {
      id: "ai.ask",
      title: "Ask AI (about this thread)",
      group: "AI",
      when: () => hasTarget() && !inCompose(),
      run: async () => {
        const id = actionTargetThreadId();
        if (!id) return;
        if (!mail().openThreadId) await mail().openThread(id);
        ui().setAskAiOpen(true);
      },
    },
    {
      id: "split.next",
      title: "Next Split Inbox",
      group: "Navigate",
      when: () => inList() && mail().listView === "inbox",
      run: () => mail().cycleSplit(1),
    },
    {
      id: "split.prev",
      title: "Previous Split Inbox",
      group: "Navigate",
      when: () => inList() && mail().listView === "inbox",
      run: () => mail().cycleSplit(-1),
    },
    {
      id: "thread.cycleSuggestion",
      title: "Preview Next Instant Reply",
      group: "AI",
      context: "in thread",
      hidden: true,
      when: () => inThread() && ui().suggestions.length > 0,
      run: () => ui().cycleSuggestion(),
    },
    // Space pages the open email down; Shift+Space pages up. ↓/↑ nudge it a
    // shorter step. J/K (list.next/prev) stay on conversations — so in the
    // reader the arrows scroll the message while J/K change conversation, and
    // in the list the arrows move the cursor (list.cursorDown/Up below).
    {
      id: "thread.scrollDown",
      title: "Scroll Message Down",
      group: "Navigate",
      context: "in thread",
      hidden: true,
      when: () => inThread(),
      run: () => scrollReader(0.9),
    },
    {
      id: "reader.pageUp",
      title: "Scroll Message Up",
      group: "Navigate",
      context: "in thread",
      hidden: true,
      when: () => inThread(),
      run: () => scrollReader(-0.9),
    },
    {
      id: "reader.lineDown",
      title: "Scroll Message Down a Little",
      group: "Navigate",
      context: "in thread",
      hidden: true,
      when: () => inThread(),
      run: () => scrollReader(0.3),
    },
    {
      id: "reader.lineUp",
      title: "Scroll Message Up a Little",
      group: "Navigate",
      context: "in thread",
      hidden: true,
      when: () => inThread(),
      run: () => scrollReader(-0.3),
    },
    {
      id: "list.cursorDown",
      title: "Move Cursor Down",
      group: "Navigate",
      context: "in list",
      hidden: true,
      when: () => inList(),
      run: () => mail().moveSelection(1),
    },
    {
      id: "list.cursorUp",
      title: "Move Cursor Up",
      group: "Navigate",
      context: "in list",
      hidden: true,
      when: () => inList(),
      run: () => mail().moveSelection(-1),
    },
    {
      id: "goto.inbox",
      title: "Go to Inbox",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("inbox");
        mail().setActiveSplit("important");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.other",
      title: "Go to Other",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("inbox");
        mail().setActiveSplit("other");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.done",
      title: "Go to Done",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("done");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.reminders",
      title: "Go to Reminders",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("reminders");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.starred",
      title: "Go to Starred",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("starred");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.trash",
      title: "Go to Trash",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        mail().setListView("trash");
        ui().setScreen("mail");
      },
    },
    {
      id: "goto.drafts",
      title: "Drafts…",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => ui().openPicker("drafts"),
    },
    {
      id: "list.selectAll",
      title: "Select All From Here Down",
      group: "Triage",
      context: "in list",
      when: () => inList(),
      run: () => {
        mail().selectFromCursorDown();
        const n = mail().selectedIds.size;
        if (n > 0) ui().showToast(`${n} selected — E done · # trash · V label`);
      },
    },
    {
      id: "list.toggleSelect",
      title: "Select / Deselect Conversation",
      group: "Triage",
      context: "in list",
      hidden: true,
      when: () => inList(),
      run: () => {
        const id = actionTargetThreadId();
        if (id) mail().toggleSelected(id);
      },
    },
    {
      id: "compose.ai",
      title: "Write with AI",
      group: "AI",
      context: "compose",
      when: () => inCompose(),
      run: () => ui().setAiBarOpen(!ui().aiBarOpen),
    },
    {
      id: "compose.send",
      title: "Send",
      group: "Compose",
      context: "compose",
      hidden: true,
      when: () => inCompose(),
      run: () => {
        // Compose owns validation + the actual send; reach it via event so
        // draft state lives in exactly one place.
        window.dispatchEvent(new CustomEvent("fission:send"));
      },
    },
    {
      id: "compose.sendDone",
      title: "Send & Mark Done",
      group: "Compose",
      context: "compose",
      hidden: true,
      when: () => inCompose(),
      run: () => {
        window.dispatchEvent(
          new CustomEvent("fission:send", { detail: { markDone: true } })
        );
      },
    },
    {
      id: "compose.sendLater",
      title: "Send Later…",
      group: "Compose",
      context: "compose",
      when: () => inCompose(),
      run: () => ui().openPicker("sendLater"),
    },
    {
      id: "compose.snippet",
      title: "Insert Snippet…",
      group: "Compose",
      context: "compose",
      when: () => inCompose(),
      run: () => ui().openPicker("snippet"),
    },
    {
      id: "compose.attachDrive",
      title: "Attach from Google Drive…",
      group: "Compose",
      context: "compose",
      when: () => inCompose(),
      run: () => ui().openPicker("drivePicker"),
    },
    {
      // Throw the draft away (the 🗑 button routes here too). Distinct from Esc,
      // which KEEPS a draft with content — this always deletes and closes.
      id: "compose.discard",
      title: "Discard Draft",
      group: "Compose",
      context: "compose",
      when: () => inCompose(),
      run: () => {
        const c = ui().compose;
        if (!c) return;
        if (c.draftId != null) void backend.deleteDraft(c.draftId).catch(() => {});
        ui().closeCompose();
        ui().showToast("Draft discarded");
      },
    },
    // New-message composer only: background the draft and open the prev/next
    // email (header ↑/↓ chevrons mirror these). Bare K/J are suppressed while a
    // field has focus, so they fire only when the caret isn't in a text input.
    {
      id: "compose.prevEmail",
      title: "New Message: Previous Email",
      group: "Compose",
      context: "compose",
      hidden: true,
      when: () => ui().compose?.mode === "new",
      run: () => composeGoToEmail(-1),
    },
    {
      id: "compose.nextEmail",
      title: "New Message: Next Email",
      group: "Compose",
      context: "compose",
      hidden: true,
      when: () => ui().compose?.mode === "new",
      run: () => composeGoToEmail(1),
    },
    {
      // Accelerate a message waiting out its Undo Send window: flush it now.
      id: "send.accelerate",
      title: "Send Now (skip Undo Send)",
      group: "Compose",
      when: () => ui().pendingSend !== null,
      run: async () => {
        const ps = ui().pendingSend;
        if (!ps) return;
        try {
          await backend.sendOutboxNow(ps.outboxId);
          ui().clearPendingSend();
          ui().showToast("Sent");
        } catch (e) {
          const msg = String((e as { message?: string })?.message ?? e);
          // "already sent" = the row was gone, so it really left — safe to
          // dismiss. Any other error is a transient delivery failure: keep the
          // bar (and Z) alive, since the message is still queued at its fuse.
          if (/already sent/i.test(msg)) {
            ui().clearPendingSend();
            ui().showToast("Already sent");
          } else {
            ui().showToast("Couldn't send now — still queued");
          }
        }
      },
    },
    // Reveal + focus a reply-dock field. These fire even while typing (mod+
    // combos pass the editable guard); Tab then walks To→Cc→Bcc→Subject→body.
    {
      id: "compose.expandTo",
      title: "Reply: Edit To",
      group: "Compose",
      context: "compose",
      hidden: true,
      when: () => inCompose(),
      run: () => focusComposeField("to"),
    },
    {
      id: "compose.expandCc",
      title: "Reply: Add Cc",
      group: "Compose",
      context: "compose",
      hidden: true,
      when: () => inCompose(),
      run: () => focusComposeField("cc"),
    },
    {
      id: "compose.expandBcc",
      title: "Reply: Add Bcc",
      group: "Compose",
      context: "compose",
      hidden: true,
      when: () => inCompose(),
      run: () => focusComposeField("bcc"),
    },
    {
      id: "compose.expandSubject",
      title: "Reply: Edit Subject",
      group: "Compose",
      context: "compose",
      hidden: true,
      when: () => inCompose(),
      run: () => focusComposeField("subject"),
    },
    {
      id: "theme.toggle",
      // Superhuman-style dynamic label naming the theme it switches TO. Rebuilt
      // every allCommands() call (the palette re-reads it on open), so it always
      // reflects the live theme.
      title:
        useSettings.getState().settings.theme === "dark"
          ? "Theme: Light (Disable Dark Mode)"
          : "Theme: Dark (Disable Light Mode)",
      group: "General",
      keywords: "theme dark mode light mode appearance color scheme",
      run: () => {
        const s = useSettings.getState();
        void s.save({ theme: s.settings.theme === "dark" ? "light" : "dark" });
      },
    },
    {
      id: "calendar.toggle",
      title: "Toggle Calendar Panel",
      group: "Navigate",
      run: () => {
        const s = useSettings.getState();
        const opening = !s.settings.calendarOpen;
        void s.save({ calendarOpen: opening });
        ui().setFocusRegion(opening ? "calendar" : "mail");
      },
    },
    {
      id: "calendar.open",
      title: "Go to Calendar (week view)",
      group: "Navigate",
      when: () => !inCompose(),
      run: () => {
        mail().closeThread();
        ui().setScreen("calendar");
      },
    },
    {
      id: "calendar.prevDay",
      title: "Calendar: Previous Day",
      group: "Navigate",
      context: "calendar",
      hidden: true,
      when: () => calendarFocused(),
      run: () => useCalendar.getState().shiftDay(-1),
    },
    {
      id: "calendar.nextDay",
      title: "Calendar: Next Day",
      group: "Navigate",
      context: "calendar",
      hidden: true,
      when: () => calendarFocused(),
      run: () => useCalendar.getState().shiftDay(1),
    },
    {
      id: "calendar.today",
      title: "Calendar: Today",
      group: "Navigate",
      when: () => calendarFocused(),
      run: () => useCalendar.getState().goToday(),
    },
    {
      // B = Create Event, matching Superhuman (bare C stays Compose).
      id: "calendar.newEvent",
      title: "New Calendar Event",
      group: "Navigate",
      context: "calendar",
      when: () => !inCompose(),
      run: () => {
        const cal = useCalendar.getState();
        // honor the navigated day only while a calendar view is actually
        // showing it — from the mail list, B means "event today"
        const offset = calendarFocused() ? cal.dayOffset : 0;
        const dayStart = startOfToday() + offset * DAY_MS;
        // today → the next full hour; other days → 9 am
        const hour =
          offset === 0 ? Math.min(new Date().getHours() + 1, 19) : 9;
        const start = dayStart + hour * 3600_000;
        cal.openCreate(start, start + 3600_000);
      },
    },
    {
      id: "sidebar.toggle",
      title: "Toggle Folder Sidebar",
      group: "Navigate",
      run: () => {
        const s = useSettings.getState();
        void s.save({ sidebarOpen: !s.settings.sidebarOpen });
      },
    },
    {
      id: "shortcutBar.toggle",
      title: "Toggle Shortcut Hints",
      group: "General",
      run: () => {
        const s = useSettings.getState();
        void s.save({ showShortcutBar: !s.settings.showShortcutBar });
      },
    },
    {
      // The full Superhuman-style sheet in the right-hand dock (where the
      // calendar panel lives). Esc or × closes it.
      id: "shortcuts.show",
      title: "Keyboard Shortcuts (show all)",
      group: "General",
      run: () => ui().setShortcutsOpen(!ui().shortcutsOpen),
    },
    // Ctrl+1..9 — Superhuman-style account switching (slots are the order in
    // Settings → Account; reassign by reordering there).
    ...Array.from({ length: 9 }, (_, i) => {
      const slot = i + 1;
      const email =
        useSettings.getState().accounts.accounts[slot - 1]?.email ??
        `Account ${slot}`;
      return {
        id: `account.${slot}`,
        title: `Switch to ${email}`,
        group: "Accounts",
        when: () => useSettings.getState().accounts.accounts.length >= slot,
        run: async () => {
          const s = useSettings.getState();
          const target = s.accounts.accounts[slot - 1];
          if (!target || target.email === s.accounts.active) return;
          mail().closeThread();
          await s.switchAccount(target.email);
          await mail().refresh();
          ui().setScreen("mail");
          ui().showToast(target.email);
        },
      } satisfies Command;
    }),
    {
      id: "inbox.zeroSweep",
      title: "Get Me To Zero (bulk archive)…",
      group: "Triage",
      when: () => inList() && mail().listView === "inbox",
      run: () => ui().openPicker("zeroSweep"),
    },
    {
      id: "sync.now",
      title: "Sync Now",
      group: "General",
      run: async () => {
        await backend.syncNow();
        await mail().refresh();
        ui().showToast("Synced");
      },
    },
    {
      id: "sync.resync",
      title: "Repair Mail (resync from scratch)",
      group: "General",
      run: async () => {
        ui().showToast("Repairing mail…");
        try {
          await backend.resyncAccount();
          await mail().refresh();
          ui().showToast("Mail repaired — reopen a message to see fixed formatting");
        } catch (e) {
          ui().showToast(`Repair failed: ${String(e)}`);
        }
      },
    },
    {
      id: "settings.open",
      title: "Settings",
      group: "General",
      run: () => ui().setScreen("settings"),
    },
    {
      id: "update.check",
      title: "Check for Updates",
      group: "General",
      run: async () => {
        await useUpdater.getState().checkNow();
        ui().showToast(useUpdater.getState().status ?? "Checked for updates");
      },
    },
    {
      id: "back",
      title: "Back / Close",
      group: "General",
      hidden: true,
      run: () => {
        const u = ui();
        if (u.askAiOpen) return u.setAskAiOpen(false);
        if (u.aiBarOpen) return u.setAiBarOpen(false);
        if (u.shortcutsOpen) return u.setShortcutsOpen(false);
        if (inList() && mail().selectedIds.size > 0)
          return mail().clearSelection();
        if (u.compose) {
          // Esc keeps your work: flush a final draft save, then close. An
          // opened-then-abandoned reply (auto-filled recipients, empty body)
          // isn't worth saving — composeHasContent handles that.
          const c = u.compose;
          if (composeHasContent(c)) {
            const { draftId, ...payload } = c;
            void backend
              .saveDraft(draftId, JSON.stringify(payload))
              .then(() => u.showToast("Draft saved"))
              .catch(() => {});
          }
          return u.closeCompose();
        }
        if (mail().openThreadId) return mail().closeThread();
        if (u.screen !== "mail") return u.setScreen("mail");
      },
    },
  ];
}

/** Bindings for the keyboard engine, honoring user remaps from settings.
 *
 * installKeyboard calls this on every keydown, so it's memoized: allCommands()
 * builds ~45 command objects plus a 9-slot account block (each reading settings
 * state), which is wasteful per keystroke. The cache is invalidated only when the
 * shortcut map or account list actually changes. */
let bindingsCache: Binding[] | null = null;

useSettings.subscribe((state, prev) => {
  if (
    state.settings.shortcuts !== prev.settings.shortcuts ||
    state.accounts.accounts !== prev.accounts.accounts
  ) {
    bindingsCache = null;
  }
});

/** Run a registered command from UI chrome (bulk bar buttons, sidebar). */
export function runCommandById(id: string) {
  const c = allCommands().find((c) => c.id === id);
  if (c && (!c.when || c.when())) runCommand(c);
}

/** Run a command, surfacing any rejection as a toast instead of silence. */
export function runCommand(c: Command) {
  try {
    const r = c.run();
    if (r instanceof Promise) r.catch((e) => ui().showToast(String(e)));
  } catch (e) {
    ui().showToast(String(e));
  }
}

export function commandBindings(): Binding[] {
  if (bindingsCache) return bindingsCache;
  const shortcuts = useSettings.getState().settings.shortcuts;
  bindingsCache = allCommands()
    .map((c) => ({
      expr: shortcuts[c.id] ?? "",
      run: () => runCommand(c),
      when: c.when,
      bypassOverlays: c.id === "palette.open",
    }))
    .filter((b) => b.expr !== "");
  return bindingsCache;
}

export function shortcutHint(commandId: string): string {
  return useSettings.getState().settings.shortcuts[commandId] ?? "";
}
