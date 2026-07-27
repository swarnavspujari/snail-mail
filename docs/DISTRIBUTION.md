# Distribution: installers, updates, and code signing

How Snail Mail gets onto a tester's machine and stays current.

## What ships today

- Every `v*` tag triggers `.github/workflows/release.yml`, which builds the
  NSIS installer on `windows-latest` and publishes a GitHub Release with:
  - `Snail Mail_<version>_x64-setup.exe` — what testers download
  - `Snail Mail_<version>_x64-setup.exe.sig` + `latest.json` — the update feed
- The same tag also builds a **universal macOS `.dmg`** — signed with a
  Developer ID certificate and notarized by Apple — *once the six `APPLE_*`
  repo secrets exist*. Until they do, that job skips itself and Windows ships
  exactly as before. See "Signing the macOS build" below.
- The app checks `releases/latest/download/latest.json` at boot and every 4
  hours, downloads in the background, and shows **"Update ready — Restart"**
  in the header. Updater artifacts are signed with a minisign key
  (public key pinned in `tauri.conf.json`; private key lives in the
  `TAURI_SIGNING_PRIVATE_KEY` repo secret and in
  `C:\Users\swarn\.fission-mail-keys\fission_updater.key` — **back this file up;
  lose it and existing installs can never update again**).

## SmartScreen: why testers see a scary prompt

The installer is not Authenticode-signed yet. Windows SmartScreen will show
"Windows protected your PC" on first run. Testers click **More info → Run
anyway**. Include this line when you send the link:

> Windows will warn because the beta isn't code-signed yet — click
> "More info", then "Run anyway".

Unsigned + low download counts = the warning persists. Signing is the only
real fix (SmartScreen "reputation" accrues per-certificate and per-file).

## Cheapest viable signing paths (2026)

| Option | Cost | Notes |
|---|---|---|
| **Azure Trusted Signing** (recommended) | **$9.99/mo** (Basic) | Microsoft-run cloud signing. Individuals can verify with a government ID; companies need 3+ years of verifiable business history. No hardware token. Certs are short-lived and rotated automatically; SmartScreen reputation attaches to the identity, not one cert. Cancel any month. |
| SignPath.io OSS program | Free | Only if the repo qualifies as an open-source project and builds run through their infrastructure; approval takes a few weeks. |
| Classic OV certificate (Certum, Sectigo via resellers) | ~$70–125/yr (Certum "Open Source" ~€69/yr) to $200–400/yr | Since June 2023 CA/B rules force private keys onto FIPS hardware tokens or cloud HSMs — annoying for CI (needs a USB token attached to a build machine, or an HSM subscription that costs more than Trusted Signing). OV certs also start with **zero** SmartScreen reputation. |
| EV certificate | $250–700/yr | Instant SmartScreen reputation, but overkill for a beta and still HSM-bound. |

**Recommendation:** Azure Trusted Signing at $9.99/mo. It is the cheapest
path that works headlessly in GitHub Actions and removes the SmartScreen
prompt once a modest number of installs accrue reputation.

### Setting up Azure Trusted Signing (one-time, ~30 min)

1. Azure portal → create a **Trusted Signing account** (Basic, $9.99/mo),
   region East US or West Europe.
2. Complete **identity validation** (individual: government ID; usually
   minutes to a few days).
3. Create a **certificate profile** (Public Trust) under the account.
4. Create an **App registration** (service principal) with the
   *Trusted Signing Certificate Profile Signer* role on the account; note
   tenant id, client id, client secret.

### Wiring the signature into CI (when the account exists)

1. Add repo secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
2. In `release.yml`, before the tauri-action step:

   ```yaml
   - run: cargo install trusted-signing-cli --locked
   ```

   and pass the three `AZURE_*` secrets through `env:` on the tauri-action step.
3. In `src-tauri/tauri.conf.json`:

   ```json
   "bundle": {
     "windows": {
       "signCommand": "trusted-signing-cli -e https://eus.codesigning.azure.net -a <account-name> -c <profile-name> %1"
     }
   }
   ```

   (`%1` is the file Tauri hands over; the CLI reads the `AZURE_*` env vars.)

Both the NSIS installer *and* the app binary get signed; the updater keeps
working unchanged (its minisign signature is independent of Authenticode).

## Signing the macOS build

macOS is not Windows-with-a-scarier-dialog. An unsigned `.exe` warns; an
unsigned or un-notarized `.app` that arrives over the internet is **refused
outright** by Gatekeeper — "damaged and can't be opened", with no override a
normal person will find. So there is no useful "ship it unsigned for now" step
here, which is why `release-macos` skips itself until it can do the job
properly.

Two separate things have to happen, and Tauri does both when the env is set:

1. **Sign** the app with a *Developer ID Application* certificate.
2. **Notarize** — upload the signed bundle to Apple, get a ticket back, staple
   it into the app so Gatekeeper can verify offline.

### What you need to do (~30 min, all of it from Windows)

You do **not** need a Mac. Git Bash ships OpenSSL, which is enough to create
the key, the request, and the `.p12`.

**1. Find your Team ID.** <https://developer.apple.com/account> → Membership
details. Ten characters, e.g. `A1B2C3D4E5`.

