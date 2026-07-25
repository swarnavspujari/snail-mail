# Remove the demo account from desktop builds

**Date:** 2026-07-25
**Branch:** `claude/remove-demo-desktop-789fd0`
**Status:** approved

## Problem

Demo mode is not a leftover — it is the app's zero-account state. A desktop build
with no connected accounts boots "signed in" to two fake accounts, writes fixture
mail into the user's real SQLite database, and re-seeds itself when the last real
account is disconnected. The demo must not ship. The browser demo (`npm run dev`)
must survive byte-for-byte, because it is the test bed.

Five anchors, verified at HEAD (the line numbers in
`docs/RESEARCH-2026-07-24.md` §4.2 predate the settings rebuild and the
per-account storage split):

| # | Anchor | Location |
|---|--------|----------|
| 1 | Static `MockBackend` import + runtime `isTauri` ternary | `src/lib/ipc.ts:42`, `:713` |
| 2 | Demo-pair fallback in `get_accounts` | `src-tauri/src/store/mod.rs:315-331` |
| 3 | Boot seed | `src-tauri/src/lib.rs:4047-4056` |
| 4 | Disconnect re-seed | `src-tauri/src/lib.rs:507-516`, `:473-475` |
| 5 | Onboarding CTA | `src/features/onboarding/Onboarding.tsx:123-125` |

Two findings changed the shape of the work:

- The account-purge path is already O(1) — `dbs.close_and_delete(email)` deletes
  the per-account db file and its sidecars (`src-tauri/src/store/registry.rs:106`).
  The migration is a file delete plus a kv edit, not a row crawl.
- `onboarded` is a *persisted setting*. A user who connects and later disconnects
  their last account has `onboarded: true`, so the existing `if (!onboarded)` gate
  does not catch them. The zero-account state needs a second, reactive condition.

## Non-goals

- No refactor of `mock.ts` / `mock-data.ts`. They are not edited at all.
- No onboarding changes beyond the CTA.
- No release. Work lands on local `main`, untagged, unpushed.

## Design

### A. Build-time split — module swap, not tree-shaking

A Vite `define` plus dead-branch elimination would *probably* drop the mock, but
it fails silently if Rollup detects a side effect in `mock.ts`. Swap the module
instead, so exclusion is structural.

New files (neither touches `mock.ts`):

- `src/lib/demo-backend.ts` — `export const createDemoBackend = (): Backend => new MockBackend()`
- `src/lib/demo-backend.desktop.ts` — same signature, throws, imports nothing

`ipc.ts` imports `createDemoBackend` from `@/lib/demo-backend` instead of
`MockBackend` from `./mock`, and line 713 calls it.

`vite.config.ts` becomes `defineConfig(({ mode }) => …)` using the **array** form
of `resolve.alias` so ordering is guaranteed: a `/^@\/lib\/demo-backend$/` entry
is prepended when `mode === "desktop"`, ahead of the existing `@` prefix entry.

Scripts:

| Command | Mode | Mock bundled |
|---|---|---|
| `npm run dev` | development | yes |
| `npm run build` | production | yes |
| `npm run dev:desktop` (`vite --mode desktop`) | desktop | **no** |
| `npm run build:desktop` (`tsc --noEmit && vite build --mode desktop`) | desktop | **no** |

`tauri.conf.json`'s `beforeDevCommand` / `beforeBuildCommand` point at the
`:desktop` variants. `dev` and `build` are untouched, so `npm run dev` and CI's
`build.yml` keep producing the full-mock web demo.

### B. Zero-account state

`src/App.tsx:266` becomes:

```ts
const needsConnect =
  isTauri && accounts.accounts.filter((a) => !a.removing).length === 0;
if (!onboarded || needsConnect) { /* <Onboarding /> */ }
```

Filtering `removing` matters: `disconnect_account` flags the account and returns
in milliseconds, tearing down in the background. Without the filter the user
stares at a dead inbox until teardown finishes.

The gate sits behind the existing `!loaded` early return, so there is no
first-paint flash. It is reactive on `accounts`, so connecting releases it the
moment an account appears — a returning user sees step 1 only and is never
re-walked through the AI-key / theme / tour steps.

### C. Rust — `demo-fixtures` cargo feature, default off

`[features] demo-fixtures = []` in `Cargo.toml`. `#[cfg(feature = "demo-fixtures")]`
guards `pub mod mock` and every call site:

- boot seed (`lib.rs:4047-4056`)
- disconnect re-seed (`lib.rs:507-516`) and the demo-pair re-read (`lib.rs:473-475`)
- the `get_accounts` fallback (`store/mod.rs:315-331`) — with the feature off it
  returns an empty `AccountsState`
- calendar stand-ins: `demo_events`, `apply_demo_rsvps`, `demo_event_by_uid`
- search stand-in: `demo_embed`; plus `ensure_demo_vectors`, `heal_demo_ics`

`is_mock_id` and the `DEMO_ACCOUNT` / `DEMO_ACCOUNT_2` consts stay
**unconditional**: the first is the legacy-DB safety net, the second is what the
migration matches on.

Tests that touch the mock carry the same cfg. That yields two commands with
different jobs, both of which must pass:

- `cargo test` — exercises the **shipped** shape (no demo anywhere)
- `cargo test --features demo-fixtures` — exercises the fixtures

### D. Migration — `demo_purged_v1`, one-shot at boot

Guarded by a kv flag in the global db. Steps:

1. Partition the accounts kv into demo (`provider == "mock"` or email ends
   `@fission.local`) and real.
2. `close_and_delete` each demo account's per-account db file.
3. Rewrite the accounts kv: repoint `active` if it named a demo account; delete
   the key outright if nothing real remains (the now-empty fallback yields the
   zero-account state).
4. Drop the `demo_rsvp` overlay from the global db.
5. Sweep `t-` / `t2-` threads, messages and vector rows out of the **legacy and
   global** dbs, for installs that never ran the per-account split.
6. Set `demo_purged_v1`.

Real accounts' dbs are never touched, so a Gmail thread id that happens to start
with `t-` is not at risk. Step 5 is scoped to the two dbs that could hold
pre-split demo rows.

### E. Onboarding

`src/features/onboarding/Onboarding.tsx:123-125` — the "Explore the demo first"
ghost button is wrapped in `{!isTauri && …}`. On desktop step 1 then offers only
Connect Gmail, which is correct: there is no longer anywhere to skip *to*.
Nothing else in the file changes.

## Verification

Each item must produce output that is quoted before the work is called done.

| Check | Command | Expected |
|---|---|---|
| Desktop bundle clean | `npm run build:desktop`, grep `dist/` for `fission.local`, `t-term-sheet`, `Helios_SeriesA_TermSheet` | zero hits |
| Web bundle unchanged | `npm run build`, same grep | hits present |
| Bundle delta | compare `dist/assets/*.js` sizes | desktop smaller by ~the mock's weight |
| Browser demo alive | `npm run dev` + drive it in a browser | inbox renders, both demo accounts in the switcher |
| Front-end tests | `npx vitest run` | green |
| Shipped Rust shape | `cargo test` | green |
| Fixture Rust paths | `cargo test --features demo-fixtures` | green |
| Migration | unit test over a db seeded by the pre-change fixtures, with planted real rows | demo rows gone, real rows intact |

**Known gap:** the fresh-install desktop flow needs `tauri build` plus a clean
app-data dir on the owner's machine. `app:dev` against a scratch data dir gets
close; whatever it does not prove will be reported as unproven rather than
folded into a completion claim.

## Landing

Merge to local `main`. No tag, no push, no release.
