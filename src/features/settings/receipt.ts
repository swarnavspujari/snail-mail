// The one receipt in settings.
//
// Three save models (apply-on-change, an explicit Save button, and a dirty-state
// "unsaved changes" warning) collapse into one: preferences apply the instant
// you change them, text commits on blur or Enter, and this strip is the only
// confirmation — it names what changed and offers one undo (Ctrl+Z). Nothing
// needs a Save button because nothing is unreversible.
import { create } from "zustand";

interface ReceiptState {
  label: string | null;
  undo: (() => void | Promise<void>) | null;
  /** Record a change: "Undo send window → 30s". */
  note: (label: string, undo?: () => void | Promise<void>) => void;
  /** Run the pending undo (Ctrl+Z / the Undo button). No-op when there is none. */
  runUndo: () => void;
  clear: () => void;
}

export const useReceipt = create<ReceiptState>((set, get) => ({
  label: null,
  undo: null,
  note: (label, undo) => set({ label, undo: undo ?? null }),
  runUndo: () => {
    const u = get().undo;
    if (!u) return;
    void u();
    set({ label: null, undo: null });
  },
  clear: () => set({ label: null, undo: null }),
}));
