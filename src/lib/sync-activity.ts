import type { SyncActivity, SyncStage } from "@/lib/types";

// Display rules for the live download pill. Pure so they can be tested without
// a DOM: SyncActivityPill.tsx owns the timers and React state, this owns every
// decision those timers act on.

/** Below this many items a pass is assumed instant — showing a pill for a
 *  2-thread incremental tick is just a flicker. */
export const MIN_ITEMS = 5;
/** …unless it turns out to be slow. A small pass that drags (rate limit, one
 *  fat thread) still deserves an explanation. */
export const MIN_DURATION_MS = 1_000;
/** How long a completed pill lingers before fading, so a fast pass is legible
 *  instead of a blink. */
export const HOLD_MS = 600;
export const FADE_MS = 300;

const STAGE_LABEL: Record<SyncStage, string> = {
  "reconcile-inbox": "Downloading",
  "reconcile-rest": "Downloading",
  incremental: "Downloading",
  // The crawl fetches mail nobody is looking at, to make it searchable.
  crawl: "Indexing",
  resync: "Repairing",
  "load-older": "Loading",
};

/** Identity of a pass. A pass is one account moving through one stage, so a
 *  reconcile that rolls from inbox → rest restarts the pill's clock rather
 *  than letting phase 2's count look like a continuation of phase 1's. */
export function passKey(a: SyncActivity): string {
  return `${a.account}:${a.stage}`;
}

/** Last tick of a pass. `total === 0` counts: an empty pass still has to clear
 *  whatever the previous one left on screen. */
export function isTerminal(a: SyncActivity): boolean {
  return a.total === 0 || a.done >= a.total;
}

/** Is this tick for the mailbox we're watching? An undefined `account` follows
 *  whatever ticked last — onboarding, where there is no switcher yet. */
export function matchesAccount(a: SyncActivity, account?: string): boolean {
  return !account || a.account === account;
}

/** Worth putting on screen? Big passes show immediately; small ones only once
 *  they've proven slow. */
export function shouldShow(a: SyncActivity, elapsedMs: number): boolean {
  return a.total > MIN_ITEMS || elapsedMs >= MIN_DURATION_MS;
}

/** "Downloading 17 of 30…". `done` is clamped because the terminal tick of a
 *  pass whose denominator shrank mid-flight would otherwise read "31 of 30". */
export function pillText(a: SyncActivity): string {
  const label = STAGE_LABEL[a.stage] ?? "Downloading";
  const done = Math.min(a.done, a.total);
  return `${label} ${done.toLocaleString()} of ${a.total.toLocaleString()}…`;
}
