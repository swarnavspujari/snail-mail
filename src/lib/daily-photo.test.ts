// The rotation clock for the inbox-zero photo. vitest.config.ts pins
// TZ=America/New_York, so the DST cases below are real transitions — which is
// the whole point: the rule this replaced was a rolling 24h from the last
// fetch, and a calendar day is not always 24 hours long.
import { describe, expect, test } from "vitest";
import { msUntilNextRotation, photoDayKey, photoIsStale } from "./daily-photo";

const HOUR = 3_600_000;
const MIN = 60_000;

describe("msUntilNextRotation", () => {
  test("counts down to today's 12:01 AM when it is still ahead", () => {
    expect(msUntilNextRotation(new Date(2026, 6, 27, 0, 0, 30))).toBe(30_000);
  });

  test("rolls to tomorrow once the boundary has passed", () => {
    // 9:00 AM → 15h to midnight + 1 min
    expect(msUntilNextRotation(new Date(2026, 6, 27, 9, 0))).toBe(15 * HOUR + MIN);
  });

  test("at the boundary itself it waits a whole day, never zero", () => {
    // A zero delay would spin: fire, refetch, re-arm, fire again.
    expect(msUntilNextRotation(new Date(2026, 6, 27, 0, 1))).toBe(24 * HOUR);
  });

  test("spring forward makes the day 23 hours, and the timer follows", () => {
    // 2026-03-08 is the US DST start; the 2 AM hour disappears, so 12:01 AM
    // Sunday to 12:01 AM Monday is 23 real hours. A fixed 24h timer would fire
    // an hour late — and a rolling 24h cache would rotate an hour into the
    // wrong day, then keep drifting.
    expect(msUntilNextRotation(new Date(2026, 2, 8, 0, 1))).toBe(23 * HOUR);
  });

  test("fall back makes the day 25 hours, and the timer follows", () => {
    // 2026-11-01 is the US DST end; the 1 AM hour repeats.
    expect(msUntilNextRotation(new Date(2026, 10, 1, 0, 1))).toBe(25 * HOUR);
  });
});

describe("photoDayKey", () => {
  test("12:00 AM still belongs to the day that is ending", () => {
    const midnight = new Date(2026, 6, 27, 0, 0).getTime();
    const lateYesterday = new Date(2026, 6, 26, 23, 30).getTime();
    expect(photoDayKey(midnight)).toBe(photoDayKey(lateYesterday));
  });

  test("12:01 AM starts the new one", () => {
    const before = new Date(2026, 6, 27, 0, 0).getTime();
    const after = new Date(2026, 6, 27, 0, 1).getTime();
    expect(photoDayKey(after)).not.toBe(photoDayKey(before));
  });

  test("one calendar day is one key", () => {
    expect(photoDayKey(new Date(2026, 6, 27, 6, 0).getTime())).toBe(
      photoDayKey(new Date(2026, 6, 27, 22, 45).getTime())
    );
  });
});

describe("photoIsStale", () => {
  test("the same day is not stale", () => {
    const morning = new Date(2026, 6, 27, 8, 0).getTime();
    const evening = new Date(2026, 6, 27, 20, 0).getTime();
    expect(photoIsStale(morning, evening)).toBe(false);
  });

  test("an afternoon fetch is stale the next morning, under 24h later", () => {
    // Exactly the case the old rolling-24h rule got wrong: fetched at 3 PM,
    // still 'fresh' at 7 AM the next day, so the photo changed at 3 PM.
    const fetched = new Date(2026, 6, 26, 15, 0).getTime();
    const nextMorning = new Date(2026, 6, 27, 7, 0).getTime();
    expect(nextMorning - fetched).toBeLessThan(24 * HOUR);
    expect(photoIsStale(fetched, nextMorning)).toBe(true);
  });
});
