import { describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { patchFor, PREF_ROWS, prefsFor, valueTextFor } from "./settings-catalog";
import { buildSettingsIndex, searchEntries } from "./settings-search";
import type { ShortcutRow } from "./shortcut-edit";
import type { AccountsState, Capabilities, Settings } from "./types";

const settings: Settings = defaultSettings();

const accounts: AccountsState = {
  accounts: [
    { email: "demo@fission.local", provider: "mock", connected: true },
    { email: "angel@fission.local", provider: "gmail", connected: true },
  ],
  active: "demo@fission.local",
};

const full: Capabilities = {
  drive: true,
  contacts: true,
  calendarWrite: true,
  settingsRead: true,
  legacyGrant: false,
};
const partial: Capabilities = { ...full, drive: false, contacts: false };

const shortcutRows: ShortcutRow[] = [
  {
    id: "palette.open",
    title: "Shell Command",
    group: "General",
    expr: "mod+k",
    defaultExpr: "mod+k",
    state: "default",
    sharesWith: [],
    conflictsWith: [],
  },
  {
    id: "thread.snooze",
    title: "Remind Me",
    group: "Triage",
    expr: "h",
    defaultExpr: "h",
    state: "default",
    sharesWith: [],
    conflictsWith: [],
  },
];

const index = () =>
  buildSettingsIndex({
    settings,
    accounts,
    capabilities: {
      "demo@fission.local": full,
      "angel@fission.local": partial,
    },
    shortcutRows,
  });

describe("settings catalog", () => {
  it("gives every preference row a home pane and section", () => {
    expect(PREF_ROWS.length).toBeGreaterThan(0);
    for (const r of PREF_ROWS) {
      expect(r.pane).toBeTruthy();
      expect(r.section).toBeTruthy();
      expect(r.label).toBeTruthy();
    }
  });

  it("has no duplicate row ids", () => {
    const ids = PREF_ROWS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("surfaces the settings that previously had no interface at all", () => {
    for (const key of [
      "sidebarOpen",
      "calendarOpen",
      "showShortcutBar",
      "driveShareMode",
      "hiddenCalendars",
    ]) {
      expect(PREF_ROWS.some((r) => r.key === key)).toBe(true);
    }
  });

  it("binds every switch/segmented/select row to a real settings key", () => {
    for (const r of PREF_ROWS) {
      if (r.control === "switch" || r.control === "segmented") {
        expect(r.key, r.id).toBeTruthy();
        expect(settings, r.id).toHaveProperty(r.key as string);
      }
    }
  });

  it("gives every segmented and select row its options", () => {
    for (const r of PREF_ROWS) {
      if (r.control === "segmented" || r.control === "select") {
        expect(r.options?.length, r.id).toBeGreaterThan(1);
      }
    }
  });

  it("never uses segmented for more than three options (that is Select's job)", () => {
    for (const r of PREF_ROWS) {
      if (r.control === "segmented") {
        expect(r.options!.length, r.id).toBeLessThanOrEqual(3);
      }
    }
  });

  it("keeps one control per setting — no key appears on two rows", () => {
    const keyed = PREF_ROWS.filter((r) => r.key).map((r) => r.key);
    expect(new Set(keyed).size).toBe(keyed.length);
  });

  it("lists a pane's rows in declaration order, filtered by section", () => {
    const launch = prefsFor("general", "On launch");
    expect(launch.map((r) => r.key)).toEqual(["sidebarOpen", "calendarOpen"]);
  });

  it("keeps both hint toggles together under Appearance", () => {
    // They are one decision split across two surfaces — the footer strip and
    // every other keycap — so they are read and changed side by side.
    expect(prefsFor("general", "Appearance").map((r) => r.key)).toEqual([
      "theme",
      "showShortcutBar",
      "showKeyHints",
    ]);
  });

  it("writes a switch back as a boolean, never the string \"false\"", () => {
    const row = PREF_ROWS.find((r) => r.key === "showShortcutBar")!;
    expect(patchFor(row, "false")).toEqual({ showShortcutBar: false });
    expect(patchFor(row, "true")).toEqual({ showShortcutBar: true });
    // the round trip a toggle actually makes must flip the rendered value
    const off = { ...settings, ...patchFor(row, "false") } as Settings;
    expect(valueTextFor(row, off)).toBe("Off");
  });

  it("writes a numeric setting back as a number", () => {
    const row = PREF_ROWS.find((r) => r.key === "undoSendSeconds")!;
    expect(patchFor(row, "30")).toEqual({ undoSendSeconds: 30 });
  });

  it("writes an empty text field back as null, not an empty string", () => {
    const row = PREF_ROWS.find((r) => r.key === "celebrationDir")!;
    expect(patchFor(row, "   ")).toEqual({ celebrationDir: null });
    expect(patchFor(row, " C:\\pics ")).toEqual({ celebrationDir: "C:\\pics" });
  });

  it("renders the current value of a row as display text", () => {
    expect(valueTextFor(PREF_ROWS.find((r) => r.key === "theme")!, settings)).toBe(
      "Dark"
    );
    expect(
      valueTextFor(PREF_ROWS.find((r) => r.key === "sidebarOpen")!, settings)
    ).toBe("Off");
    expect(
      valueTextFor(PREF_ROWS.find((r) => r.key === "showShortcutBar")!, settings)
    ).toBe("On");
    expect(
      valueTextFor(PREF_ROWS.find((r) => r.key === "undoSendSeconds")!, settings)
    ).toBe("10s");
  });
});

describe("buildSettingsIndex", () => {
  it("indexes preferences, shortcuts, accounts and help in one list", () => {
    const kinds = new Set(index().map((e) => e.kind));
    expect(kinds).toEqual(new Set(["Settings", "Shortcuts", "Accounts", "Help"]));
  });

  it("carries a breadcrumb for every entry", () => {
    for (const e of index()) expect(e.path).toBeTruthy();
  });

  it("points each preference at the pane that owns it", () => {
    const e = index().find((x) => x.label === "Drive link access");
    expect(e?.pane).toBe("mail");
    expect(e?.path).toBe("Mail & triage › Attachments");
  });

  it("marks boolean preferences as togglable in place", () => {
    const e = index().find((x) => x.toggleKey === "showShortcutBar");
    expect(e).toBeTruthy();
    expect(e!.value).toBe("On");
  });

  it("names each account's grant health and links to its own pane", () => {
    const healthy = index().find((e) => e.label === "demo@fission.local");
    const stale = index().find((e) => e.label === "angel@fission.local");
    expect(healthy?.pane).toBe("account:demo@fission.local");
    expect(healthy?.path).toContain("all access granted");
    expect(stale?.path).toContain("needs reconnect");
  });

  it("indexes each account's signature as its own entry", () => {
    const e = index().find((x) => x.label.startsWith("Signature —"));
    expect(e?.pane).toMatch(/^account:/);
  });

  it("indexes shortcuts with their keys, pointing at the Keyboard pane", () => {
    const e = index().find((x) => x.kind === "Shortcuts" && x.label === "Shell Command");
    expect(e?.keys).toBe("mod+k");
    expect(e?.pane).toBe("keyboard");
    expect(e?.path).toBe("Keyboard › General");
  });
});

describe("searchEntries", () => {
  it("finds a preference by its label", () => {
    const hits = searchEntries(index(), "drive link");
    expect(hits[0].label).toBe("Drive link access");
  });

  it("finds a preference by the settings key it writes", () => {
    expect(
      searchEntries(index(), "driveShareMode").some(
        (e) => e.label === "Drive link access"
      )
    ).toBe(true);
  });

  it("finds a shortcut by a literal key press", () => {
    const hits = searchEntries(index(), "ctrl k");
    expect(hits.some((e) => e.label === "Shell Command")).toBe(true);
  });

  it("finds an account by its address", () => {
    expect(searchEntries(index(), "angel").some((e) => e.kind === "Accounts")).toBe(
      true
    );
  });

  it("orders results settings → shortcuts → accounts → help", () => {
    const kinds = searchEntries(index(), "").map((e) => e.kind);
    const order = ["Settings", "Shortcuts", "Accounts", "Help"];
    const ranks = kinds.map((k) => order.indexOf(k));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("returns a preview slice for an empty query rather than everything", () => {
    const all = index();
    expect(searchEntries(all, "").length).toBeLessThan(all.length);
  });

  it("spreads the empty-query preview across kinds instead of only the first", () => {
    const kinds = new Set(searchEntries(index(), "").map((e) => e.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchEntries(index(), "zzzzzz")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(searchEntries(index(), "DRIVE LINK")[0].label).toBe("Drive link access");
  });
});
