# Architecture

```
UI (React + TS + Zustand + Tailwind)  ──IPC (Tauri invoke/Channel/events)──▶  Core (Rust)
  features/inbox      Split tabs, thread list                                  mail/oauth.rs   OAuth loopback + PKCE
  features/thread     Reading pane, Instant Replies, Ask AI                    mail/gmail.rs   Gmail REST + MIME parse/build
  features/compose    Compose + streaming AI bar                               mail/sync.rs    Server⇄SQLite reconcile
  features/palette    Ctrl+K command palette                                   mail/mock.rs    Demo fixtures
  features/settings   Account / AI keys / KB / splits / shortcuts              ai/context.rs   Context Assembler
  components/RestState Inbox-zero photo + streak                               ai/anthropic.rs Claude adapter (SSE)
  lib/keyboard.ts     Chord-capable key engine                                 ai/openai.rs    OpenAI + NIM adapter
  lib/commands.ts     Single action registry                                   store/          Per-account SQLite + FTS5 + vec
  lib/ipc.ts          Backend seam (Tauri ⇄ browser mock)                      secrets/        OS keychain
```

## Principles

- **The SQLite DB is the UI's single source of truth.** Sync reconciles it with Gmail. Mutations apply **locally first** and push to Gmail in the background, so triage never waits on the network; the local row is the truth the UI renders and the remote call is what eventually agrees with it.
- **Every account owns its own database file.** `store/registry.rs` maps an account email to its own SQLite file, with app-wide state (settings, the account registry, streaks) in a separate `global.db`. Disconnecting an account is a file delete rather than a multi-gigabyte row purge, and one huge mailbox cannot slow another. Two consequences that are easy to get wrong: classification must read split definitions from `global.db` (never from the account connection it is writing to), and autoincrement row ids in `drafts`/`outbox` are unique only *within* a file — so those rows are addressed by `(id, account_email)`, never by id alone.
- **Work that outlives the process gets a queue, not a spawned task.** The outbox holds sends; `remote_ops` holds the Gmail side of a bulk sweep. Both survive restart, claim a row before the network call, cap retries, and park (without burning attempts) when a grant is dead. This matters because sync rebuilds `in_inbox` from Gmail's labels: an archive that never reached the server comes *back*, so "fire and forget" silently undoes itself.
- **Secrets never enter the webview.** AI keys and OAuth tokens live in the Windows Credential Manager; all secret-bearing network calls run in Rust. The one IPC field that touches a key is `set_ai_key` (write-only); reads only expose `hasKey: bool`.
- **One backend seam.** `src/lib/ipc.ts` defines the `Backend` interface. In Tauri it maps 1:1 to Rust commands; in a plain browser a full mock implements the same surface, so the entire UX is developable and demoable without credentials.
- **One action registry.** Every user action is a `Command` (`src/lib/commands.ts`). The palette lists them; the keyboard engine binds them from the (remappable) shortcut map. An action can never exist in only one place.

## Data flows

**Sync (Gmail):** poll `threads.list` for INBOX (100) + recent non-inbox (50) → diff `historyId` per thread → `threads.get(format=full)` for changed threads → parse MIME → upsert into SQLite + FTS5 → emit `mail:updated` → stores refresh. Archive elsewhere is detected by absence from the INBOX listing. A reply to a snoozed/archived thread re-adds Gmail's INBOX label, so it resurfaces on the next pass (snoozed threads without new mail keep their local snooze).

**Snooze:** local `snoozed_until` + remote INBOX-label removal. A 30s background tick wakes due threads: local restore + `INBOX`+`UNREAD` re-added remotely.

**Drafting:**
`selected thread + attachments + Knowledge Base` → **Context Assembler** (`ai/context.rs`: dedupes, orders oldest→newest, char budget ≈25k tokens, strips oldest quoted trails first, caps per-attachment extracts, images → base64 blocks for multimodal providers) → **Provider Adapter** (Claude SSE / OpenAI-compatible stream) → tokens stream over a Tauri `Channel` into the compose textarea. Cancellation via a shared `AtomicBool` per request id.

**Send:** RFC 822 built in Rust (`In-Reply-To`/`References` from the stored `Message-ID` for replies) → `messages.send` with `threadId` → background sync picks up the sent copy.

## Security

- CSP locked to `'self'` + the IPC/asset protocols (see `tauri.conf.json`); the asset protocol is scoped at runtime to the user's celebration-image folder only.
- Every IPC input is validated in Rust (id shape, view names, lengths, address syntax).
- OAuth: loopback redirect on `127.0.0.1:<random>`, PKCE S256, `state` check, 5-minute timeout, least-privilege `gmail.modify` scope, token refresh handled in Rust.
- Errors surfaced to the UI are generic; provider/HTTP errors never embed keys or tokens.
- No telemetry of any kind.

## P2 (later — documented only, per spec)

- **Mobile:** Tauri v2 mobile targets iOS/Android from this same crate. The UI is already viewport-tolerant; the work is a responsive layout pass, mobile OAuth (ASWebAuthenticationSession / Custom Tabs via a plugin), and push-based sync instead of polling.
- **Calendar views:** a `calendar/` Rust module syncing Google Calendar (same OAuth client, added scope) into SQLite; day/week React views; `Tab`-reachable as a fourth split.
- **Team collaboration:** out of local-first scope; would need an optional sync service — explicitly deferred.
- **CRM integrations:** adapter pattern mirroring `ai/` — a `crm/` trait with per-vendor adapters, keys in the keychain.
- **Recent Opens / read receipts:** tracking-pixel injection on send + a local opens feed. Privacy posture to be decided before building.
