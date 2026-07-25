// Model behind the Keyboard pane's shortcut editor.
//
// The keyboard engine (lib/keyboard.ts) resolves two commands on one key with
// their `when` predicates plus registration order. That is the right runtime
// behaviour but it is invisible: users can't tell "↓ is three commands, and the
// right one wins wherever you are" from "Reply and Forward are both R and one
// of them silently loses". This module names the difference, so the editor can
// show five honest states instead of a single keycap.
import { eventToken, exprKeycaps } from "./keyboard";
import { DEFAULT_SHORTCUTS } from "./defaults";

/** The slice of a Command this module needs (keeps it testable + pure). */
export interface ShortcutCommand {
  id: string;
  title: string;
  group: string;
  context?: string;
}

export type ShortcutState =
  /** bound to the key it ships with */
  | "default"
  /** you remapped it — resettable */
  | "changed"
  /** shares a key with another command in a DIFFERENT context; the engine
   *  picks by where you are, so this is legitimate, not a clash */
  | "shared"
  /** shares a key with another command in the SAME context — one of them
   *  silently loses */
  | "conflict"
  /** you cleared a key it used to have */
  | "off"
  /** never had a key */
  | "unassigned";

export interface ShortcutRow {
  id: string;
  title: string;
  group: string;
  context?: string;
  /** The live binding ("" = no key). */
  expr: string;
  /** What it ships with, for Reset / Restore. */
  defaultExpr: string;
  state: ShortcutState;
  /** Command ids sharing at least one alternative with this row. */
  sharesWith: string[];
  /** Titles of the same-context commands this row clashes with. */
  conflictsWith: string[];
}

/** Group order borrowed from the command palette's own sections. */
export const SHORTCUT_GROUP_ORDER = [
  "General",
  "Navigate",
  "Triage",
  "Compose",
  "AI",
  "Accounts",
];

/** The individually-bindable alternatives of an expression ("j|down"). */
function alts(expr: string): string[] {
  return expr
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Two commands only really clash when their keys are live in the same place.
 *  An absent context means "everywhere the engine allows", which collides with
 *  another absent context but not with a scoped one. */
function sameContext(a: ShortcutCommand, b: ShortcutCommand): boolean {
  return (a.context ?? "") === (b.context ?? "");
}

export function buildShortcutRows(
  commands: ShortcutCommand[],
  shortcuts: Record<string, string>,
  defaults: Record<string, string> = DEFAULT_SHORTCUTS
): ShortcutRow[] {
  const byId = new Map(commands.map((c) => [c.id, c]));

  // alternative token -> command ids bound to it
  const owners = new Map<string, string[]>();
  for (const c of commands) {
    for (const alt of alts(shortcuts[c.id] ?? "")) {
      const list = owners.get(alt);
      if (list) list.push(c.id);
      else owners.set(alt, [c.id]);
    }
  }

  const rows = commands.map((c) => {
    const expr = shortcuts[c.id] ?? "";
    const defaultExpr = defaults[c.id] ?? "";
    const shares = new Set<string>();
    const clashes = new Set<string>();
    for (const alt of alts(expr)) {
      for (const other of owners.get(alt) ?? []) {
        if (other === c.id) continue;
        shares.add(other);
        const o = byId.get(other);
        if (o && sameContext(c, o)) clashes.add(o.title);
      }
    }

    let state: ShortcutState;
    if (expr === "") state = defaultExpr === "" ? "unassigned" : "off";
    else if (clashes.size) state = "conflict";
    else if (expr !== defaultExpr) state = "changed";
    else if (shares.size) state = "shared";
    else state = "default";

    return {
      id: c.id,
      title: c.title,
      group: c.group,
      context: c.context,
      expr,
      defaultExpr,
      state,
      sharesWith: [...shares],
      conflictsWith: [...clashes],
    };
  });

  const rank = (g: string) => {
    const i = SHORTCUT_GROUP_ORDER.indexOf(g);
    return i === -1 ? SHORTCUT_GROUP_ORDER.length : i;
  };
  // Stable within a group: the registry's own order is the palette's order.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.group) - rank(b.r.group) || a.i - b.i)
    .map((x) => x.r);
}

export type ShortcutFacet = "all" | "changed" | "unassigned" | "conflicts";

export function facetCounts(rows: ShortcutRow[]): Record<ShortcutFacet, number> {
  return {
    all: rows.length,
    changed: rows.filter((r) => r.state === "changed").length,
    unassigned: rows.filter((r) => r.state === "unassigned" || r.state === "off")
      .length,
    conflicts: rows.filter((r) => r.state === "conflict").length,
  };
}

export function inFacet(row: ShortcutRow, facet: ShortcutFacet): boolean {
  if (facet === "all") return true;
  if (facet === "changed") return row.state === "changed";
  if (facet === "conflicts") return row.state === "conflict";
  return row.state === "unassigned" || row.state === "off";
}

/** Everything a row can be found by: its name, its id, its raw expression and
 *  the keycaps as rendered — so "ctrl k" finds Shell Command, and pressing ↓
 *  in the filter box finds the three commands that own it. */
function haystack(row: ShortcutRow): string {
  const caps = alts(row.expr).flatMap((a) => {
    const chips = exprKeycaps(a);
    return [chips.join(" "), chips.join("+")];
  });
  return [row.title, row.id, row.expr, row.context ?? "", ...caps]
    .join(" ")
    .toLowerCase();
}

export function matchesShortcutQuery(row: ShortcutRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack(row).includes(q);
}

/** The keydown fields captureExpr reads (a real KeyboardEvent satisfies it). */
export type KeyLike = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

/** A pressed key as an engine-parseable expression, or null when the press
 *  isn't bindable: a bare modifier (you're still reaching for the real key),
 *  or bare Escape / Enter, which cancel and commit the capture instead. */
export function captureExpr(e: KeyLike): string | null {
  const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (bare && (e.key === "Escape" || e.key === "Enter")) return null;
  return eventToken(e as KeyboardEvent);
}
