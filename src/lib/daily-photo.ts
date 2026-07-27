// When the inbox-zero photo turns over.
//
// The Rust core decides WHICH photo (unsplash.rs `photo_day` — same 12:01 AM
// local boundary); this decides when an app that is already open should go ask
// for the next one. Without it the rest state fetched once on mount and never
// again, so an app left at inbox zero overnight kept yesterday's photo until
// something happened to remount it.

/** Minutes past local midnight at which the photo turns over. Mirrors
 *  unsplash.rs `ROTATE_AT_MS_PAST_MIDNIGHT`. */
const ROTATE_MINUTE = 1;

/** ms from `now` until the next local 12:01 AM. Strictly positive — at the
 *  boundary itself it returns a full day, so the timer this feeds can never
 *  spin on a zero delay. Recomputed after every firing, which is also what
 *  keeps it right across DST and across a machine that slept through it. */
export function msUntilNextRotation(now: Date): number {
  const next = new Date(now.getTime());
  next.setHours(0, ROTATE_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** The photo day an instant belongs to, as a local-midnight ms stamp. Two
 *  instants sharing a key share a photo. Used to tell "we were asleep across a
 *  boundary" from "nothing has changed" when the window regains focus — a
 *  suspended laptop's timers do not fire on time, so the timer alone is not
 *  enough. */
export function photoDayKey(ms: number): number {
  const d = new Date(ms - ROTATE_MINUTE * 60_000);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Has the photo day moved on since `fetchedAt`? */
export function photoIsStale(fetchedAt: number, now: number): boolean {
  return photoDayKey(fetchedAt) !== photoDayKey(now);
}
