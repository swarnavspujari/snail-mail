import { Pill } from "@/components/Pill";
import { RowGroup } from "@/components/SettingRow";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Pref, PrefAction } from "../Pref";
import { useReceipt } from "../receipt";

export function GeneralPane() {
  const onboarded = useSettings((s) => s.settings.onboarded);
  return (
    <>
      <RowGroup
        title="Appearance"
        hint="Two hint toggles, not one: the bar owns the bottom strip, the other owns every keycap elsewhere. Surfaces that are about shortcuts — the shortcuts panel, Settings → Shortcuts — always show their keys."
      >
        <Pref id="theme" />
        <Pref id="showShortcutBar" />
        <Pref id="showKeyHints" />
      </RowGroup>

      <RowGroup
        title="On launch"
        isNew={<Pill tone="accent">new home</Pill>}
        hint="Both were real settings with no interface — until now they could only be changed by editing the settings file by hand."
      >
        <Pref id="sidebarOpen" />
        <Pref id="calendarOpen" />
      </RowGroup>

      <RowGroup title="Notifications">
        <Pref id="notifications" />
        <Pref id="showBadge" />
      </RowGroup>

      <RowGroup title="Onboarding">
        <PrefAction
          id="tour"
          label={onboarded ? "Replay tour" : "Waiting on the mail screen"}
          onClick={() => {
            void useSettings.getState().save({ onboarded: false });
            useReceipt.getState().note("Welcome tour will replay", () =>
              useSettings.getState().save({ onboarded: true })
            );
            useUi.getState().setScreen("mail");
          }}
        />
      </RowGroup>
    </>
  );
}
