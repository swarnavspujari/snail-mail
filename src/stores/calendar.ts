// Shared, day-keyed event cache so the panel and week view paint instantly
// on reopen/navigation. Reads are local (SQLite / demo fixtures); freshness
// arrives via refreshCalendar + the calendar:updated event. Event modal +
// popover state lives here too (they belong to the calendar views).
//
// Visible ranges are a REGISTRY, not a single slot: the calendar screen mounts
// the week grid (7 days) and the day panel (1 day) at the same time, and a
// single activeStart/activeDays pair meant whichever mounted last won — so
// every calendar:updated re-read one day and left the week stale. Each view
// registers its own range under a key; updates re-read all of them.
import { create } from "zustand";
import { backend } from "@/lib/ipc";
import type { CalendarEvent, CalendarInfo } from "@/lib/types";

export const DAY_MS = 24 * 3600_000;

/** Longest span a single event may invalidate. A decade-long entry (they
 *  exist) must not turn one write into thousands of cache keys. */
const MAX_SPAN_DAYS = 400;

// One requestRefresh per range per window (see requestRefresh below).
const REFRESH_THROTTLE_MS = 30_000;
const refreshRequestedAt = new Map<string, number>();

/** Test hook: forget which ranges were recently refresh-requested. */
export function clearCalendarThrottle() {
  refreshRequestedAt.clear();
}

export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Snap an instant onto the day-key lattice the cache uses (`startOfToday() +
 *  n * DAY_MS`, the same arithmetic both views derive their columns from), so
 *  an invalidation key always names a real bucket. */
export function dayKeyOf(ms: number): number {
  const base = startOfToday();
  return base + Math.floor((ms - base) / DAY_MS) * DAY_MS;
}

/** The day keys an event occupies. `endMs` is exclusive both for all-day
 *  events (model-level) and timed ones, so an event ending exactly at midnight
 *  does not claim the next day. */
export function daysCovered(startMs: number, endMs: number): number[] {
  const first = dayKeyOf(startMs);
  const last = dayKeyOf(Math.max(startMs, endMs - 1));
  const out: number[] = [];
  for (let d = first; d <= last && out.length < MAX_SPAN_DAYS; d += DAY_MS) {
    out.push(d);
  }
  return out;
}

/** One view's visible range. */
export interface WatchedRange {
  start: number;
  days: number;
}

/** Ranges to actually re-read: a range wholly inside another is dropped, so
 *  the panel's single day doesn't cost a second query when the week that
 *  contains it is already being re-read. */
export function distinctRanges(ranges: WatchedRange[]): WatchedRange[] {
  const covers = (a: WatchedRange, b: WatchedRange) =>
    a.start <= b.start && a.start + a.days * DAY_MS >= b.start + b.days * DAY_MS;
  return ranges.filter(
    (r, i) =>
      !ranges.some((other, j) => j !== i && covers(other, r) && (j < i || !covers(r, other)))
  );
}

/** Is this day key inside any of these ranges? */
export function rangesCover(ranges: WatchedRange[], day: number): boolean {
  return ranges.some((r) => day >= r.start && day < r.start + r.days * DAY_MS);
}

/** The create/edit event modal. */
export interface EventModalState {
  mode: "create" | "edit";
  /** Edit target (carries id/etag/calendarId + guest context); null = create. */
  event: CalendarEvent | null;
  /** Prefill for create (from a clicked/dragged slot or "New event"). */
  startMs: number;
  endMs: number;
  allDay: boolean;
}

/** The modal's UNCOMMITTED placement, republished on every start/end edit so
 *  the day grid can show a ghost block where the event would land. Never
 *  persisted and never clickable — it is not an event yet. */
export interface EventPreview {
  startMs: number;
  endMs: number;
  allDay: boolean;
}

/** The event-details popover, anchored at the click point. */
export interface EventPopoverState {
  event: CalendarEvent;
  x: number;
  y: number;
}

interface CalendarState {
  /** dayStart (local midnight ms) → events overlapping that day. */
  eventsByDay: Record<number, CalendarEvent[]>;
  /** Days a local read has completed for — anything else shows as loading. */
  loadedDays: Record<number, true>;
  error: string | null;
  /** Days from today for the focused day (panel + week view selection). */
  dayOffset: number;
  /** Ranges the mounted views are showing, keyed by view ("week", "panel"). */
  watchers: Record<string, WatchedRange>;
  /** The account's calendars (modal selector; owner/writer = writable). */
  calendars: CalendarInfo[];
  modal: EventModalState | null;
  modalPreview: EventPreview | null;
  popover: EventPopoverState | null;

  shiftDay: (delta: number) => void;
  goToday: () => void;
  /** Jump the focused day to a local-midnight ms (mini-month click). */
  goToDay: (dayStartMs: number) => void;
  /** Local read of [dayStart, dayStart + days), bucketed per day. Days
   *  already in the cache are skipped unless `force` (the calendar:updated
   *  reconcile path) — navigation over loaded days is a pure cache paint. */
  loadRange: (dayStart: number, days: number, opts?: { force?: boolean }) => Promise<void>;
  /** Register (or move) a view's visible range and load it. */
  watchRange: (key: string, dayStart: number, days: number) => Promise<void>;
  /** The view unmounted — stop re-reading its range. */
  unwatchRange: (key: string) => void;
  /** Ask the backend for fresh data around a watched range. */
  requestRefresh: (key: string) => void;
  /** calendar:updated landed — re-read every watched range / surface errors. */
  handleUpdated: (error: string | null) => void;
  /** A local write changed these days: forget them, then re-read whichever
   *  watched ranges cover them. Days nobody is watching just become unloaded
   *  and refetch on navigation — which is the half the optimistic insert and
   *  the single-range reconcile both missed. */
  invalidateDays: (days: number[]) => Promise<void>;
  /** Refresh the calendarList for the modal's selector. */
  loadCalendars: () => Promise<void>;
  openCreate: (startMs: number, endMs: number, allDay?: boolean) => void;
  openEdit: (event: CalendarEvent) => void;
  closeModal: () => void;
  setModalPreview: (p: EventPreview | null) => void;
  openPopover: (event: CalendarEvent, x: number, y: number) => void;
  closePopover: () => void;
}

