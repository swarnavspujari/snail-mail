# Remove Demo Account From Desktop Builds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop builds ship with no demo accounts, no fixture seeding, and no mock backend in the JS bundle, while `npm run dev` keeps the full browser demo.

**Architecture:** Four independent seams. (1) The front-end mock becomes a swapped module chosen by Vite `--mode desktop`, so exclusion is structural rather than a tree-shaking hope. (2) A reactive `needsConnect` predicate turns zero-accounts into the onboarding/connect screen. (3) All Rust demo code hides behind a default-off `demo-fixtures` cargo feature. (4) A one-shot boot migration purges already-seeded demo data from existing installs.

**Tech Stack:** Vite 6 + React 18 + TypeScript, Vitest (node env, `src/**/*.test.ts` only), Rust/Tauri 2, rusqlite 0.32.

**Spec:** `docs/superpowers/specs/2026-07-25-remove-demo-desktop-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/zero-state.ts` | create | Pure `needsConnect` predicate — the desktop zero-account rule |
| `src/lib/zero-state.test.ts` | create | Tests for the predicate |
| `src/lib/demo-backend.ts` | create | Web build: constructs `MockBackend` |
| `src/lib/demo-backend.desktop.ts` | create | Desktop build: same signature, throws, imports nothing |
| `src/lib/ipc.ts` | modify | Import the factory instead of `MockBackend` |
| `src/App.tsx` | modify | Apply `needsConnect` to the onboarding gate |
| `src/features/onboarding/Onboarding.tsx` | modify | Hide the demo CTA on desktop |
| `vite.config.ts` | modify | Mode-conditional ordered alias |
| `package.json` | modify | `dev:desktop` / `build:desktop` scripts |
| `src-tauri/tauri.conf.json` | modify | Point `before*Command` at the desktop scripts |
| `src-tauri/Cargo.toml` | modify | `[features] demo-fixtures = []` |
| `src-tauri/src/mail/mod.rs` | modify | cfg-gate `pub mod mock` |
| `src-tauri/src/store/mod.rs` | modify | cfg-gate the demo-pair fallback |
| `src-tauri/src/lib.rs` | modify | cfg-gate every demo call site; call the purge at boot |
| `src-tauri/src/store/demo_purge.rs` | create | One-shot migration + its tests |

`mock.ts` and `mock-data.ts` are **never edited**.

---

### Task 1: Zero-account predicate

**Files:**
- Create: `src/lib/zero-state.ts`
- Test: `src/lib/zero-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { needsConnect } from "./zero-state";
import type { AccountInfo } from "./types";

const acct = (email: string, over: Partial<AccountInfo> = {}): AccountInfo => ({
  email,
  provider: "gmail",
  connected: true,
  removing: false,
  ...over,
});

describe("needsConnect", () => {
  it("is false in the browser demo even with no accounts", () => {
    expect(needsConnect(false, [])).toBe(false);
  });

  it("is true on desktop with no accounts", () => {
    expect(needsConnect(true, [])).toBe(true);
  });

  it("is false on desktop with a connected account", () => {
    expect(needsConnect(true, [acct("a@b.com")])).toBe(true === false);
  });

  it("treats an account mid-removal as already gone", () => {
    expect(needsConnect(true, [acct("a@b.com", { removing: true })])).toBe(true);
  });

  it("keeps a dead-grant account in place (reconnect, not re-onboard)", () => {
    expect(needsConnect(true, [acct("a@b.com", { connected: false })])).toBe(false);
  });
});
```

Note the third case is written `toBe(true === false)` deliberately — it reads as `false`. Simplify to `toBe(false)` when writing it for real.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/zero-state.test.ts`
Expected: FAIL — `Failed to resolve import "./zero-state"`.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { AccountInfo } from "./types";

/** Desktop with nothing connected must show the connect screen, never a fake
 *  inbox. Accounts flagged `removing` are already gone as far as the UI is
 *  concerned — disconnect returns in milliseconds and tears down in the
 *  background, so counting them would leave the user staring at a dead inbox.
 *  A `connected: false` account is a dead grant, not an absent one: that case
 *  wants the Reconnect banner, not onboarding. The browser demo never needs
 *  this — its accounts come from the mock. */
export function needsConnect(isTauri: boolean, accounts: AccountInfo[]): boolean {
  return isTauri && accounts.filter((a) => !a.removing).length === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/zero-state.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zero-state.ts src/lib/zero-state.test.ts
git commit -m "feat(zero-state): predicate for the desktop no-accounts case"
```

