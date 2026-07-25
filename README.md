# Snail Mail

A **keyboard-first, AI-native desktop email client** in the spirit of Superhuman — built with Tauri v2 (Rust core + system webview), React, and your own AI keys. Local-first: your mail cache, your settings, and your API keys never leave your machine.

> **Status:** v0.9 beta — Windows 11, auto-updating installer on the [Releases page](https://github.com/swarnavspujari/snail-mail/releases/latest). The same codebase targets macOS next, then iOS/Android via Tauri v2 mobile.

*(screenshots/GIFs coming — run it and hit `Ctrl+K`)*

## Features

- **Fly through email** — the keymap replicates **Superhuman v7 (Windows/Linux)**: `E` done, `Shift+E` not done, `R`/`A` reply/reply-all, `S` star, `#` trash, `!` spam, `M` mute, `H` remind, `U` read/unread, `Z` **undo anything**, `Ctrl+U` unsubscribe, `J/K` navigate, `G`-chords (incl. `G S` starred), `Tab` next split. A `Ctrl+K` command palette lists everything with its shortcut.
- **Undo Send & Send Later** — every send has a 10-second `Z` window; `Ctrl+Shift+L` schedules for later. The outbox lives in SQLite, so scheduled mail survives restarts — no server involved.
- **Multiple accounts, instant switching** — connect several Gmail accounts and jump between inboxes with `Alt+1…9`; slots are reassignable by reordering in Settings. Per-account rich signatures (paste your Gmail one, images included). Outlook (Microsoft Graph) is scaffolded for a later release.
- **Real mail, rendered properly** — HTML email on a clean white card (sanitized, script-free), quoted trails tucked behind `•••`, collapsed older messages, attachments that open/save, and a toggleable Google Calendar day panel.
- **Split Inbox** — Important / Other out of the box (calendar lives in a toggleable side panel), plus custom splits defined in a Gmail-style query language — `from:thriftytraveler.com OR from:thepointsguy.com`, quoted phrases, parentheses, bare domains matching subdomains — with per-account scoping, drag-free reordering, an "also show in Important" toggle, and membership classified at sync time over the whole mailbox. Counts show **total** conversations, so a split reads like a to-do list.
- **Inbox Zero, celebrated** — hit zero in a split and get a full-screen celebration image with your daily/weekly streak. **Get Me To Zero** bulk-archives old mail (preserving unread/starred if you want) so the first cleanup takes seconds.
- **Write with AI (`Ctrl+J`)** — drafts stream in from **Claude, OpenAI, or NVIDIA NIM** using *your* key. The model sees the full thread, parsed attachments (PDF, text, best-effort .docx, images to multimodal models), and your personal Knowledge Base — so drafts sound like you and are grounded in real context.
- **Instant Reply** — up to 3 suggested replies per thread; `Tab` previews, `R` inserts. Nothing ever sends without your explicit review.
- **Ask AI (`?`)** — ask questions about the open thread, answered from its content.
- **Sound like me** — standing instructions, reusable snippets, and pasted voice examples persist locally and shape every draft.
- **Private by design** — OAuth tokens and AI keys live in the Windows Credential Manager (OS keychain). All secret-bearing calls happen in the Rust core, never the webview. No telemetry. No servers.
- **Dark theme done right** — layered surfaces, no pure black/white, deepened accents, WCAG AA contrast, visible focus rings.

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

**Installer builds:** just click **Connect Gmail** in the welcome flow — a shared beta OAuth client is built in. Google shows an "unverified app" notice once; click *Advanced → Go to fission-mail* ([why](docs/GOOGLE_OAUTH.md)).

**Building from source:** bring your own Google OAuth client (Desktop app type, ~5 minutes) — follow [docs/SETUP.md](docs/SETUP.md), then paste the Client ID + Secret into **Settings → Account**. Tokens go straight into the OS keychain either way.

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

- **Shipped through v0.9:** Gmail sync (incremental via history API) · full Superhuman-style keymap + palette · split inbox · bulk selection with single-`Z` undo · real synced Trash · folder/label sidebar with proper label names · Inbox Zero celebrations + Get Me To Zero · streaming BYOK AI (Claude/OpenAI/NIM) · Instant Reply · Ask AI · undo anything incl. send · send later · multi-account · theme-aware HTML mail rendering · attachments · local drafts · onboarding · auto-update · notifications · local-first calendar (day panel + week view) · daily Unsplash photo on empty splits · offline Harper spell/grammar in compose · the Fission Mail Design System in dark + light
- **Next:** Outlook (Microsoft Graph) adapter · search operators (`from:`, `in:`) · macOS build · Ask AI across the whole inbox
- **Later (documented, not built):** iOS/Android via Tauri v2 mobile · calendar week view + event creation · team collaboration · CRM integrations — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#p2-later)

## License

[MIT](LICENSE)
