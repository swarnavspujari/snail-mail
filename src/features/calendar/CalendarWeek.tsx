// Full-screen week view (design system calendar week): a 24-hour, 7-day grid
// — every hour rendered, the pane scrolls internally and opens at ~7am — with
// an all-day lane, today-column tint + live now-line, and ‹ › week nav.
// Events draw in their calendar's --cal-* hue, pack side by side when they
// overlap, and respect the side panel's show/hide checkboxes. Click an event
// for details/RSVP; click or drag an empty slot to create one.
import { useEffect, useMemo, useRef, useState } from "react";
import { HoverHint } from "@/components/HoverHint";
import { Kbd } from "@/components/Kbd";
import {
  assignCalendarHues,
  calendarHue,
  hueVar,
  packDay,
  type PackSlot,
} from "@/lib/calendar-view";
import { DAY_MS, startOfToday, useCalendar } from "@/stores/calendar";
import { useSettings } from "@/stores/settings";
import { rsvpClasses } from "./DayAgenda";
import type { CalendarEvent } from "@/lib/types";

const PX_PER_HOUR = 48;
const GRID_HEIGHT = 24 * PX_PER_HOUR;
const OPEN_AT_HOUR = 7; // scroll position on open — the workday's top

function hourLabel(h: number): string {
  if (h === 0) return "12 am";
  if (h === 12) return "12 pm";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

function timeRange(e: CalendarEvent): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${fmt(e.startMs)} – ${fmt(e.endMs)}`;
}

function WeekEvent({
  e,
  dayStart,
  slot,
  hue,
}: {
  e: CalendarEvent;
  dayStart: number;
  slot: PackSlot;
  hue: string;
}) {
  const gridEnd = dayStart + DAY_MS;
  const s = Math.max(e.startMs, dayStart);
  const end = Math.min(Math.max(e.endMs, s + 15 * 60_000), gridEnd);
  if (end <= dayStart || s >= gridEnd) return null;
  const top = ((s - dayStart) / 3600_000) * PX_PER_HOUR;
  const height = Math.max(16, ((end - s) / 3600_000) * PX_PER_HOUR - 2);
  const past = e.endMs < Date.now();
  return (
    <button
      className={`cal-block absolute overflow-hidden rounded-[5px] py-0.5 pl-[9px] pr-1.5 text-left ${
        past ? "opacity-55" : ""
      } ${rsvpClasses(e)}`}
      style={
        {
          top,
          height,
          left: `calc(${(slot.col / slot.cols) * 100}% + 1px)`,
          width: `calc(${100 / slot.cols}% - 2px)`,
          "--ev": hue,
        } as React.CSSProperties
      }
      title={`${e.title} · ${timeRange(e)}${e.location ? ` · ${e.location}` : ""} · ${e.calendar}`}
      onMouseDown={(ev) => ev.stopPropagation()}
      onClick={(ev) => {
        ev.stopPropagation();
        useCalendar.getState().openPopover(e, ev.clientX, ev.clientY);
      }}
    >
      <div className="truncate text-[11.5px] font-medium leading-[15px] text-ink">
        {e.title}
      </div>
      {height >= 30 && (
        <div className="truncate text-[10.5px] leading-[14px] text-ink-3">
          {timeRange(e)}
        </div>
      )}
    </button>
  );
}

export function CalendarWeek() {
  const dayOffset = useCalendar((s) => s.dayOffset);
  const eventsByDay = useCalendar((s) => s.eventsByDay);
  const loadedDays = useCalendar((s) => s.loadedDays);
  const calendars = useCalendar((s) => s.calendars);
  const error = useCalendar((s) => s.error);
  const hiddenCalendars = useSettings((s) => s.settings.hiddenCalendars);
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  const [nowTick, setNowTick] = useState(Date.now());
  const [drag, setDrag] = useState<{ day: number; from: number; to: number } | null>(
    null
  );
  const preview = useCalendar((s) => s.modalPreview);
  const colRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const focusedDay = useMemo(
    () => startOfToday() + dayOffset * DAY_MS,
    [dayOffset]
  );
  // week starts on Sunday, local time
  const weekStart = useMemo(
    () => focusedDay - new Date(focusedDay).getDay() * DAY_MS,
    [focusedDay]
  );
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => weekStart + i * DAY_MS),
    [weekStart]
  );
  const today = startOfToday();
  const hues = useMemo(() => assignCalendarHues(calendars), [calendars]);
  const hidden = useMemo(() => new Set(hiddenCalendars), [hiddenCalendars]);

  useEffect(() => {
    const cal = useCalendar.getState();
    void cal.watchRange("week", weekStart, 7);
    cal.requestRefresh("week");
    return () => useCalendar.getState().unwatchRange("week");
  }, [weekStart]);

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

  // All 24 hours exist in the grid; open with the workday at the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = OPEN_AT_HOUR * PX_PER_HOUR - 8;
  }, []);

  /** Snap a pointer y (within a day column) to a 30-minute slot. */
  const msAtY = (day: number, clientY: number): number => {
    const col = colRefs.current[day];
    if (!col) return day + 9 * 3600_000;
    const rect = col.getBoundingClientRect();
    const hours = (clientY - rect.top) / PX_PER_HOUR;
    const snapped = Math.round(hours * 2) / 2;
    return day + Math.min(24, Math.max(0, snapped)) * 3600_000;
  };

  const beginSlotDrag = (day: number) => (ev: React.MouseEvent) => {
    if (ev.button !== 0) return;
    const from = msAtY(day, ev.clientY);
    setDrag({ day, from, to: from + 30 * 60_000 });
    const move = (e: MouseEvent) => {
      const to = msAtY(day, e.clientY);
      const next = to > from ? to : from + 30 * 60_000;
      // mousemove fires at pointer rate; only re-render on a new 30-min slot
      setDrag((d) => (d && d.to === next ? d : { day, from, to: next }));
    };
    const up = (e: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDrag(null);
      const to = msAtY(day, e.clientY);
      const start = Math.min(from, to);
      let end = Math.max(from, to);
      if (end - start < 30 * 60_000) end = start + 3600_000; // plain click = 1h
      useCalendar.getState().openCreate(start, end);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const visible = (d: number): CalendarEvent[] =>
    (eventsByDay[d] ?? []).filter((e) => !hidden.has(e.calendarId));

  /** Where the open modal's event would land in this day's column — the
   *  placement preview, shown before you commit. */
  const ghostIn = (d: number): { top: number; height: number } | null => {
    if (!preview || preview.allDay) return null;
    const gridEnd = d + DAY_MS;
    // Overlap first, THEN clamp. Clamping first turns every later day into a
    // 15-minute sliver at midnight — a real event never hits this because the
    // store already bucketed it into its own day; the ghost isn't bucketed.
    if (preview.endMs <= d || preview.startMs >= gridEnd) return null;
    const s = Math.max(preview.startMs, d);
    const e = Math.min(Math.max(preview.endMs, s + 15 * 60_000), gridEnd);
    return {
      top: ((s - d) / 3600_000) * PX_PER_HOUR,
      height: Math.max(16, ((e - s) / 3600_000) * PX_PER_HOUR - 2),
    };
  };
  const ghostAllDayOn = (d: number): boolean =>
    !!preview && preview.allDay && preview.startMs < d + DAY_MS && preview.endMs > d;

  const weekEnd = weekStart + 6 * DAY_MS;
  const monthTitle =
    new Date(weekStart).getMonth() === new Date(weekEnd).getMonth()
      ? new Date(weekStart).toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        })
      : `${new Date(weekStart).toLocaleDateString(undefined, { month: "short" })} – ${new Date(
          weekEnd
        ).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
  const loading = days.some((d) => !loadedDays[d]);
  const nowTop = ((nowTick - today) / 3600_000) * PX_PER_HOUR;
  const hasAllDay = days.some((d) => visible(d).some((e) => e.allDay));
  const tz =
    new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "";

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-6 py-3">
        <span className="text-[20px] font-semibold tracking-tight text-ink">
          {monthTitle}
        </span>
        <HoverHint label="Previous week" placement="bottom">
          <button
            className="rounded-md border border-line px-2 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
            onClick={() => useCalendar.getState().shiftDay(-7)}
            aria-label="Previous week"
          >
            ‹
          </button>
        </HoverHint>
        <HoverHint label="Next week" placement="bottom">
          <button
            className="rounded-md border border-line px-2 py-0.5 text-ink-3 hover:bg-hover hover:text-ink"
            onClick={() => useCalendar.getState().shiftDay(7)}
            aria-label="Next week"
          >
            ›
          </button>
        </HoverHint>
        <HoverHint label="Today" command="calendar.today" placement="bottom">
          <button
            className="rounded-md border border-line-strong px-2.5 py-0.5 text-[12px] text-ink-2 hover:bg-hover hover:text-ink"
            onClick={() => useCalendar.getState().goToday()}
          >
            Today
          </button>
        </HoverHint>
        <HoverHint label="New event" command="calendar.newEvent" placement="bottom">
          <button
            className="rounded-md bg-accent px-2.5 py-0.5 text-[12px] font-medium text-on-accent hover:opacity-90"
            onClick={() => {
              const start = focusedDay + 9 * 3600_000;
              useCalendar.getState().openCreate(start, start + 3600_000);
            }}
            aria-label="New event"
          >
            New event
          </button>
        </HoverHint>
        {loading && (
          <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
        )}
        <div className="flex-1" />
        {keyHints && (
          <span className="text-[11px] text-ink-3">
            <Kbd>←</Kbd>/<Kbd>→</Kbd> day · <Kbd>Esc</Kbd> back to mail
          </span>
        )}
      </div>

      {error ? (
        <div className="px-6 py-6 text-[12.5px] leading-relaxed text-ink-3">
          {error}
        </div>
      ) : (
        <>
          {/* day header row */}
          <div className="flex items-end border-b border-line pr-4">
            <div className="flex w-14 shrink-0 justify-end pb-2 pr-2">
              <span className="text-[10px] font-medium tracking-[0.04em] text-ink-3">
                {tz}
              </span>
            </div>
            {days.map((d) => {
              const date = new Date(d);
              const isToday = d === today;
              const isFocused = d === focusedDay;
              return (
                <div key={d} className="min-w-0 flex-1 py-1.5 text-center">
                  <span
                    className={`inline-flex items-baseline gap-1.5 rounded-full ${
                      isToday
                        ? "bg-accent-dim px-2.5 py-0.5"
                        : isFocused
                          ? "bg-selected px-2.5 py-0.5"
                          : ""
                    }`}
                  >
                    <span
                      className={`text-[12.5px] ${
                        isToday
                          ? "font-semibold text-accent-strong"
                          : "text-ink-3"
                      }`}
                    >
                      {date.toLocaleDateString(undefined, { weekday: "short" })}
                    </span>
                    <span
                      className={`text-[13px] ${
                        isToday
                          ? "font-bold text-accent-strong"
                          : "font-medium text-ink-2"
                      }`}
                    >
                      {date.getDate()}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          {/* all-day lane — also opens for an all-day placement preview, so
              the ghost has somewhere to sit on an otherwise timed week */}
          {(hasAllDay || days.some(ghostAllDayOn)) && (
            <div className="flex items-stretch border-b border-line bg-surface pr-4">
              <div className="flex w-14 shrink-0 items-center justify-end pr-2 text-[10px] text-ink-3">
                all-day
              </div>
              {days.map((d, i) => (
                <div
                  key={d}
                  className={`flex min-w-0 flex-1 flex-col gap-[3px] px-[3px] py-1 ${
                    i ? "border-l border-line" : ""
                  }`}
                >
                  {ghostAllDayOn(d) && (
                    <div className="cal-ghost w-full truncate rounded-[5px] py-0.5 pl-[9px] pr-1.5 text-left text-[11px] font-medium">
                      New event
                    </div>
                  )}
                  {visible(d)
                    .filter((e) => e.allDay)
                    .map((e) => (
                      <button
                        key={e.id}
                        className={`cal-block w-full truncate rounded-[5px] py-0.5 pl-[9px] pr-1.5 text-left text-[11px] font-medium text-ink ${rsvpClasses(e)}`}
                        style={
                          {
                            "--ev": hueVar(calendarHue(hues, e.calendarId)),
                          } as React.CSSProperties
                        }
                        title={`${e.title} · ${e.calendar}`}
                        onClick={(ev) =>
                          useCalendar
                            .getState()
                            .openPopover(e, ev.clientX, ev.clientY)
                        }
                      >
                        {e.title}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          )}

          {/* scrolling 24-hour grid */}
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
            <div
              className="relative ml-14 mr-4"
              style={{ height: GRID_HEIGHT }}
            >
              {Array.from({ length: 24 }, (_, i) => (
                <div key={i}>
                  {i > 0 && (
                    <div
                      className="absolute left-0 right-0 border-t border-line"
                      style={{ top: i * PX_PER_HOUR }}
                    />
                  )}
                  <span
                    className="absolute -left-12 w-10 text-right text-[10.5px] text-ink-3"
                    style={{ top: i === 0 ? 4 : i * PX_PER_HOUR - 7 }}
                  >
                    {hourLabel(i)}
                  </span>
                </div>
              ))}
              <div className="absolute inset-0 flex">
                {days.map((d, i) => {
                  const timed = visible(d).filter((e) => !e.allDay);
                  const slots = packDay(timed);
                  return (
                    <div
                      key={d}
                      ref={(el) => {
                        colRefs.current[d] = el;
                      }}
                      className={`relative flex-1 cursor-crosshair ${i ? "border-l border-line" : ""} ${
                        d === today
                          ? "bg-[color-mix(in_oklab,var(--accent)_6%,transparent)]"
                          : ""
                      } ${d === focusedDay && d !== today ? "bg-selected/40" : ""}`}
                      onMouseDown={beginSlotDrag(d)}
                    >
                      {timed.map((e) => (
                        <WeekEvent
                          key={e.id}
                          e={e}
                          dayStart={d}
                          slot={slots[e.id] ?? { col: 0, cols: 1 }}
                          hue={hueVar(calendarHue(hues, e.calendarId))}
                        />
                      ))}
                      {drag?.day === d && (
                        <div
                          className="pointer-events-none absolute left-0.5 right-0.5 rounded-[5px] border border-accent/60 bg-accent-dim/70"
                          style={{
                            top:
                              ((Math.min(drag.from, drag.to) - d) / 3600_000) *
                              PX_PER_HOUR,
                            height: Math.max(
                              (Math.abs(drag.to - drag.from) / 3600_000) *
                                PX_PER_HOUR,
                              12
                            ),
                          }}
                        />
                      )}
                      {!drag &&
                        (() => {
                          const g = ghostIn(d);
                          return g ? (
                            <div
                              className="cal-ghost pointer-events-none absolute left-0.5 right-0.5 z-[2] overflow-hidden rounded-[5px] py-0.5 pl-[9px] pr-1.5 text-[11.5px] font-medium leading-[15px]"
                              style={{ top: g.top, height: g.height }}
                            >
                              New event
                            </div>
                          ) : null;
                        })()}
                    </div>
                  );
                })}
                {today >= weekStart && today < weekStart + 7 * DAY_MS && (
                  <div
                    className="pointer-events-none absolute z-[3] border-t-2 border-bad"
                    style={{
                      top: nowTop,
                      left: `${(new Date(today).getDay() / 7) * 100}%`,
                      width: `${100 / 7}%`,
                    }}
                  >
                    <span className="absolute -left-[3px] -top-[4.5px] h-[7px] w-[7px] rounded-full bg-bad" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
