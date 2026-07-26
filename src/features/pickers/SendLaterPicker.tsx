import { backend } from "@/lib/ipc";
import { pushUndo } from "@/lib/undo";
import {
  driveSendBlocker,
  shareDriveLinks,
} from "@/features/compose/useComposeController";
import { outgoingFromCompose, useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

function at(hour: number, dayOffset: number): number {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Ctrl+Shift+L — schedule the current draft. The outbox delivers it even
 *  after an app restart; undo (Z) reclaims it any time before it goes out. */
export function SendLaterPicker() {
  const schedule = (sendAtMs: number, label: string) => async () => {
    const c = useUi.getState().compose;
    if (!c) return;
    const mail = outgoingFromCompose(c);
    if (mail.to.length === 0) {
      useUi.getState().showToast("Add a recipient before scheduling");
      return;
    }
    // Scheduling IS a send path: the same Drive gates apply — no scheduling
    // while an upload is mid-flight, and linked files get their share dialog
    // now (the message may leave while the app is unattended).
    const blocker = driveSendBlocker();
    if (blocker) {
      useUi.getState().showToast(blocker);
      return;
    }
    if (!(await shareDriveLinks(c, mail))) return; // user cancelled
    const queued = await backend.queueMail(mail, Math.max(0, sendAtMs - Date.now()));
    if (c.draftId !== null && c.draftAccount !== null)
      void backend.deleteDraft(c.draftId, c.draftAccount).catch(() => {});
    const saved = { ...c, draftId: null, draftAccount: null };
    useUi.getState().closeCompose();
    useUi.getState().showToast(`Scheduled — ${label} (Z to unschedule)`);
    pushUndo({
      label: "Send Later",
      run: async () => {
        try {
          await backend.cancelOutbox(queued.id, queued.account);
          useUi.getState().startCompose(saved);
          useUi.getState().showToast("Unscheduled — draft restored");
        } catch {
          useUi.getState().showToast("Too late — already sent");
        }
      },
    });
  };

  const now = new Date();
  const items: PickerItem[] = [
    { label: "In 1 hour", run: schedule(Date.now() + 3600_000, "in 1 hour") },
    {
      label: "This evening",
      detail: "6:00 PM",
      run: schedule(at(18, now.getHours() >= 18 ? 1 : 0), "this evening"),
    },
    { label: "Tomorrow morning", detail: "8:00 AM", run: schedule(at(8, 1), "tomorrow 8 AM") },
    {
      label: "Monday morning",
      detail: "Mon 8:00 AM",
      run: schedule(at(8, (1 - now.getDay() + 7) % 7 || 7), "Monday 8 AM"),
    },
    { label: "In 2 minutes (demo)", detail: "for testing", run: schedule(Date.now() + 120_000, "in 2 minutes") },
  ];

  return <PickerShell title="Send later…" items={items} />;
}
