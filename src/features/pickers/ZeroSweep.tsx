import { backend } from "@/lib/ipc";
import { pushUndo } from "@/lib/undo";
import { useMail } from "@/stores/mail";
import { useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

/** "Get Me To Zero" — bulk archive so the first cleanup doesn't take an hour
 *  of hammering E. Applies to the active split. One Z restores the whole sweep. */
export function ZeroSweep() {
  const run =
    (olderThanDays: number, preserveUnread: boolean, preserveStarred: boolean) =>
    async () => {
      // The sweep covers the whole split, so the undo set comes back FROM the
      // backend. Predicting it here from `inbox` (the loaded page) is what made
      // "Z restores all" a lie the moment a split outgrew the display window.
      const { archived, ids } = await useMail.getState().bulkArchive({
        olderThanDays,
        preserveUnread,
        preserveStarred,
      });
      if (ids.length > 0) {
        pushUndo({
          label: "Get Me To Zero",
          run: async () => {
            const restored = await backend.bulkMoveToInbox(ids);
            await useMail.getState().refresh();
            useUi
              .getState()
              .showToast(`Restored ${restored} conversation${restored === 1 ? "" : "s"}`);
          },
        });
      }
      useUi
        .getState()
        .showToast(`Archived ${archived} conversation${archived === 1 ? "" : "s"} — Z restores all`);
      await useUi.getState().checkInboxZero();
    };

  const items: PickerItem[] = [
    {
      label: "Archive older than 7 days, keep unread + starred",
      detail: "gentle",
      run: run(7, true, true),
    },
    {
      label: "Archive older than 3 days, keep unread + starred",
      run: run(3, true, true),
    },
    {
      label: "Archive older than 7 days, keep starred only",
      run: run(7, false, true),
    },
    {
      label: "Archive everything, keep unread + starred",
      run: run(0, true, true),
    },
    {
      label: "Archive everything in this split",
      detail: "the full sweep",
      run: run(0, false, false),
    },
  ];

  return <PickerShell title="Get Me To Zero — archive this split" items={items} />;
}
