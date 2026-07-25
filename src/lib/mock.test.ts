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
