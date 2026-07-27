# Deferred usage items #3, #10, #11, #12 — design

Date: 2026-07-26
Companion to `2026-07-26-deferred-usage-items.md`, which states the problems.
This document states what gets built and why, including the places where the
investigation contradicted the original write-up.

Decisions taken by the owner are marked **[decided]**.

---

## Corrections to the original write-up

Three of the four root causes were understated. Building to the original
sketches would have shipped fixes that miss.

**#11(b) is not "loadedDays is authoritative".** `calendar:updated` is already
emitted on every write (`finish_event_write`, lib.rs) and `handleUpdated`
already forces a re-read. The failure is that `activeStart`/`activeDays` is a
single slot in the store, and on the calendar screen `CalendarWeek` (7 days)
and `CalendarPanel` (1 day) both mount and both call `loadRange`. The panel
mounts second, so the slot settles at `{focused day, 1}` and *every*
`calendar:updated` — from a write or a background sync — re-reads one day and
leaves the visible week stale. `requestRefresh`'s throttle key is that same
clobbered pair, so the week's background refresh is issued for the wrong range.

**#10's "metadata-first" would permanently damage two indexes.** The crawl
exists to FTS-index history; `format=metadata` returns no body, so old mail
would be searchable by subject/participants/snippet only. Worse, `embed_step`
builds vectors from message text and `store::vec::missing` selects only rows
with *no* vector — embedding a snippet-only row once means a later
body-hydration pass never re-embeds it. Two cost-model corrections: format does
not change quota (`threads.get` is 10 units either way), and batching does not
either (it saves round-trips, not units). The ceiling is 250 units/s ⇒ ~25
`threads.get`/s; today's crawl achieves ~3.3/s wall-clock. Concurrency plus a
continuous loop is therefore the whole win.

**#12's UI is lying about what already happened.** On Windows/NSIS,
`downloadAndInstall()` launches the installer and exits the process. `ready:
"restart to install"` is set on a path where the app has already been replaced.
Also: `download()` holds bytes in a Rust-side `Resource` that does not survive
a restart, so "install at next launch" cannot reuse the download.

**#3 has a crash, not just a refactor.** `ComposeState` is persisted verbatim
as the draft payload. `DraftsPicker` calls `parsed.to.trim()`; an array throws
and takes the whole picker — i.e. access to every draft — with it.

---

## #3 — Recipient chips

### Model

`ComposeState.to/cc/bcc` become `string[]` (`Recipients`). Each element is one
recipient token, `"Name <a@b.c>"` or a bare address. Parsing and serialising
happen only at two edges:

- **IPC out** — `outgoingFromCompose` already produces `string[]`; it stops
  splitting on `[,;]` and passes the array through.
- **Draft in** — a `normalizeRecipients(v: unknown): string[]` accepts a legacy
  comma/semicolon string, an array, or `undefined`, and is applied in
  `DraftsPicker` on every restored draft. The persisted wire format changes to
  an array going forward; old rows keep loading forever.

