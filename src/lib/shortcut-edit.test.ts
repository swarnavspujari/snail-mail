import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS } from "./defaults";
import {
  buildShortcutRows,
  captureExpr,
  facetCounts,
  matchesShortcutQuery,
  type ShortcutCommand,
} from "./shortcut-edit";

const cmd = (
  id: string,
  title: string,
  group: string,
  context?: string
): ShortcutCommand => ({ id, title, group, context });

/** A tiny registry standing in for allCommands(). */
const REG: ShortcutCommand[] = [
  cmd("thread.done", "Mark Done", "Triage"),
  cmd("thread.reply", "Reply", "Compose"),
  cmd("thread.forward", "Forward", "Compose"),
  cmd("list.cursorDown", "Move Cursor Down", "Navigate", "in list"),
  cmd("reader.lineDown", "Scroll Email Down", "Navigate", "in thread"),
  cmd("thread.focusNext", "Next Message in Thread", "Navigate", "multi-message"),
  cmd("theme.toggle", "Toggle Theme", "General"),
  cmd("thread.mute", "Mute", "Triage"),
  cmd("palette.open", "Shell Command", "General"),
];

const DEFAULTS: Record<string, string> = {
  "thread.done": "e",
  "thread.reply": "r",
  "thread.forward": "f",
  "list.cursorDown": "down",
  "reader.lineDown": "down",
  "thread.focusNext": "down",
  "theme.toggle": "",
  "thread.mute": "shift+m",
  "palette.open": "mod+k",
};

function rows(overrides: Record<string, string> = {}) {
  const shortcuts = { ...DEFAULTS, ...overrides };
  const out = buildShortcutRows(REG, shortcuts, DEFAULTS);
  return Object.fromEntries(out.map((r) => [r.id, r]));
}

describe("buildShortcutRows — state classification", () => {
  it("marks an untouched binding as default", () => {
    expect(rows()["thread.done"].state).toBe("default");
  });

  it("marks a remapped binding as changed, keeping the default to reset to", () => {
    const r = rows({ "thread.done": "y" })["thread.done"];
    expect(r.state).toBe("changed");
    expect(r.defaultExpr).toBe("e");
    expect(r.expr).toBe("y");
  });

  it("distinguishes never-assigned from deliberately turned off", () => {
    const r = rows({ "thread.mute": "" });
    expect(r["theme.toggle"].state).toBe("unassigned");
    expect(r["thread.mute"].state).toBe("off");
    expect(r["thread.mute"].defaultExpr).toBe("shift+m");
  });

  it("treats a key shared across distinct contexts as resolved by context", () => {
    const r = rows();
    for (const id of ["list.cursorDown", "reader.lineDown", "thread.focusNext"]) {
      expect(r[id].state).toBe("shared");
    }
    expect(r["list.cursorDown"].sharesWith.sort()).toEqual([
      "reader.lineDown",
      "thread.focusNext",
    ]);
  });

  it("flags two commands in the SAME context on one key as a conflict", () => {
    const r = rows({ "thread.forward": "r" });
    expect(r["thread.forward"].state).toBe("conflict");
    expect(r["thread.reply"].state).toBe("conflict");
    expect(r["thread.forward"].conflictsWith).toEqual(["Reply"]);
  });

  it("conflicts win over changed", () => {
    // forward remapped onto reply's key is both changed AND conflicting
    const r = rows({ "thread.forward": "r" })["thread.forward"];
    expect(r.state).toBe("conflict");
    expect(r.expr).not.toBe(r.defaultExpr);
  });

  it("compares alternatives individually, not as whole expressions", () => {
    // "z|mod+z" vs "mod+z" overlap on one alternative
    const reg = [cmd("undo", "Undo", "General"), cmd("other", "Other", "General")];
    const r = buildShortcutRows(reg, { undo: "z|mod+z", other: "mod+z" }, {
      undo: "z|mod+z",
      other: "",
    });
    expect(r.every((x) => x.state === "conflict")).toBe(true);
  });

  it("ignores empty bindings when looking for overlaps", () => {
    const r = rows({ "theme.toggle": "", "thread.mute": "" });
    expect(r["theme.toggle"].sharesWith).toEqual([]);
    expect(r["thread.mute"].state).toBe("off");
  });

  it("keeps the registry's group and orders rows by palette group order", () => {
    const out = buildShortcutRows(REG, DEFAULTS, DEFAULTS);
    const groups = [...new Set(out.map((r) => r.group))];
    expect(groups).toEqual(["General", "Navigate", "Triage", "Compose"]);
  });

  it("works against the real default shortcut map", () => {
    const reg = Object.keys(DEFAULT_SHORTCUTS).map((id) =>
      cmd(id, id, "General")
    );
    const out = buildShortcutRows(reg, DEFAULT_SHORTCUTS, DEFAULT_SHORTCUTS);
    expect(out).toHaveLength(reg.length);
    expect(out.some((r) => r.state === "unassigned")).toBe(true);
  });
});

