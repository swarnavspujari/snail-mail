// The right-hand day calendar on the MAIL screen (`0`), Superhuman-style:
// toggleable, painted instantly from the shared day-keyed cache, with a
// background sync keeping it fresh. ←/→ move days while it has focus.
//
// Deliberately just the date header and the day: no mini-month, no calendars
// list. This panel answers "what is on today", and both of those pushed the
// answer below the fold. The week view's companion column (CalendarSidebar)
// is where they belong, and it is a separate component precisely so that
// decision can differ between the two.
import { useEffect, useMemo } from "react";
import { DAY_MS, startOfToday, useCalendar } from "@/stores/calendar";
import { useUi } from "@/stores/ui";
import { DayAgenda } from "./DayAgenda";
import { DayHeader } from "./DayHeader";

export function DayPanel() {
  const dayOffset = useCalendar((s) => s.dayOffset);
  const focused = useUi((s) => s.focusRegion === "calendar");
  const dayStart = useMemo(() => startOfToday() + dayOffset * DAY_MS, [dayOffset]);

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

  return (
    <aside
      onMouseDown={() => useUi.getState().setFocusRegion("calendar")}
      className={`flex w-64 shrink-0 flex-col border-l bg-surface 2xl:w-72 ${
        focused ? "border-accent/40" : "border-line"
      }`}
    >
      <DayHeader dayStart={dayStart} isToday={dayOffset === 0} showArrowHint={focused} />
      <DayAgenda dayStart={dayStart} />
    </aside>
  );
}
