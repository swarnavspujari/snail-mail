# Per-Account SQLite Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One SQLite file per account (plus a small global db) so account removal is close-a-connection-and-delete-a-file, no DB work ever runs on the main thread, and dead Google grants surface in seconds with a persistent Reconnect CTA.

**Architecture:** `global.db` holds app-wide kv (`settings`, `accounts`, `streaks`, `kb`, `demo_rsvp`, `unsplash:*`, v0.1 `account`); `accounts/<sanitized-email>-<fnv64>.db` holds everything account-scoped with today's schema unchanged (threads, messages, attachments, mail_fts, mail_vec/vec_meta, labels, contacts, people_contacts, events, drafts, outbox, per-account kv keys kept verbatim including their `:{email}` suffixes). `AppState.db` becomes a `DbRegistry` (global conn + lazily-opened per-account conns + optional legacy conn during migration). All 34 sync DB-touching commands become async. A chunked, resumable, backgrounded ATTACH migration splits the legacy `fission.db`, verifies row counts per account, then renames it `.bak`; the `.bak` is deleted on the next boot that re-verifies.

**Tech Stack:** Rust (rusqlite, tauri 2, tokio), sqlite-vec via process-global auto-extension, TypeScript/React/Zustand frontend, vitest + cargo test.

**Branch:** `claude/snail-mail-per-account-db-f5d3c8` (this worktree). Commit after every green task.

---

## Locked design decisions (from research + code exploration)

1. **Account file name:** `accounts/{sanitize(email)}-{fnv1a64(email):016x}.db`, sanitize = lowercase, `[a-z0-9]` kept, everything else `_`, truncated to 40 chars. Deterministic → the boot sweep can compute the expected file set from the registry without a mapping table. FNV-1a implemented inline (std `DefaultHasher` is not stable across Rust versions).
2. **Schema:** account files are created by today's `store::open` untouched (it is already per-file-safe: `CREATE IF NOT EXISTS` + guarded `ALTER`s, no `user_version`). `global.db` gets a new `store::open_global` that creates only `kv` and registers the same sqlite-vec `Once` (hoisted to `register_vec_extension()` so the hook can't be bypassed).
3. **Per-account kv keys keep their `:{email}` suffix** inside the account file — zero churn at every `format!("history:{email}")` call site.
4. **kv routing for migration:** keys matching `history:|crawl:|threads_total:|profile:|granted_scopes:|scope_notice_shown:|sendas:|people_synced:|drive_folder:|cal_synced_at:|cal_range:` + `{email}`, and prefixes `cal_sync:{email}:`, `cal_anchor:{email}:`, `invite_miss:{email}:` → that account's file. `embed_model` and `contacts_built_v1` are copied into **every** account file (prevents a per-file vector wipe / contacts re-backfill). Everything else → `global.db`.
5. **Migration correctness model:** sync/crawl/embed/outbox loops are globally quiesced while migration runs (one-time, minutes, progress-visible). UI reads/writes keep hitting the legacy conn for unmigrated accounts. Bulk phase copies big immutable content (messages, attachments, mail_fts, mail_vec/vec_meta) chunked by rowid cursor with the cursor committed in the same transaction (exactly-once under kill). Flip phase re-copies the small mutable tables (threads, drafts, outbox, labels, contacts, people_contacts, events, per-account kv) with INSERT OR REPLACE in one transaction, verifies row counts, then marks `migrated:{email}` in global kv. Local-only state (snoozes, splits, drafts, outbox) cannot be lost; a read-flag flipped during the bulk copy re-syncs from Gmail.
6. **Resume-after-kill:** per-table rowid cursors live in the *target* file's kv (`migrate_cursor:<table>`); the `migrated:{email}` flag lives in global kv and is only set after verification. A killed migration re-runs idempotently (cursors + INSERT OR IGNORE/REPLACE).
7. **`.bak` lifecycle:** when every account verifies → checkpoint + close legacy conn → rename `fission.db` → `fission.db.bak`. Next boot: if all `migrated:` flags still verify, delete the `.bak`.
8. **Genuinely cross-account operations** (all become fan-out-over-conns loops; none need SQL joins across accounts):
   - accounts registry / settings / streaks / kb / unsplash (global db)
   - sync loops (`sync_now`, `resync_account`, 30s tick, boot reconcile) — already iterate sessions
   - `emit_sync_progress` (sums `count_threads` + kv per account)
   - `notify_new_mail` (unread notification query — union per account)
   - `wake_due_snoozes`, outbox pump, `reclassify_page`/`has_unclassified_threads`
   - **Not** cross-account despite appearances: `search_all` (active-only today, stays), `list_labels` (its cross-account union is a leak bug — per-account is the fix), `search_contacts` (already scoped).
