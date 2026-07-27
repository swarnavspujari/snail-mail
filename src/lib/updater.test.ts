// @vitest-environment happy-dom
//
// Updates are checked and downloaded freely, and installed only when someone
// says so. The regression these guard against: runCheck used to call
// downloadAndInstall(), which on Windows/NSIS launches the installer and exits
// the process — mid-session, with no prompt anywhere in the path.
import { beforeEach, describe, expect, test, vi } from "vitest";

const updaterApi = vi.hoisted(() => ({ check: vi.fn() }));
const processApi = vi.hoisted(() => ({ relaunch: vi.fn() }));
const backend = vi.hoisted(() => ({ saveDraft: vi.fn().mockResolvedValue({ id: 1, account: "a" }) }));

vi.mock("@tauri-apps/plugin-updater", () => updaterApi);
vi.mock("@tauri-apps/plugin-process", () => processApi);
vi.mock("@/lib/ipc", () => ({ backend, isTauri: true }));

import {
  handleCloseRequest,
  installOnQuit,
  updatePromptSuppressed,
  useUpdater,
  type CloseRequestDeps,
} from "./updater";
import { useUi } from "@/stores/ui";

/** A found update: download() and install() are separate, and we assert on
 *  which of them the app reached for. */
function fakeUpdate(version = "0.26.0") {
  return {
    version,
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdater.setState({
    ready: null,
    downloading: null,
    checking: false,
    error: null,
    status: null,
  });
  useUi.setState({ compose: null, pendingSend: null, syncProgress: null });
});

describe("checkNow", () => {
  test("downloads a found update and then STOPS", async () => {
    const update = fakeUpdate();
    updaterApi.check.mockResolvedValue(update);

    await useUpdater.getState().checkNow();

    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(useUpdater.getState().ready).toBe("0.26.0");
    expect(useUpdater.getState().downloading).toBeNull();
    expect(useUpdater.getState().status).toContain("ready");
  });

  test("no update leaves nothing pending", async () => {
    updaterApi.check.mockResolvedValue(null);
    await useUpdater.getState().checkNow();
    expect(useUpdater.getState().ready).toBeNull();
    expect(useUpdater.getState().status).toBe("You're on the latest version");
  });

  test("a failed download surfaces instead of looking like 'no update'", async () => {
    const update = fakeUpdate();
    update.download.mockRejectedValue(new Error("network down"));
    updaterApi.check.mockResolvedValue(update);

    await useUpdater.getState().checkNow();

    expect(useUpdater.getState().ready).toBeNull();
    expect(useUpdater.getState().error).toContain("network down");
    expect(useUpdater.getState().status).toContain("Update failed");
  });

  test("an already-downloaded update isn't re-checked", async () => {
    useUpdater.setState({ ready: "0.26.0" });
    await useUpdater.getState().checkNow();
    expect(updaterApi.check).not.toHaveBeenCalled();
  });
});

