// Settings, one shell over three scopes.
//
// Seven flat tabs (Account, AI Providers, Knowledge Base, Splits, Shortcuts,
// Inbox Zero, Appearance) became three groups, split by SCOPE rather than by
// subject: things that belong to an address, things that belong to the app, and
// things that belong to this machine. "Appearance" was the junk drawer — theme,
// undo-send, Drive uploads, an Unsplash key and the updater all lived there; each
// went to the pane that actually owns it.
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/Pill";
import { Button } from "@/components/Button";
import { KeyHint } from "@/components/KeyHint";
import { grantHealthy } from "@/lib/grant-health";
import { PANE_SUBTITLES, PANE_TITLES, type PaneId } from "@/lib/settings-catalog";
import { useProfiles, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useUpdater } from "@/lib/updater";
import { SettingsSearch } from "./SettingsSearch";
import { ShortcutsEditor } from "./ShortcutsEditor";
import { SearchGlyph } from "./ShortcutsEditor";
import { useReceipt } from "./receipt";
import { AboutPane } from "./panes/AboutPane";
import { accountDisplayName, AccountPane, AddAccountPane } from "./panes/AccountPane";
import { AiPane } from "./panes/AiPane";
import { GeneralPane } from "./panes/GeneralPane";
import { MailPane } from "./panes/MailPane";
import { PrivacyPane } from "./panes/PrivacyPane";
import { ZeroPane } from "./panes/ZeroPane";

const APP_PANES: PaneId[] = ["general", "mail", "ai", "keyboard", "zero"];
const SYSTEM_PANES: PaneId[] = ["privacy", "about"];

/** The seven old tab ids still arrive from deep links (the Drive picker sends
 *  "account"); resolve them onto the pane that inherited their content. */
function resolvePane(tab: string, activeEmail: string): string {
  if (tab.startsWith("account")) {
    return tab === "account" ? `account:${activeEmail}` : tab;
  }
  const legacy: Record<string, string> = {
    ai: "ai",
    knowledge: "ai",
    splits: "mail",
    shortcuts: "keyboard",
    celebration: "zero",
    appearance: "general",
  };
  return legacy[tab] ?? tab;
}

export function SettingsScreen() {
  const tab = useUi((s) => s.settingsTab);
  const accounts = useSettings((s) => s.accounts);
  const capabilities = useSettings((s) => s.capabilities);
  const profiles = useProfiles((s) => s.profiles);
  const updateReady = useUpdater((s) => s.ready);
  const [searchOpen, setSearchOpen] = useState(false);

  const pane = resolvePane(tab, accounts.active);
  const go = (next: string) => useUi.getState().setSettingsTab(next);

  useEffect(() => {
    void Promise.all(
      accounts.accounts.map((a) => useProfiles.getState().loadFor(a.email))
    );
  }, [accounts.accounts]);

  // Ctrl+F opens search, Ctrl+Z undoes the last change. Capture phase, so the
  // app-wide keyboard engine never sees them while settings is on screen (its
  // "undo" command is also bound to Ctrl+Z, for triage).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "z" &&
        !editing &&
        useReceipt.getState().undo
      ) {
        e.preventDefault();
        e.stopPropagation();
        useReceipt.getState().runUndo();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // A pane change is a new context — the previous receipt no longer applies.
  useEffect(() => {
    useReceipt.getState().clear();
  }, [pane]);

  const header = useMemo(() => {
    if (pane === "account:add") {
      return {
        title: "Add account",
        sub: "Connect another address. Every account keeps its own signature, splits and slot.",
      };
    }
    if (pane.startsWith("account:")) {
      const email = pane.slice("account:".length);
      const caps = capabilities[email];
      const provider =
        accounts.accounts.find((a) => a.email === email)?.provider ?? "gmail";
      return {
        title: accountDisplayName(profiles, email) ?? email,
        sub: grantHealthy(caps, provider)
          ? "Everything that belongs to this address: its signature, what Google lets it do, and what it keeps on this machine."
          : "This address is connected, but its Google grant predates two features. Reconnecting takes one trip through the consent screen.",
      };
    }
    const id = pane as PaneId;
    return { title: PANE_TITLES[id] ?? "Settings", sub: PANE_SUBTITLES[id] ?? "" };
  }, [pane, capabilities, accounts.accounts, profiles]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        {/* ---------------------------------------------------------- nav */}
        <nav
          aria-label="Settings sections"
          className="flex w-[252px] shrink-0 flex-col border-r border-line bg-surface"
        >
          <div className="px-2.5 pb-1 pt-2.5">
            <button
              onClick={() => setSearchOpen(true)}
              className="flex h-[30px] w-full items-center gap-2 rounded-md border border-line-strong bg-raised px-2 text-left hover:border-accent"
            >
              <SearchGlyph />
              <span className="flex-1 text-[12.5px] text-ink-3">
                Search every setting
              </span>
              <KeyHint expr="mod+f" size="sm" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
            <NavGroup label="Accounts">
              {accounts.accounts.map((a, i) => (
                <NavItem
                  key={a.email}
                  on={pane === `account:${a.email}`}
                  onClick={() => go(`account:${a.email}`)}
                  label={a.email}
                  dot={grantHealthy(capabilities[a.email], a.provider) ? "ok" : "warn"}
                  slot={i < 9 ? `alt+${i + 1}` : undefined}
                />
              ))}
              <NavItem
                on={pane === "account:add"}
                onClick={() => go("account:add")}
                label="Add account"
                add
              />
            </NavGroup>

            <NavGroup label="App">
              {APP_PANES.map((id) => (
                <NavItem
                  key={id}
                  on={pane === id}
                  onClick={() => go(id)}
                  label={PANE_TITLES[id]}
                />
              ))}
            </NavGroup>

            <NavGroup label="System">
              {SYSTEM_PANES.map((id) => (
                <NavItem
                  key={id}
                  on={pane === id}
                  onClick={() => go(id)}
                  label={PANE_TITLES[id]}
                  badge={id === "about" && updateReady ? "1" : undefined}
                />
              ))}
            </NavGroup>
          </div>

          <div className="flex items-center gap-2 border-t border-line px-3.5 py-2 text-[11.5px] text-ink-3">
            <KeyHint expr="escape" size="sm" />
            <span>back to inbox</span>
          </div>
        </nav>

        {/* --------------------------------------------------------- pane */}
        <main className="flex min-w-0 flex-1 flex-col bg-base">
          <header className="flex items-start gap-4 px-7 pb-3.5 pt-[22px]">
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">
                {header.title}
              </h1>
              {header.sub && (
                <p className="mt-1 max-w-[64ch] text-[12.5px] leading-relaxed text-ink-3">
                  {header.sub}
                </p>
              )}
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-7 pt-1.5">
            <div className="flex max-w-[760px] flex-col gap-[22px]">
              {pane === "general" && <GeneralPane />}
              {pane === "mail" && <MailPane />}
              {pane === "ai" && <AiPane />}
              {pane === "keyboard" && <ShortcutsEditor />}
              {pane === "zero" && <ZeroPane />}
              {pane === "privacy" && <PrivacyPane />}
              {pane === "about" && <AboutPane />}
              {pane === "account:add" && <AddAccountPane />}
              {pane.startsWith("account:") && pane !== "account:add" && (
                <AccountPane
                  key={pane}
                  email={pane.slice("account:".length)}
                />
              )}
            </div>
          </div>
        </main>
      </div>

      <Footer keyboard={pane === "keyboard"} />

      {searchOpen && (
        <SettingsSearch onClose={() => setSearchOpen(false)} onJump={go} />
      )}
    </div>
  );
}

