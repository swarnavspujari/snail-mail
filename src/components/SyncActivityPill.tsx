import { useEffect, useState } from "react";
import { backend } from "@/lib/ipc";
import {
  FADE_MS,
  HOLD_MS,
  MIN_DURATION_MS,
  MIN_ITEMS,
  isTerminal,
  matchesAccount,
  passKey,
  pillText,
  shouldShow,
} from "@/lib/sync-activity";
import type { SyncActivity } from "@/lib/types";

// Live download counter — "Downloading 17 of 30…" — shown whenever the Gmail
// API is actively being hit. Distinct from the footer's "Downloading mail
// history… N%", which measures long-term crawl completeness from persisted
// state and can sit at 0% while a sync hammers the API (or stay hidden forever
// once the crawl is done, no matter how much is being fetched).
//
// This is a LEAF component on purpose: it subscribes to sync:activity directly
// and keeps its state local. sync:progress already re-renders the whole App
// tree per event; sync:activity fires several times more often, so routing it
// through a store would repeat that mistake at a higher frequency.
//
// Every display decision (thresholds, labels, terminal detection) lives in
// lib/sync-activity.ts so it can be tested without a DOM; this file owns the
// timers and the markup.

type Phase = "hidden" | "visible" | "leaving";

/** `account` scopes the pill to one mailbox — two accounts can sync at once in
 *  the 30s tick and a pill that followed both would jump between counts. Pass
 *  the active account; omit to follow whatever ticked last (onboarding, where
 *  there is no account switcher yet). */
export function SyncActivityPill({
  account,
  inline = false,
  bottomOffset = 12,
}: {
  account?: string;
  inline?: boolean;
  /** Distance from the bottom of the app frame, so the pill clears the footer
   *  strip when one is showing. Ignored when `inline`. */
  bottomOffset?: number;
}) {
  const [activity, setActivity] = useState<SyncActivity | null>(null);
  const [phase, setPhase] = useState<Phase>("hidden");

  useEffect(() => {
    // Timers and the pass's start time live in the effect, not in state:
    // rewriting them per tick would re-render the pill on every beat it
    // decides NOT to show.
    let startedAt = 0;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let currentPass = "";
    let cancelled = false;

    const clearTimers = () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };

    const finish = () => {
      clearTimers();
      startedAt = 0;
      currentPass = "";
      setPhase((p) => (p === "hidden" ? "hidden" : "leaving"));
      hideTimer = setTimeout(() => {
        setPhase("hidden");
        setActivity(null);
      }, FADE_MS);
    };

    const apply = (a: SyncActivity) => {
      if (cancelled || !matchesAccount(a, account)) return;

      const key = passKey(a);
      if (key !== currentPass) {
        // A new pass: restart the clock and the "is this worth showing" test.
        clearTimers();
        currentPass = key;
        startedAt = Date.now();
        if (a.total > MIN_ITEMS) {
          setPhase("visible");
        } else {
          // Small pass — hold off, but show it if it drags past the threshold.
          showTimer = setTimeout(() => {
            if (!cancelled && currentPass === key) setPhase("visible");
          }, MIN_DURATION_MS);
        }
      }

      setActivity(a);

      if (isTerminal(a)) {
        // A pass that never earned the screen leaves silently; one that did
        // gets its hold + fade so the final count is readable.
        const earned = shouldShow(a, Date.now() - startedAt);
        clearTimers();
        currentPass = "";
        startedAt = 0;
        if (!earned) {
          setPhase("hidden");
          setActivity(null);
          return;
        }
        setPhase("visible");
        hideTimer = setTimeout(finish, HOLD_MS);
      }
    };

    const un = backend.onSyncActivity(apply);
    // A pass already in flight when this mounted (onboarding's first sync, a
    // reopened window) would otherwise go unreported until its next beat.
    void backend.getSyncActivity().then((a) => {
      if (a) apply(a);
    });

    return () => {
      cancelled = true;
      clearTimers();
      un();
    };
  }, [account]);

  if (phase === "hidden" || !activity) return null;

  return (
    <div
      className={
        inline
          ? "flex justify-center"
          : // Bottom-RIGHT, and outside the footer's visibility gate: that gate
            // is `showShortcutBar || downloading || migrating`, so a pill inside
            // it would be invisible in exactly the incremental-sync case this
            // exists to surface. Bottom-left belongs to UndoToast/UndoSendBar.
            "pointer-events-none absolute right-3 z-30"
      }
      style={inline ? undefined : { bottom: bottomOffset }}
    >
      <span
        role="status"
        aria-live="polite"
        className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface/95 px-2.5 py-1 text-[11.5px] tabular-nums text-ink-2 shadow-sm backdrop-blur transition-opacity duration-300 ${
          phase === "leaving" ? "opacity-0" : "zb-pop-in opacity-100"
        }`}
        title={`${activity.account} · ${activity.stage}`}
      >
        <span className="zb-spin inline-block h-3 w-3 shrink-0 rounded-full border-2 border-line-strong border-t-accent" />
        {pillText(activity)}
      </span>
    </div>
  );
}
