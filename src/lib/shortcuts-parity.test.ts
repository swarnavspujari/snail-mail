// Two seams the type system cannot see, both of which silently produce a key
// that does nothing:
//
//   1. DEFAULT_SHORTCUTS (defaults.ts) vs. default_settings() (store/mod.rs).
//      get_settings() merges saved settings over the RUST map, so a command
//      present only in the TypeScript copy resolves to "" on desktop and
//      commandBindings() filters it out. thread.introReply shipped that way:
//      the command, its recipient math and its tests all existed, and the key
//      was unbound in every desktop build ever released.
//
//   2. Expression syntax. eventToken() folds Ctrl and Cmd into a single `mod`
//      token, so a literal "ctrl+…" / "cmd+…" expr can never equal a keypress
//      token. The same binding was ALSO spelled "ctrl+shift+i" in defaults.ts,
//      so it was dead in the browser demo too — for a different reason.
//
// Both are string-level drift between files that no compiler compares, which
// is why they get scraped here rather than imported.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUTS } from "./defaults";
import { allCommands } from "./commands";

const root = resolve(__dirname, "../..");
const rustSource = readFileSync(resolve(root, "src-tauri/src/store/mod.rs"), "utf8");

/** The (id, expr) pairs inside `pub fn default_settings()`. */
function rustShortcuts(): Record<string, string> {
  const body = /pub fn default_settings\(\) -> Settings \{([\s\S]*?)\n\}/.exec(rustSource);
  if (!body) throw new Error("could not find default_settings() in store/mod.rs");
  const out: Record<string, string> = {};
  for (const m of body[1].matchAll(/\("([A-Za-z0-9_.]+)",\s*"([^"]*)"\)/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe("shortcut defaults", () => {
  it("finds both sides of the seam", () => {
    expect(Object.keys(DEFAULT_SHORTCUTS).length).toBeGreaterThan(40);
    expect(Object.keys(rustShortcuts()).length).toBeGreaterThan(40);
  });

  it("binds every registered command", () => {
    // A command with no entry at all is unreachable by key — "" is the
    // supported way to ship one deliberately unbound (theme.toggle et al).
    const unbound = allCommands()
      .map((c) => c.id)
      .filter((id) => !(id in DEFAULT_SHORTCUTS));
    expect(unbound).toEqual([]);
  });

  it("agrees with the Rust defaults, key for key and value for value", () => {
    expect(rustShortcuts()).toEqual({ ...DEFAULT_SHORTCUTS });
  });

  it("never spells a modifier the keyboard engine cannot emit", () => {
    // eventToken() emits mod / alt / shift only. Anything else is a dead key
    // that still looks entirely plausible in a diff.
    const bad = Object.entries(DEFAULT_SHORTCUTS).filter(([, expr]) =>
      expr
        .split("|")
        .flatMap((alt) => alt.trim().split(" "))
        .some((part) =>
          part
            .split("+")
            .slice(0, -1)
            .some((mod) => !["mod", "alt", "shift"].includes(mod))
        )
    );
    expect(bad).toEqual([]);
  });
});
