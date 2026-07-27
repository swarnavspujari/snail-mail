// Cache-first day/week navigation: loadRange only fetches days missing from
// the day-keyed cache (trimming loaded days off the range ends), the
// calendar:updated reconcile path forces a full re-read of EVERY watched
// range, invalidateDays forgets the days a local write touched, and
// requestRefresh fires at most once per range per throttle window.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CalendarEvent } from "@/lib/types";

const backend = vi.hoisted(() => ({
  listEvents: vi.fn(),
  refreshCalendar: vi.fn(),
  listCalendars: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ backend, isTauri: false }));

import {
  clearCalendarThrottle,
  DAY_MS,
  dayKeyOf,
  daysCovered,
  distinctRanges,
  startOfToday,
  useCalendar,
} from "./calendar";

const DAY0 = startOfToday();

function ev(over: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1",
    calendarId: "demo",
    calendar: "Personal",
    color: null,
    title: "Workout",
    startMs: DAY0 + 7 * 3600_000,
    endMs: DAY0 + 8 * 3600_000,
    allDay: false,
    location: null,
    description: null,
    htmlLink: null,
    etag: '"1"',
    status: "confirmed",
    organizerEmail: "you@fission.local",
    organizerSelf: true,
    recurringEventId: null,
    hangoutLink: null,
    attendees: [],
    ...over,
  } as CalendarEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCalendarThrottle();
  backend.refreshCalendar.mockResolvedValue(undefined);
  useCalendar.setState({
    eventsByDay: {},
    loadedDays: {},
    error: null,
    dayOffset: 0,
    watchers: {},
    modalPreview: null,
  });
});

describe("loadRange", () => {
  test("cold range fetches and buckets per day", async () => {
    backend.listEvents.mockResolvedValue([ev({})]);
    await useCalendar.getState().loadRange(DAY0, 7);
    expect(backend.listEvents).toHaveBeenCalledWith(DAY0, DAY0 + 7 * DAY_MS);
    const s = useCalendar.getState();
    expect(s.eventsByDay[DAY0]).toHaveLength(1);
    expect(s.eventsByDay[DAY0 + DAY_MS]).toEqual([]);
    expect(s.loadedDays[DAY0 + 6 * DAY_MS]).toBe(true);
  });

  test("fully cached range is a no-op fetch (pure cache paint)", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().loadRange(DAY0, 7);
    backend.listEvents.mockClear();
    await useCalendar.getState().loadRange(DAY0, 7);
    expect(backend.listEvents).not.toHaveBeenCalled();
  });

  test("partially cached range only fetches the missing days", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().loadRange(DAY0, 7); // week 1 cached
    backend.listEvents.mockClear();
    // shift forward 3 days: days 3-6 are cached, 7-9 are not
    await useCalendar.getState().loadRange(DAY0 + 3 * DAY_MS, 7);
    expect(backend.listEvents).toHaveBeenCalledTimes(1);
    expect(backend.listEvents).toHaveBeenCalledWith(
      DAY0 + 7 * DAY_MS,
      DAY0 + 10 * DAY_MS
    );
  });
});

describe("watched ranges", () => {
  test("calendar:updated re-reads every watched range, not just the last one", async () => {
    // Exactly the calendar screen: the week grid and the day panel are both
    // mounted. With a single activeStart/activeDays slot the panel's 1-day
    // range won and the visible WEEK never refreshed.
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("week", DAY0, 7);
    await useCalendar.getState().watchRange("panel", DAY0 + 3 * DAY_MS, 1);
    backend.listEvents.mockClear();

    useCalendar.getState().handleUpdated(null);
    await vi.waitFor(() => expect(backend.listEvents).toHaveBeenCalled());
    expect(backend.listEvents).toHaveBeenCalledWith(DAY0, DAY0 + 7 * DAY_MS);
  });

  test("a range wholly inside another is not re-read twice", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("week", DAY0, 7);
    await useCalendar.getState().watchRange("panel", DAY0 + 3 * DAY_MS, 1);
    backend.listEvents.mockClear();

    useCalendar.getState().handleUpdated(null);
    await vi.waitFor(() => expect(backend.listEvents).toHaveBeenCalled());
    expect(backend.listEvents).toHaveBeenCalledTimes(1);
  });

  test("unwatching stops a view's range from being re-read", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("panel", DAY0, 1);
    useCalendar.getState().unwatchRange("panel");
    backend.listEvents.mockClear();

    useCalendar.getState().handleUpdated(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.listEvents).not.toHaveBeenCalled();
  });

  test("force re-reads a cached range (the calendar:updated path)", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("week", DAY0, 7);
    backend.listEvents.mockResolvedValue([ev({ title: "New" })]);
    useCalendar.getState().handleUpdated(null);
    await vi.waitFor(() => {
      expect(useCalendar.getState().eventsByDay[DAY0]).toHaveLength(1);
    });
    expect(useCalendar.getState().eventsByDay[DAY0][0].title).toBe("New");
  });
});