/** The receipt strip: what changed, one undo, and this pane's key hints. It is
 *  the only save confirmation in settings — nothing here needs a Save button. */
function Footer({ keyboard }: { keyboard: boolean }) {
  const label = useReceipt((s) => s.label);
  const undo = useReceipt((s) => s.undo);
  return (
    <div className="flex h-[30px] shrink-0 items-center gap-3.5 border-t border-line bg-surface px-4 text-[11.5px] text-ink-3">
      <span className="inline-flex items-center gap-1.5 text-ink-2">
        <span className={label ? "text-ok" : "text-ink-3"}>✓</span>
        <span>{label ? `${label} · saved` : "All changes saved"}</span>
      </span>
      {undo && (
        <Button variant="quiet" size="sm" onClick={() => useReceipt.getState().runUndo()}>
          Undo
        </Button>
      )}
      <div className="flex-1" />
      {(keyboard
        ? [
            { expr: "enter", label: "remap" },
            { expr: "backspace", label: "clear" },
            { expr: "mod+f", label: "search" },
            { expr: "mod+z", label: "undo" },
          ]
        : [
            { expr: "mod+f", label: "search" },
            { expr: "mod+z", label: "undo" },
            { expr: "escape", label: "inbox" },
          ]
      ).map((h) => (
        <span key={h.expr} className="inline-flex items-center gap-1.5">
          <KeyHint expr={h.expr} size="sm" />
          <span>{h.label}</span>
        </span>
      ))}
    </div>
  );
}

function NavGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
        {label}
      </div>
      {children}
    </>
  );
}

function NavItem({
  label,
  on,
  onClick,
  dot,
  slot,
  add,
  badge,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  dot?: "ok" | "warn";
  slot?: string;
  add?: boolean;
  badge?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative my-px flex h-[30px] w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors ${
        on
          ? "bg-selected font-medium text-ink"
          : "text-ink-2 hover:bg-hover"
      }`}
    >
      <span
        className={`absolute inset-y-1.5 left-0 w-0.5 rounded-sm ${
          on ? "bg-accent" : "bg-transparent"
        }`}
      />
      {dot && (
        <span
          className={`h-[7px] w-[7px] shrink-0 rounded-full ${
            dot === "ok" ? "bg-ok" : "bg-warn"
          }`}
        />
      )}
      {add && <span className="w-2 text-center text-[13px] text-ink-3">+</span>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {slot && <KeyHint expr={slot} size="sm" />}
      {badge && <Badge tone="solid">{badge}</Badge>}
    </button>
  );
}
