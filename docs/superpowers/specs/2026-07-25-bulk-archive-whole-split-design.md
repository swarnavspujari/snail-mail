# "Get me to zero" sweeps the whole split — design

**Status:** built, `cargo test` + `npm test` green
**Branch:** `worktree-bulk-archive-whole-split` (based on `99b981d`)

## The bug

`bulk_archive` selected its targets from `store::inbox_threads_for_sweep` →
`list_threads(conn, "inbox", …)`, which carries `LIMIT 500`. That is a **display
window**. The split tab rendered beside the button gets its number from
`store::split_counts`, a `COUNT(*)` over the whole mailbox.

On any split holding more than 500 conversations the two disagreed permanently:
one sweep archived 500 rows and the tab still read four figures. The button read
as broken because, from the owner's side, it was.

## Approach

Move the selection predicate into the store, next to `split_counts`, and make it
literally the same predicate. Then drain in chunks until the predicate is empty.

### 1. `SweepFilter` (src-tauri/src/store/mod.rs)

```rust
pub struct SweepFilter<'a> {
    pub split_id: Option<&'a str>,
    pub include_unclassified: bool,
    pub before_ms: Option<i64>,
    pub preserve_unread: bool,
    pub preserve_starred: bool,
}
```

One private `where_sql()` builds the clause **and** its bound values together, so
placeholder numbering cannot drift. Three functions share it:
`count_sweep_targets`, `sweep_once`, and (for undo) `unsweep_once`.

Visibility rules — `in_inbox = 1 AND snoozed_until IS NULL AND hidden IS NULL` —
are copied from `split_counts`. The preserve options are **predicates**, not a
post-filter over a page, so the count and the drain agree about what is exempt.

Two details that are easy to get wrong:

- **`COALESCE(split_id, '')`** mirrors `split_counts`' own tally.
- **`include_unclassified`** adds `OR split_id IS NULL`. Rows the classifier
  hasn't reached carry `NULL`, and `threadInSplit` files them under the
  catch-all — so that is where the owner *sees* them. A catch-all sweep matching
  only `split_id = 'other'` would leave exactly those rows on screen after
  claiming to empty the tab. `bulk_archive` sets this when the requested split is
  the catch-all, resolved through the new `splits::catch_all_id`.

### 2. Self-cursoring drain

`sweep_once` takes the next page, archives it, and queues the Gmail archive **in
one transaction**. Archiving sets `in_inbox = 0`, which drops those rows out of
the predicate — so repeated calls drain the set with no rowid cursor to skew, and
a thread arriving mid-sweep is simply picked up by a later page.

`bulk_archive` loops it at `SWEEP_CHUNK = 200`, releasing the DB lock and
yielding between chunks (the crawl-beat pattern), repainting per chunk so the
list visibly drains.

The local write and the queue insert are atomic together deliberately: split
them, and a kill in between strands a thread archived locally but still in the
inbox on the server — which `refetch_thread` then drags back. The sweep silently
undoing part of itself is the failure this exists to prevent.

### 3. Durable remote queue (`remote_ops`)

A whole-split sweep can owe Gmail tens of thousands of `modify_thread` calls —
far more than the old spawned in-memory loop could finish before the app closed.
Every request that never went out became a thread reconcile restored to the
inbox.

New per-account table, shaped deliberately like `outbox` (`_due` / `_claim` /
`_unclaim` / `_delete` / `_bump_attempts` / `_reset_attempts`, 5-attempt cap,
dead-grant parking that doesn't burn attempts). Drained by a processor spawned
beside the outbox processor, 25 ops per account per 2s beat.

Enqueueing an op for a thread deletes any **unclaimed** op for that thread first:
local state is the truth, so a sweep followed by its undo leaves the server
agreeing with the undo rather than racing it.

Demo threads never enter the queue — `is_demo_thread_id` now has one definition
in the store, which `lib.rs::is_mock_id` delegates to.

### 4. Undo stops lying

`ZeroSweep.tsx` predicted the swept set by filtering `m.inbox` — the same 500-row
window — while the toast promised *"Z restores all"*. Once the sweep covers the
whole split that promise is false.

`bulk_archive` now returns `BulkArchiveResult { archived, ids }`, and a new
chunked `bulk_move_to_inbox(ids)` restores them in one IPC call instead of N.

### 5. Progress

New `SyncStage::Sweep` → TS `"sweep"` → `STAGE_LABEL` `"Archiving"`. Reuses
`ActivityGate` and `emit_sync_activity` unchanged, so `shouldShow` keeps small
sweeps silent and large ones read "Archiving 400 of 12,000…".

## Testing

Rust (9 new): the required >500-thread drain to a zero tab count; preserve flags;
age cutoff; catch-all/NULL fold; split isolation; undo round-trip; undo ignoring
foreign ids; demo ids excluded from the queue; queue parking + reset.

TS (4 new): mock `bulkArchive` empties the tab count and returns ids; preserve
options exempt; `bulkMoveToInbox` restores exactly the swept set; foreign ids
ignored.

`src-tauri/src/mail/mock.rs` is a demo-data seeder with no IPC surface — it never
implemented `bulk_archive`, so there is nothing to mirror there.

## Known gaps

- **Not verified in the browser.** `preview_start` binds to the original session
  directory, not the worktree, so the dev server served the pre-change `mock.ts`.
  Covered by vitest + `tsc` instead; no visual confirmation of the pill or toast.
- **Tab vs list disagree on unclassified rows (pre-existing).** `split_counts`
  tallies `NULL` under key `""`, but `MailScreen`'s `countOf` reads
  `splitCounts[id]`, so the catch-all *tab* undercounts rows its *list* shows via
  `threadInSplit`. The sweep now takes those rows, so the post-sweep state is
  consistent; the pre-sweep count is not. Fixing it means teaching `split_counts`
  which split is the catch-all — a separate change with its own blast radius.
- **`secrets::tests::delete_removes_every_service_copy_so_nothing_resurrects` is
  flaky on Windows** — observed failing once in ~5 full runs, on unmodified code,
  against the real Credential Manager. Unrelated to this change.
