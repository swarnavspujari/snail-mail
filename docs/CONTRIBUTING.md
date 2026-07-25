# Contributing

## Ground rules

- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`. One coherent unit of work per commit.
- **`main` always builds and launches.** Run the smoke test (docs/SHORTCUTS.md) on Windows before merging.
- **No secrets, ever.** No keys, tokens, or `.env` files in commits. Credentials enter via the app UI → OS keychain only.
- **Docs land with code** — if behavior changes, the same commit updates README/docs. Non-default choices go in docs/DECISIONS.md.
- **Stay surgical.** Smallest change that meets the goal; no speculative abstractions.

## Dev loop

```powershell
npm run dev        # UI only, browser + mock backend, instant HMR
npm run app:dev    # full desktop app (Rust + webview)
npx tsc --noEmit   # frontend typecheck
cargo check        # in src-tauri/ — Rust typecheck
npm run app:build  # release installer
```

## Where things live

- Actions/shortcuts: `src/lib/commands.ts` (registry) + `src/lib/keyboard.ts` (engine). Add a command once; palette + keymap both pick it up.
- IPC surface: `src/lib/ipc.ts` (`Backend` interface) ⇄ `src-tauri/src/lib.rs` (commands). Keep the mock (`src/lib/mock.ts`) in sync — it's the browser demo and the UI test harness.
- Types cross the boundary as camelCase JSON: `src/lib/types.ts` ⇄ `src-tauri/src/types.rs` (serde `rename_all = "camelCase"`).

## Demo data is web-only

The mock backend and the Rust fixtures ship in the **browser demo only**.

- Front end: `@/lib/demo-backend` resolves to the mock for `npm run dev` /
  `npm run build`, and to a throwing stub for `dev:desktop` / `build:desktop`
  (which is what `app:dev` / `app:build` run). The alias lives in
  `vite.config.ts` and must stay ahead of the `@` prefix entry.
- Rust: everything demo sits behind the default-off `demo-fixtures` feature.

So there are two Rust test commands, and **both must pass**:

```powershell
cargo test                          # the shipped shape — no demo code compiled
cargo test --features demo-fixtures # the fixture paths
```

If you add a test that touches `mail::mock` or expects the demo accounts, gate
it with `#[cfg(feature = "demo-fixtures")]`, or the default run will not build.
