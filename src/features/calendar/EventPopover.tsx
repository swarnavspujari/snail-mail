// Event details popover (click an event block): time, calendar, location,
// Meet link, description, guest list with RSVP states. Actions gate on the
// calendar's accessRole + organizer: owners edit/delete (with a notify-guests
// step when there are guests), invited attendees RSVP Yes/Maybe/No.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { backend, openExternal } from "@/lib/ipc";
import { assignCalendarHues, calendarHue, hueVar } from "@/lib/calendar-view";
import { daysCovered, useCalendar } from "@/stores/calendar";
import { useUi } from "@/stores/ui";
import type { CalendarEvent, RsvpResponse } from "@/lib/types";

const RSVP_LABELS: Array<{ value: RsvpResponse; label: string }> = [
  { value: "accepted", label: "Yes" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "No" },
];

function fmtRange(e: CalendarEvent): string {
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  if (e.allDay) {
    const lastDay = e.endMs - 24 * 3600_000;
    return lastDay > e.startMs
      ? `${day(e.startMs)} – ${day(lastDay)} · all day`
      : `${day(e.startMs)} · all day`;
  }
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day(e.startMs)} · ${time(e.startMs)} – ${time(e.endMs)}`;
}

function statusGlyph(s: string): string {
  return s === "accepted" ? "✓" : s === "declined" ? "✕" : s === "tentative" ? "?" : "·";
}

export function EventPopover() {
  const popover = useCalendar((s) => s.popover);
  const calendars = useCalendar((s) => s.calendars);
  const hues = useMemo(() => assignCalendarHues(calendars), [calendars]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measure and clamp to the viewport before paint (anchor is the click
  // point). One layout effect does measure + per-event reset together — as
  // two effects in the same commit, the reset's setPos(null) landed AFTER
  // the clamp's setPos(...) and the card stayed visibility:hidden forever.
  useLayoutEffect(() => {
    setConfirmDelete(false);
    if (!popover || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, popover.x + 8), window.innerWidth - r.width - 8);
    const top = Math.min(Math.max(8, popover.y - 20), window.innerHeight - r.height - 8);
    setPos({ left, top });
  }, [popover]);

  useEffect(() => {
    if (!popover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useCalendar.getState().closePopover();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [popover]);

  if (!popover) return null;
  const e = popover.event;

  const selfAttendee = e.attendees.find((a) => a.self) ?? null;
  const writable = e.accessRole === "owner" || e.accessRole === "writer";
  // Own events (and guestless events on writable shared calendars) edit;
  // events you're invited to RSVP instead.
  const canEdit = writable && (e.organizerSelf || !selfAttendee);
  const canRsvp = !!selfAttendee && !e.organizerSelf;
  const hasGuests = e.attendees.length > 0;

  const doRsvp = async (response: RsvpResponse) => {
    setBusy(true);
    try {
      const updated = await backend.rsvpEvent(e.calendarId, e.id, response);
      useCalendar.getState().openPopover(updated, popover.x, popover.y);
      useUi.getState().showToast(
        response === "accepted"
          ? "Going — organizer notified"
          : response === "tentative"
            ? "Maybe — organizer notified"
            : "Declined — organizer notified"
      );
    } catch (err) {
      useUi.getState().showToast(String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (notify: boolean) => {
    setBusy(true);
    try {
      const res = await backend.deleteEvent(
        e.calendarId,
        e.id,
        e.etag,
        notify ? "all" : "none"
      );
      if (res.status === "conflict" && res.event) {
        // changed elsewhere — reopen on the fresh copy for review
        useCalendar.getState().openPopover(res.event, popover.x, popover.y);
        useUi.getState().showToast("This event changed elsewhere — review and retry");
        return;
      }
      // Forget the days it occupied, or the block stays drawn on any day a
      // view isn't currently watching (calendar:updated only re-reads those).
      void useCalendar.getState().invalidateDays(daysCovered(e.startMs, e.endMs));
      useCalendar.getState().closePopover();
      useUi.getState().showToast(notify ? "Event deleted — guests notified" : "Event deleted");
    } catch (err) {
      useUi.getState().showToast(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) useCalendar.getState().closePopover();
      }}
    >
      <div
        ref={ref}
        className="zb-pop-in fixed w-[320px] rounded-xl border border-line-strong bg-overlay p-3.5 shadow-2xl"
        style={pos ?? { left: popover.x + 8, top: popover.y - 20, visibility: pos ? undefined : "hidden" }}
      >
        <div className="flex items-start gap-2">
          <span
            className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-[3px]"
            style={{ background: hueVar(calendarHue(hues, e.calendarId)) }}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold leading-5 text-ink">{e.title}</div>
            <div className="mt-0.5 text-[12px] text-ink-3">{fmtRange(e)}</div>
          </div>
          <button
            className="rounded px-1 text-ink-3 hover:bg-hover hover:text-ink"
            onClick={() => useCalendar.getState().closePopover()}
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="mt-2 space-y-1 text-[12.5px] text-ink-2">
          {e.location && <div className="truncate">📍 {e.location}</div>}
          {e.hangoutLink && (
            <button
              className="text-accent-strong hover:underline"
              onClick={() => void openExternal(e.hangoutLink!)}
            >
              Join Google Meet
            </button>
          )}
          {e.calendar && (
            <div className="text-ink-3">
              {e.calendar}
              {e.accessRole === "reader" || e.accessRole === "freeBusyReader"
                ? " · read-only"
                : ""}
            </div>
          )}
          {e.organizerEmail && !e.organizerSelf && (
            <div className="truncate text-ink-3">Organizer: {e.organizerEmail}</div>
          )}
          {e.description && (
            <div className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">
              {e.description}
            </div>
          )}
        </div>

        {hasGuests && (
          <div className="mt-2 border-t border-line pt-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">
              {e.attendees.length} guest{e.attendees.length > 1 ? "s" : ""}
            </div>
            <div className="max-h-28 space-y-0.5 overflow-y-auto">
              {e.attendees.map((a) => (
                <div key={a.email} className="flex items-center gap-1.5 text-[12px]">
                  <span
                    className={
                      a.responseStatus === "accepted"
                        ? "text-ok"
                        : a.responseStatus === "declined"
                          ? "text-bad"
                          : "text-ink-3"
                    }
                  >
                    {statusGlyph(a.responseStatus)}
                  </span>
                  <span className="truncate text-ink-2">
                    {a.displayName || a.email}
                    {a.organizer ? " (organizer)" : ""}
                    {a.optional ? " (optional)" : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {e.htmlLink && (
          <button
            className="mt-2 text-[12px] text-accent-strong hover:underline"
            onClick={() => void openExternal(e.htmlLink!)}
          >
            Open in Google Calendar
          </button>
        )}

        {canRsvp && (
          <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-2.5">
            <span className="mr-1 text-[12px] text-ink-3">Going?</span>
            {RSVP_LABELS.map(({ value, label }) => (
              <button
                key={value}
                disabled={busy}
                onClick={() => void doRsvp(value)}
                className={`rounded-md px-2.5 py-1 text-[12.5px] ${
                  selfAttendee?.responseStatus === value
                    ? "bg-accent font-medium text-on-accent"
                    : "border border-line-strong text-ink-2 hover:bg-hover"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {canEdit && (
          <div className="mt-3 flex items-center justify-end gap-2 border-t border-line pt-2.5">
            {confirmDelete ? (
              hasGuests ? (
                <>
                  <span className="flex-1 text-[12px] text-ink-2">Notify guests?</span>
                  <button
                    className="rounded-md border border-line-strong px-2 py-1 text-[12px] text-ink-2 hover:bg-hover"
                    disabled={busy}
                    onClick={() => void doDelete(false)}
                  >
                    Delete silently
                  </button>
                  <button
                    className="rounded-md bg-bad px-2 py-1 text-[12px] font-medium text-white hover:opacity-90"
                    disabled={busy}
                    onClick={() => void doDelete(true)}
                  >
                    Delete & notify
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-[12px] text-ink-2">Delete this event?</span>
                  <button
                    className="rounded-md border border-line-strong px-2 py-1 text-[12px] text-ink-2 hover:bg-hover"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="rounded-md bg-bad px-2 py-1 text-[12px] font-medium text-white hover:opacity-90"
                    disabled={busy}
                    onClick={() => void doDelete(false)}
                  >
                    Delete
                  </button>
                </>
              )
            ) : (
              <>
                <button
                  className="rounded-md border border-line-strong px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-hover"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
                <button
                  className="rounded-md bg-accent px-2.5 py-1 text-[12.5px] font-medium text-on-accent hover:opacity-90"
                  onClick={() => useCalendar.getState().openEdit(e)}
                >
                  Edit
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