**2. Make a private key and a certificate signing request.** In Git Bash, in a
scratch folder (not the repo):

```bash
openssl genrsa -out developerID.key 2048
openssl req -new -key developerID.key -out developerID.csr -subj "/emailAddress=ssp@pujariventurepartners.com/CN=Swarnav S Pujari/C=US"
```

**Back up `developerID.key`.** Lose it and the certificate is dead — you cannot
re-download a usable one, only revoke and start over.

**3. Get the certificate.** <https://developer.apple.com/account/resources/certificates/list>
→ **+** → **Developer ID Application** → *Profile Type: G2 Sub-CA* → upload
`developerID.csr` → Continue → **Download**. You get `developerID_application.cer`.

> Only the Account Holder can create a Developer ID certificate. On a solo
> individual account that is you. Apple caps you at a handful of them, so do
> not create spares "to test".

**4. Build the `.p12`** — key + certificate + Apple's intermediate, which
notarization needs in the chain:

```bash
openssl x509 -inform DER -in developerID_application.cer -out developerID.pem
curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
openssl x509 -inform DER -in DeveloperIDG2CA.cer -out DeveloperIDG2CA.pem
openssl pkcs12 -export -inkey developerID.key -in developerID.pem \
  -certfile DeveloperIDG2CA.pem -out developerID.p12 -legacy
```

It asks for an export password — invent one, keep it, it becomes
`APPLE_CERTIFICATE_PASSWORD`. (`-legacy` matters: without it OpenSSL 3 uses
AES-256 encryption that macOS's `security import` cannot read.)

**5. Read the exact identity string** the certificate carries — this has to
match character for character:

```bash
openssl x509 -in developerID.pem -noout -subject
```

Take the `CN=` value, e.g. `Developer ID Application: Swarnav S Pujari (A1B2C3D4E5)`.

**6. Base64 the `.p12`** (GitHub secrets are text):

```bash
base64 -w0 developerID.p12 > developerID.p12.b64
```

**7. Make an app-specific password** for notarization —
<https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords →
**+**. Looks like `abcd-efgh-ijkl-mnop`. This is *not* your Apple ID password,
and notarization will not accept the real one.

**8. Add six repo secrets** at
<https://github.com/swarnavspujari/snail-mail/settings/secrets/actions>:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | contents of `developerID.p12.b64` (step 6) |
| `APPLE_CERTIFICATE_PASSWORD` | the export password from step 4 |
| `APPLE_SIGNING_IDENTITY` | the `CN=` string from step 5 |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password from step 7 |
| `APPLE_TEAM_ID` | the Team ID from step 1 |

**9. Tag a release as usual.** Nothing in the repo needs editing — the `gate`
job sees all six and `release-macos` runs. Set *all six or none*: a partial set
fails the workflow on purpose, because a silent skip is indistinguishable from
"not set up yet".

**10. Check the first one.** The macOS job self-verifies (`codesign --verify
--deep --strict`, `spctl --assess`, `xcrun stapler validate`) and fails if any
of them do — but the first release is worth confirming by hand: download the
`.dmg` on a Mac, open it, and make sure no Gatekeeper dialog appears at all.
Also open the release's `latest.json` and confirm it lists **all three**
platforms (`windows-x86_64`, `darwin-x86_64`, `darwin-aarch64`) — the macOS job
patches that file rather than overwriting it, and that merge is the one part of
this that has never run against a real release.

### What that buys, and what it costs

- $99/yr Apple Developer Program (already paid).
- Notarization adds ~2–10 min to the release; Apple's service is occasionally
  slow, and a timeout fails the job rather than shipping something broken.
- Certificates last 5 years. Diary the expiry — an expired Developer ID
  breaks *new* releases, though already-notarized builds keep working.

### If you would rather use an App Store Connect API key

Apple's newer notarization credential, and it does not expire the way an
app-specific password can be revoked. Swap `APPLE_ID` / `APPLE_PASSWORD` /
`APPLE_TEAM_ID` for `APPLE_API_ISSUER`, `APPLE_API_KEY` and
`APPLE_API_KEY_PATH` in `release-macos`, and update the `gate` job's list to
match. Not the default here only because it needs a `.p8` file written to disk
in CI, which is more moving parts for one person shipping to two machines.

## Cutting a release

```powershell
# bump "version" in src-tauri/tauri.conf.json, src-tauri/Cargo.toml, package.json
git commit -am "chore: bump version to X.Y.Z"
git tag vX.Y.Z && git push && git push --tags
```

Watch the `release` workflow; when green, the Releases page has the
installer and existing installs pick the update up within 4 hours (or at
next launch).

## What testers do (send them this)

1. Download `Snail Mail_…_x64-setup.exe` from
   <https://github.com/swarnavspujari/snail-mail/releases/latest>
2. Run it. If Windows warns: **More info → Run anyway** (beta is unsigned).
3. The app opens with a demo inbox. Click through the welcome flow to
   connect Gmail — a browser window asks for Google consent
   (see docs/GOOGLE_OAUTH.md for the "unverified app" screen they'll see).
