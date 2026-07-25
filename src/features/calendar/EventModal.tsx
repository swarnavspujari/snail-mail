// Create/edit event side panel — docks in the right-hand slot like the
// calendar/shortcuts panels (Superhuman-style), driven by calendar.modal:
// title, calendar (writable only), date/time or all-day, guests (contact
// autocomplete), location, description. Saving an event with guests asks
// whether to email them (Google sendUpdates); an If-Match 412 surfaces as a
// "changed elsewhere" banner with Load-latest.
import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { useCalendar } from "@/stores/calendar";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Kbd } from "@/components/Kbd";
import { RecipientInput } from "@/features/compose/RecipientInput";
import type { CalendarEvent, EventDraft, SendUpdates } from "@/lib/types";

function msToDateStr(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function msToTimeStr(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local wall-clock date+time strings → epoch ms (NaN when malformed). */
function toMs(date: string, time: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  if ([y, m, d, hh, mm].some((n) => !Number.isFinite(n))) return NaN;
  return new Date(y, m - 1, d, hh, mm).getTime();
}

/** Local midnight of the NEXT calendar day — all-day exclusive end. Calendar
 *  arithmetic (day+1 through the Date constructor), never +24h in millis: a
 *  DST fall-back day is 25h long, and midnight+24h would land at 23:00 of
 *  the SAME day, collapsing the exclusive end onto the start date. */
function nextDayMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  if ([y, m, d].some((n) => !Number.isFinite(n))) return NaN;
  return new Date(y, m - 1, d + 1).getTime();
}

/** Emails out of the comma/semicolon-separated guests field ("Name <a@b>"
 *  tokens from the autocomplete reduce to the address). */
function parseGuests(raw: string): string[] {
  const out: string[] = [];
  for (const tok of raw.split(/[,;]/)) {
    const t = tok.trim();
    if (!t) continue;
    const m = /<([^>]+)>/.exec(t);
    const email = (m ? m[1] : t).trim();
    if (email && !out.some((e) => e.toLowerCase() === email.toLowerCase())) {
      out.push(email);
    }
  }
  return out;
}

const inputCls =
  "w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] " +
  "text-ink outline-none placeholder:text-ink-3 focus:border-accent/60";
const labelCls = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-3";

export function EventModal() {
  const modal = useCalendar((s) => s.modal);
  const calendars = useCalendar((s) => s.calendars);
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  const ev = modal?.event ?? null;
  const editing = modal?.mode === "edit";

  const [title, setTitle] = useState(ev?.title ?? "");
  const [calendarId, setCalendarId] = useState(ev?.calendarId ?? "");
  const [allDay, setAllDay] = useState(modal?.allDay ?? false);
  const [startDate, setStartDate] = useState(msToDateStr(modal?.startMs ?? Date.now()));
  const [startTime, setStartTime] = useState(msToTimeStr(modal?.startMs ?? Date.now()));
  // all-day end is EXCLUSIVE in the model — show the inclusive last day
  // (endMs - 1 is always inside it, DST-proof where -24h isn't)
  const [endDate, setEndDate] = useState(
    msToDateStr((modal?.endMs ?? Date.now()) - (modal?.allDay ? 1 : 0))
  );
  const [endTime, setEndTime] = useState(msToTimeStr(modal?.endMs ?? Date.now()));
  const [guests, setGuests] = useState(
    ev && ev.attendees.length
      ? ev.attendees.map((a) => a.email).join(", ") + ", "
      : ""
  );
  const [location, setLocation] = useState(ev?.location ?? "");
  const [description, setDescription] = useState(ev?.description ?? "");
  const [etag, setEtag] = useState(ev?.etag ?? null);
  const [conflict, setConflict] = useState<CalendarEvent | null>(null);
  const [notifyStep, setNotifyStep] = useState<EventDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Google Meet: default on once the event has a guest (or already has a Meet),
  // but a manual toggle wins either way. null = follow that default.
  const [meetChoice, setMeetChoice] = useState<boolean | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const writable = calendars.filter(
    (c) => c.accessRole === "owner" || c.accessRole === "writer"
  );
  // default the create target to the primary calendar once the list lands
  useEffect(() => {
    if (!calendarId && writable.length > 0) {
      setCalendarId((writable.find((c) => c.primary) ?? writable[0]).id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendars]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useCalendar.getState().closeModal();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  if (!modal) return null;

  const addMeet =
    meetChoice ?? (parseGuests(guests).length > 0 || !!ev?.hangoutLink);

  const buildDraft = (): EventDraft | string => {
    if (!title.trim()) return "Give the event a title";
    const startMs = allDay ? toMs(startDate, "00:00") : toMs(startDate, startTime);
    const endMs = allDay
      ? nextDayMs(endDate) // inclusive picker → exclusive model
      : toMs(endDate, endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return "Set a valid date and time";
    }
    if (endMs <= startMs) return "The event must end after it starts";
    return {
      calendarId: calendarId || ev?.calendarId || "",
      title: title.trim(),
      startMs,
      endMs,
      allDay,
      location: location.trim() || null,
      description: description.trim() || null,
      attendees: parseGuests(guests),
      addConferencing: addMeet,
    };
  };

  const submit = () => {
    const draft = buildDraft();
    if (typeof draft === "string") {
      setError(draft);
      return;
    }
    setError(null);
    // guests (added, kept, or removed) get a say in notifications
    const hadGuests = (ev?.attendees.length ?? 0) > 0;
    if (draft.attendees.length > 0 || hadGuests) {
      setNotifyStep(draft);
    } else {
      void save(draft, "none");
    }
  };

  const save = async (draft: EventDraft, sendUpdates: SendUpdates) => {
    setSaving(true);
    setNotifyStep(null);
    try {
      if (editing && ev) {
        const res = await backend.updateEvent(
          ev.calendarId,
          ev.id,
          etag,
          draft,
          sendUpdates
        );
        if (res.status === "conflict" && res.event) {
          setConflict(res.event);
          return;
        }
        useUi.getState().showToast(
          sendUpdates === "all" ? "Event updated — guests notified" : "Event updated"
        );
      } else {
        await backend.createEvent(draft, sendUpdates);
        useUi.getState().showToast(
          sendUpdates === "all" && draft.attendees.length > 0
            ? "Event created — invites sent"
            : "Event created"
        );
      }
      useCalendar.getState().closeModal();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const loadLatest = () => {
    if (!conflict) return;
    setTitle(conflict.title);
    setAllDay(conflict.allDay);
    setStartDate(msToDateStr(conflict.startMs));
    setStartTime(msToTimeStr(conflict.startMs));
    setEndDate(msToDateStr(conflict.endMs - (conflict.allDay ? 1 : 0)));
    setEndTime(msToTimeStr(conflict.endMs));
    setGuests(
      conflict.attendees.length
        ? conflict.attendees.map((a) => a.email).join(", ") + ", "
        : ""
    );
    setLocation(conflict.location ?? "");
    setDescription(conflict.description ?? "");
    setEtag(conflict.etag);
    setConflict(null);
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-surface 2xl:w-80">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex-1 text-[14px] font-semibold text-ink">
          {editing ? "Edit event" : "New event"}
        </span>
        {keyHints && <Kbd>esc</Kbd>}
        <button
          className="rounded px-1.5 text-[15px] leading-none text-ink-3 hover:bg-hover hover:text-ink"
          onClick={() => useCalendar.getState().closeModal()}
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {conflict && (
          <div className="mb-3 flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-2.5 py-2 text-[12px] text-ink">
            <span className="flex-1">
              This event changed elsewhere — review and retry.
            </span>
            <button
              className="shrink-0 rounded-md border border-line-strong px-2 py-0.5 text-[12px] text-ink-2 hover:bg-hover"
              onClick={loadLatest}
            >
              Load latest
            </button>
          </div>
        )}

        <div className="space-y-3">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Event title"
            className="w-full border-b border-line bg-transparent pb-1.5 text-[16px] font-medium text-ink outline-none placeholder:text-ink-3 focus:border-accent/60"
          />

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(e) => setAllDay(e.target.checked)}
              />
              All day
            </label>
            {writable.length > 1 && (
              <select
                value={calendarId}
                onChange={(e) => setCalendarId(e.target.value)}
                disabled={editing}
                title={editing ? "Events can't move between calendars here" : "Calendar"}
                className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2 py-1 text-[12.5px] text-ink-2 outline-none"
              >
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Start/End stack vertically — five inline inputs won't fit the
              narrow dock, unlike the old wide modal. */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-9 shrink-0 text-[11px] font-medium uppercase tracking-wide text-ink-3">
                Start
              </span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={`${inputCls} min-w-0`}
              />
              {!allDay && (
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className={`${inputCls} w-[100px] shrink-0`}
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-9 shrink-0 text-[11px] font-medium uppercase tracking-wide text-ink-3">
                End
              </span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={`${inputCls} min-w-0`}
              />
              {!allDay && (
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className={`${inputCls} w-[100px] shrink-0`}
                />
              )}
            </div>
          </div>

          <div>
            <label className={labelCls}>Guests</label>
            <div className="flex rounded-md border border-line bg-surface px-2.5 py-1.5 focus-within:border-accent/60">
              <RecipientInput
                value={guests}
                onChange={setGuests}
                placeholder="Add guests (email, email…)"
              />
            </div>
            <label className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <input
                type="checkbox"
                checked={addMeet}
                onChange={(e) => setMeetChoice(e.target.checked)}
              />
              Add Google Meet
            </label>
          </div>

          <div>
            <label className={labelCls}>Location</label>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Add location"
              className={inputCls}
            />
          </div>

          <div>
            <label className={labelCls}>Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Add description"
              className={`${inputCls} resize-none`}
            />
          </div>
        </div>

        {error && <div className="mt-3 text-[12px] text-bad">{error}</div>}
      </div>

      <div className="border-t border-line px-4 py-3">
        {notifyStep ? (
          <div className="space-y-2">
            <span className="block text-[12.5px] text-ink-2">
              Send invites/updates to guests?
            </span>
            <div className="flex items-center justify-end gap-2">
              <button
                className="rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover"
                onClick={() => void save(notifyStep, "none")}
                disabled={saving}
              >
                Don't send
              </button>
              <button
                className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-on-accent hover:opacity-90"
                onClick={() => void save(notifyStep, "all")}
                disabled={saving}
              >
                Send
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <button
              className="rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover"
              onClick={() => useCalendar.getState().closeModal()}
            >
              Cancel
            </button>
            <button
              className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-on-accent hover:opacity-90 disabled:opacity-50"
              onClick={submit}
              disabled={saving}
            >
              {saving ? "Saving…" : editing ? "Save" : "Create"}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
