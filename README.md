# Snail Mail

A **keyboard-first, AI-native desktop email client** in the spirit of Superhuman — built with Tauri v2 (Rust core + system webview), React, and your own AI keys. Local-first: your mail cache, your settings, and your API keys never leave your machine.

> **Status:** v0.24.0 — Windows 11, auto-updating installer on the [Releases page](https://github.com/swarnavspujari/snail-mail/releases/latest). macOS and Linux compile in CI on every push; neither has a released build yet.

*(screenshots/GIFs coming — run it and hit `Ctrl+K`)*

## Features

- **Fly through email** — the keymap replicates **Superhuman v7 (Windows/Linux)**: `E` done, `Shift+E` not done, `R`/`A` reply/reply-all, `S` star, `#` trash, `!` spam, `M` mute, `H` remind, `U` read/unread, `Z` **undo anything**, `Ctrl+U` unsubscribe, `J/K` navigate, `G`-chords (incl. `G S` starred), `Tab` next split. A `Ctrl+K` command palette lists everything with its shortcut, and every binding is remappable in Settings with conflict detection.
- **Search that reaches your whole mailbox** — a background crawler indexes full history (not just the synced window), ranked with SQLite FTS5 + BM25. Semantic search runs on a bundled local embedding model — no bytes leave the machine — and hybrid results fuse keyword and meaning. Natural-language queries (`from maya last week about the term sheet`) are planned into structured filters.
- **Undo Send & Send Later** — every send has a configurable `Z` window (10s default); `Ctrl+Shift+L` schedules for later. The outbox lives in SQLite, so scheduled mail survives restarts — no server involved. Replies send optimistically: the row appears instantly, `Z` pulls it back to a draft.
- **Multiple accounts, properly isolated** — every account gets its **own SQLite file**, so connecting a second mailbox can't slow the first and disconnecting one is a file delete rather than a multi-gigabyte row purge. `Alt+1…9` switches; per-account rich signatures; dead OAuth grants surface as a Reconnect banner instead of failing silently.
- **Real mail, rendered properly** — HTML email renders inline in a shadow DOM as one continuous document: selection crosses subject into body, nothing reflows, and the sanitizer is the sole trust boundary (CSS scrubbed, `position:fixed` jailed, per-attribute URL policy). Quoted trails tuck behind `•••`, attachments open/save, and Drive files attach as links or copies.
- **Split Inbox v2** — Important / Other out of the box, plus custom splits in a Gmail-style query language (`from:thriftytraveler.com OR from:thepointsguy.com`, quoted phrases, parentheses, bare domains matching subdomains), with per-account scoping and an "also show in Important" toggle. Membership is classified **at sync time** and stored on the row, so tab counts, the unread badge, and bulk actions all read the same materialized value.
- **Inbox Zero** — empty a split and the list gives way to that day's photograph, your streak counted in the corner. Nothing sits in between. **Get Me To Zero** bulk-archives the *entire* split (not just what's on screen), chunked so the UI stays live, with one `Z` restoring the whole sweep.
- **Two-way calendar** — Google Calendar in a side panel and a week view, with event create/edit/delete, invitations and RSVP-from-mail, and Google Meet links created on demand.
- **Write with AI (`Ctrl+J`)** — drafts stream in from **Claude, OpenAI, or NVIDIA NIM** using *your* key. The model sees the full thread, parsed attachments (PDF, text, best-effort .docx, images to multimodal models), and your personal Knowledge Base.
- **Instant Reply** — up to 3 suggested replies per thread; `Tab` previews, `R` inserts. Nothing ever sends without your explicit review.
- **Ask AI (`?`)** — ask questions about the open thread, answered from its content.
- **Sound like me** — standing instructions, reusable snippets, and pasted voice examples persist locally and shape every draft.
- **Live sync feedback** — a "Downloading 17 of 30…" pill while the Gmail API is being hit, a long-term crawl-completeness strip, and an unread badge on the Windows taskbar, macOS dock, and Linux launcher.
- **Private by design, and erasable** — OAuth tokens and AI keys live in the OS keychain; all secret-bearing calls happen in the Rust core, never the webview. No telemetry, no servers. **Settings → Privacy & keys → Erase all local data** removes every mailbox, credential and cache and shows you a literal list of what it deleted; uninstalling offers the same cleanup.
- **Dark and light, done right** — layered surfaces, no pure black/white, deepened accents, WCAG AA contrast, visible focus rings.

## Install (beta testers)