export const useCalendar = create<CalendarState>((set, get) => ({
  eventsByDay: {},
  loadedDays: {},
  error: null,
  dayOffset: 0,
  watchers: {},
  calendars: [],
  modal: null,
  modalPreview: null,
  popover: null,

  shiftDay: (delta) => set((s) => ({ dayOffset: s.dayOffset + delta })),
  goToday: () => set({ dayOffset: 0 }),
  goToDay: (dayStartMs) =>
    set({ dayOffset: Math.round((dayStartMs - startOfToday()) / DAY_MS) }),

  loadRange: async (dayStart, days, opts) => {
    // Trim already-loaded days off both ends of the range; a fully cached
    // range is a no-op (the views paint straight from eventsByDay).
    let from = dayStart;
    let to = dayStart + days * DAY_MS;
    if (!opts?.force) {
      const loadedDays = get().loadedDays;
      while (from < to && loadedDays[from]) from += DAY_MS;
      while (to > from && loadedDays[to - DAY_MS]) to -= DAY_MS;
      if (from >= to) return;
    }
    try {
      const events = await backend.listEvents(from, to);
      const byDay: Record<number, CalendarEvent[]> = {};
      const loaded: Record<number, true> = {};
      for (let d = from; d < to; d += DAY_MS) {
        byDay[d] = events.filter((e) => e.startMs < d + DAY_MS && e.endMs > d);
        loaded[d] = true;
      }
      set((s) => ({
        eventsByDay: { ...s.eventsByDay, ...byDay },
        loadedDays: { ...s.loadedDays, ...loaded },
        error: null,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  watchRange: async (key, dayStart, days) => {
    set((s) => ({ watchers: { ...s.watchers, [key]: { start: dayStart, days } } }));
    await get().loadRange(dayStart, days);
  },

  unwatchRange: (key) =>
    set((s) => {
      if (!(key in s.watchers)) return {};
      const watchers = { ...s.watchers };
      delete watchers[key];
      return { watchers };
    }),

  requestRefresh: (key) => {
    const range = get().watchers[key];
    if (!range) return;
    // One background sync per range per window: day/week nav shouldn't spam
    // the network (the core throttles too; the mock echoes synchronously).
    // Keyed by the RANGE, not the view — the panel and the week asking for the
    // same span is still one request. Freshness after writes is untouched:
    // that flows through calendar:updated / invalidateDays, which re-read.
    const throttleKey = `${range.start}:${range.days}`;
    const last = refreshRequestedAt.get(throttleKey) ?? 0;
    if (Date.now() - last < REFRESH_THROTTLE_MS) return;
    refreshRequestedAt.set(throttleKey, Date.now());
    void backend
      .refreshCalendar(range.start, range.start + range.days * DAY_MS)
      .catch(() => {});
  },

  handleUpdated: (error) => {
    if (error) {
      set({ error });
      return;
    }
    for (const r of distinctRanges(Object.values(get().watchers))) {
      void get().loadRange(r.start, r.days, { force: true });
    }
  },

  invalidateDays: async (days) => {
    if (days.length === 0) return;
    set((s) => {
      const loadedDays = { ...s.loadedDays };
      const eventsByDay = { ...s.eventsByDay };
      for (const d of days) {
        delete loadedDays[d];
        delete eventsByDay[d];
      }
      return { loadedDays, eventsByDay };
    });
    // The days are gone from the cache, so a plain (unforced) loadRange over a
    // watched range refetches exactly them and nothing else.
    const touched = distinctRanges(Object.values(get().watchers)).filter((r) =>
      days.some((d) => d >= r.start && d < r.start + r.days * DAY_MS)
    );
    await Promise.all(touched.map((r) => get().loadRange(r.start, r.days)));
  },

  loadCalendars: async () => {
    try {
      set({ calendars: await backend.listCalendars() });
    } catch {
      // selector falls back to the event's own calendar
    }
  },

  openCreate: (startMs, endMs, allDay = false) => {
    void get().loadCalendars();
    set({
      popover: null,
      modal: { mode: "create", event: null, startMs, endMs, allDay },
      modalPreview: { startMs, endMs, allDay },
    });
  },

  openEdit: (event) => {
    void get().loadCalendars();
    set({
      popover: null,
      modal: {
        mode: "edit",
        event,
        startMs: event.startMs,
        endMs: event.endMs,
        allDay: event.allDay,
      },
      modalPreview: {
        startMs: event.startMs,
        endMs: event.endMs,
        allDay: event.allDay,
      },
    });
  },

  closeModal: () => set({ modal: null, modalPreview: null }),
  setModalPreview: (p) => set({ modalPreview: p }),
  openPopover: (event, x, y) => set({ popover: { event, x, y } }),
  closePopover: () => set({ popover: null }),
}));

/** Is this day key on screen in any mounted calendar view? Drives whether the
 *  placement preview needs to move the view to itself. */
export function dayIsWatched(day: number): boolean {
  return rangesCover(Object.values(useCalendar.getState().watchers), day);
}
