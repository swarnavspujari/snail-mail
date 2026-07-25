import { useEffect, useMemo, useRef, useState } from "react";
import { HoverHint } from "@/components/HoverHint";
import { Kbd } from "@/components/Kbd";
import {
  assignCalendarHues,
  calendarHue,
  hueVar,
} from "@/lib/calendar-view";
import { DAY_MS, startOfToday, useCalendar } from "@/stores/calendar";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import type { CalendarEvent } from "@/lib/types";

const FIRST_HOUR = 7;
const LAST_HOUR = 20;
const PX_PER_HOUR = 52;

function hourLabel(h: number): string {
  if (h === 12) return "12 pm";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

function timeRange(e: CalendarEvent): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${fmt(e.startMs)} – ${fmt(e.endMs)}`;
}

/** RSVP tint: events you declined fade, pending invites get a dashed edge. */
export function rsvpClasses(e: CalendarEvent): string {
  const self = e.attendees.find((a) => a.self);
  if (!self || e.organizerSelf) return "";
  if (self.responseStatus === "declined") return "opacity-40 line-through";
  if (self.responseStatus === "needsAction" || self.responseStatus === "tentative")
    return "border-dashed";
  return "";
}

function EventBlock({
  e,
  dayStart,
  hue,
}: {
  e: CalendarEvent;
  dayStart: number;
  hue: string;
}) {
  const gridStart = dayStart + FIRST_HOUR * 3600_000;
  const gridEnd = dayStart + LAST_HOUR * 3600_000;
  const s = Math.max(e.startMs, gridStart);
  const end = Math.min(Math.max(e.endMs, s + 15 * 60_000), gridEnd);
  if (end <= gridStart || s >= gridEnd) return null;
  const top = ((s - gridStart) / 3600_000) * PX_PER_HOUR;
  const height = Math.max(20, ((end - s) / 3600_000) * PX_PER_HOUR - 2);
  const past = e.endMs < Date.now();
  return (
    <button
      className={`cal-block absolute left-1 right-1 overflow-hidden rounded-md py-1 pl-[11px] pr-2 text-left ${
        past ? "opacity-55" : ""
      } ${rsvpClasses(e)}`}
      style={{ top, height, "--ev": hue } as React.CSSProperties}
      title={`${e.title} · ${timeRange(e)}${e.location ? ` · ${e.location}` : ""} · ${e.calendar}`}
      onMouseDown={(ev) => {
        // keep slot-drag from starting, but still hand the panel keyboard
        // focus like any other click inside the aside
        ev.stopPropagation();
        useUi.getState().setFocusRegion("calendar");
      }}
      onClick={(ev) => {
        ev.stopPropagation();
        useCalendar.getState().openPopover(e, ev.clientX, ev.clientY);
      }}
    >
      <div className="truncate text-[12px] font-medium leading-4 text-ink">
        {e.title}
      </div>
      {height > 34 && (
        <div className="truncate text-[11px] text-ink-3">{timeRange(e)}</div>
      )}
    </button>
  );
}

const MINI_DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** Navigable mini-month: today filled with the accent, the focused day (and
 *  the focused week, while the week view is open) banded; click any day to
 *  jump the agenda — and the week view's range with it. */
function MiniMonth({ dayStart }: { dayStart: number }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const weekViewOpen = useUi((s) => s.screen === "calendar");
  const focused = new Date(dayStart);
  // follow the agenda when it moves to another month
  useEffect(() => setMonthOffset(0), [dayStart]);

  const view = new Date(focused.getFullYear(), focused.getMonth() + monthOffset, 1);
  const gridStart = new Date(
    view.getFullYear(),
    view.getMonth(),
    1 - view.getDay()
  );
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i
    );
    return { ms: d.getTime(), date: d.getDate(), inMonth: d.getMonth() === view.getMonth() };
  });
  const today = startOfToday();
  const weekStart = dayStart - new Date(dayStart).getDay() * DAY_MS;
  const weekEnd = weekStart + 6 * DAY_MS;
  const label = view.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const navBtn =
    "flex h-[22px] w-[22px] items-center justify-center rounded-md text-[14px] text-ink-3 hover:bg-hover hover:text-ink";

  return (
    <div>
      <div className="mb-2 flex items-center">
        <span className="flex-1 text-[13.5px] font-semibold text-ink">{label}</span>
        <HoverHint label="Previous month" placement="bottom">
          <button
            className={navBtn}
            aria-label="Previous month"
            onClick={() => setMonthOffset((o) => o - 1)}
          >
            ‹
          </button>
        </HoverHint>
        <HoverHint label="Next month" placement="bottom">
          <button
            className={navBtn}
            aria-label="Next month"
            onClick={() => setMonthOffset((o) => o + 1)}
          >
            ›
          </button>
        </HoverHint>
      </div>
      <div className="grid grid-cols-7 gap-y-px">
        {MINI_DOW.map((d, i) => (
          <div
            key={i}
            className="pb-0.5 text-center text-[10.5px] font-medium text-ink-3"
          >
            {d}
          </div>
        ))}
        {cells.map((c) => {
          const isToday = c.ms === today;
          const isFocused = c.ms === dayStart;
          const inWeek = weekViewOpen && c.ms >= weekStart && c.ms <= weekEnd;
          return (
            <button
              key={c.ms}
              onClick={() => useCalendar.getState().goToDay(c.ms)}
              className={`flex h-[26px] items-center justify-center rounded-full text-[12px] tabular-nums ${
                isToday
                  ? "bg-accent font-bold text-on-accent"
                  : isFocused
                    ? "bg-selected font-semibold text-ink"
                    : inWeek
                      ? "bg-hover font-semibold text-ink-2"
                      : c.inMonth
                        ? "text-ink-2 hover:bg-hover"
                        : "text-ink-3 opacity-45 hover:bg-hover"
              }`}
            >
              {c.date}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Filled-with-its-hue calendar checkbox (design system calendar panel). */
function CalCheck({ hue, on }: { hue: string; on: boolean }) {
  return (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[11px] leading-none text-on-accent"
      style={
        on
          ? { background: hue }
          : { border: `1.5px solid color-mix(in oklab, ${hue} 55%, transparent)` }
      }
    >
      {on ? "✓" : ""}
    </span>
  );
}

/** The account's calendars, grouped under its email: each row a color-coded
 *  checkbox that shows/hides that calendar's events live in both views. The
 *  choice persists in settings. */
function CalendarsList() {
  const calendars = useCalendar((s) => s.calendars);
  const hiddenCalendars = useSettings((s) => s.settings.hiddenCalendars);
  const account = useSettings((s) => s.accounts.active);
  const [expanded, setExpanded] = useState(true);
  const hues = useMemo(() => assignCalendarHues(calendars), [calendars]);
  if (calendars.length === 0) return null;
  const hidden = new Set(hiddenCalendars);

  const toggle = (id: string) => {
    const s = useSettings.getState();
    const cur = s.settings.hiddenCalendars;
    void s.save({
      hiddenCalendars: cur.includes(id)
        ? cur.filter((h) => h !== id)
        : [...cur, id],
    });
  };

  return (
    <div>
      <div className="px-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
        Calendars
      </div>
      <button
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-hover"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink-2">
          {account}
        </span>
        <span
          className="text-[10px] text-ink-3 transition-transform"
          style={{ transform: expanded ? "none" : "rotate(-90deg)" }}
        >
          ▼
        </span>
      </button>
      {expanded &&
        calendars.map((c) => {
          const on = !hidden.has(c.id);
          return (
            <button
              key={c.id}
              className="flex w-full items-center gap-2.5 rounded-md px-1 py-[5px] text-left hover:bg-hover"
              onClick={() => toggle(c.id)}
              title={on ? `Hide ${c.name}` : `Show ${c.name}`}
            >
              <CalCheck hue={hueVar(calendarHue(hues, c.id))} on={on} />
              <span
                className={`min-w-0 flex-1 truncate text-[12.5px] ${
                  on ? "text-ink" : "text-ink-3"
                }`}
              >
                {c.name}
              </span>
            </button>
          );
        })}
    </div>
  );
}

/** Right-hand day calendar, Superhuman-style: toggleable, painted instantly
 *  from the shared day-keyed cache; a background sync keeps it fresh. A
 *  navigable mini-month and the color-coded calendars list sit above the
 *  agenda. ←/→ move days while the panel has focus. Click an event for
 *  details/RSVP; click or drag an empty slot to create one. */
export function CalendarPanel() {
  const dayOffset = useCalendar((s) => s.dayOffset);
  const events = useCalendar((s) => s.eventsByDay);
  const loadedDays = useCalendar((s) => s.loadedDays);
  const calendars = useCalendar((s) => s.calendars);
  const error = useCalendar((s) => s.error);
  const hiddenCalendars = useSettings((s) => s.settings.hiddenCalendars);
  const focused = useUi((s) => s.focusRegion === "calendar");
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  const [nowTick, setNowTick] = useState(Date.now());
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayStart = useMemo(() => startOfToday() + dayOffset * DAY_MS, [dayOffset]);
  const hues = useMemo(() => assignCalendarHues(calendars), [calendars]);
  const hidden = useMemo(() => new Set(hiddenCalendars), [hiddenCalendars]);

  useEffect(() => {
    const cal = useCalendar.getState();
    void cal.loadRange(dayStart, 1);
    cal.requestRefresh();
  }, [dayStart]);

  useEffect(() => {
    // The list survives in the store across remounts; the event modal
    // (openCreate/openEdit) still fetches fresh every time.
    if (useCalendar.getState().calendars.length === 0)
      void useCalendar.getState().loadCalendars();
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Center the current time in view on open (Google-style); no-op when the
  // 7am–8pm grid already fits.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const now = new Date();
    const nowH = now.getHours() + now.getMinutes() / 60;
    const clamped = Math.min(LAST_HOUR, Math.max(FIRST_HOUR, nowH));
    const target = (clamped - FIRST_HOUR) * PX_PER_HOUR;
    el.scrollTop = Math.max(0, target - el.clientHeight / 2);
  }, []);

  /** Snap a pointer y to a 30-minute slot inside the visible hours. */
  const msAtY = (clientY: number): number => {
    const rect = gridRef.current!.getBoundingClientRect();
    const hours = (clientY - rect.top) / PX_PER_HOUR + FIRST_HOUR;
    const snapped = Math.round(hours * 2) / 2;
    return dayStart + Math.min(LAST_HOUR, Math.max(FIRST_HOUR, snapped)) * 3600_000;
  };

  const beginSlotDrag = (ev: React.MouseEvent) => {
    if (ev.button !== 0 || !gridRef.current) return;
    const from = msAtY(ev.clientY);
    setDrag({ from, to: from + 30 * 60_000 });
    const move = (e: MouseEvent) => {
      const to = msAtY(e.clientY);
      const next = to > from ? to : from + 30 * 60_000;
      // mousemove fires at pointer rate; only re-render on a new 30-min slot
      setDrag((d) => (d && d.to === next ? d : { from, to: next }));
    };
    const up = (e: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      const to = msAtY(e.clientY);
      const start = Math.min(from, to);
      let end = Math.max(from, to);
      if (end - start < 30 * 60_000) end = start + 3600_000; // plain click = 1h
      useCalendar.getState().openCreate(start, end);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const dayEvents = (events[dayStart] ?? []).filter(
    (e) => !hidden.has(e.calendarId)
  );
  const loading = !loadedDays[dayStart];
  const timed = dayEvents.filter((e) => !e.allDay);
  const allDay = dayEvents.filter((e) => e.allDay);
  const isToday = dayOffset === 0;
  const nowTop =
    isToday && nowTick > dayStart + FIRST_HOUR * 3600_000 && nowTick < dayStart + LAST_HOUR * 3600_000
      ? ((nowTick - dayStart - FIRST_HOUR * 3600_000) / 3600_000) * PX_PER_HOUR
      : null;

  const title = new Date(dayStart).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const dragTop = drag
    ? ((Math.min(drag.from, drag.to) - dayStart - FIRST_HOUR * 3600_000) / 3600_000) *
      PX_PER_HOUR
    : 0;
  const dragHeight = drag
    ? (Math.abs(drag.to - drag.from) / 3600_000) * PX_PER_HOUR
    : 0;

  const navBtn =
    "rounded-md border border-line px-2 py-0.5 text-ink-3 hover:bg-hover hover:text-ink";

  return (
    <aside
      onMouseDown={() => useUi.getState().setFocusRegion("calendar")}
      className={`flex w-64 shrink-0 flex-col border-l bg-surface 2xl:w-72 ${
        focused ? "border-accent/40" : "border-line"
      }`}
    >
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="flex-1 text-[14px] font-semibold text-ink">
          {title}
          {!isToday && (
            <button
              className="ml-2 rounded px-1.5 text-[11px] text-accent-strong hover:bg-hover"
              onClick={() => useCalendar.getState().goToday()}
            >
              today
            </button>
          )}
        </span>
        {focused && keyHints && (
          <span className="text-[10.5px] text-ink-3">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
          </span>
        )}
        <HoverHint label="New event" command="calendar.newEvent" placement="bottom">
          <button
            className={navBtn}
            aria-label="New event"
            onClick={() => {
              const start = dayStart + 9 * 3600_000;
              useCalendar.getState().openCreate(start, start + 3600_000);
            }}
          >
            +
          </button>
        </HoverHint>
        <HoverHint label="Previous day" command="calendar.prevDay" placement="bottom">
          <button
            className={navBtn}
            aria-label="Previous day"
            onClick={() => useCalendar.getState().shiftDay(-1)}
          >
            ‹
          </button>
        </HoverHint>
        <HoverHint label="Next day" command="calendar.nextDay" placement="bottom">
          <button
            className={navBtn}
            aria-label="Next day"
            onClick={() => useCalendar.getState().shiftDay(1)}
          >
            ›
          </button>
        </HoverHint>
      </div>

      <div className="shrink-0 space-y-2 border-b border-line px-3 pb-2">
        <MiniMonth dayStart={dayStart} />
        <CalendarsList />
      </div>

      {allDay.length > 0 && (
        <div className="space-y-1 px-4 pb-2 pt-2">
          {allDay.map((e) => (
            <button
              key={e.id}
              className={`cal-block block w-full truncate rounded-md py-1 pl-[11px] pr-2 text-left text-[12px] font-medium text-ink ${rsvpClasses(e)}`}
              style={
                {
                  "--ev": hueVar(calendarHue(hues, e.calendarId)),
                } as React.CSSProperties
              }
              title={`${e.title} · ${e.calendar}`}
              onClick={(ev) =>
                useCalendar.getState().openPopover(e, ev.clientX, ev.clientY)
              }
            >
              {e.title}
            </button>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          // The Rust core classifies the cause (API-not-enabled vs. missing
          // scope vs. generic) into actionable guidance — show it verbatim.
          <div className="px-4 py-6 text-[12px] leading-relaxed text-ink-3">
            {error}
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 pt-12 text-[12px] text-ink-3">
            <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
            Loading calendar…
          </div>
        ) : (
          <div className="relative mx-3 my-2" style={{ height: (LAST_HOUR - FIRST_HOUR) * PX_PER_HOUR }}>
            {Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => (
              <div
                key={i}
                className="absolute left-0 right-0 border-t border-line"
                style={{ top: i * PX_PER_HOUR }}
              >
                <span className="absolute -top-2 left-0 bg-surface pr-1 text-[10.5px] text-ink-3">
                  {hourLabel(FIRST_HOUR + i)}
                </span>
              </div>
            ))}
            <div
              ref={gridRef}
              className="absolute bottom-0 left-12 right-0 top-0 cursor-crosshair"
              onMouseDown={beginSlotDrag}
              title="Click or drag to create an event"
            >
              {timed.map((e) => (
                <EventBlock
                  key={e.id}
                  e={e}
                  dayStart={dayStart}
                  hue={hueVar(calendarHue(hues, e.calendarId))}
                />
              ))}
              {drag && (
                <div
                  className="pointer-events-none absolute left-1 right-1 rounded-md border border-accent/60 bg-accent-dim/70"
                  style={{ top: dragTop, height: Math.max(dragHeight, 12) }}
                />
              )}
              {timed.length === 0 && !drag && (
                <div className="pointer-events-none pt-10 text-center text-[12px] text-ink-3">
                  Nothing scheduled.
                </div>
              )}
            </div>
            {nowTop !== null && (
              <div
                className="pointer-events-none absolute left-10 right-0 border-t-2 border-bad"
                style={{ top: nowTop }}
              >
                <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-bad" />
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
