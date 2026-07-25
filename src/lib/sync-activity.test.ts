import { describe, expect, it } from "vitest";
import {
  MIN_DURATION_MS,
  MIN_ITEMS,
  isTerminal,
  matchesAccount,
  passKey,
  pillText,
  shouldShow,
} from "@/lib/sync-activity";
import type { SyncActivity } from "@/lib/types";

const tick = (p: Partial<SyncActivity> = {}): SyncActivity => ({
  account: "you@x.test",
  stage: "incremental",
  done: 1,
  total: 30,
  ...p,
});

describe("shouldShow", () => {
  it("shows a big pass immediately", () => {
    expect(shouldShow(tick({ total: 30 }), 0)).toBe(true);
  });

  it("holds off on a small fast pass", () => {
    // the 2-thread incremental tick that would otherwise flicker every 30s
    expect(shouldShow(tick({ total: 2 }), 0)).toBe(false);
    expect(shouldShow(tick({ total: MIN_ITEMS }), 0)).toBe(false);
  });

  it("shows a small pass once it drags", () => {
    expect(shouldShow(tick({ total: 2 }), MIN_DURATION_MS)).toBe(true);
    expect(shouldShow(tick({ total: 2 }), MIN_DURATION_MS - 1)).toBe(false);
  });

  it("uses a strict threshold on item count", () => {
    expect(shouldShow(tick({ total: MIN_ITEMS + 1 }), 0)).toBe(true);
  });
});

describe("isTerminal", () => {
  it("ends on the last item", () => {
    expect(isTerminal(tick({ done: 30, total: 30 }))).toBe(true);
    expect(isTerminal(tick({ done: 29, total: 30 }))).toBe(false);
  });

  it("treats an empty pass as terminal so a stale pill clears", () => {
    expect(isTerminal(tick({ done: 0, total: 0 }))).toBe(true);
  });

  it("does not get stuck if done overshoots", () => {
    expect(isTerminal(tick({ done: 31, total: 30 }))).toBe(true);
  });
});

describe("passKey", () => {
  it("separates stages so reconcile phase 2 restarts the count", () => {
    expect(passKey(tick({ stage: "reconcile-inbox" }))).not.toBe(
      passKey(tick({ stage: "reconcile-rest" }))
    );
  });

  it("separates accounts syncing concurrently", () => {
    expect(passKey(tick({ account: "a@x.test" }))).not.toBe(
      passKey(tick({ account: "b@x.test" }))
    );
  });
});

describe("matchesAccount", () => {
  it("filters to the watched mailbox", () => {
    expect(matchesAccount(tick({ account: "a@x.test" }), "a@x.test")).toBe(true);
    expect(matchesAccount(tick({ account: "b@x.test" }), "a@x.test")).toBe(false);
  });

  it("follows any pass when unscoped (onboarding has no switcher yet)", () => {
    expect(matchesAccount(tick({ account: "b@x.test" }), undefined)).toBe(true);
  });
});

describe("pillText", () => {
  it("reads as a live count", () => {
    expect(pillText(tick({ done: 17, total: 30 }))).toBe("Downloading 17 of 30…");
  });

  it("names what each pass is actually doing", () => {
    expect(pillText(tick({ stage: "crawl", done: 4, total: 100 }))).toBe(
      "Indexing 4 of 100…"
    );
    expect(pillText(tick({ stage: "resync", done: 1, total: 9 }))).toBe(
      "Repairing 1 of 9…"
    );
    expect(pillText(tick({ stage: "load-older", done: 3, total: 50 }))).toBe(
      "Loading 3 of 50…"
    );
  });

  it("never reads past its own total", () => {
    expect(pillText(tick({ done: 31, total: 30 }))).toBe("Downloading 30 of 30…");
  });

  it("groups large counts", () => {
    expect(pillText(tick({ done: 1200, total: 5400 }))).toBe(
      "Downloading 1,200 of 5,400…"
    );
  });
});
