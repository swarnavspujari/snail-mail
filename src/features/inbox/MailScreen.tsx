import { useEffect, useMemo, useRef, useState } from "react";
import { runCommandById } from "@/lib/commands";
import { splitCountOf, splitThreads, useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { DayPanel } from "@/features/calendar/DayPanel";
import { FolderSidebar } from "@/components/FolderSidebar";
import { useUi } from "@/stores/ui";
import { IconButton } from "@/components/Button";
import { HoverHint } from "@/components/HoverHint";
import { Kbd } from "@/components/Kbd";
import { Label } from "@/components/Label";
import {
  draftRecipientLabel,
  draftsByThread,
  type ThreadDraft,
} from "@/lib/thread-drafts";
import type { Thread } from "@/lib/types";

// Sender status dots — unread markers cycle so threads are tellable apart
// at a glance (design system "sender dots").
const DOTS = ["--dot-blue", "--dot-pink", "--dot-amber", "--dot-violet"];
function dotOf(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return `var(${DOTS[((h % 4) + 4) % 4]})`;
}

function timeLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Toggle for the day panel; the badge counts what's still ahead today. */
function SplitTabs({ overlay }: { overlay?: boolean }) {
  const inbox = useMail((s) => s.inbox);
  const activeSplitId = useMail((s) => s.activeSplitId);
  const splitCounts = useMail((s) => s.splitCounts);
  const splits = useSettings((s) => s.settings.splits);
  const activeAccount = useSettings((s) => s.accounts.active);
  const keyHints = useSettings((s) => s.settings.showKeyHints);

  // Local list while it's complete (moves with optimistic triage, so the badge
  // hits zero in the same frame the inbox empties), backend SQL once it's
  // truncated. See splitCountOf.
  const countOf = (id: string) => splitCountOf(inbox, splitCounts, id);
  const shown = splits
    .filter((sp) => sp.accountId == null || sp.accountId === activeAccount)
    .filter((sp) => !sp.hideWhenEmpty || countOf(sp.id) > 0);

  // Over the inbox-zero photo the tabs stay put but go translucent-white with
  // a soft shadow (the chrome sits ON the photo, per the inbox-zero pattern).
  const shadow = overlay ? { textShadow: "0 1px 3px rgba(0,0,0,0.4)" } : undefined;

  return (
    <div className="relative z-10 flex h-[52px] shrink-0 items-center gap-5 px-6">
      {shown.map((sp) => {
        const count = countOf(sp.id);
        const active = sp.id === activeSplitId;
        return (
          <button
            key={sp.id}
            onClick={() => useMail.getState().setActiveSplit(sp.id)}
            style={shadow}
            className={`flex items-center gap-2 py-1 text-[17px] tracking-tight transition-colors ${
              overlay
                ? active
                  ? "font-semibold text-white"
                  : "text-white/60 hover:text-white/85"
                : active
                  ? "font-semibold text-ink"
                  : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {sp.name}
            {/* total conversations, not unread — a split reads like a to-do list */}
            <span
              className={`text-[12.5px] font-medium ${
                overlay
                  ? "text-white/75"
                  : active
                    ? "text-accent-strong"
                    : "text-ink-3"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
      <div className="flex-1" />
      {keyHints && (
        <span
          style={shadow}
          className={`whitespace-nowrap text-[11px] ${overlay ? "text-white/75" : "text-ink-3"}`}
        >
          {overlay ? (
            <>Tab to switch</>
          ) : (
            <>
              <Kbd>Tab</Kbd> to switch
            </>
          )}
        </span>
      )}
    </div>
  );
}

function Row({
  t,
  index,
  selected,
  checked,
  draft,
}: {
  t: Thread;
  index: number;
  selected: boolean;
  checked: boolean;
  /** An unsent draft on this conversation, if there is one. */
  draft?: ThreadDraft;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const userLabels = t.labels.filter((l) => !/^[A-Z_]+$/.test(l));

  return (
    <div
      ref={ref}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) {
          useMail.getState().toggleSelected(t.id);
          return;
        }
        useMail.getState().select(index);
        void useMail.getState().openThread(t.id);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`flex cursor-pointer items-center gap-3 px-6 py-[11px] text-[14px] ${
        selected ? "bg-selected" : checked ? "bg-accent-dim" : "hover:bg-hover"
      }`}
    >
      {checked ? (
        <div className="flex w-[7px] shrink-0 items-center justify-center text-[11px] leading-none text-accent-strong">
          ✓
        </div>
      ) : (
        <div
          className="h-[7px] w-[7px] shrink-0 rounded-full"
          style={{
            background: t.unread ? dotOf(t.participants[0] ?? t.id) : "transparent",
          }}
        />
      )}
      <div className="w-44 shrink-0 truncate">
        {draft ? (
          // An unsent draft owns the row's sender column, Superhuman-style —
          // the useful thing about this conversation is that YOU owe it a
          // reply, not who last wrote in it.
          <>
            <span className="font-semibold text-ok">Draft</span>
            {draftRecipientLabel(draft.to) && (
              <span className="text-ink-2"> to {draftRecipientLabel(draft.to)}</span>
            )}
          </>
        ) : (
          <span
            className={
              t.unread ? "font-semibold text-ink" : selected ? "text-ink-2" : "text-ink-2"
            }
          >
            {t.participants
              .map((p) => p.replace(/\s*<[^>]*>/, ""))
              .slice(0, 2)
              .join(", ")}
          </span>
        )}
        {t.messageCount > 1 && (
          <span className="ml-1.5 text-[11px] text-ink-3">{t.messageCount}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 truncate">
        {userLabels.map((l) => (
          <Label key={l}>{l}</Label>
        ))}
        <span
          className={`shrink-0 ${t.unread ? "font-semibold text-ink" : "text-ink-2"}`}
        >
          {t.subject}
        </span>
        {/* The draft you're mid-way through is more use than the snippet of
            the message you already read. */}
        <span className="truncate text-[12.5px] text-ink-3">
          {draft?.preview || t.snippet}
        </span>
      </div>
      {hovered ? (
        <div
          className="flex shrink-0 gap-0.5"
          onClick={(e) => e.stopPropagation()}
        >
          <HoverHint label="Mark Done" command="thread.done" placement="bottom">
            <IconButton
              label="Mark Done"
              noTitle
              onClick={() => {
                useMail.getState().select(index);
                runCommandById("thread.done");
              }}
            >
              ✓
            </IconButton>
          </HoverHint>
          <HoverHint label="Remind Me" command="thread.snooze" placement="bottom">
            <IconButton
              label="Remind Me"
              noTitle
              onClick={() => {
                useMail.getState().select(index);
                runCommandById("thread.snooze");
              }}
            >
              🕑
            </IconButton>
          </HoverHint>
        </div>
      ) : (
        <>
          {t.snoozedUntil !== null && (
            <span className="shrink-0 rounded-full bg-accent-dim px-2 text-[11px] leading-[18px] text-accent-strong">
              {new Date(t.snoozedUntil).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZoneName: "short",
              })}
            </span>
          )}
          {t.starred && <span className="shrink-0 text-[12px] text-gold">★</span>}
          <span className="w-14 shrink-0 text-right text-[12px] text-ink-3">
            {timeLabel(t.lastDate)}
          </span>
        </>
      )}
    </div>
  );
}

function BulkBar({ count }: { count: number }) {
  // Keycaps are the decoration here; the button labels carry the meaning, so
  // with hints off these stay buttons that simply say what they do.
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  return (
    <div className="zb-fade-in flex items-center gap-2 border-b border-line bg-accent-dim px-4 py-1.5 text-[12.5px] text-ink">
      <span className="font-medium">{count} selected</span>
      <div className="flex-1" />
      <button
        className="rounded-md border border-line-strong px-2.5 py-0.5 hover:bg-hover"
        onClick={() => runCommandById("thread.done")}
      >
        Mark Done {keyHints && <Kbd>E</Kbd>}
      </button>
      <button
        className="rounded-md border border-line-strong px-2.5 py-0.5 hover:bg-hover"
        onClick={() => runCommandById("thread.trash")}
      >
        Trash {keyHints && <Kbd>#</Kbd>}
      </button>
      <button
        className="rounded-md border border-line-strong px-2.5 py-0.5 hover:bg-hover"
        onClick={() => runCommandById("thread.move")}
      >
        Label {keyHints && <Kbd>V</Kbd>}
      </button>
      <button
        className="rounded-md px-2 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
        onClick={() => useMail.getState().clearSelection()}
        title="Clear selection (Esc)"
      >
        ×
      </button>
    </div>
  );
}

export function MailScreen() {
  const listView = useMail((s) => s.listView);
  const inbox = useMail((s) => s.inbox);
  const done = useMail((s) => s.done);
  const reminders = useMail((s) => s.reminders);
  const starred = useMail((s) => s.starred);
  const trash = useMail((s) => s.trash);
  const labelThreads = useMail((s) => s.labelThreads);
  const activeSplitId = useMail((s) => s.activeSplitId);
  const selectedIndex = useMail((s) => s.selectedIndex);
  const selectedIds = useMail((s) => s.selectedIds);
  const splits = useSettings((s) => s.settings.splits);
  const calendarOpen = useSettings((s) => s.settings.calendarOpen);
  const sidebarOpen = useSettings((s) => s.settings.sidebarOpen);
  const drafts = useMail((s) => s.drafts);
  const draftByThread = useMemo(() => draftsByThread(drafts), [drafts]);
  const loaded = useMail((s) => s.loaded);
  const loadingOlder = useMail((s) => s.loadingOlder);
  const noMoreOlder = useMail((s) => s.noMoreOlder);
  // Done/Starred/Trash page older mail from Gmail as you scroll; inbox is
  // fully synced and label/reminder views aren't paged.
  const pagedView =
    listView === "done" || listView === "starred" || listView === "trash";

  const threads = useMemo(() => {
    if (listView === "inbox") return splitThreads(inbox, activeSplitId);
    if (listView === "done") return done;
    if (listView === "starred") return starred;
    if (listView === "trash") return trash;
    if (listView.startsWith("label:")) return labelThreads;
    return reminders;
    // splits is a dependency because splitThreads reads it via settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listView, inbox, done, reminders, starred, trash, labelThreads, activeSplitId, splits]);

  const title =
    listView === "inbox"
      ? null
      : listView === "done"
        ? "Done"
        : listView === "starred"
          ? "Starred"
          : listView === "trash"
            ? "Trash"
            : listView === "reminders"
              ? "Reminders"
              : listView.startsWith("label:")
                ? listView.slice(6)
                : listView;

  // Inbox zero: the daily photo fills the WHOLE app (rendered by App, behind
  // the translucent chrome); here the split tabs go overlay-styled and the
  // empty list container is skipped so the photo's attribution stays
  // clickable (design "Inbox Zero" pattern).
  const zero = loaded && listView === "inbox" && threads.length === 0;

  return (
    <div className="flex h-full">
      {sidebarOpen && <FolderSidebar />}
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onMouseDown={() => useUi.getState().setFocusRegion("mail")}
      >
        {listView === "inbox" ? (
          <SplitTabs overlay={zero} />
        ) : (
          <div className="flex items-center border-b border-line bg-base px-4 py-2 text-[13px] font-medium text-ink">
            {title}
            <span className="ml-2 rounded-full border border-line bg-raised px-1.5 text-[10.5px] leading-[17px] text-ink-3">
              {threads.length}
            </span>
            <div className="flex-1" />
          </div>
        )}
        {selectedIds.size > 0 && <BulkBar count={selectedIds.size} />}
        {!zero && (
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          onScroll={(e) => {
            // near the bottom of a paged view → fetch the next older page
            if (!pagedView) return;
            const el = e.currentTarget;
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 240)
              void useMail.getState().loadOlder();
          }}
        >
          {threads.map((t, i) => (
            <Row
              key={t.id}
              t={t}
              index={i}
              selected={i === selectedIndex}
              checked={selectedIds.has(t.id)}
              draft={draftByThread.get(t.id)}
            />
          ))}
          {pagedView && threads.length > 0 && (
            <div className="flex items-center justify-center gap-2 py-3 text-[11.5px] text-ink-3">
              {loadingOlder ? (
                <>
                  <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
                  Loading older mail…
                </>
              ) : noMoreOlder ? (
                "End of history."
              ) : (
                "Scroll for older mail"
              )}
            </div>
          )}
          {/* inbox zero renders as the full-app photo (in App), not in-list */}
          {loaded && threads.length === 0 && listView !== "inbox" && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-3">
              <div className="text-4xl">◎</div>
              <div className="text-[14px]">Nothing here.</div>
            </div>
          )}
        </div>
        )}
      </div>
      {calendarOpen && <DayPanel />}
    </div>
  );
}
