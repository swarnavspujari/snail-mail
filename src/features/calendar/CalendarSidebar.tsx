// The week view's companion column: mini-month, per-calendar visibility, and
// the focused day's full agenda beneath them.
//
// This used to be the mail screen's day panel, mounted a second time beside
// the week grid. Trimming that panel down to "the day and nothing else" was
// right for the mail screen and wrong here — it took the month grid and the
// calendars list out of the one surface whose whole job is navigating and
// managing the calendar, without anyone touching the week view. Separate
// components, so the next such decision only lands where it is aimed.
import { useEffect, useMemo, useState } from "react";
import { HoverHint } from "@/components/HoverHint";
import { assignCalendarHues, calendarHue, hueVar } from "@/lib/calendar-view";
import { DAY_MS, startOfToday, useCalendar } from "@/stores/calendar";
import { useSettings } from "@/stores/settings";
import { DayAgenda } from "./DayAgenda";
import { DayHeader } from "./DayHeader";

const MINI_DOW = ["S", "M", "T", "W", "T", "F", "S"];

/** A month at a glance. Clicking a day moves the whole week view to it; the
 *  week currently on the grid stays tinted, so the mini-month doubles as the
 *  "where am I" indicator for the seven columns beside it. */
function MiniMonth({ dayStart }: { dayStart: number }) {
  const [monthOffset, setMonthOffset] = useState(0);
  const focused = new Date(dayStart);
  // follow the agenda when it moves to another month
  useEffect(() => setMonthOffset(0), [dayStart]);

  const view = new Date(focused.getFullYear(), focused.getMonth() + monthOffset, 1);
  const gridStart = new Date(view.getFullYear(), view.getMonth(), 1 - view.getDay());
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(
      gridStart.getFullYear(),
      gridStart.getMonth(),
      gridStart.getDate() + i
    );
    return {
      ms: d.getTime(),
      date: d.getDate(),
      inMonth: d.getMonth() === view.getMonth(),
    };
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
          const inWeek = c.ms >= weekStart && c.ms <= weekEnd;
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

/** The account's calendars, grouped under its email: each row a colour-coded
 *  checkbox that shows/hides that calendar's events live in both the week grid
 *  and the agenda below. The choice persists in settings (and is also editable
 *  in Settings → Mail). */
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

export function CalendarSidebar() {
  const dayOffset = useCalendar((s) => s.dayOffset);
  const dayStart = useMemo(() => startOfToday() + dayOffset * DAY_MS, [dayOffset]);

  // Its own watcher key. The week grid registers "week"; if this column shared
  // that key the two would overwrite each other's range and one of them would
  // stop being re-read on calendar:updated.
  useEffect(() => {
    const cal = useCalendar.getState();
    void cal.watchRange("sidebar", dayStart, 1);
    cal.requestRefresh("sidebar");
    return () => useCalendar.getState().unwatchRange("sidebar");
  }, [dayStart]);

  useEffect(() => {
    if (useCalendar.getState().calendars.length === 0)
      void useCalendar.getState().loadCalendars();
  }, []);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-line bg-surface 2xl:w-72">
      <DayHeader dayStart={dayStart} isToday={dayOffset === 0} />
      {/* Capped and independently scrollable: on a short window the month and
          the calendars list must not squeeze the agenda out of existence. */}
      <div className="max-h-[58%] shrink-0 space-y-3 overflow-y-auto border-b border-line px-3 pb-3">
        <MiniMonth dayStart={dayStart} />
        <CalendarsList />
      </div>
      <DayAgenda dayStart={dayStart} />
    </aside>
  );
}
