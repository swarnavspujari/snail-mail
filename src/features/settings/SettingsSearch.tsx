// Ctrl+F inside settings: one index over every preference, every command's keys,
// every connected address and the help pages. Results carry their breadcrumb, and
// a boolean can be flipped right here (click its switch, or Ctrl+Enter on the
// highlighted row) instead of only being jumped to.
import { useEffect, useMemo, useRef, useState } from "react";
import { KeyHint } from "@/components/KeyHint";
import { allCommands } from "@/lib/commands";
import { buildShortcutRows } from "@/lib/shortcut-edit";
import {
  buildSettingsIndex,
  groupEntries,
  searchEntries,
  type SearchEntry,
} from "@/lib/settings-search";
import { prefRow } from "@/lib/settings-catalog";
import { openExternal } from "@/lib/ipc";
import { useSettings } from "@/stores/settings";
import { applyPref } from "./Pref";
import { SearchGlyph } from "./ShortcutsEditor";

export function SettingsSearch({
  onClose,
  onJump,
}: {
  onClose: () => void;
  onJump: (pane: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const settings = useSettings((s) => s.settings);
  const accounts = useSettings((s) => s.accounts);
  const capabilities = useSettings((s) => s.capabilities);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const entries = useMemo(() => {
    const shortcutRows = buildShortcutRows(
      allCommands().map((c) => ({
        id: c.id,
        title: c.title,
        group: c.group,
        context: c.context,
      })),
      settings.shortcuts
    );
    return buildSettingsIndex({ settings, accounts, capabilities, shortcutRows });
  }, [settings, accounts, capabilities]);

  const hits = useMemo(() => searchEntries(entries, query), [entries, query]);
  const groups = groupEntries(hits);
  useEffect(() => setIndex(0), [query]);

  const open = (e: SearchEntry) => {
    if (e.url) {
      void openExternal(e.url);
      onClose();
      return;
    }
    onJump(e.pane);
    onClose();
  };

  const toggle = (e: SearchEntry) => {
    if (!e.prefId || !e.toggleKey) return;
    const row = prefRow(e.prefId);
    const next = !settings[e.toggleKey];
    applyPref(row, String(next), `${row.label} ${next ? "on" : "off"}`);
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    ev.stopPropagation();
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setIndex((i) => Math.min(hits.length - 1, i + 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const hit = hits[index];
      if (!hit) return;
      if (ev.ctrlKey || ev.metaKey) toggle(hit);
      else open(hit);
    }
  };

  let flat = -1;

  return (
    <div
      className="zb-fade-in absolute inset-0 z-30 flex items-start justify-center bg-black/50 pt-16"
      onClick={onClose}
    >
      {/* Same dark-on-any-theme surface as the Shell Command palette. */}
      <div
        className="zb-pop-in w-[620px] max-w-[calc(100%-48px)] overflow-hidden rounded-xl border border-[var(--palette-line)] bg-[var(--palette-bg)] shadow-2xl [color-scheme:dark]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-[46px] items-center gap-2.5 border-b border-[var(--palette-line)] px-3.5">
          <span className="text-[var(--palette-text-faint)]">
            <SearchGlyph />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search settings, shortcuts and accounts"
            /* the field IS the focus — the app-wide focus ring would just draw a
               box inside the dialog that is already focused */
            className="min-w-0 flex-1 bg-transparent text-[14.5px] text-[var(--palette-text)] outline-none focus-visible:shadow-none placeholder:text-[var(--palette-text-faint)]"
          />
          <span className="text-[11px] text-[var(--palette-text-faint)]">
            {hits.length} result{hits.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="max-h-[376px] overflow-y-auto py-1.5 [scrollbar-gutter:stable]">
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="px-4 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--palette-text-faint)]">
                {g.kind}
              </div>
              {g.entries.map((e) => {
                flat += 1;
                const on = flat === index;
                const i = flat;
                return (
                  <div
                    key={`${e.kind}-${e.label}-${i}`}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => open(e)}
                    className={`relative flex cursor-pointer items-center gap-2.5 px-4 py-[7px] ${
                      on ? "bg-[var(--palette-hover)]" : ""
                    }`}
                  >
                    <span
                      className={`absolute inset-y-1 left-0 w-0.5 rounded-sm ${
                        on ? "bg-accent" : "bg-transparent"
                      }`}
                    />
                    <span className="w-4 shrink-0 text-center text-[12px] text-[var(--palette-text-faint)]">
                      {e.glyph}
                    </span>
                    <span className="min-w-0 shrink truncate text-[13.5px] text-[var(--palette-text)]">
                      {e.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--palette-text-faint)]">
                      {e.path}
                    </span>
                    {e.keys && (
                      <span className="shrink-0">
                        <KeyHint expr={e.keys} size="sm" on="tooltip" />
                      </span>
                    )}
                    {e.toggleKey ? (
                      <button
                        aria-label={`Toggle ${e.label}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          toggle(e);
                        }}
                        className={`relative h-[18px] w-[30px] shrink-0 rounded-full border ${
                          settings[e.toggleKey]
                            ? "border-transparent bg-accent"
                            : "border-[var(--palette-line)] bg-white/10"
                        }`}
                      >
                        <span
                          className={`absolute top-[2px] h-3 w-3 rounded-full ${
                            settings[e.toggleKey]
                              ? "left-[14px] bg-on-accent"
                              : "left-[2px] bg-[var(--palette-text-faint)]"
                          }`}
                        />
                      </button>
                    ) : (
                      e.value && (
                        <span className="max-w-[180px] shrink-0 truncate text-[11.5px] text-[var(--palette-text-dim)]">
                          {e.value}
                        </span>
                      )
                    )}
                    {on && (
                      <span className="shrink-0 text-[11px] text-accent">
                        {e.toggleKey
                          ? "ctrl+enter toggles"
                          : e.keys !== undefined
                            ? "enter to remap"
                            : "enter to open"}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {hits.length === 0 && (
            <div className="px-4 py-6 text-center text-[12.5px] text-[var(--palette-text-faint)]">
              Nothing matches. Try “undo”, “drive”, “key” or a literal key like
              “ctrl k”.
            </div>
          )}
        </div>

        <div className="flex items-center gap-3.5 border-t border-[var(--palette-line)] px-3.5 py-2 text-[11px] text-[var(--palette-text-faint)]">
          <Hint expr="up|down" label="move" />
          <Hint expr="enter" label="open" />
          <Hint expr="mod+enter" label="change here" />
          <Hint expr="escape" label="close" />
        </div>
      </div>
    </div>
  );
}

function Hint({ expr, label }: { expr: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <KeyHint expr={expr} size="sm" on="tooltip" />
      <span>{label}</span>
    </span>
  );
}
