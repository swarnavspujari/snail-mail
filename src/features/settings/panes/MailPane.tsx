import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { Pill } from "@/components/Pill";
import { RowGroup, SettingRow, WideRow } from "@/components/SettingRow";
import { Switch } from "@/components/Switch";
import { assignCalendarHues, calendarHue, hueVar } from "@/lib/calendar-view";
import { backend } from "@/lib/ipc";
import { parseSplitQuery } from "@/lib/split-query";
import { useSettings } from "@/stores/settings";
import { Pref } from "../Pref";
import { useReceipt } from "../receipt";
import type { CalendarInfo, Split } from "@/lib/types";

const inputCls =
  "w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";

export function MailPane() {
  return (
    <>
      <SplitsSection />
      <RowGroup title="Sending">
        <Pref id="undoSendSeconds" />
      </RowGroup>
      <RowGroup title="Attachments" isNew={<Pill tone="accent">new home</Pill>}>
        <Pref id="driveAutoUpload" />
        <Pref id="driveShareMode" />
      </RowGroup>
      <CalendarSection />
    </>
  );
}

// ---------------------------------------------------------------- splits

/** Query input with instant client-side validation and a debounced backend
 *  match-count preview. The same syntax the row list displays round-trips
 *  here — from:domain.com, quoted phrases, AND/OR, parentheses. */
