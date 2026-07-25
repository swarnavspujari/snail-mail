# Live download indicator (`sync:activity`) — design

Date: 2026-07-25
Research: `docs/RESEARCH-2026-07-24.md` §3

## Problem

Every Gmail round-trip is one `threads.get`, and the counts the UI needs already
exist in Rust — then get thrown away. `fetch_streaming` (`src-tauri/src/mail/sync.rs:295`)
knows both the denominator (`ids.len()`) and the loop index, but `on_progress` is a
zero-argument `Fn()`. The incremental path knows `affected.len()` and is never even
handed the callback. Crawl and embed beats print to stderr.

The one existing event, `sync:progress`, measures *crawl completeness* against
persisted state, not activity: it can show while nothing downloads, and never shows
once the initial crawl finishes no matter how much is being fetched. Silent today:
the 30s incremental tick, boot reconcile, `sync_now`, `resync_account`, post-crawl
reconciles, `load_older`, and onboarding's first sync — the largest download in the
app's life, with zero feedback.

## Scope

Add a second, activity-scoped event alongside the completeness footer. The footer
stays, including its visual design. No per-message granularity (thread-level is what
the API does). No sync-history UI.

## 1. The tick

```rust
pub enum SyncStage { ReconcileInbox, ReconcileRest, Incremental, Crawl, Resync, LoadOlder }
pub struct SyncTick { pub account: String, pub stage: SyncStage, pub done: usize, pub total: usize }
```

Serialized kebab-case (`reconcile-inbox`, …) to match the TS union.

`LoadOlder` is a sixth stage beyond the five named in the brief. `load_older` had to
be wired, and folding it into `Crawl` would label a user-initiated paging fetch as
background indexing.

`Resync` is a *pass* distinction, not a phase one — `resync_account` is only
`force_reconcile: true`, which `reconcile()` cannot otherwise distinguish from the
boot pass or the ~10-minute forced tick. So `full_sync` takes a `SyncPass`
(`Normal` | `Resync`); `reconcile()` emits `Resync` for both phases under that pass,
otherwise `ReconcileInbox` / `ReconcileRest`.

The callback widens: `&(dyn Fn() + Send + Sync)` → `&(dyn Fn(SyncTick) + Send + Sync)`.

## 2. Coalescing

Throttling lives at the emit layer in `lib.rs`, never in `sync.rs` — `sync.rs` fires
per item and stays policy-free.

`ActivityGate` holds an `AtomicU64` of the last emit's millis (the callback is `Fn`,
not `FnMut`, so interior mutability is required). It drops ticks less than
`ACTIVITY_MIN_GAP_MS` (250ms → ~4/s) apart, but **always** emits when
`done == total`, so a pass's terminal tick can never be swallowed and leave the pill
stuck mid-count. One gate per pass.

`emit_sync_activity` emits `sync:activity` and parks the tick in
`AppState.activity: Mutex<Option<SyncTick>>`, cleared on the terminal tick. The
`get_sync_activity` command serves that parked value so a late-mounting UI cannot
miss an in-flight pass.

## 3. Call sites

In `sync.rs`:
- `fetch_streaming` — per item; takes the stage from its caller.
- `incremental` — receives the callback for the first time; ticks over `affected`.
- `crawl_step` — per item within the ≤100-thread page.

In `lib.rs`, six closures: boot reconcile, the 30s tick, `sync_now`,
`resync_account`, `spawn_history_crawl`, `load_older`.

## 4. The pill

`SyncActivityPill` — a leaf component with `useState` only. It subscribes directly to
`sync:activity` and calls `getSyncActivity()` once on mount. It does **not** touch
zustand: `sync:progress` already re-renders the whole App tree per event, and the
pill fires far more often.

- Appears when a pass reports more than `MIN_ITEMS` (5) items **or** has lasted
  longer than `MIN_DURATION_MS` (1000).
- Counts up live: "Downloading 17 of 30…".
- On the terminal tick, holds `HOLD_MS` (600) then fades out.

**Placement.** Absolutely positioned bottom-right, above the footer, and
deliberately *outside* the `footerVisible` gate. That gate is
`showShortcutBar || downloading || migrating` — a pill rendered inside it would be
invisible in exactly the incremental-sync case this feature exists to surface.
Bottom-right because bottom-left holds `UndoToast` / `UndoSendBar`. Absolute
positioning keeps it layout-shift-free.

The same component renders inline in the Onboarding card, where `connect()` awaits
`backend.syncNow()` behind a static "Waiting for your browser…".

**Multi-account.** The pill tracks the active account's pass and ignores others.
Two concurrent passes would otherwise make the count jump between accounts.

## 5. Adjacent correctness fixes

**Numerator / denominator populations.** The numerator counted every local thread
(trash included) while the denominator was Gmail's `threadsTotal` (spam and drafts
included, which the crawl excludes) — so the percentage asymptotes below 100 and is
clamped to 99 to hide it (`App.tsx:110`).

- Numerator → `count_threads_visible` (`hidden IS NULL`), matching the crawl's
  population.
- Denominator → `threadsTotal` minus the SPAM/TRASH/DRAFT `threadsTotal`, read via
  three `labels.get` calls per reconcile (`labels.list` does not return counts) and
  cached in kv. Floored at the crawl's own cumulative listing count — a new `listed`
  field on `CrawlCursor` — so a bad estimate cannot pin the bar at 99%.
- The `Math.min(99, …)` clamp becomes `Math.min(100, …)`.

The research note's "incl. demo" is stale post-re-architecture: `emit_sync_progress`
filters to `provider == "gmail"` and per-account DBs cannot hold mock rows.

**Repair Mail re-downloads everything silently.** `resync_account` deletes
`history:<email>` but not `crawl:<email>`, so `CrawlCursor.done` stays sticky and the
footer is suppressed through the heaviest download in the app. It now deletes both.

**`threads(account_id)` index — already present.** `idx_threads_account_split ON
threads(account_id, split_id)` (`store/mod.rs:159`, v0.23) covers the
`WHERE account_id = ?` predicate on its leftmost column, so `emit_sync_progress`'s
per-beat `COUNT(*)` is already indexed. Verified by query plan; no redundant index
added.

## 6. Mock parity

`MockBackend` gains `onSyncActivity` / `getSyncActivity` driven by real per-item
ticks (~60ms apart), not one synthetic climb:

- the initial simulated reconcile ticks over the actual fixture thread count;
- `syncNow()` runs an honest simulated 30-thread pass rather than only waking
  snoozes.

## 7. Testing

- Vitest: pill show/hide thresholds (>5 items, >1s, fade-on-complete), stage
  labelling, active-account filtering; mock tick sequencing.
- Rust: the throttle gate (sub-gap ticks dropped, terminal tick always emitted),
  the corrected denominator, `CrawlCursor.listed` round-trip, `resync` clearing the
  crawl cursor.
- `cargo check` and a browser-demo screenshot of a simulated 30-thread pass.
