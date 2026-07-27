import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { backend, isTauri } from "@/lib/ipc";
import { commandBindings, runCommandById } from "@/lib/commands";
import { installKeyboard } from "@/lib/keyboard";
import { startUpdateChecks, updatePromptSuppressed, useUpdater } from "@/lib/updater";
import { needsConnect } from "@/lib/zero-state";
import { clearMailCaches, splitThreads, useMail } from "@/stores/mail";
import { useProfiles, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";
import { IconButton } from "@/components/Button";
import { HoverHint } from "@/components/HoverHint";
import { Kbd } from "@/components/Kbd";
import { NavRail } from "@/components/NavRail";
import { RestState } from "@/components/RestState";
import { UndoToast } from "@/components/UndoToast";
import { UndoSendBar } from "@/components/UndoSendBar";
import { SyncActivityPill } from "@/components/SyncActivityPill";
import { MailScreen } from "@/features/inbox/MailScreen";
import { CalendarPanel } from "@/features/calendar/CalendarPanel";
import { CalendarWeek } from "@/features/calendar/CalendarWeek";
import { EventModal } from "@/features/calendar/EventModal";
import { EventPopover } from "@/features/calendar/EventPopover";
import { useCalendar } from "@/stores/calendar";
import { ThreadView } from "@/features/thread/ThreadView";
import { Compose } from "@/features/compose/Compose";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { SnoozePicker } from "@/features/pickers/SnoozePicker";
import { MovePicker } from "@/features/pickers/MovePicker";
import { ZeroSweep } from "@/features/pickers/ZeroSweep";
import { SendLaterPicker } from "@/features/pickers/SendLaterPicker";
import { SnippetPicker } from "@/features/pickers/SnippetPicker";
import { DraftsPicker } from "@/features/pickers/DraftsPicker";
import { DrivePicker } from "@/features/pickers/DrivePicker";
import { SearchScreen } from "@/features/search/SearchScreen";
import { SettingsScreen } from "@/features/settings/SettingsScreen";
import { ShortcutsPanel } from "@/features/shortcuts/ShortcutsPanel";
import { AskAi } from "@/features/thread/AskAi";
import { Onboarding } from "@/features/onboarding/Onboarding";

// Translucent chrome over the inbox-zero photo (design "Inbox Zero" pattern):
// re-pointing the tokens at white-alpha values lets the existing Tailwind
// classes on the header / nav rail / footer render frosted-on-photo without
// any new variants. Spread onto the chrome element's style while zero.
const ZERO_CHROME = {
  textShadow: "0 1px 2px rgba(0,0,0,0.35)",
  "--bg-base": "transparent",
  "--bg-surface": "rgba(255,255,255,0.10)",
  "--bg-raised": "rgba(255,255,255,0.16)",
  "--bg-hover": "rgba(255,255,255,0.14)",
  "--text-primary": "#fff",
  "--text-secondary": "rgba(255,255,255,0.88)",
  "--text-muted": "rgba(255,255,255,0.65)",
  "--border": "rgba(255,255,255,0.20)",
  "--border-strong": "rgba(255,255,255,0.30)",
  "--accent-dim": "rgba(255,255,255,0.16)",
  "--accent-strong": "#fff",
} as CSSProperties;

function ActiveAvatar({ email }: { email: string }) {
  const profile = useProfiles((s) => s.profiles[email]);
  useEffect(() => {
    if (email) void useProfiles.getState().loadFor(email);
  }, [email]);
  if (!email) return null;
  return (
    <Avatar
      name={profile?.name ?? email}
      email={email}
      src={profile?.picture}
      size={22}
    />
  );
}

export default function App() {
  const screen = useUi((s) => s.screen);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const picker = useUi((s) => s.picker);
  const compose = useUi((s) => s.compose);
  const askAiOpen = useUi((s) => s.askAiOpen);
  const shortcutsOpen = useUi((s) => s.shortcutsOpen);
  const toast = useUi((s) => s.toast);
  const pendingSend = useUi((s) => s.pendingSend);
  const syncProgress = useUi((s) => s.syncProgress);
  const migration = useUi((s) => s.migration);
  const openThreadId = useMail((s) => s.openThreadId);
  const listView = useMail((s) => s.listView);
  const activeSplitId = useMail((s) => s.activeSplitId);
  const inboxThreads = useMail((s) => s.inbox);
  const mailLoaded = useMail((s) => s.loaded);
  // Splits config feeds splitThreads via settings — subscribe so a split edit
  // recomputes the zero state.
  const splitsConfig = useSettings((s) => s.settings.splits);
  const eventModal = useCalendar((s) => s.modal);
  const eventPopover = useCalendar((s) => s.popover);
  const updateReady = useUpdater((s) => s.ready);
  const updateDownloading = useUpdater((s) => s.downloading);
  const updateError = useUpdater((s) => s.error);
  // Nothing nags while the first full-history crawl is still running — the one
  // moment a restart costs the most. Settings → About still says so.
  const updateSuppressed = useUi((s) => updatePromptSuppressed(s.syncProgress));
  const loaded = useSettings((s) => s.loaded);
  const onboarded = useSettings((s) => s.settings.onboarded);
  const accounts = useSettings((s) => s.accounts);
  const showShortcutBar = useSettings((s) => s.settings.showShortcutBar);

  // Show the download strip only while history is actively downloading (total
  // known, crawl not done). The ceiling is a real 100 now: the numerator counts
  // only non-hidden threads and the denominator subtracts spam/trash/drafts, so
  // both describe the crawl's population and the bar can actually reach the top.
  // It used to be clamped to 99 to hide the mismatched-population asymptote.
  const downloading =
    !!syncProgress && !syncProgress.done && syncProgress.total > 0;
  const downloadPct = downloading
    ? Math.min(100, Math.max(1, Math.round((syncProgress.indexed / syncProgress.total) * 100)))
    : 0;
  // One-time storage split after the per-account-files update: same strip
  // treatment, cleared by the final `table === "done"` payload.
  const migrating = !!migration && migration.total > 0;
  const migrationPct = migrating
    ? Math.min(99, Math.max(1, Math.round((migration.copied / migration.total) * 100)))
    : 0;

  // Dead grants: gmail accounts whose refresh token no longer works. The
  // banner + amber dot stay until a reconnect fixes it.
  const deadAccounts = accounts.accounts.filter(
    (a) => a.provider === "gmail" && !a.connected && !a.removing
  );
  const activeConnected =
    accounts.accounts.find((a) => a.email === accounts.active)?.connected ?? true;
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  // email -> "is a refresh token still stored". Undefined until asked, and the
  // banner falls back to the "revoked" wording then, because that is the safe
  // reading: claiming a credential is MISSING when it is merely refused would
  // send someone deleting and re-pasting things that were fine.
  const [grants, setGrants] = useState<Record<string, boolean>>({});
  // Ask once per dead account (and again after a reconnect attempt changes the
  // set) rather than on every render.
  const deadKey = deadAccounts.map((a) => a.email).join(",");
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      deadAccounts.map(async (a) => [a.email, await backend.hasStoredGrant(a.email)] as const)
    )
      .then((pairs) => {
        if (!cancelled) setGrants(Object.fromEntries(pairs));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadKey]);

  const reconnectDead = async () => {
    setReconnecting(true);
    setReconnectError(null);
    try {
      // in-place re-consent: token + scopes refresh, the mailbox is untouched
      await backend.startOauth("", "");
      await useSettings.getState().refreshAccounts();
      await backend.syncNow();
      await useMail.getState().refresh();
    } catch (e) {
      // Persist it in the strip below rather than only toasting: this is the
      // message that explains why every mailbox is frozen.
      setReconnectError(String(e).replace(/^Error:\s*/, ""));
      await useSettings.getState().refreshAccounts();
    } finally {
      setReconnecting(false);
    }
  };

  // Inbox zero (design "Inbox Zero" pattern): the active split is empty, so
  // the daily photo fills the WHOLE app and the chrome goes translucent above
  // it. splitsConfig is a dependency because splitThreads reads it internally.
  void splitsConfig;
  const zero =
    screen === "mail" &&
    !openThreadId &&
    listView === "inbox" &&
    mailLoaded &&
    splitThreads(inboxThreads, activeSplitId).length === 0;
  // Settings carries its own footer strip (the receipt + that pane's keys), so
  // the triage hint bar stands down there — "Hit E Mark Done" is a lie on the
  // settings screen. The sync/migration strips are global and stay.
  const hintsVisible = showShortcutBar && screen !== "settings";
  const footerVisible = hintsVisible || downloading || migrating;

  // The attribute must flip BEFORE React re-renders: QuoteFrame (compose)
  // bakes the current token values into its iframe srcDoc during render, and
  // a zustand subscription fires synchronously on save while effects run
  // after. (The reading pane needs no re-render at all — its shadow DOM
  // inherits the custom properties live.)
  useEffect(() => {
    document.documentElement.dataset.theme =
      useSettings.getState().settings.theme;
    return useSettings.subscribe((s, prev) => {
      if (s.settings.theme !== prev.settings.theme)
        document.documentElement.dataset.theme = s.settings.theme;
    });
  }, []);

  useEffect(() => {
    // Settings and mail load concurrently: the mail lists don't depend on
    // settings, and chaining them cost a full IPC round-trip before any row.
    void useSettings.getState().load();
    void useMail.getState().refresh();
    startUpdateChecks();

    // Reconciliation is debounced: sync / outbox / the 30s loop emit
    // mail:updated at arbitrary times, and a synchronous 4-IPC refresh
    // mid-keystroke was a source of the input lag.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const debouncedRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void useMail.getState().refresh();
        // Keep the OPEN thread fresh too: a queued reply that just flushed (or
        // new inbound) lands here, so an optimistic "Sending…" row reconciles
        // against the real message with no duplicate and no manual reopen.
        if (useMail.getState().openThreadId)
          void useMail.getState().refreshOpenThread();
      }, 400);
    };
    const unMail = backend.onMailUpdated(debouncedRefresh);
    // background history download → the "Downloading mail history… N%" strip
    const unSync = backend.onSyncProgress((p) =>
      useUi.getState().setSyncProgress(p)
    );
    // one-time per-account storage split → "Optimizing mail storage… N%"
    const unMigration = backend.onMigrationProgress((p) =>
      useUi.getState().setMigration(p)
    );
    // inline images for the open thread resolved in the background — re-read it
    const unImages = backend.onThreadImages((id) => {
      if (useMail.getState().openThreadId === id)
        void useMail.getState().refreshOpenThread();
    });
    // a deferred triage sync to Gmail failed — surface it (not silent)
    const unTriage = backend.onTriageError((msg) =>
      useUi.getState().showToast(msg)
    );
    // general core notices (e.g. a partial OAuth grant at connect time)
    const unNotice = backend.onNotice((msg) => useUi.getState().showToast(msg));
    // a background calendar refresh landed — repaint from cache / show why not
    const unCalendar = backend.onCalendarUpdated((err) =>
      useCalendar.getState().handleUpdated(err)
    );
    // returning to the app → an incremental calendar pull (throttled in core)
    // for every range a mounted view is showing, not just one of them
    const onFocus = () => {
      const cal = useCalendar.getState();
      for (const key of Object.keys(cal.watchers)) cal.requestRefresh(key);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      unMail();
      unSync();
      unMigration();
      unImages();
      unTriage();
      unNotice();
      unCalendar();
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    return installKeyboard({
      getBindings: commandBindings,
      isOverlayOpen: () => {
        const u = useUi.getState();
        const cal = useCalendar.getState();
        return (
          u.paletteOpen ||
          u.picker !== "none" ||
          u.drivePrompt !== null ||
          u.sharePrompt !== null ||
          cal.modal !== null ||
          cal.popover !== null
        );
      },
    });
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-ink-3">
        Loading Snail Mail…
      </div>
    );
  }

  // Desktop with nothing connected lands here too, not just first-run: the
  // backend no longer invents a demo pair to stand in for "no accounts", and
  // `onboarded` is persisted, so a user who disconnects their last account
  // would otherwise fall through to an empty inbox.
  if (!onboarded || needsConnect(isTauri, accounts.accounts)) {
    return (
      <div className="relative h-full bg-base">
        <Onboarding />
      </div>
    );
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-base">
      {/* Inbox zero: the daily photo fills the whole app, chrome floats
          translucently above it (top scrim keeps the header legible). */}
      {zero && (
        <>
          <div className="absolute inset-0">
            <RestState labelOffset={footerVisible ? 44 : 14} />
          </div>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[150px]"
            style={{
              background:
                "linear-gradient(to bottom, rgba(10,16,28,0.62), rgba(10,16,28,0.34) 55%, transparent)",
            }}
          />
        </>
      )}
      <NavRail
        view={screen === "calendar" ? "calendar" : "mail"}
        overlay={zero}
        onMail={() => {
          useMail.getState().closeThread();
          useUi.getState().setScreen("mail");
        }}
        onCalendar={() => runCommandById("calendar.open")}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
      <header
        className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-base px-3.5"
        style={
          zero
            ? ({ ...ZERO_CHROME, "--border": "transparent" } as CSSProperties)
            : undefined
        }
      >
        <button
          className="rounded px-1.5 py-0.5 text-[15px] text-ink-3 hover:bg-hover hover:text-ink"
          onClick={() => {
            const s = useSettings.getState();
            void s.save({ sidebarOpen: !s.settings.sidebarOpen });
          }}
          title="Toggle folder sidebar"
        >
          ☰
        </button>
        <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight text-ink">
          Snail Mail
        </span>
        <div className="flex items-center gap-2 rounded-full border border-line bg-surface py-1 pl-1.5 pr-2 hover:border-line-strong">
          <ActiveAvatar email={accounts.active} />
          <span
            className={`h-1.5 w-1.5 rounded-full ${activeConnected ? "bg-ok" : "bg-warn"}`}
            title={
              activeConnected
                ? "connected"
                : "sign-in expired — reconnect in Settings → Account"
            }
          />
          {accounts.accounts.length > 1 ? (
            <select
              value={accounts.active}
              onChange={(e) => {
                void useSettings
                  .getState()
                  .switchAccount(e.target.value)
                  .then(() => {
                    clearMailCaches();
                    return useMail.getState().refresh();
                  });
              }}
              title="Switch account (Alt+1…9)"
              className="max-w-56 cursor-pointer appearance-none truncate bg-transparent pr-1 text-[12px] text-ink-2 outline-none"
            >
              {accounts.accounts
                .filter((a) => !a.removing)
                .map((a, i) => (
                  <option key={a.email} value={a.email}>
                    {i + 1} · {a.email}
                  </option>
                ))}
            </select>
          ) : (
            <span className="pr-1 text-[12px] text-ink-2">{accounts.active}</span>
          )}
        </div>
        {!isTauri && (
          <span className="rounded bg-accent-dim px-2 py-0.5 text-[11px] text-accent-strong">
            demo mode (browser)
          </span>
        )}
        <div className="flex-1" />
        {updateReady && !updateSuppressed ? (
          <button
            className="zb-pop-in rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent hover:opacity-90"
            onClick={() => void useUpdater.getState().installNow()}
            title={`v${updateReady} downloaded — install now, or leave it and it installs when you quit`}
          >
            v{updateReady} ready — Install & restart
          </button>
        ) : updateDownloading ? (
          <span className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink-3">
            Downloading update…
          </span>
        ) : updateError ? (
          <button
            className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-warn hover:bg-hover"
            onClick={() => void useUpdater.getState().checkNow()}
            title={updateError}
          >
            Update failed — Retry
          </button>
        ) : null}
        <HoverHint label="Compose" command="compose" placement="bottom">
          <IconButton
            label="Compose"
            noTitle
            onClick={() => runCommandById("compose")}
          >
            ✎
          </IconButton>
        </HoverHint>
        <HoverHint label="Search" command="search" placement="bottom">
          <IconButton
            label="Search"
            noTitle
            onClick={() => runCommandById("search")}
          >
            ⌕
          </IconButton>
        </HoverHint>
        <IconButton
          label="Settings (Ctrl+,)"
          onClick={() => useUi.getState().setScreen("settings")}
        >
          ⚙
        </IconButton>
        {/* Theme toggle is intentionally NOT a button — it lives in Shell
            Command (type "theme" or "dark mode"), Superhuman-style. */}
      </header>

      {/* Persistent per-account Reconnect strip: a dead Google grant stays
          visible (and one click from fixed) until it IS fixed. Gated on
          `connected` — not on scopes — so it survives restarts, unlike the
          old one-shot 2.6s toast. */}
      {deadAccounts.map((a) => (
        <div
          key={a.email}
          className="flex h-9 shrink-0 items-center gap-3 border-b border-warn/40 bg-warn/10 px-3.5 text-[12.5px] text-ink-2"
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-warn" />
          <span className="min-w-0 flex-1 truncate">
            {grants[a.email] === false ? (
              <>
                No saved Google sign-in for {a.email} — it was removed from this
                machine, or consent never finished. Reconnect to sign in again.
              </>
            ) : (
              <>
                Google sign-in for {a.email} expired or was revoked — mail and
                calendar are paused, queued sends are parked.
              </>
            )}
          </span>
          <button
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-60"
            disabled={reconnecting}
            onClick={() => void reconnectDead()}
          >
            {reconnecting ? "Waiting for consent…" : "Reconnect"}
          </button>
        </div>
      ))}

      {/* A failed reconnect used to go out as a 2.6s toast — the one message
          explaining why every mailbox is frozen, gone before it can be read.
          It stays until the next attempt, and stays selectable so it can be
          pasted into a bug report. */}
      {reconnectError && (
        <div className="flex shrink-0 items-start gap-3 border-b border-danger/40 bg-danger/10 px-3.5 py-2 text-[12.5px] text-ink-2">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-danger" />
          <span className="min-w-0 flex-1 select-text break-words">
            Reconnect failed — {reconnectError}
          </span>
          <button
            className="shrink-0 rounded-md px-2 py-0.5 text-[12px] text-ink-3 hover:text-ink-1"
            onClick={() => setReconnectError(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* The shortcuts panel docks OUTSIDE <main> so it stays put across
          screens and thread views — the same right-hand slot the calendar
          panel occupies inside MailScreen. */}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <main className="relative min-w-0 flex-1">
        {screen === "mail" && !openThreadId && <MailScreen />}
        {screen === "mail" && openThreadId && <ThreadView />}
        {screen === "calendar" && <CalendarWeek />}
        {screen === "search" && <SearchScreen />}
        {screen === "settings" && <SettingsScreen />}

        {/* New-message compose is the modal; replies/forwards dock inline in
            ThreadView (see ReplyDock). */}
        {compose && compose.mode === "new" && <Compose />}
        {askAiOpen && <AskAi />}
        {paletteOpen && <CommandPalette />}
        {picker === "snooze" && <SnoozePicker />}
        {picker === "move" && <MovePicker />}
        {picker === "zeroSweep" && <ZeroSweep />}
        {picker === "sendLater" && <SendLaterPicker />}
        {picker === "snippet" && <SnippetPicker />}
        {picker === "drafts" && <DraftsPicker />}
        {picker === "drivePicker" && <DrivePicker />}
        {eventPopover && <EventPopover />}

        {/* Bottom-left notification stack: the Undo Send bar sits closest to the
            corner, transient toasts stack above it. */}
        {(toast || pendingSend) && (
          <div className="absolute bottom-5 left-5 z-25 flex flex-col gap-2">
            {toast && <UndoToast message={toast} />}
            {pendingSend && <UndoSendBar />}
          </div>
        )}
      </main>
      {/* The week view carries the calendar-management panel beside it
          (design: week grid + mini-month + calendars list side by side). */}
      {screen === "calendar" && <CalendarPanel />}
      {/* The event editor docks in the right-hand slot (like the shortcuts /
          calendar panels) so it stays put across the mail and calendar
          screens — opened from a slot click/drag or B, driven by
          calendar.modal. */}
      {/* startMs is part of the key: every create shares the id "new", so
          without it, clicking a second slot while a create panel is open
          re-used the panel and kept the FIRST slot's time in the form. */}
      {eventModal && (
        <EventModal
          key={`${eventModal.mode}-${eventModal.event?.id ?? "new"}-${eventModal.startMs}`}
        />
      )}
      {shortcutsOpen && <ShortcutsPanel />}
      </div>

      {/* Live "Downloading 17 of 30…" counter. Anchored beside the footer strip
          but rendered OUTSIDE its gate — the footer only exists when the
          shortcut bar, the crawl bar, or a migration is showing, and the pill's
          whole point is the passes that have no bar (the 30s incremental tick,
          sync_now, load-older). Scoped to the active account so two concurrent
          syncs can't fight over one count. */}
      <SyncActivityPill
        account={accounts.active}
        bottomOffset={footerVisible ? 38 : 12}
      />

      {footerVisible && (
        <footer
          className="flex h-[30px] shrink-0 items-center gap-4 overflow-hidden border-t border-line bg-surface px-3 text-[11.5px] text-ink-3"
          style={
            zero
              ? ({
                  ...ZERO_CHROME,
                  "--bg-surface": "transparent",
                  "--border": "rgba(255,255,255,0.14)",
                } as CSSProperties)
              : undefined
          }
        >
          {migrating && (
            <span
              className="flex shrink-0 items-center gap-2 whitespace-nowrap text-ink-2"
              title={`${migration!.copied.toLocaleString()} of ${migration!.total.toLocaleString()} rows moved for ${migration!.email}`}
            >
              <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
              Optimizing mail storage… {migrationPct}%
            </span>
          )}
          {downloading && (
            <span
              className="flex shrink-0 items-center gap-2 whitespace-nowrap text-ink-2"
              title={`${syncProgress!.indexed.toLocaleString()} of ${syncProgress!.total.toLocaleString()} conversations downloaded`}
            >
              <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
              Downloading mail history… {downloadPct}%
            </span>
          )}
          {hintsVisible && (
            <div className="flex min-w-0 flex-1 items-center justify-center gap-4 overflow-hidden">
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <Kbd>E</Kbd> Mark Done
              </span>
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <Kbd>H</Kbd> to set a reminder
              </span>
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <Kbd>C</Kbd> to compose
              </span>
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <Kbd>/</Kbd> to search
              </span>
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <Kbd>Ctrl</Kbd>
                <Kbd>K</Kbd> for Shell Command
              </span>
            </div>
          )}
        </footer>
      )}
      </div>
    </div>
  );
}