Grab the latest Windows installer from the
[**Releases page**](https://github.com/swarnavspujari/snail-mail/releases/latest)
(`Snail Mail_…_x64-setup.exe`). Windows will warn that the beta isn't
code-signed yet — click **More info → Run anyway**. The app updates itself
automatically from then on. Details in [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

## Requirements (building from source)

- Windows 11 (10 should work; untested)
- [Node.js](https://nodejs.org) 20+ and npm
- [Rust](https://rustup.rs) (stable, MSVC toolchain) + Visual Studio Build Tools with the C++ workload
- WebView2 runtime (preinstalled on Windows 11)

## Run it

```powershell
git clone https://github.com/swarnavspujari/snail-mail.git
cd snail-mail
npm install
npm run app:dev     # desktop app (first Rust build takes a few minutes)
```

The desktop app starts on the connect screen — it ships no demo data and no
fake accounts, so it needs a real Gmail account to show you anything.

To explore the whole UI without credentials, use the browser demo below: it
runs the same interface against a realistic mock inbox, and every feature works
there before you connect anything.

Build an installer:

```powershell
npm run app:build   # NSIS installer in src-tauri/target/release/bundle/nsis/
```

Browser demo / UI dev (mock backend, instant reload): `npm run dev` → http://localhost:1420

The mock backend is a **web-only** build artifact. `npm run dev` and `npm run
build` include it; `npm run dev:desktop` and `npm run build:desktop` — which is
what `app:dev` / `app:build` run — alias it out of the bundle entirely.

## Connect Gmail

**Installer builds** carry a shared beta OAuth client baked in at build time, from the `SNAIL_GMAIL_CLIENT_ID` / `SNAIL_GMAIL_CLIENT_SECRET` repo secrets — click **Connect Gmail** and go. A release built without both secrets ships no client and says so; it does not pretend to have one.

**Building from source:** bring your own Google OAuth client (Desktop app type, ~5 minutes) — follow [docs/SETUP.md](docs/SETUP.md), then paste the Client ID + Secret into **Settings → Accounts**. The client and every token live in the OS keychain, never on disk.

> **The beta consent screen is deliberately in *Testing*.** Google expires refresh tokens after **7 days** in that state, so expect to hit Reconnect about weekly — that is the configuration working as intended, not a bug. Publishing to production (unverified) removes the weekly expiry and takes one click when the app is ready for wider testers; the trade-offs are in [docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md).

## Add AI keys

Settings → **AI Providers** → paste a key for any of:

| Provider | Get a key at | Notes |
|---|---|---|
| NVIDIA NIM (default) | [build.nvidia.com](https://build.nvidia.com) | DeepSeek v4 (`deepseek-ai/deepseek-v4-pro`); OpenAI-compatible, hosted or self-hosted base URL |
| Claude | [console.anthropic.com](https://console.anthropic.com) | SSE streaming via the Messages API |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | Chat Completions, streaming |

Details and model configuration: [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md). Use **Test connection** to verify. Keys are stored in the OS keychain and sent only to the provider you chose.

## Shortcut cheat sheet

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `Ctrl+K` | Command palette | `V` | Move to folder/label |
| `C` | Compose | `/` | Search |
| `E` / `Shift+E` | Mark Done / Not Done | `?` | Ask AI |
| `H` | Remind me / snooze | `Tab` | Next split · preview instant reply (in thread) |
| `R` / `A` | Reply / Reply all | `Shift+Tab` | Previous split |
| `F` | Forward | `G` then `I`/`O`/`E`/`H` | Go to Inbox / Other / Done / Reminders |
| `Enter` | Open (list) / Reply-all (thread) | `S` | Star |
| `J` / `↓`, `K` / `↑` | Next / previous conversation | `#` | Trash |
| `U` | Mark read/unread | `Ctrl+J` | Write with AI (in compose) |
| `Alt+1…9` | Switch account | `Ctrl+Enter` / `Ctrl+Shift+Enter` | Send / Send & Mark Done |
| `Esc` | Back / close | | |

Every shortcut is remappable in **Settings → Shortcuts**. Full list + smoke test: [docs/SHORTCUTS.md](docs/SHORTCUTS.md).

## Tests

```powershell
npm test                       # front end (vitest)
npx tsc --noEmit               # type check
cd src-tauri; cargo test       # Rust core
```

CI runs all three on every push and pull request ([.github/workflows/build.yml](.github/workflows/build.yml)):

| Job | What it covers |
|---|---|
| **windows** | `tsc`, `npm test`, production build, `cargo check --locked`, and a guard that the desktop bundle contains no demo-fixture strings |
| **linux** | the full `cargo test --features demo-fixtures` suite, run inside `dbus-run-session` with a real `gnome-keyring` — so the credential-store tests exercise an actual Secret Service rather than being skipped. A follow-up step asserts those four tests **ran by name**, because a skipped test and a passing test look identical in a green build |
| **macos** | `cargo check --locked`, the only leg that compiles the macOS `cfg` arms |

## Docs

- [docs/SETUP.md](docs/SETUP.md) — full Windows setup incl. creating the Gmail OAuth client
- [docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md) — publishing the consent screen, what testers see, verification path
- [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) — installers, auto-update, code signing
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module boundaries, data flow, security model
- [docs/AI_PROVIDERS.md](docs/AI_PROVIDERS.md) — keys, models, endpoints
- [docs/SHORTCUTS.md](docs/SHORTCUTS.md) — cheat sheet + smoke-test checklist
- [docs/DECISIONS.md](docs/DECISIONS.md) — every non-default choice and assumption
- [DEMO.md](DEMO.md) — 10-minute acceptance test

## Roadmap

- **Shipped through v0.24:** Gmail sync (incremental via history API) · full Superhuman-style keymap + remappable palette · Split Inbox v2 with a query language and sync-time classification · full-history search with BM25 + local semantic embeddings + NL query planning · two-way calendar with invites, RSVP and Meet links · streaming BYOK AI (Claude/OpenAI/NIM) · Instant Reply · Ask AI · undo anything incl. send · send later · optimistic reply-send · per-account SQLite storage with resumable migration · inline shadow-DOM mail rendering + hardened sanitizer · Drive attachments · contacts autocomplete · snooze with natural-language reminders · unread badge on all three OSes · live sync-activity pill · rebuilt Settings with a shortcuts editor · welcome/onboarding flow · erase-all-local-data + clean uninstall · auto-update · notifications · offline Harper spell/grammar · the Snail Mail Design System in dark + light
- **Next:** macOS and Linux release builds (both already compile in CI) · Outlook (Microsoft Graph) adapter · Ask AI across the whole inbox · diagnostic/crash reporter
- **Later (documented, not built):** iOS/Android via Tauri v2 mobile · team collaboration · CRM integrations — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#p2-later)

## License

[MIT](LICENSE)
