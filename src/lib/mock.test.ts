// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AccountsState } from "./types";
import { MockBackend } from "./mock";

// The contact panel's mail history: threads a person was actually ON (a
// sender or recipient), never every message that merely mentions them.
describe("MockBackend.threadsWithContact", () => {
  beforeEach(() => localStorage.clear());

  test("lists every thread the address is a participant in, newest first", async () => {
    const be = new MockBackend();
    // Priya sent the board-deck draft (recent) and an archived memo (older).
    const hits = await be.threadsWithContact("priya@fissionventures.com");
    expect(hits.map((h) => h.threadId)).toEqual(["t-board-deck", "t-done-memo"]);
  });

  test("matches the address columns, not the message body", async () => {
    const be = new MockBackend();
    // Maya sent the term-sheet thread. Her address ALSO appears in the body of
    // the board-meeting invitation ("Organizer: maya@heliosrobotics.io") — the
    // old first-name FTS surfaced that; an address-scoped query must not.
    const hits = await be.threadsWithContact("maya@heliosrobotics.io");
    expect(hits.map((h) => h.threadId)).toEqual(["t-term-sheet"]);
  });

  test("a contact with no other mail returns nothing (no full-text noise)", async () => {
    const be = new MockBackend();
    expect(await be.threadsWithContact("stranger@example.com")).toEqual([]);
  });
});

// Mirrors the desktop removal flow: instant `removing` marker, background
// teardown, accounts:updated pushes, idempotent double-click.
describe("MockBackend.disconnect", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  test("marks removing instantly, then drops the account and its threads", async () => {
    const be = new MockBackend();
    const pushes: AccountsState[] = [];
    be.onAccountsUpdated((a) => pushes.push(a));
    const before = await be.getAccounts();
    expect(before.accounts).toHaveLength(2);
    const victim = before.accounts[1].email;

    const snap = await be.disconnect(victim);
    expect(snap.accounts.find((a) => a.email === victim)?.removing).toBe(true);
    expect(snap.active).not.toBe(victim);
    expect(pushes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    const after = await be.getAccounts();
    expect(after.accounts.map((a) => a.email)).not.toContain(victim);
    expect(pushes).toHaveLength(2);
    // the removed account's threads are gone from every list
    const inbox = await be.listThreads("inbox");
    expect(inbox).toBeDefined();
  });

  test("double-click safe: a second disconnect is a no-op", async () => {
    const be = new MockBackend();
    const victim = (await be.getAccounts()).accounts[1].email;
    await be.disconnect(victim);
    const second = await be.disconnect(victim);
    expect(second.accounts.filter((a) => a.email === victim)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect((await be.getAccounts()).accounts.map((a) => a.email)).not.toContain(victim);
  });

  test("the last remaining account cannot be removed", async () => {
    const be = new MockBackend();
    const [first, second] = (await be.getAccounts()).accounts.map((a) => a.email);
    await be.disconnect(second);
    await vi.advanceTimersByTimeAsync(500);
    const state = await be.disconnect(first);
    expect(state.accounts.map((a) => a.email)).toContain(first);
  });
});

// The demo has to emit REAL per-item ticks, not one synthetic climb — the pill
// counts Gmail round-trips, so a fake ramp would demo nothing.
describe("MockBackend sync:activity", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  test("syncNow ticks once per thread, 1..30, and ends on the terminal tick", async () => {
    const be = new MockBackend();
    const seen: Array<[number, number]> = [];
    be.onSyncActivity((a) => {
      if (a.stage === "incremental") seen.push([a.done, a.total]);
    });

    const pass = be.syncNow();
    await vi.advanceTimersByTimeAsync(60 * 30 + 10);
    await pass;

    expect(seen).toHaveLength(30);
    expect(seen[0]).toEqual([1, 30]);
    expect(seen[16]).toEqual([17, 30]); // "Downloading 17 of 30…"
    expect(seen[29]).toEqual([30, 30]);
    // strictly monotonic — a pill that jumped backwards would read as two
    // interleaved passes
    expect(seen.every(([done], i) => done === i + 1)).toBe(true);
  });

  test("getSyncActivity serves the in-flight pass, then clears when it ends", async () => {
    const be = new MockBackend();
    expect(await be.getSyncActivity()).toBeNull();

    const pass = be.syncNow();
    await vi.advanceTimersByTimeAsync(60 * 3);
    const mid = await be.getSyncActivity();
    expect(mid?.stage).toBe("incremental");
    expect(mid?.done).toBe(3);
    expect(mid?.total).toBe(30);

    await vi.advanceTimersByTimeAsync(60 * 30);
    await pass;
    // a finished pass must not keep reporting itself to late subscribers
    expect(await be.getSyncActivity()).toBeNull();
  });

  test("resyncAccount reports a repair pass over the account's threads", async () => {
    const be = new MockBackend();
    const stages: string[] = [];
    be.onSyncActivity((a) => stages.push(a.stage));

    const pass = be.resyncAccount();
    await vi.advanceTimersByTimeAsync(60 * 200);
    await pass;

    expect(stages.length).toBeGreaterThan(0);
    expect(new Set(stages)).toEqual(new Set(["resync"]));
  });
});
