// The shortcuts editor: every command in the app, grouped the way the command
// palette groups them, filterable by name OR by key, with the five states a
// binding can actually be in made visually distinct — because "one keycap per
// row" hid all of them. See lib/shortcut-edit.ts for the model.
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { KeyHint } from "@/components/KeyHint";
import { Pill } from "@/components/Pill";
import { allCommands } from "@/lib/commands";
import { formatKeyExpr } from "@/lib/keyboard";
import {
  buildShortcutRows,
  captureExpr,
  facetCounts,
  inFacet,
  matchesShortcutQuery,
  SHORTCUT_GROUP_ORDER,
  type ShortcutFacet,
  type ShortcutRow,
} from "@/lib/shortcut-edit";
import { useSettings } from "@/stores/settings";
import { useReceipt } from "./receipt";

const FACETS: { id: ShortcutFacet; label: string }[] = [
  { id: "all", label: "All" },
  { id: "changed", label: "Changed" },
  { id: "unassigned", label: "Unassigned" },
  { id: "conflicts", label: "Conflicts" },
];

/** Write one binding, with the previous value as the undo. */
function bind(id: string, expr: string, label: string) {
  const shortcuts = useSettings.getState().settings.shortcuts;
  const before = shortcuts[id] ?? "";
  void useSettings.getState().save({ shortcuts: { ...shortcuts, [id]: expr } });
  useReceipt.getState().note(label, () => {
    const now = useSettings.getState().settings.shortcuts;
    return useSettings.getState().save({ shortcuts: { ...now, [id]: before } });
  });
}

export function ShortcutsEditor() {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const [query, setQuery] = useState("");
  const [facet, setFacet] = useState<ShortcutFacet>("all");
  /** Command id whose next keypress becomes its binding. */
  const [recording, setRecording] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      buildShortcutRows(
        allCommands().map((c) => ({
          id: c.id,
          title: c.title,
          group: c.group,
          context: c.context,
        })),
        shortcuts
      ),
    [shortcuts]
  );

  const counts = useMemo(() => facetCounts(rows), [rows]);
  const visible = rows.filter(
    (r) => inFacet(r, facet) && matchesShortcutQuery(r, query)
  );

  // While capturing, the app's own keyboard engine must not see the keys — this
  // listens on the capture phase and swallows everything until the row is bound.
  useEffect(() => {
    if (!recording) return;
    const id = recording;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const title = rows.find((r) => r.id === id)?.title ?? id;
      if (e.key === "Escape") return setRecording(null);
      if (e.key === "Backspace" || e.key === "Delete") {
        bind(id, "", `${title} turned off`);
        return setRecording(null);
      }
      const expr = captureExpr(e);
      if (!expr) return; // a bare modifier — still reaching for the real key
      bind(id, expr, `${title} → ${formatKeyExpr(expr)}`);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, rows]);

  const groups = SHORTCUT_GROUP_ORDER.map((g) => ({
    group: g,
    items: visible.filter((r) => r.group === g),
  })).filter((g) => g.items.length > 0);

  return (
    <section>
      <div className="mx-0.5 mb-2 flex items-baseline gap-2.5">
        <h2 className="text-[13px] font-semibold text-ink">Shortcuts</h2>
        <span className="text-[11.5px] text-ink-3">
          {counts.all} commands · click a key to remap, Backspace clears it
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center gap-2.5 border-b border-line px-3 py-2.5">
          <div className="flex h-7 min-w-0 flex-1 items-center gap-[7px] rounded-md border border-line-strong bg-raised px-2.5">
            <SearchGlyph />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Filter by command, or type a key like “ctrl k” to find what owns it"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none focus-visible:shadow-none placeholder:text-ink-3"
            />
          </div>
          <div className="flex gap-1">
            {FACETS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFacet(f.id)}
                className={`rounded-md border px-2.5 py-1 text-[11.5px] ${
                  facet === f.id
                    ? "border-accent bg-accent-dim text-ink"
                    : "border-line-strong text-ink-3 hover:text-ink-2"
                }`}
              >
                {f.label} {counts[f.id]}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto [scrollbar-gutter:stable]">
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div className="sticky top-0 z-1 flex items-center gap-2 border-b border-line bg-raised px-3.5 py-[7px] text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-2">
                <span>{group}</span>
                <span className="font-normal normal-case tracking-normal text-ink-3">
                  {items.length} {items.length === 1 ? "command" : "commands"}
                </span>
              </div>
              {items.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  recording={recording === r.id}
                  onRecord={() => setRecording(r.id)}
                />
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <div className="px-4 py-8 text-center text-[12.5px] text-ink-3">
              No command matches “{query}”.
            </div>
          )}
        </div>

        <Legend />
      </div>
    </section>
  );
}

