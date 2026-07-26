# Deferred usage items — #3, #10, #11, #12

Raised 2026-07-26 alongside seven items that shipped the same session. These
four were held back because each is a design problem, not a fix. Root causes
below are investigated, not guessed.

---

## #3 — Recipient chips (drag to reorder, × to remove)

**Today:** To/Cc/Bcc are plain comma-separated `<input>` text. Reordering means
retyping; removing one address means finding the right comma.

**Wanted:** each address a rectangle; drag to reorder; an `×` per chip that
turns the chip red on hover so the destructive click is legible before it lands.

**Why it is not a quick fix.** The compose state stores `to`/`cc`/`bcc` as
single strings (`ComposeState` in `stores/ui.ts`, serialised into the draft
payload). Chips need an array model, which touches: the reply dock, the compose
modal, draft save/restore (persisted shape changes), the contacts-autocomplete
insertion path, and `useComposeController`'s `{ draftId, ...payload }` spread.
Doing it as a display-only veneer over the string would reintroduce the exact
parse/serialise ambiguity chips exist to remove (a display name containing a
comma).

**Sketch.** Introduce `Recipients = string[]` in `ComposeState`; keep a
`toString()/parse()` pair at the IPC boundary only, so the wire format and the
stored draft stay unchanged for one release. Chip component owns drag via
pointer events (not HTML5 DnD — it does not work reliably inside the WebView2
composer). Reorder is a pure array move, so it unit-tests without a DOM.

**Ordering caveat worth deciding:** Gmail does not preserve recipient order as
meaningful metadata. Reordering is for the *author's* benefit while composing.
Worth confirming that is the intent before building drag.

---

## #10 — Why sync is slow, and what Superhuman actually does

**Measured cause, not speculation.** `crawl_step` fetches **one thread per
HTTP request** (`threads.get?format=full`), one listing page per beat, and the
beat is driven off the 30-second sync tick with a `crawl_busy` overlap guard.
So throughput is bounded at roughly *one page of threads per beat*, serially.
For a mailbox of tens of thousands of threads that is hours. The "Indexing 96
of 100…" pill is showing one page, not the mailbox.

**Three separate costs, only one of which is Google's fault:**

1. **No batching.** Gmail supports `POST /batch` with up to 100 sub-requests in
   one HTTP round trip. Every `threads.get` in a page could be one batch call.
   This is the single biggest win and does not change any data model.
2. **Serial beats.** One page per 30s tick wastes almost all of the wall clock.
   The crawl should run its own loop with a concurrency limit (Gmail's per-user
   rate limit is 250 quota units/second; `threads.get` is 10 units, so ~25/s is
   the ceiling — roughly 5–8 concurrent requests sustained).
3. **Full-format fetches for everything.** `format=full` pulls every body and
   attachment structure. Superhuman-style "instant" comes from fetching
   `format=metadata` for the long tail (headers only — enough for the list) and
   hydrating bodies lazily on open. Bodies are the bulk of the bytes.

**What Superhuman actually does** (from public engineering talks + observable
behaviour): a server-side index does the crawl once, so the client never pays
for history at all; the client syncs a thin recent window and queries the
server for anything older. We have no server, so the honest local equivalent
is: make the *first* screen correct within seconds (already true — reconcile
streams the inbox first), then make the background crawl fast enough to be
invisible (batching + concurrency + metadata-first).

**Risk to respect:** all three changes multiply request volume. The dead-grant
classification and the 5-attempt park exist because this app has already had a
silent-auth-failure outage; any concurrency work must keep those paths intact
and must back off on 429 rather than burn attempts.

---

## #11 — Event creation: two clicks, and the event not appearing locally

**Two distinct bugs.**

**(a) The invite takes two clicks.** Creating an event and adding an attendee
are separate confirmations in `EventModal`. Should be one commit.

**(b) The event does not appear on the Snail Mail calendar** even though it was
created on Google. This is the more serious one and is a *cache coherence* bug,
not a sync bug: `useCalendar` keeps `eventsByDay` keyed by day with a
`loadedDays` set. A day already in `loadedDays` is considered authoritative and
is not refetched, so an event created *into* an already-loaded day never lands
in the cache until something invalidates it. The event modal fetches fresh on
open, which is why the event looks right while you are editing and vanishes
after.

**Fix shape:** on a successful create/edit/delete, invalidate the affected
day(s) in `loadedDays` and re-run `loadRange` for them, rather than trusting
the optimistic insert. Same pattern the mail side already uses for
`mail:updated`. Small and well-bounded — this is the closest of the four to
"just do it", and it is only deferred because it wants a test seeding a
pre-loaded day.

**Also asked for:** show where the event lands on your calendar while creating
it, so placement is visually confirmable before committing. That is a preview
overlay in the day grid driven by the modal's current start/end.

---

## #12 — Surgical updates, and asking before installing

**Today:** `runCheck()` in `lib/updater.ts` calls `update.downloadAndInstall()`
unconditionally, on boot, every 4 hours, and on every window focus (5-minute
throttle). There is no prompt anywhere in that path, and `installMode` is
`"passive"`, so the NSIS installer runs over the live app.

**Wanted:** notify that an update exists; install on quit, or on next launch
before the window paints; never mid-session without consent.

**What is already safe** (verified, and worth stating because it changes the
urgency): the crawl cursor is persisted to `kv` after every page, and threads
whose `history_id` already matches are skipped rather than refetched. So an
update landing mid-download costs *at most the current page*. The mission-
critical "don't lose hours of indexing" property largely holds today. What is
missing is consent and predictability, not durability.

**Fix shape:**
- Split `check()` from `downloadAndInstall()`. Check freely; download in the
  background; then **stop** and surface "vX is ready".
- Install on an explicit action, on app quit, or at next launch before the
  window shows.
- Suppress the prompt entirely while a first-run crawl is in flight — the one
  moment a restart is most expensive and least welcome.

**Related, and the part that is genuinely mission-critical:** multi-account
triage of the initial download. Today each account crawls independently off the
same tick. The requirement is that adding several accounts degrades gracefully,
survives a kill or an account switch, and never restarts from zero. The cursor
design already supports resumption per account; what is unproven is behaviour
under *several* accounts crawling at once, and that deserves its own test —
seed two accounts mid-crawl, kill, resume, assert neither restarted and neither
starved the other.
