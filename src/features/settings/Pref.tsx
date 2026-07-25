// Renders one catalog preference row: the label and help come from the catalog,
// the control comes from its `control` kind, and every change applies
// immediately and files a receipt you can undo. Panes never re-state a label —
// if a row exists here it exists in search too.
import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { Segmented, Select } from "@/components/Segmented";
import { SettingRow } from "@/components/SettingRow";
import { Switch } from "@/components/Switch";
import {
  patchFor,
  prefRow,
  rawValueFor,
  valueTextFor,
  type PrefRow,
} from "@/lib/settings-catalog";
import { useSettings } from "@/stores/settings";
import { useReceipt } from "./receipt";
import type { Settings } from "@/lib/types";

/** Apply a preference and file its receipt (with the inverse patch as undo). */
export function applyPref(row: PrefRow, value: string, receiptLabel?: string) {
  const before = rawValueFor(row, useSettings.getState().settings);
  void useSettings.getState().save(patchFor(row, value));
  const after = valueTextFor(
    row,
    { ...useSettings.getState().settings, ...patchFor(row, value) } as Settings
  );
  useReceipt.getState().note(receiptLabel ?? `${row.label} → ${after}`, () =>
    useSettings.getState().save(patchFor(row, before))
  );
}

export function Pref({ id, tag }: { id: string; tag?: React.ReactNode }) {
  const row = prefRow(id);
  const settings = useSettings((s) => s.settings);
  const raw = rawValueFor(row, settings);

  return (
    <SettingRow label={row.label} help={row.help} tag={tag}>
      {row.control === "switch" && (
        <Switch
          label={row.label}
          checked={!!settings[row.key!]}
          onChange={(next) =>
            applyPref(
              row,
              String(next),
              `${row.label} ${next ? "on" : "off"}`
            )
          }
        />
      )}
      {row.control === "segmented" && (
        <Segmented
          label={row.label}
          value={raw}
          options={row.options!}
          onChange={(v) => applyPref(row, v)}
        />
      )}
      {row.control === "select" && (
        <Select
          label={row.label}
          value={raw}
          options={row.options!}
          onChange={(v) => applyPref(row, v)}
        />
      )}
      {row.control === "text" && <PrefText row={row} value={raw} />}
    </SettingRow>
  );
}

/** An action row: the catalog owns the wording, the pane owns what it does. */
export function PrefAction({
  id,
  onClick,
  tag,
  busy,
  label,
}: {
  id: string;
  onClick: () => void;
  tag?: React.ReactNode;
  busy?: boolean;
  /** Overrides the catalog's button label (e.g. "Add key" vs "Replace"). */
  label?: string;
}) {
  const row = prefRow(id);
  return (
    <SettingRow label={row.label} help={row.help} tag={tag}>
      <Button
        variant={row.actionVariant ?? "secondary"}
        size="sm"
        onClick={onClick}
        disabled={busy}
      >
        {label ?? row.action ?? "Open"}
      </Button>
    </SettingRow>
  );
}

/** Text commits on blur or Enter — never left sitting in a draft state. */
function PrefText({ row, value }: { row: PrefRow; value: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() === value.trim()) return;
    applyPref(row, draft);
  };
  return (
    <input
      value={draft}
      spellCheck={false}
      placeholder={row.help && row.control === "text" ? "" : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="w-[250px] rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
    />
  );
}
