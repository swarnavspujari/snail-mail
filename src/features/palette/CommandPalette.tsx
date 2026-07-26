import { useEffect, useMemo, useRef, useState } from "react";
import { useScrollSelectedIntoView } from "@/lib/scroll-into-view";
import { allCommands, runCommand, type Command } from "@/lib/commands";
import { formatKeyExpr } from "@/lib/keyboard";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";

function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q);
  // subsequence match
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length ? 10 : -1;
}

export function CommandPalette() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Same fix as PickerShell: the highlight must drag the scroll viewport with
  // it, or arrowing past the visible rows steers something off-screen.
  const listRef = useScrollSelectedIntoView<HTMLDivElement>(index);
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  // The per-command chord chip teaches that command's key, so it answers to
  // showKeyHints like every other hint. The palette's OWN driving keys are a
  // different thing and would stay — it has none rendered today.
  const keyHints = useSettings((s) => s.settings.showKeyHints);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo(() => {
    const available = allCommands().filter(
      (c) => !c.hidden && (!c.when || c.when())
    );
    return available
      .map((c) => ({
        c,
        score: Math.max(
          fuzzyScore(query, c.title),
          c.keywords ? fuzzyScore(query, c.keywords) : -1
        ),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const runItem = (c: Command) => {
    useUi.getState().closePalette();
    runCommand(c);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      useUi.getState().closePalette();
    } else if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = items[index];
      if (c) runItem(c);
    }
  };

  let lastGroup = "";

  return (
    <div
      className="zb-fade-in absolute inset-0 z-40 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={() => useUi.getState().closePalette()}
    >
      {/* Shell Command is dark on any theme — --palette-* tokens don't
          flip with the light theme (design system rule). */}
      <div
        className="zb-pop-in w-[640px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--palette-line)] bg-[var(--palette-bg)] shadow-2xl [color-scheme:dark]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-4 pb-2 pt-3.5 text-[13px] text-[var(--palette-text-faint)]">
          <span aria-hidden>⬡</span> Shell Command
        </div>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type a command…"
          className="w-full border-b border-t border-[var(--palette-line)] bg-transparent px-4 py-3 text-[15px] text-[var(--palette-text)] outline-none placeholder:text-[var(--palette-text-faint)]"
        />
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {items.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && (
                  <div className="px-4 pb-1 pt-2.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--palette-text-faint)]">
                    {header}
                  </div>
                )}
                <button
                  data-row={i}
                  onClick={() => runItem(c)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-center px-4 py-2 text-left text-[13.5px] ${
                    i === index
                      ? "bg-[var(--palette-hover)] text-[var(--palette-text)]"
                      : "text-[var(--palette-text-dim)]"
                  }`}
                >
                  <span className="flex-1">{c.title}</span>
                  {keyHints && shortcuts[c.id] && (
                    <span className="rounded px-1.5 text-[11px] leading-4 text-[var(--palette-text-dim)] [background:rgba(255,255,255,0.08)]">
                      {formatKeyExpr(shortcuts[c.id])}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="px-4 py-6 text-center text-[13px] text-[var(--palette-text-faint)]">
              No matching commands
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
