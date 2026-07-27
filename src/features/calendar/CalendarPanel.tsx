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

/** Right-hand day calendar, Superhuman-style: toggleable, painted instantly
 *  from the shared day-keyed cache; a background sync keeps it fresh. Shows
 *  the day's events and nothing else. ←/→ move days while the panel has
 *  focus. Click an event for details/RSVP; click or drag an empty slot to
 *  create one. */
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
  const preview = useCalendar((s) => s.modalPreview);
  const gridRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dayStart = useMemo(() => startOfToday() + dayOffset * DAY_MS, [dayOffset]);
  const hues = useMemo(() => assignCalendarHues(calendars), [calendars]);
  const hidden = useMemo(() => new Set(hiddenCalendars), [hiddenCalendars]);

  useEffect(() => {
    const cal = useCalendar.getState();
    void cal.watchRange("panel", dayStart, 1);
    cal.requestRefresh("panel");
    return () => useCalendar.getState().unwatchRange("panel");
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

  // Where the open modal's event would land, if it lands on this day. Timed
  // previews get a ghost in the grid; an all-day one rides the all-day strip.
  const ghost = useMemo(() => {
    if (!preview || preview.allDay) return null;
    const gridStart = dayStart + FIRST_HOUR * 3600_000;
    const gridEnd = dayStart + LAST_HOUR * 3600_000;
    // Overlap first, THEN clamp — clamping first draws a sliver on every
    // other day (a real event never hits this; the store buckets those).
    if (preview.endMs <= gridStart || preview.startMs >= gridEnd) return null;
    const s = Math.max(preview.startMs, gridStart);
    const e = Math.min(Math.max(preview.endMs, s + 15 * 60_000), gridEnd);
    return {
      top: ((s - gridStart) / 3600_000) * PX_PER_HOUR,
      height: Math.max(20, ((e - s) / 3600_000) * PX_PER_HOUR - 2),
    };
  }, [preview, dayStart]);
  const ghostAllDay =
    !!preview &&
    preview.allDay &&
    preview.startMs < dayStart + DAY_MS &&
    preview.endMs > dayStart;

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

      {/* Nothing between the date header and the agenda. This panel answers
          "what is on today"; the mini-month and the per-calendar checkboxes
          both pushed the answer below the fold. ←/→ move days, and calendar
          visibility is a setting you change rarely — both live in the full
          Calendar surface's own settings — per-calendar visibility lives in
          Settings -> Mail, which is where it was already editable. */}

      {(allDay.length > 0 || ghostAllDay) && (
        <div className="space-y-1 px-4 pb-2 pt-2">
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
              {timed.length === 0 && !drag && !ghost && (
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
