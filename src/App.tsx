import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { backend, isTauri } from "@/lib/ipc";
import { commandBindings, runCommandById } from "@/lib/commands";
import { installKeyboard } from "@/lib/keyboard";
import { startUpdateChecks, useUpdater } from "@/lib/updater";
import { clearMailCaches, splitThreads, useMail } from "@/stores/mail";
import { useProfiles, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";
import { IconButton } from "@/components/Button";
import { HoverHint } from "@/components/HoverHint";
import { NavRail } from "@/components/NavRail";
import { RestState } from "@/components/RestState";
import { UndoToast } from "@/components/UndoToast";
import { UndoSendBar } from "@/components/UndoSendBar";
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
import { Celebration } from "@/features/zero/Celebration";
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
  const celebration = useUi((s) => s.celebration);
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
  const loaded = useSettings((s) => s.loaded);
  const onboarded = useSettings((s) => s.settings.onboarded);
  const accounts = useSettings((s) => s.accounts);
  const showShortcutBar = useSettings((s) => s.settings.showShortcutBar);

  // Show the download strip only while history is actively downloading (total
  // known, crawl not done). Clamp to 1–99% so it never reads "0%" or lingers at
  // "100%" — `done` hides it outright.
  const downloading =
    !!syncProgress && !syncProgress.done && syncProgress.total > 0;
  const downloadPct = downloading
    ? Math.min(99, Math.max(1, Math.round((syncProgress.indexed / syncProgress.total) * 100)))
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
  const reconnectDead = async () => {
    setReconnecting(true);
    try {
      // in-place re-consent: token + scopes refresh, the mailbox is untouched
      await backend.startOauth("", "");
      await useSettings.getState().refreshAccounts();
      await backend.syncNow();
      await useMail.getState().refresh();
    } catch (e) {
      useUi.getState().showToast(String(e));
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
  const footerVisible = showShortcutBar || downloading || migrating;

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
    const onFocus = () => useCalendar.getState().requestRefresh();
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
          u.celebration !== null ||
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

  if (!onboarded) {
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
      {/* Signature wash — the faint cerulean glow anchored to the bottom edge
          (design token --wash-bottom). A ~300px bottom strip, not full height:
          the light token's stops (transparent at 130px, cerulean at 40%) are
          only consistent on a short layer — full-height renders a hard band.
          Present, never loud; overlays sit higher in the stack. Skipped over
          the inbox-zero photo. */}
      {!zero && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-[300px]"
          style={{ background: "var(--wash-bottom)" }}
        />
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
        {updateReady ? (
          <button
            className="zb-pop-in rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent hover:opacity-90"
            onClick={() => void useUpdater.getState().restart()}
            title={`${updateReady} downloaded — restart to apply`}
          >
            Update ready — Restart
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
            Google sign-in for {a.email} expired or was revoked — mail and
            calendar are paused, queued sends are parked.
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
        {celebration && <Celebration />}

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
      {eventModal && (
        <EventModal key={`${eventModal.mode}-${eventModal.event?.id ?? "new"}`} />
      )}
      {shortcutsOpen && <ShortcutsPanel />}
      </div>

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
          {showShortcutBar && (
            <div className="flex min-w-0 flex-1 items-center justify-center gap-4 overflow-hidden">
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <span className="kbd">E</span> Mark Done
              </span>
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <span className="kbd">H</span> to set a reminder
              </span>
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <span className="kbd">C</span> to compose
              </span>
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <span className="kbd">/</span> to search
              </span>
              <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                Hit <span className="kbd">Ctrl</span>
                <span className="kbd">K</span> for Shell Command
              </span>
            </div>
          )}
        </footer>
      )}
      </div>
    </div>
  );
}
