import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { backend, openExternal } from "@/lib/ipc";
import { startReply } from "@/lib/commands";
import { prepareEmailHtml } from "@/lib/email-render";
import { normalizeRecipients } from "@/lib/recipients";
import { nextFocusIndex } from "@/lib/thread-focus";
import {
  draftRecipientLabel,
  draftsForThread,
  type ThreadDraft,
} from "@/lib/thread-drafts";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi, type ComposeState } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";
import { ContactPanel } from "@/components/ContactPanel";
import { DayPanel } from "@/features/calendar/DayPanel";
import { HoverHint } from "@/components/HoverHint";
import { Kbd } from "@/components/Kbd";
import { Label } from "@/components/Label";
import { InviteBar } from "@/features/thread/InviteBar";
import { ReplyDock } from "@/features/compose/ReplyDock";
import type { PendingMessage } from "@/lib/pending";
import type { Attachment, Message } from "@/lib/types";

function fmtSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes > 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Split plain text into the fresh part and the quoted trail. */
function splitQuotedText(text: string): { main: string; quoted: string | null } {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    const restAllQuoted = () =>
      lines.slice(i).every((x) => x.trim() === "" || x.trim().startsWith(">"));
    if (/^On .{8,100} wrote:$/.test(l) || (l.startsWith(">") && restAllQuoted())) {
      const main = lines.slice(0, i).join("\n").trimEnd();
      if (!main) return { main: text, quoted: null };
      return { main, quoted: lines.slice(i).join("\n") };
    }
  }
  return { main: text, quoted: null };
}

const QUOTE_MARKERS = ["gmail_quote", "<blockquote"];

// Instant-reply suggestions per thread + newest message: a reopen paints them
// in the same frame and never re-runs the AI call; a thread that gained a
// message gets fresh ones. (On desktop aiSuggestReplies is a provider call.)
const suggestionsCache = new Map<string, string[]>();

// Injected into every message's shadow root. Theme tokens: CSS custom
// properties (and color-scheme) inherit THROUGH shadow boundaries, so the
// email restyles live on theme flips with no re-render. The email's own
// <style> rules are scoped to this shadow tree; app CSS can't reach in.
const EMAIL_SHADOW_CSS = `
  :host{display:block;background:var(--bg-raised,#ffffff);color:var(--text-primary,#1d222b);
        font:13.5px/1.55 "Segoe UI",system-ui,sans-serif;
        user-select:text;-webkit-user-select:text}
  /* Emails that style their own colors are authored against white; on the
     dark theme they'd go dark-on-dark, so designed mail gets a light canvas
     (Superhuman does the same). Bare mail keeps the theme canvas above. */
  :host([data-light-canvas]){background:#ffffff;color:#1d222b;color-scheme:light}
  :host([data-light-canvas]) a{color:#3b52c4}
  :host([data-light-canvas]) blockquote{border-left-color:#d5d9e2;color:#5b6272}
  #fm-pad{padding:16px 18px}
  /* Wide content (fixed-width tables, <pre>, oversized imgs) gets a
     horizontal scrollbar INSIDE the email box rather than widening the
     reading pane. #fm-root is its own scroll root, so this axis can never
     chain into the pane — no diagonal drift; y stays content-sized so the
     pane scrolls as one document. */
  #fm-root{overflow-x:auto;overflow-y:hidden;word-break:break-word}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  a{color:var(--accent-strong,#3b52c4)}
  blockquote{margin:8px 0 8px 4px;padding-left:12px;border-left:2px solid var(--border-strong,#d5d9e2);color:var(--text-secondary,#5b6272)}
  pre{overflow-x:auto;max-width:100%}
  :host(:not([data-show-quote])) .gmail_quote,
  :host(:not([data-show-quote])) #fm-root>blockquote:last-of-type,
  :host(:not([data-show-quote])) div>blockquote:last-child{display:none!important}
`;

/**
 * Sanitized HTML body rendered inline in a shadow root, so the reading pane
 * is one continuous document: selection runs subject → body, one native
 * scroll spans the pane, and heights are real at first paint (no measuring,
 * no reflow when stepping between emails). Isolation model: the shadow root
 * scopes CSS both ways, and the wrapper div's `contain: layout paint style`
 * is a layout jail the email's CSS cannot reach (selectors can't cross the
 * boundary outward and :host rules are neutered in the sanitizer), so even
 * position:fixed content paints inside the message box. With the iframe
 * sandbox gone, the Rust sanitizer (mail/render.rs) is the sole trust
 * boundary for active content. Links open in the system browser; quoted
 * trails collapse behind the same ••• toggle as plain text.
 */
