// Auto-update: check GitHub Releases on boot, every 4h, and on window focus;
// download in the background — then STOP and say so. Installing is an explicit
// act: the header button, or app quit.
//
// It used to call downloadAndInstall(). On Windows/NSIS that launches the
// installer and exits the process, so the "Update ready — restart to install"
// state was set on a path where the app had already been replaced under you.
// check / download / install are three separate steps now, and only the first
// two happen on their own.
//
// The downloaded bytes live in a Rust-side Resource that does NOT survive a
// restart, so "install at next launch" would mean re-downloading at boot.
// Installing on quit gets the same outcome for free: you quit, it installs,
// the next launch is the new version.
//
// No-op in the browser demo.
import { create } from "zustand";
import { isTauri } from "./ipc";
import { flushComposeDraft, useUi } from "@/stores/ui";

/** The checked-and-downloaded update, held so install() can be called later.
 *  A Resource handle, not state — it never belongs in the store. */
let pending: { version: string; install: () => Promise<void> } | null = null;

/** The handle, but only while the store still says that version is ready.
 *  `ready` is the user-visible truth about what was downloaded; the handle is
 *  just how we act on it, and the two must never disagree. */
function pendingUpdate(): typeof pending {
  const { ready } = useUpdater.getState();
  return pending && ready === pending.version ? pending : null;
}

interface UpdateState {
  /** Version string when an update is downloaded and ready to install. */
  ready: string | null;
  /** Non-null while downloading. */
  downloading: string | null;
  /** A check is in flight. */
  checking: boolean;
  /** Last error reason, if a check/download failed. */
  error: string | null;
  /** Human-facing one-liner: "You're on the latest version", "Downloading vX…". */
  status: string | null;
  /** Install now and restart into the new version. Exits the process. */
  installNow: () => Promise<void>;
  /** Manual check (Ctrl+K / Settings). Reports the outcome via `status`. */
  checkNow: () => Promise<void>;
}

export const useUpdater = create<UpdateState>((set, get) => ({
  ready: null,
  downloading: null,
  checking: false,
  error: null,
  status: null,
  installNow: async () => {
    const update = pendingUpdate();
    if (!update) return;
    // Last keystrokes may predate the 800ms autosave, and this process is
    // about to end.
    flushComposeDraft();
    useUpdater.setState({ status: `Installing v${update.version}…` });
    try {
      await update.install();
      // Windows exits inside install(); elsewhere finish the job ourselves.
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      useUpdater.setState({ error: String(e), status: `Update failed: ${String(e)}` });
    }
  },
  checkNow: async () => {
    if (!isTauri) {
      set({ status: "Updates apply to the installed desktop app." });
      return;
    }
    if (get().checking || get().downloading) return;
    await runCheck(true);
  },
}));

/** Should the ambient "update ready" affordance stay out of the way? The first
 *  full-history crawl is the one moment a restart is most expensive and least
 *  welcome, so nothing nags until the mailbox has been walked once. Settings →
 *  About still tells you — that one you went looking for. */
export function updatePromptSuppressed(p: { total: number; done: boolean } | null): boolean {
  return !!p && p.total > 0 && !p.done;
}

async function runCheck(manual: boolean): Promise<void> {
  // already downloaded and waiting for the user to install — nothing to do
  if (useUpdater.getState().ready) return;
  useUpdater.setState({
    checking: true,
    error: null,
    ...(manual ? { status: "Checking for updates…" } : {}),
  });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      useUpdater.setState({
        checking: false,
        status: manual ? "You're on the latest version" : useUpdater.getState().status,
      });
      return;
    }
    useUpdater.setState({
      checking: false,
      downloading: update.version,
      status: `Downloading v${update.version}…`,
    });
    // Download only. The install is a separate, consented step.
    await update.download();
    pending = { version: update.version, install: () => update.install() };
    useUpdater.setState({
      downloading: null,
      ready: update.version,
      status: `v${update.version} is ready — install it now or on quit`,
    });
  } catch (e) {
    // Surface it: a silently-failing update was exactly the user's experience.
    useUpdater.setState({
      checking: false,
      downloading: null,
      error: String(e),
      status: `Update failed: ${String(e)}`,
    });
  }
}

/** Is there mail that must not be interrupted right now? A queued Send Later
 *  is durable — it lives in SQLite and the outbox pump picks it up on the next
 *  launch. A live Undo Send window is not: it is seconds long and the user is
 *  still deciding. Never install through one. */
function sendInFlight(): boolean {
  return useUi.getState().pendingSend !== null;
}

/** Called from the window's close request. Returns true when it took over the
 *  quit (installed); false to let the window close normally. */
export async function installOnQuit(): Promise<boolean> {
  const update = pendingUpdate();
  if (!update || sendInFlight()) return false;
  flushComposeDraft();
  try {
    await update.install();
    return true;
  } catch {
    // A failed install must never trap the user in an app that won't close.
    return false;
  }
}

/** Call once at app boot. Safe in the browser (does nothing). Checks on boot,
 *  every 4h, and when the window regains focus/visibility (throttled), so a user
 *  who reopens the app after a release gets it promptly — and installs a ready
 *  update on the way out. */
export function startUpdateChecks(): void {
  if (!isTauri) return;
  void runCheck(false);
  setInterval(() => void runCheck(false), 4 * 60 * 60 * 1000);

  let lastFocusCheck = 0;
  const onResume = () => {
    const now = Date.now();
    if (now - lastFocusCheck < 5 * 60 * 1000) return; // at most every 5 min
    lastFocusCheck = now;
    void runCheck(false);
  };
  window.addEventListener("focus", onResume);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onResume();
  });

  void (async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.onCloseRequested(async (event) => {
      if (!pendingUpdate() || sendInFlight()) return; // close normally
      event.preventDefault();
      if (!(await installOnQuit())) {
        // install failed or was skipped — honour the quit anyway
        await win.destroy();
      }
    });
  })();
}