function Row({
  row,
  recording,
  onRecord,
}: {
  row: ShortcutRow;
  recording: boolean;
  onRecord: () => void;
}) {
  const bg =
    row.state === "conflict"
      ? "bg-bad/8"
      : recording
        ? "bg-accent-dim"
        : "hover:bg-hover";
  return (
    <div
      className={`flex flex-col gap-1.5 border-t border-line px-3.5 py-2.5 transition-colors ${bg}`}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-[13px] text-ink">{row.title}</span>
          {row.context && (
            <Pill tone="neutral" fill="dim">
              {row.context}
            </Pill>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {recording ? (
            <>
              <span className="text-[11.5px] text-accent-strong">Listening…</span>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-dim px-2 py-[3px] text-[11px] text-ink-2">
                press a key
              </span>
            </>
          ) : (
            <>
              {row.state === "unassigned" && (
                <span className="text-[11.5px] text-ink-3">Not assigned</span>
              )}
              <button
                onClick={onRecord}
                title="Click to remap"
                className="rounded-md focus-visible:outline-none"
              >
                {row.expr ? (
                  <span
                    className={
                      row.state === "conflict"
                        ? "inline-flex items-center gap-1.5 rounded-md border border-bad px-1.5 py-0.5"
                        : "inline-flex items-center gap-1.5"
                    }
                  >
                    <KeyHint expr={row.expr} />
                  </span>
                ) : (
                  <span className="inline-flex h-[18px] min-w-[40px] items-center justify-center rounded border border-dashed border-line-strong px-1.5 font-mono text-[10.5px] text-ink-3">
                    add
                  </span>
                )}
              </button>
              {row.state === "conflict" && <Pill tone="danger">Conflict</Pill>}
              {row.state === "changed" && <Pill tone="accent">Changed</Pill>}
              {row.state === "off" && (
                <Pill tone="neutral" fill="outline">
                  Turned off
                </Pill>
              )}
              {row.state === "shared" && (
                <Pill tone="neutral" fill="dim" title={row.sharesWith.join(", ")}>
                  by context
                </Pill>
              )}
              {row.state === "off" && (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    bind(
                      row.id,
                      row.defaultExpr,
                      `${row.title} restored to ${formatKeyExpr(row.defaultExpr)}`
                    )
                  }
                >
                  Restore {formatKeyExpr(row.defaultExpr)}
                </Button>
              )}
              {(row.state === "changed" || row.state === "conflict") &&
                row.defaultExpr !== row.expr && (
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() =>
                      bind(
                        row.id,
                        row.defaultExpr,
                        `${row.title} reset to ${
                          row.defaultExpr ? formatKeyExpr(row.defaultExpr) : "no key"
                        }`
                      )
                    }
                  >
                    {row.state === "conflict" && row.defaultExpr
                      ? `Revert to ${formatKeyExpr(row.defaultExpr)}`
                      : "Reset"}
                  </Button>
                )}
            </>
          )}
        </div>
      </div>
      {recording && (
        <div className="text-[11px] text-accent-strong">
          Press the keys to bind · Backspace clears it · Esc keeps{" "}
          {row.expr ? formatKeyExpr(row.expr) : "it unassigned"}
        </div>
      )}
      {!recording && row.state === "conflict" && (
        <div className="text-[11px] text-bad">
          Also bound to {row.conflictsWith.join(", ")} in the same context — the
          last one registered wins, so one of them will never fire.
        </div>
      )}
      {!recording && row.state === "off" && (
        <div className="text-[11px] text-ink-3">
          You cleared this on purpose — it stays empty until you restore it.
        </div>
      )}
      {!recording && row.state === "shared" && row.sharesWith.length > 0 && (
        <div className="max-w-[64ch] text-[11px] text-ink-3">
          Shares {formatKeyExpr(row.expr)} with{" "}
          {row.sharesWith.length === 1
            ? "one other command"
            : `${row.sharesWith.length} other commands`}
          , resolved by where you are — not by order.
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3.5 border-t border-line bg-surface px-3.5 py-2.5 text-[11px] text-ink-3">
      <span className="inline-flex items-center gap-1.5">
        <KeyHint expr="e" size="sm" />
        <span>default</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Pill tone="accent">Changed</Pill>
        <span>you remapped it — reset anytime</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-flex h-4 min-w-[34px] items-center justify-center rounded border border-dashed border-line-strong font-mono text-[10px] text-ink-3">
          add
        </span>
        <span>never had a key</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Pill tone="neutral" fill="outline">
          Turned off
        </Pill>
        <span>you cleared it</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Pill tone="neutral" fill="dim">
          by context
        </Pill>
        <span>shared key, resolved by where you are</span>
      </span>
    </div>
  );
}

export function SearchGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      className="shrink-0 text-ink-3"
      aria-hidden
    >
      <circle cx="5" cy="5" r="3.4" />
      <path d="M7.7 7.7 10.6 10.6" />
    </svg>
  );
}
