import { useEffect, useState } from "react";
import { backend, type MailView } from "@/lib/ipc";
import { shortcutHint } from "@/lib/commands";
import { formatKeyExpr } from "@/lib/keyboard";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";

interface Folder {
  id: MailView | "drafts";
  name: string;
  sub?: string;
  /** Command id whose shortcut jumps here — shown as a light hint. */
  shortcut?: string;
}

const FOLDERS: Folder[] = [
  { id: "inbox", name: "Inbox", sub: "Important · Other", shortcut: "goto.inbox" },
  { id: "starred", name: "Starred", shortcut: "goto.starred" },
  { id: "drafts", name: "Drafts", shortcut: "goto.drafts" },
  { id: "done", name: "Done", shortcut: "goto.done" },
  { id: "reminders", name: "Reminders", shortcut: "goto.reminders" },
  { id: "trash", name: "Trash", shortcut: "goto.trash" },
];

/** True for Gmail system labels (IMPORTANT, CATEGORY_…) vs user labels. */
function isSystemLabel(l: string): boolean {
  return /^[A-Z_]+$/.test(l);
}

function Item({
  name,
  sub,
  badge,
  hint,
  active,
  onClick,
}: {
  name: string;
  sub?: string;
  /** A count shown as a small red notification square by the name (hidden at 0). */
  badge?: number;
  hint?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative flex w-full items-center gap-2 rounded-md px-2.5 py-[7px] text-left ${
        active ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      {active && (
        <span className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r bg-accent" />
      )}
      <span
        className={`text-[13.5px] ${
          active ? "font-medium text-ink" : "text-ink-2"
        }`}
      >
        {name}
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="inline-flex min-w-[18px] items-center justify-center rounded-[5px] bg-bad px-1 text-[10.5px] font-semibold leading-[16px] tabular-nums text-white">
          {badge}
        </span>
      )}
      {sub && <span className="truncate text-[12px] text-ink-3">{sub}</span>}
      <span className="flex-1" />
      {hint && (
        <span className="font-mono text-[10.5px] uppercase tracking-wide text-ink-3/70">
          {hint}
        </span>
      )}
    </button>
  );
}

// The sidebar remounts on every thread open/close and screen switch; keep the
// last label list module-side so it paints instantly (the fetch revalidates).
let labelsCache: string[] | null = null;

/** Left-hand mailbox navigator: fixed folders + the account's labels. */
export function FolderSidebar() {
  const listView = useMail((s) => s.listView);
  const inboxCount = useMail((s) => s.inbox.length);
  const active = useSettings((s) => s.accounts.active);
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  const [labels, setLabels] = useState<string[]>(() => labelsCache ?? []);

  useEffect(() => {
    void backend.listLabels().then((all) => {
      const user = all.filter((l) => !isSystemLabel(l));
      labelsCache = user;
      setLabels(user);
    });
  }, []);

  const goTo = (view: MailView) => {
    const mail = useMail.getState();
    mail.closeThread();
    mail.setListView(view);
    if (view === "inbox") mail.setActiveSplit("important");
    useUi.getState().setScreen("mail");
  };

  return (
    <nav className="flex w-[244px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-surface px-2 py-3">
      <div className="flex items-center gap-2.5 px-2 pb-3">
        <Avatar name={active} email={active} size={26} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
          {active}
        </span>
      </div>
      {FOLDERS.map((f) => {
        // compact chord hint: "g i" → "G+I" (not "G then I")
        const hint =
          keyHints && f.shortcut
            ? formatKeyExpr(shortcutHint(f.shortcut)).replace(/ then /gi, "+") ||
              undefined
            : undefined;
        return f.id === "drafts" ? (
          <Item
            key={f.id}
            name={f.name}
            hint={hint}
            active={false}
            onClick={() => useUi.getState().openPicker("drafts")}
          />
        ) : (
          <Item
            key={f.id}
            name={f.name}
            sub={f.sub}
            badge={f.id === "inbox" ? inboxCount : undefined}
            hint={hint}
            active={listView === f.id}
            onClick={() => goTo(f.id as MailView)}
          />
        );
      })}
      {labels.length > 0 && (
        <>
          <div className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-ink-3">
            Labels
          </div>
          {labels.map((l) => (
            <Item
              key={l}
              name={l}
              active={listView === `label:${l}`}
              onClick={() => goTo(`label:${l}`)}
            />
          ))}
        </>
      )}
    </nav>
  );
}