function HtmlBody({
  html,
  subject,
  showQuote,
}: {
  html: string;
  subject: string | null;
  showQuote: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const prepared = useMemo(
    () => prepareEmailHtml(html, { subject }),
    [html, subject]
  );
  // "Designed" mail declares its own colors or backgrounds somewhere;
  // bare mail (plain Gmail replies) declares neither.
  const ownColors = useMemo(
    () => /color\s*[:=]|background[^;:=]*[:=]/i.test(html),
    [html]
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${EMAIL_SHADOW_CSS}</style><div id="fm-pad"><div id="fm-root">${prepared}</div></div>`;
    const open = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a) return;
      e.preventDefault(); // relative/#fragment links must never navigate the app
      const href = a.getAttribute("href");
      if (href && /^https?:|^mailto:/i.test(href)) void openExternal(href);
    };
    const aux = (e: Event) => {
      if ((e as MouseEvent).button === 1) open(e);
    };
    root.addEventListener("click", open);
    root.addEventListener("auxclick", aux);
    return () => {
      root.removeEventListener("click", open);
      root.removeEventListener("auxclick", aux);
    };
  }, [prepared]);

  return (
    <div
      style={{ contain: "layout paint style" }}
      className="rounded-b-[10px] bg-raised"
    >
      <div
        ref={hostRef}
        data-show-quote={showQuote ? "" : undefined}
        data-light-canvas={ownColors ? "" : undefined}
      />
    </div>
  );
}

function AttachmentChip({ a }: { a: Attachment }) {
  const [busy, setBusy] = useState(false);
  const act = async (mode: "open" | "save") => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "open") {
        await backend.openAttachment(a.id);
      } else {
        const path = await backend.downloadAttachment(a.id);
        if (path) useUi.getState().showToast(`Saved ${path}`);
      }
    } catch (e) {
      useUi.getState().showToast(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span
      className="flex items-center gap-1 rounded-md border border-line-strong bg-raised py-1 pl-2.5 pr-1 text-[12px] text-ink-2"
      title={`${a.mimeType} · ${fmtSize(a.sizeBytes)}`}
    >
      <button
        onClick={() => void act("open")}
        disabled={busy}
        className="hover:text-ink disabled:opacity-50"
        title="Open"
      >
        📎 {a.filename}
        <span className="ml-1.5 text-ink-3">{fmtSize(a.sizeBytes)}</span>
      </button>
      <button
        onClick={() => void act("save")}
        disabled={busy}
        className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-hover hover:text-ink disabled:opacity-50"
        title="Save as…"
      >
        ⭳
      </button>
    </span>
  );
}

function MessageCard({
  m,
  index,
  expanded,
  focused,
  first,
  last,
  healTried,
  onToggle,
}: {
  m: Message;
  index: number;
  expanded: boolean;
  focused: boolean;
  first: boolean;
  last: boolean;
  /** The open thread's blank-body heal round-trip has settled — so a message
   *  that's *still* empty is genuinely unavailable, not merely mid-load. */
  healTried: boolean;
  onToggle: () => void;
}) {
  const [showQuote, setShowQuote] = useState(false);
  const { main, quoted } = useMemo(() => splitQuotedText(m.bodyText), [m.bodyText]);
  const html = m.bodyHtml;
  const htmlHasQuote = html !== null && QUOTE_MARKERS.some((q) => html.includes(q));
  const hasQuoteToggle = html ? htmlHasQuote : quoted !== null;
  // No HTML and no text = a body that didn't come through on first sync;
  // openThread refetches it in the background (see stores/mail openThread).
  const isEmpty = !html && !m.bodyText.trim();

  if (!expanded) {
    return (
      <button
        onClick={onToggle}
        data-message-index={index}
        data-focused={focused ? "true" : undefined}
        className={`flex w-full items-center gap-3 rounded-[10px] border bg-surface px-4 py-2.5 text-left hover:bg-hover ${
          focused ? "border-accent ring-1 ring-accent" : "border-line"
        }`}
      >
        <Avatar name={m.fromName} email={m.from} size={26} />
        <span className="w-40 shrink-0 truncate text-[13px] font-medium text-ink-2">
          {m.fromName}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-3">
          {m.snippet || m.bodyText.slice(0, 120)}
        </span>
        <span className="shrink-0 text-[11.5px] text-ink-3">{fmtWhen(m.date)}</span>
      </button>
    );
  }

  return (
    <div
      data-message-index={index}
      data-focused={focused ? "true" : undefined}
      className={`overflow-hidden rounded-[10px] border bg-raised ${
        focused
          ? "border-accent ring-1 ring-accent"
          : last
            ? "border-line-strong"
            : "border-line"
      }`}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-[18px] py-3 text-left"
      >
        <Avatar name={m.fromName} email={m.from} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-ink">{m.fromName}</span>
            <span className="truncate text-[12px] text-ink-3">{m.from}</span>
          </div>
          <div className="truncate text-[12px] text-ink-3">
            to {m.to.join(", ")}
            {m.cc.length > 0 && <> · cc {m.cc.join(", ")}</>}
          </div>
        </div>
        <span className="shrink-0 text-[12px] text-ink-3">{fmtWhen(m.date)}</span>
      </button>

      {html ? (
        <HtmlBody
          html={html}
          subject={first ? m.subject : null}
          showQuote={showQuote}
        />
      ) : isEmpty ? (
        healTried ? (
          // Heal ran and the body is still empty. Usually that is the honest
          // answer: an "Accepted:"/"Declined:" invite reply carries a
          // text/calendar part and no prose at all, and the InviteBar above has
          // already shown the only content there is. The old copy blamed size,
          // which was a guess — and a wrong one for every invite reply in the
          // mailbox. Say what is true, and keep the escape hatch.
          <div className="px-[18px] py-3 text-[13px] text-ink-3">
            No message body.{" "}
            <button
              onClick={() =>
                void openExternal(
                  `https://mail.google.com/mail/u/0/#all/${m.threadId}`
                )
              }
              className="text-accent-strong hover:underline"
            >
              Open in Gmail ↗
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-[18px] py-3 text-[13px] italic text-ink-3">
            <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
            Loading message…
          </div>
        )
      ) : (
        <div className="selectable whitespace-pre-wrap px-[18px] pb-4 pt-1 text-[14px] leading-[1.65] text-ink">
          {showQuote && quoted ? `${main}\n${quoted}` : main}
        </div>
      )}

      {hasQuoteToggle && (
        <div className="px-[18px] pb-3">
          <button
            onClick={() => setShowQuote((s) => !s)}
            className="rounded-full border border-line-strong px-2 leading-4 text-ink-3 hover:bg-hover"
            title={showQuote ? "Hide quoted text" : "Show quoted text"}
          >
            •••
          </button>
        </div>
      )}

      {m.attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line px-[18px] py-3">
          {m.attachments.map((a) => (
            <AttachmentChip key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * An optimistic reply the user just sent, docked at the bottom of the thread
 * before the backend confirms it (Superhuman-style). "Sending…" during the
 * Undo Send window; a real timestamp once it leaves. Reconciled away against
 * the real message on the next fetch (see @/lib/pending), so it never lingers.
 */
function PendingCard({ p }: { p: PendingMessage }) {
  return (
    <div className="zb-fade-in overflow-hidden rounded-[10px] border border-line bg-raised">
      <div className="flex w-full items-center gap-3 px-[18px] py-3 text-left">
        <Avatar name={p.fromName} email={p.from} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-ink">{p.fromName}</span>
            <span className="truncate text-[12px] text-ink-3">{p.from}</span>
          </div>
          <div className="truncate text-[12px] text-ink-3">
            to {p.to.join(", ")}
            {p.cc.length > 0 && <> · cc {p.cc.join(", ")}</>}
          </div>
        </div>
        <span className="shrink-0 text-[12px]">
          {p.status === "sending" ? (
            <span className="flex items-center gap-1.5 text-accent-strong">
              <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
              Sending…
            </span>
          ) : (
            <span className="text-ink-3">{fmtWhen(p.sentAt ?? p.createdAt)}</span>
          )}
        </span>
      </div>
      {p.bodyHtml ? (
        <div
          className="selectable px-[18px] pb-4 pt-1 text-[14px] leading-[1.65] text-ink [&_a]:text-accent-strong [&_p]:my-1"
          dangerouslySetInnerHTML={{ __html: p.bodyHtml }}
        />
      ) : (
        <div className="selectable whitespace-pre-wrap px-[18px] pb-4 pt-1 text-[14px] leading-[1.65] text-ink">
          {p.bodyText}
        </div>
      )}
    </div>
  );
}

/**
 * An unsent draft written on this thread, docked where it was written.
 *
 * Backing out of a reply autosaves it and closes the dock — and until now that
 * was the last you saw of it anywhere except G-D. Clicking (or Enter) puts it
 * straight back in the reply dock with its row identity intact, so resuming
 * edits the same draft rather than starting a second one.
 *
 * Deliberately a card and not an auto-opened editor: opening the dock on every
 * visit to a thread with a draft would put you in compose just for reading it,
 * which turns E / R / H into typing and re-arms the autosave on mail you only
 * glanced at.
 */
function DraftCard({ d }: { d: ThreadDraft }) {
  const to = draftRecipientLabel(d.to);
  const resume = () => {
    if (!d.payload) {
      // Unreadable payload — nothing to reopen, so offer the one honest
      // action instead of a composer full of undefined.
      void backend.deleteDraft(d.id, d.account);
      void useMail.getState().loadDrafts();
      useUi.getState().showToast("Draft was unreadable — removed");
      return;
    }
    const p = d.payload as unknown as ComposeState;
    useUi.getState().startCompose({
      ...p,
      // Drafts saved before Bcc/Drive links existed lack those fields; ones
      // saved before chips hold recipients as a single string.
      to: normalizeRecipients(p.to),
      cc: normalizeRecipients(p.cc),
      bcc: normalizeRecipients(p.bcc),
      attachments: p.attachments ?? [],
      driveLinks: p.driveLinks ?? [],
      // A reply resumed from here must dock in THIS thread, whatever the row
      // says — and never as "new", which would open the modal composer.
      mode: p.mode === "new" ? "reply" : p.mode,
      threadId: d.threadId,
      draftId: d.id,
      draftAccount: d.account,
    });
  };

  return (
    <button
      onClick={resume}
      className="zb-fade-in block w-full overflow-hidden rounded-[10px] border border-line bg-raised text-left hover:border-line-strong"
      title="Resume this draft"
    >
      <div className="flex w-full items-center gap-3 px-[18px] py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-ok">Draft</span>
            {to && (
              <span className="truncate text-[13px] text-ink-2">to {to}</span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-[12px] text-ink-3">
          {fmtWhen(d.updatedAt)}
        </span>
      </div>
      {d.preview && (
        <div className="truncate px-[18px] pb-4 pt-0 text-[14px] leading-[1.65] text-ink">
          {d.preview}
        </div>
      )}
    </button>
  );
}

function InstantReplies() {
  const suggestions = useUi((s) => s.suggestions);
  const idx = useUi((s) => s.suggestionIndex);
  const keyHints = useSettings((s) => s.settings.showKeyHints);

  if (suggestions.length === 0) return null;
  return (
    <div className="border-t border-line bg-surface py-3">
      {/* Content aligns to the same centered 760px column as the email body
          above; the divider/background stay full-bleed across the pane. */}
      <div className="mx-auto w-full max-w-[760px] px-7">
        <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.06em] text-ink-3">
          <span aria-hidden className="text-accent-strong">
            ✦
          </span>
          Instant replies
          {keyHints && (
            <>
              {" — "}
              <Kbd>Tab</Kbd> preview · <Kbd>R</Kbd> use
            </>
          )}
        </div>
        <div className="flex gap-2">
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => {
                useUi.setState({ suggestionIndex: i });
              }}
              className={`max-w-[32%] truncate rounded-full border px-3.5 py-1.5 text-[12.5px] transition-colors ${
                idx === i
                  ? "border-accent bg-accent-dim text-ink"
                  : "border-line-strong bg-raised text-ink-2 hover:bg-hover"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        {idx !== null && (
          <div className="zb-fade-in mt-2 whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 text-[13px] leading-relaxed text-ink">
            {suggestions[idx]}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadView() {
  const messages = useMail((s) => s.openMessages);
  const threadId = useMail((s) => s.openThreadId);
  const pendingAll = useMail((s) => s.pendingMessages);
  const allDrafts = useMail((s) => s.drafts);
  const blankHealDone = useMail((s) => s.blankHealDone);
  const myEmail = useSettings((s) => s.accounts.active);
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  const calendarOpen = useSettings((s) => s.settings.calendarOpen);
  const compose = useUi((s) => s.compose);
  // A reply/forward for THIS thread docks its composer inline at the bottom
  // (new-message compose stays the modal); Instant Replies hide while it's open.
  const replyingHere =
    !!compose && compose.threadId === threadId && compose.mode !== "new";
  // Optimistic sent replies for this thread (Superhuman-style "Sending…" rows),
  // appended after the real messages until they reconcile away.
  const pendingHere = pendingAll.filter((p) => p.threadId === threadId);
  // Unsent drafts written on this thread. The one currently open in the dock
  // is excluded — the dock IS that draft, and showing both would read as two.
  const draftsHere = useMemo(
    () =>
      threadId
        ? draftsForThread(allDrafts, threadId).filter(
            (d) => !(compose?.draftId === d.id && compose?.draftAccount === d.account)
          )
        : [],
    [allDrafts, threadId, compose?.draftId, compose?.draftAccount]
  );
  // Superhuman-style: older messages collapse; the last (and any unread)
  // stay open. User toggles override until the thread changes.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Per-message keyboard cursor — only meaningful when messages.length > 1. The
  // ref mirrors it so the window-event handlers below always read the live index
  // without re-subscribing on every step.
  const [focused, setFocused] = useState(0);
  const focusedRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Expansion is independent of the cursor: last + unread open by default, an
  // explicit click (override) wins. Arrowing never changes this; Enter writes an
  // override to open a collapsed focused message.
  const isExpanded = (m: Message, i: number) =>
    overrides[m.id] ?? (i === messages.length - 1 || m.unread);

  // Scroll message `i` just into view within the reader (12px margin), only when
  // it's off-screen — same math as the open-scroll effect, instant for headless.
  const scrollCardIntoView = (i: number) => {
    const scroller = scrollRef.current;
    const card = listRef.current?.children[i] as HTMLElement | undefined;
    if (!scroller || !card) return;
    const top =
      card.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const bottom = top + card.offsetHeight;
    if (top < scroller.scrollTop + 12) {
      scroller.scrollTop = Math.max(0, top - 12);
    } else if (bottom > scroller.scrollTop + scroller.clientHeight - 12) {
      scroller.scrollTop = bottom - scroller.clientHeight + 12;
    }
  };

  useEffect(() => {
    setOverrides({});
  }, [threadId]);

  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);

  // Park the cursor on the newest message whenever the thread's messages settle
  // (matches where the pane opens). useLayoutEffect so it lands before paint —
  // no one-frame highlight flash on message 0.
  useLayoutEffect(() => {
    const lastIdx = Math.max(0, messages.length - 1);
    setFocused(lastIdx);
    focusedRef.current = lastIdx;
  }, [threadId, messages.length]);

  // ↓/↑ step the cursor, Enter drills in. Intents come from commands.ts
  // (thread.focusNext/Prev/Enter), which only fire for multi-message threads; we
  // re-subscribe when messages/overrides change so the handlers read fresh state.
  useEffect(() => {
    if (messages.length <= 1) return;
    const onStep = (e: Event) => {
      const dir = (e as CustomEvent<{ dir: 1 | -1 }>).detail.dir;
      const next = nextFocusIndex(focusedRef.current, dir, messages.length);
      setFocused(next);
      focusedRef.current = next;
      requestAnimationFrame(() => scrollCardIntoView(next));
    };
    const onEnter = () => {
      const i = focusedRef.current;
      const m = messages[i];
      if (!m) return;
      if (!isExpanded(m, i)) {
        // Stage 1 — open the focused message.
        setOverrides((o) => ({ ...o, [m.id]: true }));
        requestAnimationFrame(() => scrollCardIntoView(i));
      } else {
        // Stage 2 — it's open: reply-all to THIS message (its sender/recipients,
        // its quoted body), reusing any previewed instant reply as the draft.
        const u = useUi.getState();
        const preset =
          u.suggestionIndex === null ? undefined : u.suggestions[u.suggestionIndex];
        void startReply("replyAll", preset, m.id);
      }
    };
    window.addEventListener("fission:thread-step", onStep);
    window.addEventListener("fission:thread-enter", onEnter);
    return () => {
      window.removeEventListener("fission:thread-step", onStep);
      window.removeEventListener("fission:thread-enter", onEnter);
    };
  }, [messages, overrides]);

  useEffect(() => {
    // Bodies lay out at their real height before paint now (shadow DOM, no
    // iframe measurement lag), so position the pane deterministically: a
    // single message opens at the subject; a conversation jumps to the top
    // of the latest message (older ones sit collapsed above).
    const scroller = scrollRef.current;
    const last = listRef.current?.lastElementChild as HTMLElement | null;
    if (!scroller || !last) return;
    if (messages.length === 1) {
      scroller.scrollTop = 0;
      return;
    }
    const top =
      last.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTop = Math.max(0, top - 12);
  }, [threadId, messages.length]);

  // A just-sent optimistic reply appears at the bottom — scroll it into view
  // (the dock that was here is gone, so nothing else moves the pane down).
  useEffect(() => {
    if (pendingHere.length === 0) return;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [pendingHere.length]);

  // Fetch instant-reply suggestions for the open thread — cache-first. The
  // fetch waits for the messages to settle (keying on the newest message id),
  // so a cached reopen shows suggestions instantly with no AI round-trip.
  const lastMsgId = messages[messages.length - 1]?.id ?? null;
  useEffect(() => {
    if (!threadId || !lastMsgId) {
      useUi.getState().setSuggestions([]);
      return;
    }
    const key = `${threadId}#${lastMsgId}`;
    const cached = suggestionsCache.get(key);
    useUi.getState().setSuggestions(cached ?? []);
    if (cached) return;
    let stale = false;
    backend
      .aiSuggestReplies(threadId)
      .then((s) => {
        suggestionsCache.set(key, s.slice(0, 3));
        if (!stale) useUi.getState().setSuggestions(s.slice(0, 3));
      })
      .catch(() => {
        /* no provider key yet — instant replies simply don't appear */
      });
    return () => {
      stale = true;
    };
  }, [threadId, lastMsgId]);

  const thread = useMail((s) =>
    [...s.inbox, ...s.done, ...s.reminders, ...s.starred, ...s.trash].find(
      (t) => t.id === threadId
    )
  );

  if (messages.length === 0 || !threadId) return null;
  const subject = messages[0].subject;
  // The person you're talking to: latest sender that isn't you.
  const me = (myEmail ?? "").toLowerCase();
  const contact =
    [...messages].reverse().find((m) => m.from.toLowerCase() !== me) ??
    messages[0];
  const userLabels = (thread?.labels ?? []).filter((l) => !/^[A-Z_]+$/.test(l));

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 px-7 py-2.5">
          <HoverHint label="Back" command="back" placement="bottom">
            <button
              className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-hover"
              onClick={() => useMail.getState().closeThread()}
              aria-label="Back"
            >
              ←
            </button>
          </HoverHint>
          <div className="flex-1" />
          {keyHints && (
            <span className="text-[11px] text-ink-3">
              <Kbd>E</Kbd> done · <Kbd>R</Kbd> reply · <Kbd>H</Kbd> snooze
            </span>
          )}
        </div>
        <div
          ref={scrollRef}
          data-thread-scroll
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-[760px] px-7 pb-5">
            <div className="pb-4 pt-1">
              {userLabels.length > 0 && (
                <div className="mb-2 flex items-center gap-2">
                  {userLabels.map((l) => (
                    <Label key={l}>{l}</Label>
                  ))}
                </div>
              )}
              <h1 className="selectable text-[22px] font-semibold leading-snug tracking-tight text-ink">
                {subject}
              </h1>
              <div className="selectable mt-1 text-[12px] text-ink-3">
                {messages.length + pendingHere.length} message
                {messages.length + pendingHere.length > 1 ? "s" : ""}
              </div>
            </div>
            <InviteBar threadId={threadId} />
            <div ref={listRef} className="space-y-2">
              {messages.map((m, i) => (
                <MessageCard
                  key={m.id}
                  m={m}
                  index={i}
                  expanded={isExpanded(m, i)}
                  focused={messages.length > 1 && i === focused}
                  first={i === 0}
                  last={i === messages.length - 1}
                  healTried={blankHealDone}
                  onToggle={() => {
                    setFocused(i);
                    focusedRef.current = i;
                    setOverrides((o) => ({ ...o, [m.id]: !isExpanded(m, i) }));
                  }}
                />
              ))}
              {pendingHere.map((p) => (
                <PendingCard key={p.localId} p={p} />
              ))}
              {draftsHere.map((d) => (
                <DraftCard key={`${d.account}:${d.id}`} d={d} />
              ))}
            </div>
            {/* Threaded inline in the conversation column at the email's width. */}
            {replyingHere && <ReplyDock />}
          </div>
        </div>
        {!replyingHere && <InstantReplies />}
      </div>
      {/* `0` toggles the day calendar here too. It takes the sidebar slot
          rather than adding a third column: at thread width there is only room
          for one right-hand panel, and the contact card is the thing you are
          willing to trade away when you asked to see your day. Toggling back
          restores it. */}
      {calendarOpen ? (
        <DayPanel />
      ) : (
        <ContactPanel
          name={contact.fromName}
          email={contact.from}
          currentThreadId={threadId}
        />
      )}
    </div>
  );
}
