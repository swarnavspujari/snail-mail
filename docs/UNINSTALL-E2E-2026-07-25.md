# Uninstall cleanup — what a real E2E on a second machine must confirm

Everything below is what could **not** be verified without a signed install +
uninstall cycle. What *was* verified locally is listed at the bottom so the two
are never confused.

Run this on a machine that is **not** the primary — step 3 revokes live Google
grants and deletes real credentials.

---

## 0. Baseline capture (before installing)

Record the "before" so every later check is a diff, not a guess.

```bash
cmdkey /list > before-credentials.txt
```

```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "Mail" > before-uninstall-keys.txt
```

Also note whether `%APPDATA%\com.fission.mail`, `%APPDATA%\com.zenbox.mail`,
`%LOCALAPPDATA%\com.fission.mail`, `%LOCALAPPDATA%\com.zenbox.mail`,
`HKCU\Software\fission` or `HKCU\Software\zenbox` already exist. On a clean
machine they will not — to exercise the legacy-orphan sweep you must **stage
them** (create the directories with a dummy file, and
`reg add "HKCU\Software\fission\Fission Mail" /v InstallDir /d "C:\x" /f`).
Without staging, steps 4 and 5 prove nothing.

---

## 1. `dev-secrets.exe` is gone from the installed app directory

The single most objective check, and the one with a known-bad "before".

- [ ] `dir "%LOCALAPPDATA%\Snail Mail"` (or wherever `$INSTDIR` landed) contains
      **`snail-mail.exe` and no `dev-secrets.exe`**.