function SplitQueryField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    try {
      parseSplitQuery(value);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCount(null);
      return;
    }
    if (!value.trim()) {
      setCount(null);
      return;
    }
    const t = setTimeout(() => {
      void backend
        .previewSplit(value)
        .then((p) => setCount(p.ok ? p.count : null))
        .catch(() => setCount(null));
    }, 300);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div className="flex-1">
      <input
        className={inputCls}
        placeholder={placeholder ?? "from:alice@example.com OR from:news.example.com"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        spellCheck={false}
      />
      {error ? (
        <p className="mt-1 text-[11.5px] text-bad">{error}</p>
      ) : count !== null ? (
        <p className="mt-1 text-[11.5px] text-ink-3">
          matches {count} recent inbox conversation{count === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}

/** Inline editor shared by "edit split" and "new split". */
function SplitEditor({
  initial,
  accounts,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; query: string; accountId: string | null; alsoShow: boolean };
  accounts: { email: string }[];
  submitLabel: string;
  onSubmit: (v: typeof initial) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [query, setQuery] = useState(initial.query);
  const [accountId, setAccountId] = useState(initial.accountId);
  const [alsoShow, setAlsoShow] = useState(initial.alsoShow);

  const valid = (() => {
    if (!name.trim() || !query.trim()) return false;
    try {
      parseSplitQuery(query);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <div className="space-y-2">
      <input
        className={inputCls}
        placeholder='Split name, e.g. "Travel Deals"'
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <SplitQueryField value={query} onChange={setQuery} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          applies to
          <select
            className="rounded-md border border-line-strong bg-raised px-2 py-1 text-[12.5px] text-ink"
            value={accountId ?? ""}
            onChange={(e) => setAccountId(e.target.value || null)}
          >
            <option value="">all accounts</option>
            {accounts.map((a) => (
              <option key={a.email} value={a.email}>
                {a.email}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            checked={alsoShow}
            onChange={(e) => setAlsoShow(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          also show matches in Important or Other
        </label>
        <div className="flex-1" />
        {onCancel && (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={!valid}
          onClick={() =>
            onSubmit({ name: name.trim(), query: query.trim(), accountId, alsoShow })
          }
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

function SplitsSection() {
  const splits = useSettings((s) => s.settings.splits);
  const accounts = useSettings((s) => s.accounts.accounts);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const saveSplits = (next: Split[], label: string) => {
    const before = splits;
    void useSettings.getState().save({ splits: next });
    useReceipt
      .getState()
      .note(label, () => useSettings.getState().save({ splits: before }));
  };

  const move = (id: string, dir: -1 | 1) => {
    const next = [...splits];
    const i = next.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    saveSplits(next, `${next[j].name} moved ${dir === -1 ? "down" : "up"} the order`);
  };

  return (
    <RowGroup
      title="Split inboxes"
      colLabel="Hide when empty"
      hint="Splits divide the inbox into tabs, checked top to bottom — the first match wins. Counts are totals, not unread, so a split reads like a to-do list. Tab cycles them."
    >
      {splits.map((s, i) => (
        <div key={s.id}>
          <SettingRow
            label={
              <span className="flex items-center gap-2">
                <span className="flex w-3 shrink-0 flex-col items-center">
                  <button
                    className="text-[8px] leading-[9px] text-ink-3 hover:text-ink disabled:opacity-25"
                    disabled={i === 0}
                    onClick={() => move(s.id, -1)}
                    title="Match earlier"
                  >
                    ▲
                  </button>
                  <button
                    className="text-[8px] leading-[9px] text-ink-3 hover:text-ink disabled:opacity-25"
                    disabled={i === splits.length - 1}
                    onClick={() => move(s.id, 1)}
                    title="Match later"
                  >
                    ▼
                  </button>
                </span>
                {s.name}
              </span>
            }
            help={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px]">
                  {s.query.trim() === "" ? "catch-all" : s.query}
                </span>
                {s.accountId && <span>· {s.accountId}</span>}
                {s.alsoShow && <span>· also in Important/Other</span>}
                {s.builtin && <span>· built-in</span>}
              </span>
            }
          >
            {s.query.trim() !== "" && (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => setEditingId(editingId === s.id ? null : s.id)}
              >
                {editingId === s.id ? "Close" : "Edit"}
              </Button>
            )}
            {!s.builtin && (
              <Button
                variant="quiet"
                size="sm"
                onClick={() =>
                  saveSplits(
                    splits.filter((x) => x.id !== s.id),
                    `${s.name} removed`
                  )
                }
              >
                Remove
              </Button>
            )}
            <Switch
              label={`Hide ${s.name} when empty`}
              checked={s.hideWhenEmpty}
              onChange={(next) =>
                saveSplits(
                  splits.map((x) =>
                    x.id === s.id ? { ...x, hideWhenEmpty: next } : x
                  ),
                  `${s.name} ${next ? "hides" : "stays"} when empty`
                )
              }
            />
          </SettingRow>
          {editingId === s.id && (
            <WideRow>
              <SplitEditor
                initial={{
                  name: s.name,
                  query: s.query,
                  accountId: s.accountId,
                  alsoShow: s.alsoShow,
                }}
                accounts={accounts}
                submitLabel="Save"
                onCancel={() => setEditingId(null)}
                onSubmit={(v) => {
                  saveSplits(
                    splits.map((x) => (x.id === s.id ? { ...x, ...v } : x)),
                    `${v.name} updated`
                  );
                  setEditingId(null);
                }}
              />
            </WideRow>
          )}
        </div>
      ))}
      {creating ? (
        <WideRow>
          <div className="mb-2 text-[12px] text-ink-3">
            Write the definition as a search query:{" "}
            <span className="font-mono">from:alice@example.com</span> ·{" "}
            <span className="font-mono">subject:"survey results"</span> ·{" "}
            <span className="font-mono">from:thriftytraveler.com</span> matches the
            whole domain.
          </div>
          <SplitEditor
            initial={{ name: "", query: "", accountId: null, alsoShow: false }}
            accounts={accounts}
            submitLabel="Create split"
            onCancel={() => setCreating(false)}
            onSubmit={(v) => {
              // Custom splits go on top so they win over Important.
              saveSplits(
                [
                  {
                    id: `custom-${Date.now()}`,
                    builtin: false,
                    hideWhenEmpty: false,
                    ...v,
                  },
                  ...splits,
                ],
                `${v.name} created`
              );
              setCreating(false);
            }}
          />
        </WideRow>
      ) : (
        <SettingRow
          label="New split"
          help="Name it, write the rule, choose which accounts it applies to."
        >
          <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
            Create split
          </Button>
        </SettingRow>
      )}
    </RowGroup>
  );
}

// -------------------------------------------------------------- calendars

/** settings.hiddenCalendars had no interface at all: a calendar unchecked in
 *  the side panel could only be brought back from the panel itself. */
function CalendarSection() {
  const hidden = useSettings((s) => s.settings.hiddenCalendars);
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || calendars) return;
    void backend
      .listCalendars()
      .then(setCalendars)
      .catch(() => setCalendars([]));
  }, [open, calendars]);

  const setHidden = (next: string[], label: string) => {
    const before = hidden;
    void useSettings.getState().save({ hiddenCalendars: next });
    useReceipt
      .getState()
      .note(label, () => useSettings.getState().save({ hiddenCalendars: before }));
  };

  return (
    <RowGroup title="Calendar" isNew={<Pill tone="accent">new home</Pill>}>
      <SettingRow
        label="Hidden calendars"
        help="Hidden from the week grid and the day panel. settings.hiddenCalendars"
        tag={
          hidden.length > 0 ? (
            <Pill tone="neutral">{hidden.length} hidden</Pill>
          ) : undefined
        }
      >
        <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
          {open ? "Done" : "Manage"}
        </Button>
      </SettingRow>
      {open && (
        <WideRow>
          {calendars === null ? (
            <div className="text-[12px] text-ink-3">Loading calendars…</div>
          ) : calendars.length === 0 ? (
            <div className="text-[12px] text-ink-3">
              No calendars yet — connect a Google account with calendar access.
            </div>
          ) : (
            <div className="space-y-1.5">
              {calendars.map((c) => {
                const shown = !hidden.includes(c.id);
                const hues = assignCalendarHues(calendars);
                return (
                  <div key={c.id} className="flex items-center gap-3">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: hueVar(calendarHue(hues, c.id)) }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                      {c.name}
                    </span>
                    {c.primary && <Pill tone="neutral">primary</Pill>}
                    <Switch
                      label={`Show ${c.name}`}
                      checked={shown}
                      onChange={(next) =>
                        setHidden(
                          next
                            ? hidden.filter((id) => id !== c.id)
                            : [...hidden, c.id],
                          `${c.name} ${next ? "shown" : "hidden"}`
                        )
                      }
                    />
                  </div>
                );
              })}
              <p className="pt-1 text-[11.5px] text-ink-3">
                Switched off calendars keep syncing — their events just stay out of
                both calendar views.
              </p>
            </div>
          )}
        </WideRow>
      )}
    </RowGroup>
  );
}