describe("invalidateDays", () => {
  test("a create into an already-loaded, watched day lands", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("panel", DAY0, 1);
    expect(useCalendar.getState().eventsByDay[DAY0]).toEqual([]);

    // the write happened; the day is stale
    backend.listEvents.mockResolvedValue([ev({ title: "Standup" })]);
    await useCalendar
      .getState()
      .invalidateDays(daysCovered(DAY0 + 9 * 3600_000, DAY0 + 10 * 3600_000));
    expect(useCalendar.getState().eventsByDay[DAY0]).toHaveLength(1);
    expect(useCalendar.getState().eventsByDay[DAY0][0].title).toBe("Standup");
  });

  test("a day nobody is watching is forgotten, so navigating back refetches", async () => {
    backend.listEvents.mockResolvedValue([]);
    // Wednesday was visited earlier, then the user went back to Monday.
    const wed = DAY0 + 2 * DAY_MS;
    await useCalendar.getState().loadRange(wed, 1);
    await useCalendar.getState().watchRange("panel", DAY0, 1);
    expect(useCalendar.getState().loadedDays[wed]).toBe(true);

    // create an event into Wednesday from the modal's date picker
    await useCalendar.getState().invalidateDays([wed]);
    expect(useCalendar.getState().loadedDays[wed]).toBeUndefined();

    // navigating there now actually reads instead of painting a stale cache
    backend.listEvents.mockClear();
    backend.listEvents.mockResolvedValue([
      ev({ title: "Offsite", startMs: wed + 9 * 3600_000, endMs: wed + 10 * 3600_000 }),
    ]);
    await useCalendar.getState().watchRange("panel", wed, 1);
    expect(backend.listEvents).toHaveBeenCalledWith(wed, wed + DAY_MS);
    expect(useCalendar.getState().eventsByDay[wed][0].title).toBe("Offsite");
  });

  test("moving an event clears the day it left as well as the one it lands on", async () => {
    backend.listEvents.mockResolvedValue([ev({})]);
    await useCalendar.getState().watchRange("week", DAY0, 7);
    const from = DAY0;
    const to = DAY0 + 2 * DAY_MS;

    backend.listEvents.mockResolvedValue([]);
    await useCalendar
      .getState()
      .invalidateDays([
        ...daysCovered(from, from + 3600_000),
        ...daysCovered(to, to + 3600_000),
      ]);
    // both ends re-read; neither keeps the old copy
    expect(useCalendar.getState().eventsByDay[from]).toEqual([]);
    expect(useCalendar.getState().eventsByDay[to]).toEqual([]);
  });

  test("an empty invalidation touches nothing", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("panel", DAY0, 1);
    backend.listEvents.mockClear();
    await useCalendar.getState().invalidateDays([]);
    expect(backend.listEvents).not.toHaveBeenCalled();
  });
});

describe("daysCovered", () => {
  test("a timed event claims one day", () => {
    expect(daysCovered(DAY0 + 9 * 3600_000, DAY0 + 10 * 3600_000)).toEqual([DAY0]);
  });

  test("an event ending exactly at midnight does not claim the next day", () => {
    expect(daysCovered(DAY0 + 23 * 3600_000, DAY0 + DAY_MS)).toEqual([DAY0]);
  });

  test("a multi-day all-day event claims its whole span (end exclusive)", () => {
    expect(daysCovered(DAY0, DAY0 + 3 * DAY_MS)).toEqual([
      DAY0,
      DAY0 + DAY_MS,
      DAY0 + 2 * DAY_MS,
    ]);
  });

  test("a pathological span is capped, not unbounded", () => {
    expect(daysCovered(DAY0, DAY0 + 4000 * DAY_MS)).toHaveLength(400);
  });

  test("day keys land on the same lattice the cache buckets by", () => {
    expect(dayKeyOf(DAY0 + 5 * DAY_MS + 13 * 3600_000)).toBe(DAY0 + 5 * DAY_MS);
    expect(dayKeyOf(DAY0 - DAY_MS + 1)).toBe(DAY0 - DAY_MS);
  });
});

describe("distinctRanges", () => {
  test("drops a contained range, keeps disjoint ones", () => {
    const week = { start: DAY0, days: 7 };
    const day = { start: DAY0 + 3 * DAY_MS, days: 1 };
    const next = { start: DAY0 + 7 * DAY_MS, days: 7 };
    expect(distinctRanges([week, day])).toEqual([week]);
    expect(distinctRanges([day, week])).toEqual([week]);
    expect(distinctRanges([week, next])).toEqual([week, next]);
  });

  test("identical ranges collapse to one", () => {
    const a = { start: DAY0, days: 1 };
    expect(distinctRanges([a, { ...a }])).toHaveLength(1);
  });
});

describe("requestRefresh", () => {
  test("throttles repeat requests for the same range", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("week", DAY0, 7);
    useCalendar.getState().requestRefresh("week");
    useCalendar.getState().requestRefresh("week");
    expect(backend.refreshCalendar).toHaveBeenCalledTimes(1);
  });

  test("two views on the SAME range still only ask once", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("week", DAY0, 7);
    await useCalendar.getState().watchRange("other", DAY0, 7);
    useCalendar.getState().requestRefresh("week");
    useCalendar.getState().requestRefresh("other");
    expect(backend.refreshCalendar).toHaveBeenCalledTimes(1);
  });

  test("a different range still fires immediately", async () => {
    backend.listEvents.mockResolvedValue([]);
    await useCalendar.getState().watchRange("week", DAY0, 7);
    useCalendar.getState().requestRefresh("week");
    await useCalendar.getState().watchRange("week", DAY0 + 7 * DAY_MS, 7);
    useCalendar.getState().requestRefresh("week");
    expect(backend.refreshCalendar).toHaveBeenCalledTimes(2);
  });

  test("an unregistered key asks for nothing", () => {
    useCalendar.getState().requestRefresh("panel");
    expect(backend.refreshCalendar).not.toHaveBeenCalled();
  });
});