- [ ] **The upgrade path specifically.** Install v0.22.0 first (it *does* ship
      the exe — `File /a "/oname=dev-secrets.exe" …`), confirm
      `dev-secrets.exe` is in `$INSTDIR`, then auto-update to the new build and
      confirm it is **gone**.

      This is the one regression path the change could have introduced, and it
      is handled by an explicit `Delete "$INSTDIR\dev-secrets.exe"` in
      `NSIS_HOOK_POSTINSTALL`. Gating the bin out is *not* sufficient on its
      own: an auto-update never runs the old uninstaller ("In update mode,
      always proceeds without uninstalling"), and the new uninstaller has no
      `Delete` line for a file the new bundle doesn't contain — so without the
      hook line the exe would survive every future update and every future
      uninstall.
- [ ] After uninstalling such an upgraded install, `$INSTDIR` itself is gone —
      a leftover file would make the template's non-recursive `RMDir "$INSTDIR"`
      fail silently and strand the directory.

## 2. An UPDATE must not clean anything ($UpdateMode guard)

The highest-consequence check in the document. Getting this wrong wipes the
mailbox on every release.

- [ ] Install version A, connect a Gmail account, let mail sync.
- [ ] Ship/point the updater at version B and let the in-app updater apply it
      (this runs the same installer with `/UPDATE`).
- [ ] After the update: **mail is still there**, the account is still connected,
      and `cmdkey /list` still shows `gmail:refresh_token:<email>.SnailMail`.
- [ ] Nothing in the Credential Manager was removed, and
      `HKCU\Software\snail\Snail Mail` still exists.

## 3. Uninstall WITHOUT ticking the checkbox

Default path. Credentials must go; mail must stay.

- [ ] Uninstall from Add/Remove Programs, leave "delete application data"
      **unchecked**.
- [ ] `cmdkey /list` no longer contains **any** of these, under **any** of the
      three service suffixes `.SnailMail`, `.FissionMail`, `.ZenBoxMail`:

      | Credential Manager target |
      |---|
      | `LegacyGeneric:target=gmail:refresh_token:<each connected email>.<service>` |
      | `LegacyGeneric:target=gmail:refresh_token.<service>` (v0.1 shared entry) |
      | `LegacyGeneric:target=gmail:client_id.<service>` |
      | `LegacyGeneric:target=gmail:client_secret.<service>` |
      | `LegacyGeneric:target=ai:claude.<service>` |
      | `LegacyGeneric:target=ai:openai.<service>` |
      | `LegacyGeneric:target=ai:nim.<service>` |
      | `LegacyGeneric:target=unsplash:access_key.<service>` |

      That is 8 names × 3 services = up to 24 targets. Diff against
      `before-credentials.txt`; the only Snail-Mail-related lines left should be
      none.
- [ ] **`%APPDATA%\com.snail.mail` still exists** with `global.db` + `accounts\`
      intact — the mailbox is checkbox-gated on purpose and must survive.
- [ ] The Google grant is actually revoked, not merely forgotten: at
      https://myaccount.google.com/permissions the app no longer appears (or
      reappears only after a fresh consent). This is the half `cmdkey` cannot
      show you.
- [ ] Reinstall and confirm the app boots to the **connect screen** (tokens
      gone) but the old mail cache is still on disk.

## 4. Uninstall WITH the checkbox ticked

- [ ] Same credential checks as step 3, plus:
- [ ] `%APPDATA%\com.snail.mail` and `%LOCALAPPDATA%\com.snail.mail` are both
      gone (this half is the stock template's work, not ours).
- [ ] `HKCU\Software\snail` is gone.

## 5. Legacy-brand orphans (requires the staging from step 0)

Unconditional — must happen on both checkbox paths.

- [ ] `%APPDATA%\com.fission.mail` — gone
- [ ] `%APPDATA%\com.zenbox.mail` — gone
- [ ] `%LOCALAPPDATA%\com.fission.mail` — gone
- [ ] `%LOCALAPPDATA%\com.zenbox.mail` — gone
- [ ] `HKCU\Software\fission` — gone
- [ ] `HKCU\Software\zenbox` — gone
- [ ] `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Fission Mail` —
      gone, and **"Fission Mail" no longer appears in Add/Remove Programs**.
      (It is listed there on the primary machine today.)
- [ ] Known remaining orphan, out of scope and worth eyeballing: the stale
      *program directory* the old `Fission Mail` uninstall key pointed at is not
      removed — only the registry key is. Note whether one exists.

## 6. The uninstaller does not hang or error

- [ ] With the machine **offline** (revoke calls will fail), the uninstall still
      completes, and in well under a minute. The internal budget is ~15 s.
- [ ] With the app **running** during uninstall.
- [ ] Uninstalling an install that never connected an account (no databases at
      all) completes cleanly.
- [ ] `%TEMP%` / the uninstall log shows no NSIS error dialog. The hook runs
      `ExecWait` on a `windows_subsystem="windows"` binary, so it produces no
      visible console — silence here is expected, not a failure.

## 7. In-app "Erase all local data" on the desktop build

Settings → **Privacy & keys** → *On this machine* → Erase all local data.
(This was verified only in the browser demo, where there is no keychain and no
SQLite — the desktop path below is entirely unverified.)

- [ ] The receipt lists real `SnailMail/gmail:refresh_token:<email>` lines, not
      an empty credential list.
- [ ] `cmdkey /list` afterwards matches the step-3 table (nothing left).
- [ ] `%APPDATA%\com.snail.mail\accounts\` is empty/gone, `models\` gone,
      `fission.db*` gone, and **`global.db` still exists but is empty** (it is
      emptied in place, not unlinked, because its connection is open).
- [ ] The app is at the connect screen **without a restart**, and the taskbar
      unread badge cleared.
- [ ] Connecting an account again works and syncs from scratch.
- [ ] Any `errors` shown in the receipt are files locked by another process —
      confirm they are gone after the next launch.

## 8. Attachment cache

- [ ] Open two different attachments that share a filename (two `invoice.pdf`
      from different senders). Both open with their **own** contents — this was
      the collision bug.
- [ ] `%LOCALAPPDATA%\com.snail.mail\attachments\` contains one directory per
      attachment id (`<message-id>-a1\invoice.pdf`), not bare files.
- [ ] Upgrading over an install with the **old flat layout** leaves those bare
      files in place initially and they disappear within 14 days (or immediately
      if you back-date their mtime and relaunch). Nothing should crash on them.
- [ ] Disconnecting one account removes only its attachment directories.

---

## What was verified locally (do not re-verify)

| Check | Result |
|---|---|
| `cargo check --all-targets` | clean (1 pre-existing warning, `AttachmentRow::mime_type`) |
| `cargo test --lib` | **127 passed**, 0 failed |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **210 passed** |
| `dev-secrets` gated out | `cargo build --bins` produces only `snail-mail.exe`; cargo metadata records `required-features: ["dev-secrets"]`; builds only with `--features dev-secrets` |
| `--purge-data --dry-run` vs the real profile | derived all 3 real accounts out of the legacy `fission.db`; probed 10 entry names × 3 services; reported the 11 credentials that actually exist, matching `cmdkey /list` exactly; deleted nothing |
| `--purge-data` default scope, scratch tree | legacy `com.fission.mail`/`com.zenbox.mail` removed; current `global.db`, `models\`, `accounts\` untouched |
| `--purge-data --all`, scratch tree | mailbox + sidecars + `models\` + `attachments\` + `EBWebView\` removed; a foreign file in the root kept the root alive |
| re-running the same purge | idempotent, prints "nothing to remove" |
| in-app Erase, **browser demo only** | confirm gate (lowercase `erase` rejected, exact `ERASE` required), storage emptied, receipt rendered, no console errors |
| `npm run app:build` (full release) | succeeded; installer produced at `bundle/nsis/Snail Mail_0.22.0_x64-setup.exe` (18.7 MB). Only failure is the updater signing step (`TAURI_SIGNING_PRIVATE_KEY` unset locally) — after the installer, unrelated |
| `dev-secrets` absent from the real bundle | the generated `installer.nsi` now has an **empty** "Delete external binaries" section and a single app `File` line; the previous build emitted `File /a "/oname=dev-secrets.exe" …` at line 643. `target/release` contains only `snail-mail.exe`; `grep dev-secrets` on the built installer: 0 matches |
| **NSIS hook compiles** | `makensis -V2 installer.nsi` → exit 0, with a temporary `!warning` inside each macro confirming both bodies were expanded (`macro:NSIS_HOOK_POSTINSTALL`, `macro:NSIS_HOOK_PREUNINSTALL`). So `${If} $UpdateMode <> 1`, `ExecWait`, `RMDir /r`, `DeleteRegKey`, `${FileExists}`, `DetailPrint` are all valid — the markers were then removed and it recompiled clean |
| `--purge-data` from the **release** binary | exit 0, no window shown, output visible via `AttachConsole`, correct deletions against a scratch tree — so the `windows_subsystem = "windows"` build really does handle the flag headlessly, which is what the uninstaller depends on |

## Not verified anywhere, by anyone, yet

- Any real Windows **uninstall**. The hook compiles and the installer builds, but
  no one has ever watched it run. Every behavioural claim in sections 2–6 is
  reasoning about the generated `installer.nsi`, not an observed uninstall.
- The desktop in-app Erase path (section 7) — WebView2 cannot be captured here,
  and the browser demo has neither a keychain nor SQLite.
- `--purge-data` has not been run **by the uninstaller** (only by hand). The
  binary side is covered — see the release-binary row above — but the
  `ExecWait` handoff from NSIS is not.
- macOS/Linux: `app_roots` has per-OS branches; only the Windows branch is
  test-pinned and only the Windows path is exercised by an uninstaller.
