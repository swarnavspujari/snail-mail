import { Button } from "@/components/Button";
import { Pill } from "@/components/Pill";
import { RowGroup, SettingRow } from "@/components/SettingRow";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Pref } from "../Pref";

export function ZeroPane() {
  const streaks = useSettings((s) => s.streaks);
  return (
    <>
      <RowGroup
        title="Rest photo"
        hint="When a split hits zero the list is replaced by a photo. The Rust core fetches one a day — never the web bundle."
      >
        <Pref id="celebrationDir" />
        <SettingRow
          label="Daily photo source"
          help="Unsplash, fetched once a day. Its access key lives in Privacy & keys — one home for every credential."
          tag={<Pill tone="neutral">read-only</Pill>}
        >
          <Button
            variant="quiet"
            size="sm"
            onClick={() => useUi.getState().setSettingsTab("privacy")}
          >
            Privacy &amp; keys
          </Button>
        </SettingRow>
      </RowGroup>

      <section>
        <div className="mx-0.5 mb-2 flex items-baseline gap-2.5">
          <h2 className="text-[13px] font-semibold text-ink">Your streak</h2>
          <div className="flex-1" />
          <span className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3">
            Read-only
          </span>
        </div>
        <p className="mx-0.5 mb-2.5 -mt-1 max-w-[70ch] text-[12px] leading-relaxed text-ink-3">
          Counted on this machine, never uploaded. Nothing here is a setting — it
          moved out from between the preferences.
        </p>
        <div className="flex gap-3">
          <Tile value={String(streaks.daily)} label="day inbox-zero streak" />
          <Tile value={String(streaks.weekly)} label="week streak" />
          <Tile
            value={streaks.lastZeroDay ?? "—"}
            label="last time you hit zero"
          />
        </div>
      </section>
    </>
  );
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex-1 rounded-lg border border-line bg-surface px-4 py-3.5">
      <div className="text-[26px] font-semibold tracking-[-0.01em] text-ink">
        {value}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">{label}</div>
    </div>
  );
}