describe("installNow", () => {
  test("installs the downloaded update and flushes the open draft first", async () => {
    const update = fakeUpdate();
    updaterApi.check.mockResolvedValue(update);
    await useUpdater.getState().checkNow();

    useUi.setState({
      compose: {
        mode: "new",
        threadId: null,
        to: ["ann@example.com"],
        cc: [],
        bcc: [],
        subject: "half-written",
        body: "<p>wait</p>",
        quote: "",
        attachments: [],
        driveLinks: [],
        draftId: null,
        draftAccount: null,
      },
    });

    await useUpdater.getState().installNow();

    expect(backend.saveDraft).toHaveBeenCalledTimes(1);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  test("with nothing downloaded it does nothing at all", async () => {
    await useUpdater.getState().installNow();
    expect(processApi.relaunch).not.toHaveBeenCalled();
  });
});

describe("installOnQuit", () => {
  test("installs on the way out once an update is ready", async () => {
    const update = fakeUpdate();
    updaterApi.check.mockResolvedValue(update);
    await useUpdater.getState().checkNow();

    expect(await installOnQuit()).toBe(true);
    expect(update.install).toHaveBeenCalledTimes(1);
  });

  test("never installs through a live Undo Send window", async () => {
    const update = fakeUpdate();
    updaterApi.check.mockResolvedValue(update);
    await useUpdater.getState().checkNow();
    useUi.setState({
      pendingSend: {
        outboxId: 1,
        outboxAccount: "a@x.test",
        expiresAt: Date.now() + 8000,
        label: "Sent",
      },
    });

    expect(await installOnQuit()).toBe(false);
    expect(update.install).not.toHaveBeenCalled();
  });

  test("with no update pending it lets the window close", async () => {
    expect(await installOnQuit()).toBe(false);
  });

  test("a failing install never traps the user in an app that won't quit", async () => {
    const update = fakeUpdate();
    update.install.mockRejectedValue(new Error("installer missing"));
    updaterApi.check.mockResolvedValue(update);
    await useUpdater.getState().checkNow();

    expect(await installOnQuit()).toBe(false);
  });
});

describe("updatePromptSuppressed", () => {
  test("stays quiet while the first history crawl is still running", () => {
    expect(updatePromptSuppressed({ total: 40_000, done: false })).toBe(true);
  });

  test("speaks up once the mailbox has been walked", () => {
    expect(updatePromptSuppressed({ total: 40_000, done: true })).toBe(false);
  });

  test("an unknown mailbox size is not a crawl in flight", () => {
    // total 0 means threadsTotal isn't known yet (or this is the demo) — that
    // is not a reason to hide a ready update forever.
    expect(updatePromptSuppressed({ total: 0, done: false })).toBe(false);
    expect(updatePromptSuppressed(null)).toBe(false);
  });
});

// The X button. Every case below is one where the OLD handler left the window
// open with the close already swallowed — press X, nothing happens, press it
// again, nothing happens, forever. It only ever called destroy() on the branch
// where the install returned false, which is the one path that already worked
// (and the only one the old "a failing install never traps the user" test
// exercised).
describe("handleCloseRequest", () => {
  function deps(over: Partial<CloseRequestDeps> = {}) {
    return {
      hasPendingUpdate: () => true,
      sendInFlight: () => false,
      preventDefault: vi.fn(),
      install: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      forceExit: vi.fn().mockResolvedValue(undefined),
      budgetMs: 50,
      ...over,
    };
  }

  test("with nothing to install it never touches the close at all", async () => {
    const d = deps({ hasPendingUpdate: () => false });
    expect(await handleCloseRequest(d)).toBe("close-normally");
    // Not preventing default is what lets Tauri destroy the window itself.
    expect(d.preventDefault).not.toHaveBeenCalled();
    expect(d.install).not.toHaveBeenCalled();
  });

  test("a live Undo Send window closes normally rather than installing", async () => {
    const d = deps({ sendInFlight: () => true });
    expect(await handleCloseRequest(d)).toBe("close-normally");
    expect(d.preventDefault).not.toHaveBeenCalled();
  });

  test("an install that succeeds WITHOUT exiting still closes the window", async () => {
    // THE REPORTED BUG. Windows/NSIS exits inside install(), so the old code
    // got away with returning true and never calling destroy(). Everywhere
    // else — and on Windows when the installer declines to launch — the
    // process lives on, and the window was trapped for good.
    const d = deps();
    expect(await handleCloseRequest(d)).toBe("destroyed");
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  test("an install that never resolves does not hold the window hostage", async () => {
    const d = deps({ install: vi.fn(() => new Promise<void>(() => {})) });
    expect(await handleCloseRequest(d)).toBe("destroyed");
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  test("an install that throws still closes the window", async () => {
    const d = deps({ install: vi.fn().mockRejectedValue(new Error("boom")) });
    expect(await handleCloseRequest(d)).toBe("destroyed");
    expect(d.destroy).toHaveBeenCalledTimes(1);
  });

  test("the quit is honoured even if destroy() itself fails", async () => {
    const d = deps({ destroy: vi.fn().mockRejectedValue(new Error("no window")) });
    expect(await handleCloseRequest(d)).toBe("destroyed");
    expect(d.forceExit).toHaveBeenCalledTimes(1);
  });

  test("it takes the close over before doing anything slow", async () => {
    // preventDefault has to happen synchronously with the decision; deferring
    // it past an await would let Tauri close the window mid-install.
    const order: string[] = [];
    const d = deps({
      preventDefault: vi.fn(() => order.push("prevent")),
      install: vi.fn(async () => {
        order.push("install");
      }),
      destroy: vi.fn(async () => {
        order.push("destroy");
      }),
    });
    await handleCloseRequest(d);
    expect(order).toEqual(["prevent", "install", "destroy"]);
  });
});
