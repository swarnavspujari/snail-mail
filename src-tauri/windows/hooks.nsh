; NSIS install/uninstall hooks (wired via bundle.windows.nsis.installerHooks).

; ---------------------------------------------------------------- postinstall
;
; Updater-driven installs run with /UPDATE, and Tauri's template skips ALL
; shortcut creation in update mode. Across the Fission→Snail rename the first
; update lands in a brand-new "Snail Mail" install dir with a new uninstall
; key, so nothing ever creates a "Snail Mail" Start-menu entry — the old
; "Fission Mail" shortcut would remain the only launcher. Create the shortcut
; when it is missing; on fresh interactive installs it already exists and this
; is a no-op. The uninstaller removes it like any template-created shortcut
; (same name, same target).
!macro NSIS_HOOK_POSTINSTALL
  ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}

  ; Evict dev-secrets.exe, which builds up to v0.22.0 shipped into $INSTDIR (a
  ; keychain-WRITING dev utility, bundled because cargo auto-discovers
  ; src/bin/*.rs and tauri-cli treats every bin as an external binary). It is no
  ; longer built — see the [[bin]] required-features block in Cargo.toml — but
  ; gating it out is not enough to remove the copies already installed:
  ;
  ;   * an auto-update NEVER runs the old uninstaller ("In update mode, always
  ;     proceeds without uninstalling" — PageLeaveReinstall in the template), it
  ;     just installs over the top; and
  ;   * the new uninstaller has no Delete line for a file the new bundle does
  ;     not contain.
  ;
  ; So without this the exe would survive every future update AND every future
  ; uninstall. This hook is inside Section Install with no $UpdateMode guard, so
  ; it runs on updates too — which is exactly the path that strands the file.
  Delete "$INSTDIR\dev-secrets.exe"
!macroend

; --------------------------------------------------------------- preuninstall
;
; What the stock template does NOT clean up, and this hook does.
;
; DANGER — $UpdateMode. Every auto-update runs this same installer with
; /UPDATE, which means this macro runs on ordinary updates too. Anything that
; deletes user data must sit inside the ${If} below, or the mailbox is wiped on
; every release. This is the single most important line in the file.
;
; ---- Decision: what is checkbox-gated and what is not --------------------
;
; The template's "delete application data" checkbox is UNCHECKED BY DEFAULT and
; its scope is exactly two directories: $APPDATA\${BUNDLEID} and
; $LOCALAPPDATA\${BUNDLEID} (plus the vendor registry keys). That covers the
; mailbox, the embedding model, the attachment cache and the WebView2 profile
; for the CURRENT bundle identifier.
;
;   * MAILBOX AND CACHES stay checkbox-gated. Deleting a 5 GB local mail store
;     is a choice the person uninstalling gets to make — they may be moving the
;     install, or reinstalling after a crash. The template already asks. We do
;     not second-guess it, and we do not delete those paths here.
;
;   * CREDENTIALS AND LEGACY-BRAND ORPHANS are purged UNCONDITIONALLY. A secret
;     must never outlive the app that created it. Today a "full uninstall"
;     leaves a LIVE Google refresh token, the OAuth client secret and every AI
;     API key sitting in Windows Credential Manager — checkbox or not, because
;     NSIS has no way to reach the credential store at all. Likewise the
;     com.fission.mail / com.zenbox.mail trees and the HKCU\Software\fission
;     keys: they belong to bundle identifiers this installer has never heard of,
;     so no checkbox, ticked or not, will ever remove them. Leaving credentials
;     behind is a security bug; leaving mail behind is a preference.
;
; The credential half needs the app binary — see src-tauri/src/purge.rs for why
; and for exactly what --purge-data removes. It runs headless (no window, no
; database), and this hook fires at the very top of Section Uninstall, before
; any file is deleted, so the binary and the databases it reads are both still
; on disk.
!macro NSIS_HOOK_PREUNINSTALL
  ; Unconditional, and deliberately OUTSIDE the $UpdateMode guard: the template
  ; only deletes files the current bundle ships, so a dev-secrets.exe left in
  ; $INSTDIR by a pre-gating install would otherwise make the template's
  ; non-recursive `RMDir "$INSTDIR"` fail and strand the whole directory.
  ; Harmless during an update — the file is not part of this bundle either way.
  Delete "$INSTDIR\dev-secrets.exe"

  ${If} $UpdateMode <> 1
    SetShellVarContext current

    ; 1. Windows Credential Manager + the legacy identifier trees. Revokes each
    ;    Google refresh token server-side before deleting it, so uninstalling
    ;    actually ends the grant instead of merely forgetting the token.
    ;    Bounded internally (~15s worst case on a dead network) and non-fatal:
    ;    a missing or failing binary must not block an uninstall.
    ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      DetailPrint "Removing saved credentials…"
      ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --purge-data'
    ${EndIf}

    ; 2. Pre-rename app-data and cache trees. --purge-data already took these;
    ;    repeating it here is what covers the case where the binary was missing
    ;    or refused to start. RMDir /r on a non-existent path is a no-op.
    RMDir /r "$APPDATA\com.fission.mail"
    RMDir /r "$APPDATA\com.zenbox.mail"
    RMDir /r "$LOCALAPPDATA\com.fission.mail"
    RMDir /r "$LOCALAPPDATA\com.zenbox.mail"

    ; 3. Pre-rename registry keys. The rename migrations copy forward and never
    ;    clean up, so these are pure orphans — including a "Fission Mail"
    ;    uninstall entry that still lists the app in Add/Remove Programs and
    ;    points at an uninstaller that no longer exists.
    ;    The CURRENT install's own keys are deliberately left to the template,
    ;    which removes them with the app-data checkbox.
    DeleteRegKey HKCU "Software\fission"
    DeleteRegKey HKCU "Software\zenbox"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Fission Mail"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ZenBox Mail"
  ${EndIf}
!macroend
