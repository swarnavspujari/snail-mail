import { useEffect, useState } from "react";
import { backend } from "@/lib/ipc";
import { displayLabel, normalizeRecipients } from "@/lib/recipients";
import { useUi, type ComposeState } from "@/stores/ui";
import { PickerShell, type PickerItem } from "./PickerShell";
import type { DraftEntry } from "@/lib/types";

function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay)
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** G then D — resume an unsent draft. Sending or discarding it in compose
 *  removes it from this list. */
export function DraftsPicker() {
  const [drafts, setDrafts] = useState<DraftEntry[] | null>(null);

  useEffect(() => {
    void backend.listDrafts().then(setDrafts);
  }, []);

  if (drafts === null) return null;

  const items: PickerItem[] = drafts.map((d) => {
    let parsed: Omit<ComposeState, "draftId" | "draftAccount"> | null = null;
    try {
      parsed = JSON.parse(d.payload);
    } catch {
      /* corrupt draft rows are shown raw and can be discarded in compose */
    }
    const subject = parsed?.subject?.trim() || "(no subject)";
    // normalize, don't read: a draft written before recipients became arrays
    // still holds a comma-separated string, and calling .trim() on the array
    // that replaced it threw — taking out the picker, and with it access to
    // every draft.
    const to = normalizeRecipients(parsed?.to).map(displayLabel).join(", ");
    return {
      label: subject,
      detail: `${to ? `to ${to} · ` : ""}${fmtWhen(d.updatedAt)}`,
      run: () => {
        if (!parsed) {
          void backend.deleteDraft(d.id, d.account);
          useUi.getState().showToast("Draft was unreadable — removed");
          return;
        }
        useUi.getState().startCompose({
          ...parsed,
          // Drafts saved before Bcc/Drive links existed lack those fields;
          // ones saved before chips hold recipients as a single string.
          to: normalizeRecipients(parsed.to),
          cc: normalizeRecipients(parsed.cc),
          bcc: normalizeRecipients(parsed.bcc),
          attachments: parsed.attachments ?? [],
          driveLinks: parsed.driveLinks ?? [],
          draftId: d.id,
          draftAccount: d.account,
        });
      },
    };
  });

  if (items.length === 0) {
    return (
      <PickerShell
        title="Drafts"
        items={[{ label: "No drafts — Esc to close", run: () => {} }]}
      />
    );
  }
  return <PickerShell title="Drafts — Enter resumes" items={items} filterable />;
}
