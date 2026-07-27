// One day, all of it: 12:00 AM to 11:59 PM.
//
// This is the grid half of both day surfaces — the mail-screen side panel
// (DayPanel, `0`) and the week view's companion column (CalendarSidebar). They
// used to be the SAME component mounted at two call sites, which is how a
// change meant for one silently rewrote the other; now they share this and
// compose the rest themselves.
//
// The grid used to run 7 AM–8 PM and clip everything outside, so a 6 AM flight
// or a 9 PM dinner simply did not exist here while the week view showed both.
// All 24 hours render; the pane scrolls and opens centred on the current time.
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { assignCalendarHues, calendarHue, hueVar } from "@/lib/calendar-view";
import { DAY_MS, startOfToday, useCalendar } from "@/stores/calendar";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import type { CalendarEvent } from "@/lib/types";

const HOURS = 24;
export const PX_PER_HOUR = 52;
const GRID_HEIGHT = HOURS * PX_PER_HOUR;

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
  const gridEnd = dayStart + DAY_MS;
  const s = Math.max(e.startMs, dayStart);
  const end = Math.min(Math.max(e.endMs, s + 15 * 60_000), gridEnd);
  if (end <= dayStart || s >= gridEnd) return null;
  const top = ((s - dayStart) / 3600_000) * PX_PER_HOUR;
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

/**
 * The all-day strip + the scrolling 24-hour grid for `dayStart`.
 *
 * Owns everything that is genuinely about *a day*: the events, the now-line,
 * slot drag-to-create, the placement ghost, and the scroll position. What sits
 * ABOVE it (a date header, a mini-month, a calendars list) is the caller's
 * business — that is the whole reason the two surfaces are separate now.
 */
export function DayAgenda({ dayStart }: { dayStart: number }) {
  const events = useCalendar((s) => s.eventsByDay);
  const loadedDays = useCalendar((s) => s.loadedDays);
  const calendars = useCalendar((s) => s.calendars);
  const error = useCalendar((s) => s.error);
  const hiddenCalendars = useSettings((s) => s.settings.hiddenCalendars);
  const preview = useCalendar((s) => s.modalPreview);
  const [nowTick, setNowTick] = useState(Date.now());
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const hues = useMemo(() => assignCalendarHues(calendars), [calendars]);
  const hidden = useMemo(() => new Set(hiddenCalendars), [hiddenCalendars]);

  const dayEvents = (events[dayStart] ?? []).filter(
    (e) => !hidden.has(e.calendarId)
  );
  const loading = !loadedDays[dayStart];
  const timed = dayEvents.filter((e) => !e.allDay);
  const allDay = dayEvents.filter((e) => e.allDay);
  const isToday = dayStart === startOfToday();

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Open with the current time in the MIDDLE of the visible grid, so "now" is
  // never the thing you have to go looking for. Re-runs when the day changes
  // (stepping days keeps the same vantage point) and when `loading` clears,
  // because before that the scroller has no content to position against — the
  // old one-shot mount effect could and did run against an empty pane.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const now = new Date();
    const nowH = now.getHours() + now.getMinutes() / 60;
    const target = nowH * PX_PER_HOUR - el.clientHeight / 2;
    el.scrollTop = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
  }, [dayStart, loading, error]);

  /** Snap a pointer y to a 30-minute slot anywhere in the day. */
  const msAtY = (clientY: number): number => {
    const rect = gridRef.current!.getBoundingClientRect();
    const hours = (clientY - rect.top) / PX_PER_HOUR;
    const snapped = Math.round(hours * 2) / 2;
    return dayStart + Math.min(HOURS, Math.max(0, snapped)) * 3600_000;
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

  // Where the open modal's event would land, if it lands on this day. Timed
  // previews get a ghost in the grid; an all-day one rides the all-day strip.
  const ghost = useMemo(() => {
    if (!preview || preview.allDay) return null;
    const gridEnd = dayStart + DAY_MS;
    // Overlap first, THEN clamp — clamping first draws a sliver on every
    // other day (a real event never hits this; the store buckets those).
    if (preview.endMs <= dayStart || preview.startMs >= gridEnd) return null;
    const s = Math.max(preview.startMs, dayStart);
    const e = Math.min(Math.max(preview.endMs, s + 15 * 60_000), gridEnd);
    return {
      top: ((s - dayStart) / 3600_000) * PX_PER_HOUR,
      height: Math.max(20, ((e - s) / 3600_000) * PX_PER_HOUR - 2),
    };
  }, [preview, dayStart]);
  const ghostAllDay =
    !!preview &&
    preview.allDay &&
    preview.startMs < dayStart + DAY_MS &&
    preview.endMs > dayStart;

  // Every hour is on the grid now, so the now-line needs no window guard —
  // if it is today, the line is somewhere on screen.
  const nowTop = isToday
    ? ((nowTick - dayStart) / 3600_000) * PX_PER_HOUR
    : null;

  const dragTop = drag
    ? ((Math.min(drag.from, drag.to) - dayStart) / 3600_000) * PX_PER_HOUR
    : 0;
  const dragHeight = drag
    ? (Math.abs(drag.to - drag.from) / 3600_000) * PX_PER_HOUR
    : 0;

  return (
    <>
      {(allDay.length > 0 || ghostAllDay) && (
        <div className="shrink-0 space-y-1 px-4 pb-2 pt-2">
          {ghostAllDay && (
            <div className="cal-ghost block w-full truncate rounded-md py-1 pl-[11px] pr-2 text-left text-[12px] font-medium">
              New event
            </div>
          )}
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
          <div className="relative mx-3 my-2" style={{ height: GRID_HEIGHT }}>
            {Array.from({ length: HOURS }, (_, i) => (
              <div key={i}>
                {/* no rule above 12 am — it is the top edge of the grid */}
                {i > 0 && (
                  <div
                    className="absolute left-0 right-0 border-t border-line"
                    style={{ top: i * PX_PER_HOUR }}
                  />
                )}
                <span
                  className="absolute left-0 bg-surface pr-1 text-[10.5px] text-ink-3"
                  style={{ top: i === 0 ? 0 : i * PX_PER_HOUR - 8 }}
                >
                  {hourLabel(i)}
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
              {/* Where the event being composed would land — visible before
                  you commit it, so placement is confirmable, not guessed. */}
              {ghost && !drag && (
                <div
                  className="cal-ghost pointer-events-none absolute left-1 right-1 overflow-hidden rounded-md py-1 pl-[11px] pr-2 text-[12px] font-medium"
                  style={{ top: ghost.top, height: ghost.height }}
                >
                  New event
                </div>
              )}
              {/* Anchored near the working day rather than at 12 am, so an
                  empty day says so where the eye already is. */}
              {timed.length === 0 && !drag && !ghost && (
                <div
                  className="pointer-events-none absolute inset-x-0 text-center text-[12px] text-ink-3"
                  style={{ top: 9 * PX_PER_HOUR }}
                >
                  Nothing scheduled.
                </div>
              )}
            </div>
            {nowTop !== null && (
              <div
                className="pointer-events-none absolute left-10 right-0 z-[2] border-t-2 border-bad"
                style={{ top: nowTop }}
              >
                <span className="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-bad" />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
