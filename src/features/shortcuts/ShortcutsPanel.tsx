import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { exprKeycaps } from "@/lib/keyboard";
import { Kbd } from "@/components/Kbd";
import {
  SHORTCUTS_CATALOG,
  liveKeysFor,
  type CatalogItem,
} from "@/lib/shortcuts-catalog";

/** A binding as keycap chips; chords render "G then I" with a plain "then".
 *  Exempt from settings.showKeyHints on purpose — this panel IS the shortcut
 *  reference, so hiding its keycaps would empty it. */
function Keycaps({ expr }: { expr: string }) {
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {expr
        .split("|")
        .flatMap((alt, i) =>
          exprKeycaps(alt.trim()).map((chip, j) =>
            chip === "then" ? (
              <span key={`${i}-${j}`} className="text-[10px] text-ink-3">
                then
              </span>
            ) : (
              <Kbd key={`${i}-${j}`}>{chip}</Kbd>
            )
          )
        )}
    </span>
  );
}

function Row({
  item,
  shortcuts,
}: {
  item: CatalogItem;
  shortcuts: Record<string, string>;
}) {
  const planned = item.status === "planned";
  return (
    <div
      className={`flex items-center gap-3 py-[5px] ${planned ? "opacity-45" : ""}`}
      title={item.note}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">
        {item.label}
        {planned && (
          <span className="ml-2 rounded-full border border-line px-1.5 text-[9px] uppercase tracking-wide text-ink-3">
            soon
          </span>
        )}
      </span>
      <Keycaps expr={liveKeysFor(item, shortcuts)} />
    </div>
  );
}

/** Right-hand shortcuts reference, Superhuman-style: the full sheet in their
 *  categories, live-updated from Settings → Shortcuts remaps. Dimmed rows are
 *  Superhuman capabilities on the Snail Mail roadmap (see docs/SHORTCUTS.md).
 *  Opens from the palette ("Keyboard Shortcuts"); Esc or × closes. */
export function ShortcutsPanel() {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-surface 2xl:w-80">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex-1 text-[14px] font-semibold text-ink">
          Shortcuts
        </span>
        <Kbd>esc</Kbd>
        <button
          className="rounded px-1.5 text-[15px] leading-none text-ink-3 hover:bg-hover hover:text-ink"
          onClick={() => useUi.getState().setShortcutsOpen(false)}
          title="Close (Esc)"
        >
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {SHORTCUTS_CATALOG.map((section) => (
          <div key={section.title}>
            <div className="pb-1.5 pt-4 text-[13px] font-semibold text-ink">
              {section.title}
            </div>
            {section.items.map((item, i) => (
              <Row key={`${item.label}-${i}`} item={item} shortcuts={shortcuts} />
            ))}
          </div>
        ))}
        <div className="pt-4 text-[11px] leading-relaxed text-ink-3">
          Dimmed = on the roadmap. Hover a row for notes. Remap anything in
          Settings → Shortcuts.
        </div>
      </div>
    </aside>
  );
}