---

### Task 2: Wire the gate and drop the desktop demo CTA

**Files:**
- Modify: `src/App.tsx:266`
- Modify: `src/features/onboarding/Onboarding.tsx:123-125`

- [ ] **Step 1: Apply the predicate in App.tsx**

Import it alongside the existing imports:

```ts
import { needsConnect } from "@/lib/zero-state";
```

Replace the gate at `src/App.tsx:266`:

```tsx
  if (!onboarded || needsConnect(isTauri, accounts.accounts)) {
    return (
      <div className="relative h-full bg-base">
        <Onboarding />
      </div>
    );
  }
```

This sits after the existing `if (!loaded)` early return (`src/App.tsx:258`), so
there is no first-paint flash while accounts load.

- [ ] **Step 2: Hide the demo CTA on desktop**

In `src/features/onboarding/Onboarding.tsx`, wrap the ghost button:

```tsx
            {!isTauri && (
              <button className={ghostBtn} onClick={next}>
                Explore the demo first
              </button>
            )}
```

Nothing else in the file changes.

- [ ] **Step 3: Fix the welcome copy that promises a demo**

`Onboarding.tsx:108-112` currently ends "…Connect Gmail to begin, or look around
with the demo inbox first." On desktop that sentence now describes a button that
is not there. Make the tail conditional:

```tsx
            <p className="mx-auto mt-3 max-w-[400px] text-[14px] leading-relaxed text-ink-2">
              Keyboard-first triage, split inboxes, and AI drafting — all local,
              on your machine.{" "}
              {isTauri
                ? "Connect Gmail to begin."
                : "Connect Gmail to begin, or look around with the demo inbox first."}
            </p>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/features/onboarding/Onboarding.tsx
git commit -m "feat(onboarding): desktop zero-account state, no demo CTA"
```

---

### Task 3: Build-time split

**Files:**
- Create: `src/lib/demo-backend.ts`, `src/lib/demo-backend.desktop.ts`
- Modify: `src/lib/ipc.ts:42`, `:713`; `vite.config.ts`; `package.json`; `src-tauri/tauri.conf.json`

- [ ] **Step 1: Create the web factory**

`src/lib/demo-backend.ts`:

```ts
// Web-demo half of the build-time split. `vite --mode desktop` aliases this
// module to demo-backend.desktop.ts, which imports nothing — that is what
// keeps mock.ts and mock-data.ts out of the shipped desktop bundle. A runtime
// isTauri check cannot do that; the bundler needs the import to be absent.
import type { Backend } from "./ipc";
import { MockBackend } from "./mock";

export const createDemoBackend = (): Backend => new MockBackend();
```

- [ ] **Step 2: Create the desktop stub**

`src/lib/demo-backend.desktop.ts`:

```ts
// Desktop half of the build-time split — deliberately imports nothing. The
// desktop app always has __TAURI_INTERNALS__, so isTauri is true and this is
// unreachable; it throws rather than returning a stub so that a regression
// which routes desktop through the demo path fails loudly instead of showing
// fake mail.
import type { Backend } from "./ipc";

export const createDemoBackend = (): Backend => {
  throw new Error("the demo backend is not bundled in the desktop app");
};
```

- [ ] **Step 3: Point ipc.ts at the factory**

Replace `src/lib/ipc.ts:42`:

```ts
import { createDemoBackend } from "@/lib/demo-backend";
```

The specifier must be exactly `@/lib/demo-backend` — the alias in Step 4 matches
that string, and a relative `./demo-backend` would not be caught.

Replace `src/lib/ipc.ts:712-714`:

```ts
export const backend: Backend = instrument(
  isTauri ? new TauriBackend() : createDemoBackend()
);
```

- [ ] **Step 4: Mode-conditional alias in vite.config.ts**

```ts
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tauri expects a fixed dev port; clearScreen off keeps Rust errors visible.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Array form: order is significant. The demo-backend entry must be tried
    // before the "@" prefix entry, or "@" would resolve it first and the swap
    // would silently never happen. `mode === "desktop"` is set by the
    // dev:desktop / build:desktop scripts, which is what tauri.conf.json runs.
    alias: [
      ...(mode === "desktop"
        ? [
            {
              find: /^@\/lib\/demo-backend$/,
              replacement: src("./src/lib/demo-backend.desktop.ts"),
            },
          ]
        : []),
      { find: "@", replacement: src("./src") },
    ],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Rust saves must not full-reload the webview mid-edit
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
  },
}));
```

