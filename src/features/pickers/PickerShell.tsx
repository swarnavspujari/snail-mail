import { useEffect, useRef, useState } from "react";
import { useScrollSelectedIntoView } from "@/lib/scroll-into-view";
import { useUi } from "@/stores/ui";

export interface PickerItem {
  label: string;
  detail?: string;
  run: () => void | Promise<void>;
  /** Secondary action on Ctrl/Cmd+Enter (e.g. Drive "attach as copy"). */
  runAlt?: () => void | Promise<void>;
}

/** Shared chrome for small keyboard-driven option lists (snooze, move…).
 *  Two filter modes: `filterable` filters the given items locally;
 *  `onQuery` hands the typed query to the owner (async sources like Drive)
 *  and renders whatever items come back. */
export function PickerShell({
  title,
  items,
  filterable,
  onQuery,
  queryPlaceholder,
  footer,
}: {
  title: string;
  items: PickerItem[];
  filterable?: boolean;
  onQuery?: (query: string) => void;
  queryPlaceholder?: string;
  footer?: React.ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The list scrolls (max-h + overflow), so moving the highlight has to move
  // the viewport with it — otherwise holding Down walks the selection off the
  // bottom and you are steering something you cannot see.
  const listRef = useScrollSelectedIntoView<HTMLDivElement>(index);

  const hasInput = filterable || onQuery !== undefined;
  const shown = filterable
    ? items.filter((i) => i.label.toLowerCase().includes(query.toLowerCase()))
    : items;

  useEffect(() => {
    (hasInput ? inputRef : boxRef).current?.focus();
  }, [hasInput]);

  useEffect(() => setIndex(0), [query, items.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // stopPropagation everywhere: this handler sits on BOTH the filter input
    // and the outer box, so a handled key must not bubble input → box and run
    // twice (Enter double-ran the action — two chips from one pick).
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      useUi.getState().closePicker();
    } else if (e.key === "ArrowDown" || (e.key === "j" && !hasInput)) {
      e.preventDefault();
      e.stopPropagation();
      setIndex((i) => Math.min(shown.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.key === "k" && !hasInput)) {
      e.preventDefault();
      e.stopPropagation();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const item = shown[index];
      if (!item) return;
      const alt = (e.ctrlKey || e.metaKey) && item.runAlt;
      useUi.getState().closePicker();
      void (alt ? item.runAlt!() : item.run());
    }
  };

  return (
    <div
      className="zb-fade-in absolute inset-0 z-40 flex items-start justify-center bg-black/50 pt-[16vh]"
      onClick={() => useUi.getState().closePicker()}
    >
      <div
        ref={boxRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="zb-pop-in w-[440px] max-w-[90vw] overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-2xl outline-none"
      >
        <div className="border-b border-line px-4 py-3 text-[13px] font-medium text-ink">
          {title}
        </div>
        {hasInput && (
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              onQuery?.(e.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder={queryPlaceholder ?? "Filter…"}
            className="w-full border-b border-line bg-transparent px-4 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
        )}
        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1">
          {shown.map((item, i) => (
            <button
              key={`${i}-${item.label}`}
              data-row={i}
              onClick={() => {
                useUi.getState().closePicker();
                void item.run();
              }}
              onMouseEnter={() => setIndex(i)}
              className={`flex w-full items-center px-4 py-2 text-left text-[13px] ${
                i === index ? "bg-selected text-ink" : "text-ink-2"
              }`}
            >
              <span className="flex-1">{item.label}</span>
              {item.detail && (
                <span className="text-[11.5px] text-ink-3">{item.detail}</span>
              )}
            </button>
          ))}
          {shown.length === 0 && (
            <div className="px-4 py-5 text-center text-[13px] text-ink-3">
              Nothing matches
            </div>
          )}
        </div>
        {footer && (
          <div className="border-t border-line px-4 py-2 text-[11.5px] text-ink-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