Because tokens are no longer joined by commas, `RecipientInput`'s `safeName`
workaround (which discards a contact's display name when it contains a comma)
is deleted — autocomplete keeps full names.

`composeHasContent` switches from `c.to.trim()` to `c.to.length > 0`.
`RecipientFields.summarize` maps the array instead of splitting a string.

### Component

New `RecipientChips` replaces `RecipientInput` in the To/Cc/Bcc rows and in
`EventModal`'s Guests field **[decided]**. It renders one chip per token
followed by a bare text input for the next entry.

- `×` per chip; the chip turns to the destructive state on hover of the `×` so
  the click is legible before it lands.
- Backspace in an empty input removes the last chip.
- Typing `,`, `;`, Enter, or Tab commits the current text as a chip. Pasting a
  comma/semicolon-separated list commits several.
- A token that is not a plausible address renders in a warning state with a
  tooltip. **Send is not blocked** **[decided]** — Gmail rejects it as it does
  today, and no regex gets to make an address unsendable.
- Drag reorders within a field **and moves a chip across To / Cc / Bcc**
  **[decided]**. Pointer events, not HTML5 DnD (unreliable in WebView2). The
  three rows share one drop-target layer.
- `[data-field="…"] input` still resolves, so `Ctrl+Shift+O/C/B/S` focus and
  the Tab walk To → Cc → Bcc → Subject → body are unchanged.

### Pure core, testable without a DOM

`src/lib/recipients.ts`:

```
normalizeRecipients(v: unknown): string[]
parseRecipientText(raw: string): string[]     // paste / typed commit
moveRecipient(list, from, to): string[]       // within-field reorder
transferRecipient(fields, from, to): Fields   // cross-field drop
isPlausibleAddress(token: string): boolean
addrSpec(token: string): string
```

Everything drag does is one of `moveRecipient` / `transferRecipient`, so the
reorder logic unit-tests with no DOM.

### Ordering caveat

Recorded and accepted: Gmail does not preserve recipient order as meaningful
metadata. Reordering is for the author's benefit while composing.

---

## #10 — Sync speed

**[decided]** Concurrency plus a continuous crawl loop. `format=full` stays.
No Gmail `POST /batch`, no metadata-first.

### The change

`crawl_step` becomes `crawl_slice`: instead of one listing page per 30s tick,
the crawl owns a loop that keeps working until the mailbox is walked, the
account errors, or shutdown. Within a page, `threads.get` calls run with a
bounded number in flight.

Concurrency requires not holding `&mut GmailSession` per request. The calendar
fetch already establishes the pattern: resolve the bearer **once**, then issue
plain `reqwest` calls concurrently. The crawl adopts it.

- **Adaptive limit.** Start at 6 in flight, ceiling 8 (≈25 units/s at 10
  units/call is the quota ceiling; 8 sustained leaves headroom for the user's
  own traffic). On any 429 or 5xx, halve the limit and apply a shared backoff;
  recover by +1 per clean page. A single shared signal, so a global 429 does
  not produce a thundering herd of independent retries.
- **Single-flight token refresh.** Today `is_grant_dead` probes one forced
  refresh on a 401. With N in flight a dead grant produces N simultaneous
  refreshes against Google's token endpoint. The refresh is wrapped so exactly
  one is in flight per account and the rest await its result. The dead-grant
  classification and the 5-attempt park are otherwise untouched.
- **Per-page history probe.** The current loop issues two extra SQLite queries
  per thread (history_id, then last_date). Both are hoisted to one query per
  page over the page's ids.

### Multi-account fairness

Quota is per Google account, so accounts do not share a budget; the shared
resources are local. The crawl runs one task per connected account, each with
its own concurrency limit, and a scheduler that hands out work slices
round-robin so a 60k-thread mailbox cannot starve a 500-thread one. The
scheduler is a pure function over `(account, cursor)` pairs and is unit-tested
directly.

Resumption is unchanged in shape — the cursor is persisted to `kv` after every
page and threads whose `history_id` already matches are skipped — but is now
covered by a test that seeds two accounts mid-crawl, drops the process,
resumes, and asserts neither restarted from zero and neither starved.

To make that testable, the page loop is extracted behind a small trait
(`ThreadSource`: list a page, fetch a thread) so tests drive it with an
in-memory fake. No HTTP mock crate is added.

### The pill

`sync:activity` for the `Crawl` stage reports mailbox-level numbers
(`cur.listed + i` against `max(threadsTotal estimate, listed)`) rather than
position within one page. "Indexing 96 of 100…" showing one page was the
observation that opened the item.

### Not doing, and why

Battery/thermal throttling and a user-facing crawl-speed setting are out of
scope. The crawl keeps running when the window is unfocused — a mail client
sits in the background, and pausing there means it never finishes.

---

## #11 — Event creation

### (a) One commit

The separate "Send invites/updates to guests?" step is removed. An **"Email
invites to guests"** checkbox sits next to the Guests field, shown whenever the
event has (or had) guests. Default **[decided]**: checked for a new event,
unchecked for an edit. `submit` maps it directly to `sendUpdates: "all" |
"none"` and saves in one click.

### (b) Cache coherence

Two changes, because invalidating the created day alone would leave the week
view stale on every background sync.

1. **Range registry.** `activeStart`/`activeDays` is replaced by
   `watchers: Record<string, {start, days}>`. Each view registers on mount
   (`"week"`, `"panel"`) and unregisters on unmount. `handleUpdated` re-reads
   the union of registered ranges; `requestRefresh` throttles per watcher key.
   The single-slot clobber disappears.
2. **Explicit day invalidation.** On a successful create/edit/delete the store
   is told which days changed — for an edit or a move, **both** the old and the
   new span, and for an all-day or multi-day event, every day it touches. Those
   days are dropped from `loadedDays` and `eventsByDay`, then every registered
   range covering them is re-read. Days outside all registered ranges simply
   become un-loaded and refetch on navigation.

Tests seed a pre-loaded day and assert: a create into it lands; a move out of
it clears the old day and populates the new; a multi-day event invalidates its
whole span; and a second registered range is refreshed alongside the first.

### (c) Placement preview

The modal publishes its uncommitted `{startMs, endMs, allDay}` to the calendar
store as `modalPreview` on every edit. `CalendarPanel` and `CalendarWeek`
render a non-interactive ghost block at that position, styled distinctly from a
real event and never persisted.

When the target day is outside the visible range, the calendar **follows the
date, debounced ~400ms** **[decided]**, so the ghost is always visible.

This also fixes a latent bug the overlay would otherwise expose: `EventModal`
is keyed `create-new` for every create, and its start/end live in `useState`
initialisers — so clicking a second slot while a create modal is open keeps the
*old* time in the form. The key gains the modal's start time.

---

## #12 — Surgical updates

**[decided]** Notify, install on quit, explicit button; never mid-session.

### The change

`runCheck` splits: `check()` freely, `download()` in the background, then
**stop**. `ready` means "downloaded, waiting for you" — which is what the UI has
claimed all along and will now be true.

- The header's **"vX ready — Install & restart"** button calls `install()`
  (which exits the process on Windows) after flushing compose state.
- **Install on quit.** A close-request interceptor installs a ready update on
  the way out, so the next launch is the new version without the app ever
  restarting under you.
- **Never with mail in flight.** Install-on-quit is skipped when the outbox has
  pending rows — an Undo Send window must not be killed by an installer.
- **Suppressed during the first crawl.** No prompt while
  `ui.syncProgress` reports `!done && total > 0`. That signal already exists;
  no new plumbing. It is effectively "until the mailbox has been walked once",
  which is the moment a restart is most expensive.

Not doing: a boot-time install-before-paint. The downloaded bytes do not
survive a restart, so it would re-download ~20 MB at launch. Install-on-quit
delivers the same outcome for free.

### Bootstrapping note

Clients on v0.25.0 carry the *old* updater and will auto-install this release
without asking. That is unavoidable and is the last time it happens.

---

## Testing

| Area | Coverage |
|---|---|
| #3 | `recipients.ts` pure functions: legacy-string normalisation, paste splitting, within-field move, cross-field transfer, address plausibility. Draft round-trip through both shapes. |
| #10 | Scheduler fairness (pure). Cursor resume across a simulated kill with two accounts, asserting neither restarts and neither starves. Adaptive-limit backoff on 429. Existing `crawl_query` / `reanchor` tests stay. |
| #11 | Day-invalidation over a pre-loaded day; move clears old + fills new; multi-day span; two registered ranges both refreshed. One-click save maps the checkbox to `sendUpdates`. |
| #12 | `runCheck` stops after download and never installs. Ready-state suppression while a crawl is in flight. Quit path skips install when the outbox is non-empty. |

Plus the existing suites: `npm test`, `tsc --noEmit`, `cargo test`, and a
browser-demo pass over compose, calendar, and the update banner.

## Release

Lands on `main` and ships as **v0.26.0** — version bumped in `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, the lockfile version
edited in place (never regenerated), tag pushed so CI builds the three-OS
installers.
