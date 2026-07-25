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
      <RowGroup title="Appearance">
        <Pref id="theme" />
      </RowGroup>

      <RowGroup
        title="On launch"
        isNew={<Pill tone="accent">new home</Pill>}
        hint="All three were real settings with no interface — until now they could only be changed by editing the settings file by hand."
      >
        <Pref id="sidebarOpen" />
        <Pref id="calendarOpen" />
        <Pref id="showShortcutBar" />
      </RowGroup>

      <RowGroup title="Notifications">
        <Pref id="notifications" />
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
