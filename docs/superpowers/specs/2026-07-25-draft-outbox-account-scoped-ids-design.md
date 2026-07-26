# Account-scoped draft & outbox ids

**Date:** 2026-07-25
**Status:** approved, implementing

## Problem

v0.23.0 gave every account its own SQLite file (`store/registry.rs`), but `drafts`
and `outbox` rows are still keyed by a bare `INTEGER PRIMARY KEY AUTOINCREMENT`.
That id is unique only *within* one account file, so id 7 exists independently in
account A and account B.

Four command paths address those rows by bare id:

| Path | Today |
|---|---|
| `delete_draft` (lib.rs:2953) | probes every registered account, active first, deletes the first `id` hit |
| `outbox_db` (lib.rs:3818) → `cancel_outbox`, `send_outbox_now` | same probe |
| `save_draft` (lib.rs:2927) | no probe at all — `UPDATE drafts … WHERE id = ?1` against the **active** account's db |

With two accounts connected, a draft or queued send created under account B and
acted on while A is active hits A's row instead. `save_draft` is the worst of the
four: compose autosaves every 800ms, so one keystroke after an account switch
silently overwrites the wrong row.

### Why the connection alone is not enough

`DbRegistry::account(email)` (registry.rs:66) returns the **shared legacy db** for
any account that has not finished the split migration. During that window several
accounts read and write one file, which is why the outbox processor carries an
`if account != email { continue }` guard (lib.rs:4504). Resolving to "the right
connection" therefore does not by itself disambiguate — the `account_id` column
has to be in the `WHERE` clause.

## Design

Identity becomes the pair `(id, account_email)`, carried across IPC as separate
arguments. No schema change; `account_id` already exists on both tables.

### Store (`store/mod.rs`)

Every id-addressed mutator takes `account_id` and scopes on it:

- `draft_save` (UPDATE arm), `draft_delete`
- `outbox_cancel`, `outbox_get`, `outbox_claim`, `outbox_unclaim`,
  `outbox_delete`, `outbox_bump_attempts`

`… WHERE id = ?1 AND account_id = ?2`. This is the actual fix; everything below is
plumbing to feed it the right owner. It closes the bug in both worlds — separate
per-account files *and* the shared legacy db mid-migration.

### Commands (`lib.rs`)

- `outbox_db()` probe deleted outright.
- `delete_draft(draft_id, account)`, `cancel_outbox(outbox_id, account)`,
  `send_outbox_now(outbox_id, account)` resolve the owner's connection directly.
- `save_draft(draft_id, draft_account, payload)` updates the owner's row. If the
  scoped UPDATE matches 0 rows the draft is re-inserted under the **active**
  account, preserving today's "row vanished — recreate rather than lose work"
  behavior.
- Return shapes carry the owner back to the front-end: `save_draft` →
  `DraftRef { id, account }`, `queue_mail` → `OutboxRef { id, account }`,
  `DraftEntry` gains `account`.
- The outbox processor already holds the owning email from `outbox_due`, so it
  passes it through; its `account != email` guard becomes redundant and goes.

### Front-end

- `ComposeState.draftAccount`, `PendingSend.outboxAccount`,
  `PendingMessage.outboxAccount`, `DraftEntry.account`.
- **Trap:** `const { draftId, ...payload } = c` (useComposeController.ts:207,
  commands.ts:239) must also strip `draftAccount`, or a stale owner is serialized
  into the draft payload and restored later.

### Mock backends

- `src/lib/mock.ts` — drafts/outbox entries gain `account`; the six methods honor
  it. Entries restored from older persisted localStorage default to the active
  account.
- `src-tauri/src/mail/mock.rs` — **no change required.** It is a fixture seeder
  (`seed_account_if_empty`, `demo_events`) with no drafts/outbox surface; Rust
  mock mode goes through the same `store::` functions as real mode and is covered
  by the store change.

## Testing

A Rust test seeds two account files that both hold draft id 7 and outbox id 7 with
distinguishable payloads, then asserts each of delete / cancel / send acts on the
owner's row and leaves the other account's row untouched. A companion test pins
the mid-migration case where both accounts share the legacy connection.

## Verification

`cargo test` (src-tauri), `npm test`, `npx tsc --noEmit`.

## Out of scope

No redesign of the drafts/outbox schema. Ids stay per-file autoincrement integers;
only their *addressing* changes.