- [ ] **Step 5: Add the scripts**

In `package.json`, alongside the existing `dev` and `build` (which stay exactly
as they are — they build the web demo, and CI's `build.yml` runs `npm run build`):

```json
    "dev:desktop": "vite --mode desktop",
    "build:desktop": "tsc --noEmit && vite build --mode desktop",
```

- [ ] **Step 6: Point Tauri at them**

In `src-tauri/tauri.conf.json`:

```json
    "beforeDevCommand": "npm run dev:desktop",
    "beforeBuildCommand": "npm run build:desktop",
```

- [ ] **Step 7: Verify the split — this is the whole point of the task**

```bash
npm run build:desktop && grep -rc "fission.local\|t-term-sheet\|Helios_SeriesA_TermSheet" dist/assets/ || echo "CLEAN: no demo strings in desktop bundle"
```

Expected: `CLEAN: …` (grep exits 1 with no matches).

```bash
npm run build && grep -rl "fission.local" dist/assets/
```

Expected: at least one matching file — the web demo must still contain the mock.

Record both `dist/assets/*.js` sizes for the delta.

- [ ] **Step 8: Commit**

```bash
git add src/lib/demo-backend.ts src/lib/demo-backend.desktop.ts src/lib/ipc.ts vite.config.ts package.json src-tauri/tauri.conf.json
git commit -m "build: exclude the mock backend from desktop bundles"
```

---

### Task 4: `demo-fixtures` cargo feature

**Files:**
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/mail/mod.rs`, `src-tauri/src/store/mod.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Declare the feature**

In `src-tauri/Cargo.toml`, after the `[dependencies]` block (before `[profile.release]`):

```toml
# Demo fixtures: the fake accounts, seeded mail, synthesized calendar events and
# toy embedder. Default OFF — shipped builds must contain none of it. Enable
# only to run the fixture tests: cargo test --features demo-fixtures
[features]
demo-fixtures = []
```

- [ ] **Step 2: Gate the module**

`src-tauri/src/mail/mod.rs:5`:

```rust
#[cfg(feature = "demo-fixtures")]
pub mod mock;
```

- [ ] **Step 3: Gate the account fallback**

In `src-tauri/src/store/mod.rs`, replace the fallback body at `:315-331`. Keep
`DEMO_ACCOUNT` / `DEMO_ACCOUNT_2` unconditional — the purge migration matches on
them.

```rust
    #[cfg(feature = "demo-fixtures")]
    {
        AccountsState {
            accounts: vec![
                AccountInfo {
                    email: DEMO_ACCOUNT.into(),
                    provider: "mock".into(),
                    connected: true,
                    removing: false,
                },
                AccountInfo {
                    email: DEMO_ACCOUNT_2.into(),
                    provider: "mock".into(),
                    connected: true,
                    removing: false,
                },
            ],
            active: DEMO_ACCOUNT.into(),
        }
    }
    // Shipped builds have no zero-account state in the backend: an empty list
    // is the honest answer, and the UI turns it into the connect screen.
    #[cfg(not(feature = "demo-fixtures"))]
    {
        AccountsState { accounts: vec![], active: String::new() }
    }
```

- [ ] **Step 4: Gate every call site in lib.rs**

Each of these becomes `#[cfg(feature = "demo-fixtures")]` on the enclosing block,
with a non-demo fallback where a value is required:

| Line | Current | With feature off |
|---|---|---|
| `473-475` | `store::get_accounts(&conn)` re-read for the demo pair | keep `accounts` (already empty) |
| `507-516` | disconnect re-seed loop | remove the block entirely |
| `650-653` | `mail::mock::demo_events` + `apply_demo_rsvps` | `return Ok(vec![])` |
| `1178-1190` | `demo_event_by_uid` + RSVP overlay write | `return Err("no calendar for this account".into())` |
| `1303-1304` | `demo_event_by_uid` lookup | `None` |
| `2934` | `mail::mock::demo_embed(…)` | `None` |
| `4047-4056` | boot seed loop | remove the block entirely |

`apply_demo_rsvps` itself (`663`) is only reachable from gated call sites, so it
carries the same cfg.

`is_mock_id` (`151`) and its call sites (`2337`, `2414`, `3102`, `3118`, `3425`,
`3521`, `4410`) stay **unconditional** — legacy-DB safety net, per the spec.

- [ ] **Step 5: Gate the fixture tests**

Any `#[test]` that calls `mail::mock::*` — including
`mock.rs:718/738/767` and `store/mod.rs:2867` (`model_tag_change_wipes_all_but_demo_vectors`,
which inserts a `demo@fission.local` vector) — gets `#[cfg(feature = "demo-fixtures")]`.
`store/mod.rs:2867` only uses the string as an account id, so check whether it
actually needs the mock module before gating it; gate only if it does not compile
without the feature.

- [ ] **Step 6: Both test shapes must compile and pass**

```bash
cd src-tauri && cargo test 2>&1 | tail -20
```
Expected: PASS. This is the **shipped** shape — no demo code compiled.

```bash
cd src-tauri && cargo test --features demo-fixtures 2>&1 | tail -20
```
Expected: PASS, with a higher test count than the previous run.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/mail/mod.rs src-tauri/src/store/mod.rs src-tauri/src/lib.rs
git commit -m "feat(core): hide all demo fixtures behind a default-off cargo feature"
```

---

### Task 5: Purge migration

**Files:**
- Create: `src-tauri/src/store/demo_purge.rs`
- Modify: `src-tauri/src/store/mod.rs` (add `pub mod demo_purge;`), `src-tauri/src/lib.rs` (call at boot)

**Critical safety constraint.** `store/mod.rs:131` is
`ALTER TABLE threads ADD COLUMN account_id TEXT NOT NULL DEFAULT 'demo@fission.local'`.
A v0.1-era install's **real** threads can therefore carry
`account_id = 'demo@fission.local'`. Matching on the account alone would delete
real mail. Every row-level delete must require the mock id shape
(`id LIKE 't-%' OR id LIKE 't2-%'`) **and** a demo `account_id`.

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/store/demo_purge.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn db() -> Connection {
        let conn = crate::store::open_in_memory().unwrap();
        conn
    }

    fn plant(conn: &Connection, id: &str, account: &str) {
        conn.execute(
            "INSERT INTO threads (id, subject, account_id) VALUES (?1, ?2, ?3)",
            params![id, format!("subject {id}"), account],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, thread_id, account_id, body) VALUES (?1, ?2, ?3, 'x')",
            params![format!("{id}-m1"), id, account],
        )
        .unwrap();
    }

    #[test]
    fn sweeps_demo_rows_only() {
        let conn = db();
        plant(&conn, "t-term-sheet", "demo@fission.local");
        plant(&conn, "t2-standup", "angel@fission.local");
        plant(&conn, "18f2a3b4c5d6e7f8", "real@gmail.com");

        sweep_demo_rows(&conn).unwrap();

        let ids: Vec<String> = conn
            .prepare("SELECT id FROM threads ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(ids, vec!["18f2a3b4c5d6e7f8".to_string()]);
    }

    #[test]
    fn spares_v01_real_mail_defaulted_to_the_demo_account() {
        // store/mod.rs:131 defaulted every pre-v0.2 thread to demo@fission.local.
        // A real Gmail thread carrying that account_id must survive.
        let conn = db();
        plant(&conn, "18f2a3b4c5d6e7f8", "demo@fission.local");

        sweep_demo_rows(&conn).unwrap();

        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "a real thread id must survive the demo account_id default");
    }

    #[test]
    fn drops_demo_accounts_from_the_registry_kv() {
        let conn = db();
        let state = AccountsState {
            accounts: vec![
                AccountInfo {
                    email: "demo@fission.local".into(),
                    provider: "mock".into(),
                    connected: true,
                    removing: false,
                },
                AccountInfo {
                    email: "real@gmail.com".into(),
                    provider: "gmail".into(),
                    connected: true,
                    removing: false,
                },
            ],
            active: "demo@fission.local".into(),
        };
        crate::store::save_accounts(&conn, &state).unwrap();

        let removed = purge_registry(&conn).unwrap();

        assert_eq!(removed, vec!["demo@fission.local".to_string()]);
        let after = crate::store::get_accounts(&conn);
        assert_eq!(after.accounts.len(), 1);
        assert_eq!(after.active, "real@gmail.com", "active must move off the demo account");
    }

    #[test]
    fn clears_the_accounts_key_when_only_demo_existed() {
        let conn = db();
        let state = AccountsState {
            accounts: vec![AccountInfo {
                email: "demo@fission.local".into(),
                provider: "mock".into(),
                connected: true,
                removing: false,
            }],
            active: "demo@fission.local".into(),
        };
        crate::store::save_accounts(&conn, &state).unwrap();

        purge_registry(&conn).unwrap();

        let raw: Option<String> = conn
            .query_row("SELECT value FROM kv WHERE key = 'accounts'", [], |r| r.get(0))
            .ok();
        assert!(raw.is_none(), "the accounts key must be gone, not an empty list");
    }

    #[test]
    fn is_idempotent() {
        let conn = db();
        plant(&conn, "t-term-sheet", "demo@fission.local");
        sweep_demo_rows(&conn).unwrap();
        sweep_demo_rows(&conn).unwrap(); // must not error on the second pass
    }
}
```

If `store::open_in_memory` does not exist, use whatever helper the existing
`store/mod.rs` tests use to build a schema-complete in-memory `Connection`
(check `store/mod.rs:2324` `seed` and its callers) and mirror it.

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test demo_purge 2>&1 | tail -20`
Expected: FAIL to compile — `sweep_demo_rows` / `purge_registry` not found.

- [ ] **Step 3: Implement**

```rust
//! One-shot removal of demo data seeded by builds before the demo account was
//! cut from desktop. Runs at boot behind a kv flag.
//!
//! Safety: store/mod.rs:131 defaulted every pre-v0.2 thread's account_id to
//! 'demo@fission.local', so real mail can carry a demo account id. Row deletes
//! therefore require BOTH the mock id shape and a demo account_id.

use rusqlite::{params, Connection};

use crate::store::{AccountsState, DEMO_ACCOUNT, DEMO_ACCOUNT_2};

pub const PURGED_FLAG: &str = "demo_purged_v1";

fn is_demo_email(email: &str) -> bool {
    email == DEMO_ACCOUNT || email == DEMO_ACCOUNT_2 || email.ends_with("@fission.local")
}

/// Delete fixture threads/messages/attachments/fts/vector rows from a db that
/// may hold them (the legacy pre-split db, or global.db).
pub fn sweep_demo_rows(conn: &Connection) -> Result<(), String> {
    const DEMO_THREADS: &str = "SELECT id FROM threads
         WHERE (id LIKE 't-%' OR id LIKE 't2-%')
           AND account_id IN (?1, ?2)";

    let ids: Vec<String> = {
        let mut stmt = conn.prepare(DEMO_THREADS).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![DEMO_ACCOUNT, DEMO_ACCOUNT_2], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for id in &ids {
        let _ = crate::store::vec::delete_thread_vectors(conn, id);
        conn.execute(
            "DELETE FROM attachments WHERE message_id IN
             (SELECT id FROM messages WHERE thread_id = ?1)",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM messages WHERE thread_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        let _ = conn.execute("DELETE FROM mail_fts WHERE thread_id = ?1", params![id]);
        conn.execute("DELETE FROM threads WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    let _ = conn.execute("DELETE FROM kv WHERE key = 'demo_rsvp'", []);
    Ok(())
}

/// Drop demo accounts from the registry kv. Returns the emails removed so the
/// caller can delete their per-account db files. Repoints `active`; deletes the
/// key outright when nothing real remains, which is what makes get_accounts
/// return the empty zero-account state.
pub fn purge_registry(conn: &Connection) -> Result<Vec<String>, String> {
    let state: AccountsState = match crate::store::get_json(conn, "accounts") {
        Some(s) => s,
        None => return Ok(vec![]),
    };
    let (demo, real): (Vec<_>, Vec<_>) = state
        .accounts
        .into_iter()
        .partition(|a| a.provider == "mock" || is_demo_email(&a.email));
    let removed: Vec<String> = demo.into_iter().map(|a| a.email).collect();
    if removed.is_empty() {
        return Ok(removed);
    }
    if real.is_empty() {
        conn.execute("DELETE FROM kv WHERE key = 'accounts'", [])
            .map_err(|e| e.to_string())?;
    } else {
        let active = if real.iter().any(|a| a.email == state.active) {
            state.active
        } else {
            real[0].email.clone()
        };
        crate::store::save_accounts(conn, &AccountsState { accounts: real, active })?;
    }
    Ok(removed)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd src-tauri && cargo test demo_purge 2>&1 | tail -20`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into boot**

Add `pub mod demo_purge;` to `src-tauri/src/store/mod.rs`.

In `src-tauri/src/lib.rs`, in the setup block near the existing boot sweep
(where `store::get_accounts` is re-read around `:4046`), before the accounts are
read, add:

```rust
            // One-shot: strip demo data seeded by pre-cut builds. Guarded by a
            // flag so a real account named like a fixture can never be caught
            // by a later re-run.
            {
                let already = {
                    let conn = dbs.global().lock().unwrap();
                    store::get_json::<bool>(&conn, store::demo_purge::PURGED_FLAG) == Some(true)
                };
                if !already {
                    let removed = {
                        let conn = dbs.global().lock().unwrap();
                        let _ = store::demo_purge::sweep_demo_rows(&conn);
                        store::demo_purge::purge_registry(&conn).unwrap_or_default()
                    };
                    for email in &removed {
                        let _ = dbs.close_and_delete(email);
                    }
                    if let Some(legacy) = dbs.legacy() {
                        let conn = legacy.lock().unwrap();
                        let _ = store::demo_purge::sweep_demo_rows(&conn);
                    }
                    let conn = dbs.global().lock().unwrap();
                    let _ = store::set_json(&conn, store::demo_purge::PURGED_FLAG, &true);
                }
            }
```

Lock scopes are deliberately narrow — `close_and_delete` takes the registry's own
lock, so the global guard must be dropped before the loop.

- [ ] **Step 6: Verify both test shapes still pass**

```bash
cd src-tauri && cargo test 2>&1 | tail -5
cd src-tauri && cargo test --features demo-fixtures 2>&1 | tail -5
```
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/store/demo_purge.rs src-tauri/src/store/mod.rs src-tauri/src/lib.rs
git commit -m "feat(migration): purge seeded demo data from existing installs"
```

---

### Task 6: Full verification sweep

- [ ] **Step 1: Front-end tests**

Run: `npx vitest run`
Expected: all green, count ≥ the pre-change 202.

- [ ] **Step 2: Typecheck + both bundles**

```bash
npm run build:desktop && grep -rc "fission.local\|t-term-sheet\|Helios_SeriesA_TermSheet" dist/assets/ || echo "CLEAN"
```
Expected: `CLEAN`.

```bash
npm run build && grep -rl "fission.local" dist/assets/
```
Expected: a match.

- [ ] **Step 3: Rust, both shapes**

```bash
cd src-tauri && cargo test 2>&1 | tail -5
cd src-tauri && cargo test --features demo-fixtures 2>&1 | tail -5
```
Expected: both PASS.

- [ ] **Step 4: Browser demo still works**

Run `npm run dev`, open it, confirm: the inbox renders fixture mail, the account
switcher lists both demo accounts, and the "demo mode (browser)" pill is present.
Capture a screenshot.

- [ ] **Step 5: Desktop zero-account state**

Run `npm run app:dev` against a scratch app-data dir. Confirm it lands on the
connect screen with no demo accounts and no "Explore the demo first" button.
Record exactly what this does and does not prove versus a real installer run.

- [ ] **Step 6: Migration against a seeded db**

Build a db with the pre-change fixtures (`cargo test --features demo-fixtures`
covers the seeding path), plant a real thread and a real account beside them,
run the purge, and assert the demo rows are gone and the real rows survive. The
Task 5 tests cover this; run them against a *copy of a real db* if one is
available.

- [ ] **Step 7: Merge to local main**

```bash
git checkout main
git merge --no-ff claude/remove-demo-desktop-789fd0
```

No tag. No push. No release.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| A. Build-time split | 3 |
| B. Zero-account state | 1, 2 |
| C. `demo-fixtures` feature | 4 |
| D. Purge migration | 5 |
| E. Onboarding CTA | 2 |
| Verification table | 6 |

**Placeholders:** none — every code step carries real code. Task 4 Step 4 is a
table rather than seven code blocks because each edit is a one-line cfg attribute
on an identified line; the fallback value for each is specified.

**Type consistency:** `needsConnect(isTauri, accounts)` is used identically in
Task 1 and Task 2. `createDemoBackend(): Backend` matches across both
`demo-backend.ts` and `demo-backend.desktop.ts`. `sweep_demo_rows(&Connection)`
and `purge_registry(&Connection) -> Vec<String>` match between Task 5 Steps 1, 3
and 5. `PURGED_FLAG` is defined once and referenced by the boot wiring.

**Known risk carried into execution:** Task 4 Step 5 cannot be fully specified
without compiling — which existing tests fail to build without the feature is
discoverable only from the compiler. The step says to gate what does not compile,
which is the correct instruction, but expect iteration there.