9. **Bare-id commands** (`get_thread`, `archive_thread`, `toggle_star`, `cancel_outbox`, `delete_draft`, …): resolve against the **active** account's conn first, fall back to a fan-out probe (`registry.find_thread_account`). Outbox/draft row ids stay per-file AUTOINCREMENT; `queue_mail` callers keep working because cancel/send-now fan out with the same active-first probe.
10. **Removal (Phase 2):** `AccountInfo` gains `removing: bool` (serde default, TS optional). `disconnect_account` = mark removing + reassign active + save + emit + return (ms). Background `finish_removal`: revoke (5s timeout) → drop session → collect this account's attachment-cache filenames (skip ones referenced by other accounts) → close conn + delete db/-wal/-shm (retry loop for Windows sharing violations) → keychain (per-account entry always; legacy shared `gmail:refresh_token` only when no gmail accounts remain) → prune `settings.signatures[email]` → drop account from registry → demo fallback if empty → emit `accounts:updated` + `mail:updated`. Boot: `finish_removal` for any account still flagged `removing`; sweep deletes `accounts/*.db` not derivable from the registry.
11. **Reconnect-for-scopes:** SettingsScreen `reconnect()` stops calling `disconnect` — `start_oauth` already updates an existing account row in place (lib.rs:205-215), so mail, cursors and history survive; verify no demo-purge side effect for existing accounts.
12. **Grant health (Phase 3):** `classify_sync_error(app, email, err)` helper applied at: boot reconcile, `sync_now`, `resync_account` (both must also stop aborting the whole loop on the first account's error), calendar sync + range fetch, people sync, sendas fetch, crawl, outbox delivery. 401 → one forced token refresh + single retry inside `gmail.rs::get_json/post_json`; the calendar bearer path forces one `session.token()` refresh on a 401 so a Google-side revoke classifies in seconds. `mark_auth_lost` additionally emits `accounts:updated`; settings store subscribes. UI: persistent per-account Reconnect banner gated on `connected === false` (provider gmail, not removing), header dot bound to the active account's `connected`. Outbox: pump skips accounts with `connected == false`; auth-classified delivery failures don't bump attempts (park + auto-resume on reconnect); the unscoped `DELETE FROM outbox WHERE attempts >= 5` is replaced by keep-row + one `app:notice`.
13. **Events added to the seam** (Backend interface + TauriBackend + MockBackend + App.tsx listener): `onAccountsUpdated` (Phase 2), `onMigrationProgress` (Phase 1). `src-tauri/src/mail/mock.rs` needs no event work (fixture seeder only).
14. **Frontend caches:** `clearMailCaches()` in `src/stores/mail.ts` is promoted from test hook to production API, called on disconnect and account switch.

---

## Phase 1 — Per-account storage, async commands, migration

### Task 1.1: `register_vec_extension` + `store::open_global` + filename helper

**Files:** Modify `src-tauri/src/store/mod.rs` (top, around lines 10-24). Tests in the existing `mod tests` block.

- [ ] Hoist the `Once` at mod.rs:14-19 into `pub fn register_vec_extension()`; call it from `open`.
- [ ] Add `pub fn open_global(path: &Path) -> Result<Connection, String>`: `register_vec_extension()` → `Connection::open` → `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`
- [ ] Add `pub fn account_db_filename(email: &str) -> String` (sanitize + inline fnv1a64) with unit tests: stable output, distinct emails → distinct names, weird unicode email safe.
- [ ] `cargo test -p snail-mail account_db_filename` green; commit `feat(store): global-db opener + account db filename helper`.

### Task 1.2: `DbRegistry`

**Files:** Create `src-tauri/src/store/registry.rs`; wire `pub mod registry;` in `store/mod.rs`.

```rust
pub struct DbRegistry {
    global: Arc<Mutex<Connection>>,
    accounts: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    legacy: Mutex<Option<Arc<Mutex<Connection>>>>, // fission.db while migration incomplete
    pub data_dir: PathBuf,
}
```
- [ ] `open(data_dir)` — opens `global.db`; if `fission.db` exists and global kv lacks `migration_done`, opens it as legacy and (once) copies the global kv keys into global.db (`copy_global_kv`, idempotent, guarded by kv flag `global_kv_copied`).
- [ ] `account(&self, email) -> Result<Arc<Mutex<Connection>>, String>` — if `migrated:{email}` set in global kv (or no legacy conn), lazily `store::open(accounts/<file>.db)`; else return the legacy Arc.
- [ ] `global(&self)`, `account_db_path(email)`, `registered_emails()` (reads accounts blob from global), `legacy()` accessor, `mark_migrated(email)`, `is_migrated(email)`.
- [ ] Unit tests (tempdir): isolation (thread in A invisible in B), legacy routing before/after `mark_migrated`, `copy_global_kv` moves `settings`/`accounts`/`streaks` and leaves `history:x@y` behind.
- [ ] Commit `feat(store): DbRegistry — global + per-account connections with legacy routing`.

### Task 1.3: Migrator

**Files:** Create `src-tauri/src/store/migrate.rs`. Tests inside it.

- [ ] `pub fn needs_migration(global: &Connection, data_dir: &Path) -> bool` — legacy file exists && `migration_done` unset.
- [ ] `pub fn migrate_account(registry: &DbRegistry, email: &str, progress: &dyn Fn(MigrateProgress)) -> Result<(), String>`:
  - open target via `store::open`, `ATTACH ? AS legacy` (read-only path of fission.db)
  - bulk tables chunked by legacy rowid, cursor `migrate_cursor:<table>` committed in-tx, `INSERT OR IGNORE`:
    - `messages` via `JOIN legacy.threads t ON t.id=m.thread_id AND t.account_id=?`
    - `attachments` via message join (2 hops)
    - `mail_fts(rowid, thread_id, subject, from_text, body)` via thread join, explicit rowid
    - `vec_meta` WHERE account_id=? then `mail_vec(rowid, embedding)` joined on `vec_rowid`
  - flip step in ONE transaction: `INSERT OR REPLACE` full re-copy of `threads` (WHERE account_id), `drafts`, `outbox`, `labels`, `contacts`, `people_contacts`, `events`, per-account kv (decision #4) + copy `embed_model`/`contacts_built_v1`
  - verify: per-table `COUNT(*)` legacy-scoped vs target + 3 spot checks (a thread's subject, a message body length, an FTS `MATCH` smoke); mismatch → `Err` (leaves flag unset, next boot retries)
  - DETACH, then caller sets `migrated:{email}` in global kv.
- [ ] `pub fn finish_if_complete(registry: &DbRegistry) -> Result<bool, String>` — all registered emails migrated → `wal_checkpoint(TRUNCATE)` + drop legacy conn + rename `fission.db` (+`-wal`/`-shm` if present) to `.bak` + set `migration_done`. Boot path deletes `.bak` when `migration_done` set and every account file exists.
- [ ] Test: **round-trip** — seed a legacy db with 2 accounts (reuse `tests::seed` pattern + drafts/outbox/labels/contacts/events/kv/fts/vec rows), migrate both, assert per-table counts + spot checks + global/account kv routing.
- [ ] Test: **resume-after-kill** — run `migrate_account` with an injected chunk budget (`MigrateOpts { max_chunks: Some(2) }` test hook) so it errors mid-`messages`; re-run without budget; assert final counts identical to round-trip and zero duplicates.
- [ ] Commit `feat(store): chunked resumable legacy-db split migration`.

### Task 1.4: AppState swap + boot sequence

**Files:** Modify `src-tauri/src/lib.rs` (AppState at 23-43, setup at 3481-3860).

- [ ] `AppState { dbs: store::registry::DbRegistry, migrating: AtomicBool, ... }` (db field removed; compiler drives the rest).
- [ ] setup(): `migrate_legacy_db` (unchanged) → `DbRegistry::open` → demo seeding against the demo accounts' conns → sessions from keychain (reads global accounts) → manage state → spawn one task: if `needs_migration` { set `migrating`, per-account `migrate_account` emitting `migration:progress {account, done, total, pct}`, `finish_if_complete`, clear `migrating` } then boot reconcile (Task 1.6 wiring).
- [ ] All periodic loops (30s tick, outbox pump, crawl, embed) skip while `state.migrating` is true.
- [ ] Boot sweep replaces `spawn_orphan_mail_sweep`: delete any `accounts/*.db` (+sidecars) whose name isn't derived from a registered email — only runs when `migration_done`.
- [ ] Commit `feat(core): DbRegistry in AppState + backgrounded migration on boot`.

### Task 1.5: Command + helper conversion (the wide mechanical pass)

**Files:** `src-tauri/src/lib.rs` throughout; `src-tauri/src/ai/context.rs`; `src-tauri/src/mail/sync.rs` call sites.

Routing recipe per command (from the explorer table of all 76):
- **Global conn:** get_accounts, switch_account, reorder_accounts, get_settings, save_settings, get_knowledge_base, save_knowledge_base, set_ai_key, test_ai_provider (settings read), get_streaks, record_zero, list_celebration_images, get_daily_photo, photo_shown.
- **Active-account conn:** list_threads, search_threads, threads_with_contact, search_all, load_older, bulk_archive, queue_mail, send_mail_now, save_draft, list_drafts, list_events…delete_event, rsvp_event, list_calendars, refresh_calendar, search_contacts, refresh_contacts, split_counts, preview_split, drive_*.
- **Email-param conn:** get_capabilities, get_profile, set_profile_photo, get_send_as, start_oauth, disconnect_account.
- **Thread-resolved conn (active-first, fan-out fallback):** get_thread, refetch_message_body, archive→unsubscribe thread ops, thread_invite, ai_draft, ai_suggest_replies, download_attachment, open_attachment.
- **Row-id fan-out:** cancel_outbox, send_outbox_now, delete_draft.
- [ ] Add helpers: `active_email(&AppState) -> Result<String,_>`, `active_conn`, `thread_conn(state, thread_id) -> Result<(String, Arc<Mutex<Connection>>), _>`.
- [ ] Convert all 34 sync commands to `async fn` returning `Result<T, String>` where they didn't already (Tauri: async + `State<'_>` requires Result). Frontend unaffected (Result<T,String> serializes as T on success).
- [ ] `ai::context::assemble` signature: take the account's `&Mutex<Connection>` (caller resolves), same for embed beat (`registry.account(email)` clone) and `emit_sync_progress`/`notify_new_mail`/`wake_due_snoozes`/outbox pump/`reclassify` fan-outs.
- [ ] `cargo check` + full `cargo test` green; commit `refactor(core): route every command through DbRegistry; all DB commands async`.

### Task 1.6: Frontend migration strip + seam event

**Files:** `src/lib/ipc.ts`, `src/lib/mock.ts`, `src/App.tsx`, `src/lib/types.ts`.

- [ ] `onMigrationProgress(cb)` in Backend + TauriBackend (`listen("migration:progress")`) + MockBackend no-op unsubscribe. Type `MigrationProgress { account: string; done: number; total: number; pct: number }`.
- [ ] Footer strip next to the download strip (App.tsx:435 pattern): "Optimizing mail storage… {pct}%" while migrating.
- [ ] `npm test` green; commit `feat(ui): migration progress strip`.

### Task 1.7: Phase-1 verification (gate before Phase 2)

- [ ] `cargo test` — migration round-trip + resume tests green (paste output).
- [ ] `npm test` green.
- [ ] **Measurement:** ignored-by-default `#[test] perf_migration_responsiveness` (`cargo test --release -- --ignored perf_`) — seeds a legacy db (~10k threads / 20k messages + FTS), runs `migrate_account` on a thread while timing `store::list_threads` against the legacy conn every 50ms; report max/median latency. Expect: median < 5ms, max bounded by one chunk transaction.
- [ ] Commit + report numbers.

## Phase 2 — Instant, honest removal

### Task 2.1: `removing` state + instant disconnect + background finisher
- `types.rs` AccountInfo `+ removing: bool` (serde default) mirrored in `src/lib/types.ts` (`removing?: boolean`) and the demo fallback literal (store/mod.rs:270-276).
- Rewrite `disconnect_account` per decision #10; add `finish_removal`; boot resumes unfinished removals; sweep extended. `DbRegistry::close_and_delete(email)` with Windows retry loop.
- Idempotency + double-click test (second call returns same state, no error); removal-of-missing-file test.
- Emit `accounts:updated` (new event) on both the instant return and background completion.

### Task 2.2: keychain legacy-entry fix
- `disconnect` deletes `gmail:refresh_token:{email}` always; `GMAIL_REFRESH_TOKEN_LEGACY` only when no gmail accounts remain (count from global registry post-removal). Unit test in secrets/lib tests.

### Task 2.3: UI — confirm, removing state, error path
- `SettingsScreen`: two-step inline confirm; per-account busy; row renders "Removing {email}…" (spinner) when `removing`; `.catch` → toast. `clearMailCaches()` on disconnect + `switchAccount`. `onAccountsUpdated` seam event + MockBackend implementation (stateful `disconnect(email)` mutating accountOrder + emitting) + App.tsx listener → `refreshAccounts()`.
- vitest: MockBackend disconnect removes + emits; mail-store cache cleared on disconnect/switch.

### Task 2.4: purge-free reconnect
- `reconnect()` drops the `backend.disconnect` call (straight `startOauth`); verify `start_oauth` in-place update path doesn't touch mail tables or cursors for an existing account (add regression note/test around lib.rs:205-215 demo purge gating).

### Task 2.5: Phase-2 verification
- **Measurement:** ignored perf test seeding ~10k-thread account: old path = `clear_account_mail_chunked` equivalent (`delete_threads` loop) wall-time vs new path = `close_and_delete` wall-time. Report both.
- Removal idempotency + sweep tests green; `npm test` green; manual event-flow check in browser demo via preview.

## Phase 3 — Dead grants visible and cheap to fix

### Task 3.1: `classify_sync_error` + 401 refresh-retry
- `gmail.rs get_json/post_json`: on 401 → `self.force_refresh()` (drop cached token) → retry once; refresh failure propagates `invalid_grant` string. Calendar bearer path: on 401 result, one forced `session.token()` to classify. Unit tests: `is_auth_revoked` matrix (invalid_grant body, 401 body, long-body truncation), force_refresh state transition.
- Apply classifier at: boot reconcile (stop swallowing), sync_now + resync_account (per-account continue instead of `?` abort), calendar sync/range, people, sendas, crawl, outbox delivery.

### Task 3.2: `accounts:updated` from `mark_auth_lost` + settings-store subscription (store subscribes, not just App.tsx — spec requirement).

### Task 3.3: Reconnect surfacing
- Persistent banner (App shell) listing each gmail account with `connected === false && !removing`: "Google sign-in for {email} expired — Reconnect" → startOauth. Header dot at App.tsx:296 bound to active account's `connected` (green/amber).

### Task 3.4: outbox parking
- Pump skips `connected == false` accounts; auth-classified failure → no attempt bump; reconnect resumes automatically. Replace `DELETE FROM outbox WHERE attempts >= 5` with keep-row + one `app:notice`. Store test: parked row survives 10 pump iterations with dead grant, delivers after flag restored.

### Task 3.5: Phase-3 verification — classification tests green, vitest green, browser-demo banner flow, report.

---

## Self-review notes
- Spec coverage: file layout ✔ (1.1-1.4), async conversion ✔ (1.5), cross-account audit ✔ (decision #8, reported to user), migration ✔ (1.3), instant removal ✔ (2.1), sweeps ✔ (2.1/1.4), keychain ✔ (2.2), reconnect-in-place ✔ (2.4), classification ✔ (3.1), 401 retry ✔ (3.1), accounts:updated ✔ (3.2), banner/dot ✔ (3.3), outbox parking ✔ (3.4), both mocks ✔ (1.6/2.3), measurements ✔ (1.7/2.5).
- Constraint check: schema untouched inside account files; sync algorithm untouched (only error handling around it); no unrequested refactors (list_labels scoping is a consequence, flagged to user).