describe("facetCounts", () => {
  it("counts changed, unassigned-or-off and conflicting rows", () => {
    const out = buildShortcutRows(
      REG,
      { ...DEFAULTS, "thread.done": "y", "thread.mute": "", "thread.forward": "r" },
      DEFAULTS
    );
    expect(facetCounts(out)).toEqual({
      all: REG.length,
      changed: 1,
      unassigned: 2, // theme.toggle (never had one) + thread.mute (cleared)
      conflicts: 2, // reply + forward
    });
  });
});

describe("matchesShortcutQuery", () => {
  const row = () => rows()["palette.open"];

  it("matches the command title, case-insensitively", () => {
    expect(matchesShortcutQuery(row(), "shell")).toBe(true);
    expect(matchesShortcutQuery(row(), "SHELL COMMAND")).toBe(true);
  });

  it("matches the command id", () => {
    expect(matchesShortcutQuery(row(), "palette.open")).toBe(true);
  });

  it("matches the raw expression and the rendered keycaps", () => {
    expect(matchesShortcutQuery(row(), "mod+k")).toBe(true);
    expect(matchesShortcutQuery(row(), "ctrl k")).toBe(true);
    expect(matchesShortcutQuery(row(), "ctrl+k")).toBe(true);
  });

  it("matches the context label", () => {
    expect(matchesShortcutQuery(rows()["reader.lineDown"], "in thread")).toBe(true);
  });

  it("matches an arrow binding by its glyph and by its name", () => {
    expect(matchesShortcutQuery(rows()["list.cursorDown"], "↓")).toBe(true);
    expect(matchesShortcutQuery(rows()["list.cursorDown"], "down")).toBe(true);
  });

  it("returns true for an empty query and false for a miss", () => {
    expect(matchesShortcutQuery(row(), "  ")).toBe(true);
    expect(matchesShortcutQuery(row(), "zzz")).toBe(false);
  });
});

describe("captureExpr", () => {
  const ev = (
    key: string,
    mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}
  ) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  });

  it("turns a plain letter into its lowercase token", () => {
    expect(captureExpr(ev("E"))).toBe("e");
  });

  it("encodes modifiers the way the engine parses them", () => {
    expect(captureExpr(ev("k", { ctrlKey: true }))).toBe("mod+k");
    expect(captureExpr(ev("Tab", { shiftKey: true }))).toBe("shift+tab");
    expect(captureExpr(ev("1", { altKey: true }))).toBe("alt+1");
  });

  it("normalizes arrows and space", () => {
    expect(captureExpr(ev("ArrowDown"))).toBe("down");
    expect(captureExpr(ev(" "))).toBe("space");
  });

  it("refuses a bare modifier press, so holding Ctrl doesn't bind anything", () => {
    expect(captureExpr(ev("Control", { ctrlKey: true }))).toBeNull();
    expect(captureExpr(ev("Shift", { shiftKey: true }))).toBeNull();
  });

  it("refuses Escape and Enter — they cancel and commit the capture", () => {
    expect(captureExpr(ev("Escape"))).toBeNull();
    expect(captureExpr(ev("Enter"))).toBeNull();
    // …but Ctrl+Enter is a real binding
    expect(captureExpr(ev("Enter", { ctrlKey: true }))).toBe("mod+enter");
  });
});
