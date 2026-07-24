import { backend } from "@/lib/ipc";
import { threadInSplit } from "@/lib/split-query";
import { pushUndo } from "@/lib/undo";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";

/** "Get Me To Zero" — bulk archive so the first cleanup doesn't take an hour
 *  of hammering E. Applies to the active split. One Z restores the whole sweep. */
export function ZeroSweep() {
  const run =
    (olderThanDays: number, preserveUnread: boolean, preserveStarred: boolean) =>
    async () => {
      // Predict the swept set with the same materialized membership the
      // backend applies, so a single undo entry can bring all of it back.
      const m = useMail.getState();
      const st = useSettings.getState();
      const cutoff = Date.now() - olderThanDays * 86_400_000;
      const swept = m.inbox
        .filter(
          (t) =>
            t.snoozedUntil === null &&
            (olderThanDays === 0 || t.lastDate <= cutoff) &&
            !(preserveUnread && t.unread) &&
            !(preserveStarred && t.starred) &&
            (m.listView !== "inbox" ||
              threadInSplit(t, m.activeSplitId, st.settings.splits, st.accounts.active))
        )
        .map((t) => t.id);

      const n = await useMail.getState().bulkArchive({
        olderThanDays,
        preserveUnread,
        preserveStarred,
      });
      if (swept.length > 0) {
        pushUndo({
          label: "Get Me To Zero",
          run: async () => {
            for (const id of swept) {
              await backend.moveToInbox(id);
            }
            await useMail.getState().refresh();
            useUi
              .getState()
              .showToast(`Restored ${swept.length} conversation${swept.length === 1 ? "" : "s"}`);
          },
        });
      }
      useUi
        .getState()
        .showToast(`Archived ${n} conversation${n === 1 ? "" : "s"} — Z restores all`);
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
