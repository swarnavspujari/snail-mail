// The date line above a day agenda: which day, a way back to today, and the
// +/‹/› controls. Shared by both day surfaces (DayPanel, CalendarSidebar) —
// the parts they do NOT share are what earned them separate files.
import { HoverHint } from "@/components/HoverHint";
import { Kbd } from "@/components/Kbd";
import { useCalendar } from "@/stores/calendar";
import { useSettings } from "@/stores/settings";

const navBtn =
  "rounded-md border border-line px-2 py-0.5 text-ink-3 hover:bg-hover hover:text-ink";

export function DayHeader({
  dayStart,
  isToday,
  showArrowHint = false,
}: {
  dayStart: number;
  isToday: boolean;
  /** Render the ←/→ keycaps (the panel does while focused; the week view
   *  already says so in its own header). */
  showArrowHint?: boolean;
}) {
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  const title = new Date(dayStart).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="flex shrink-0 items-center gap-2 px-4 py-3">
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
      {showArrowHint && keyHints && (
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
  );
}
