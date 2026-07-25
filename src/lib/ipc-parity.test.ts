// The one seam the type system cannot check: `invoke("name")` strings in
// ipc.ts against the `generate_handler![…]` registration list in lib.rs. The
// mock side needs no guard — TauriBackend and MockBackend implement the same
// Backend interface, so a missing mock method is a tsc error already. A
// command invoked but never registered compiles clean on both sides and only
// fails at runtime on desktop, which is exactly how parity drift ships.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const ipcSource = readFileSync(resolve(root, "src/lib/ipc.ts"), "utf8");
const libSource = readFileSync(resolve(root, "src-tauri/src/lib.rs"), "utf8");

const invoked = [
  ...new Set(
    [...ipcSource.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1])
  ),
];

const handlerBlock = /generate_handler!\[([\s\S]*?)\]/.exec(libSource)?.[1] ?? "";
const registered = new Set(
  [...handlerBlock.matchAll(/[a-z][a-z0-9_]*/g)].map((m) => m[0])
);

describe("ipc parity", () => {
  it("finds both sides of the seam", () => {
    expect(invoked.length).toBeGreaterThan(40);
    expect(registered.size).toBeGreaterThan(40);
  });

  it("registers every command the front end invokes", () => {
    const missing = invoked.filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });
});
