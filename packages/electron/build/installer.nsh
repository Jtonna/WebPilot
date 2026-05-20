; WebPilot installer customizations (electron-builder NSIS).
;
; ─────────────────────────────────────────────────────────────────────
; Fills the gaps in the default electron-builder install / uninstall
; flow. The default NSIS uninstaller:
;   - removes the install directory
;   - removes the Programs-and-Features registry entry
;   - removes Start Menu / desktop shortcuts
;   - calls CHECK_APP_RUNNING (only knows about WebPilot.exe)
;
; It does NOT:
;   - know about the standalone server daemon
;     (webpilot-server-for-chrome-extension.exe), which holds file
;     handles on its own .exe inside the install dir - so file removal
;     fails and the uninstaller aborts when the daemon is running
;   - remove the HKCU Run autostart entry (WebPilotServer)
;   - remove the user-data dir (DB, paired-key state, formatter config,
;     PID/port files, logs)
;
; This file plugs all of the above in.
;
; Hook points used:
;   - customCheckAppRunning: REPLACES the default check. Runs at both
;     install time (from installSection.nsh) and uninstall time (from
;     un.onInit when silent, or un.install section when interactive).
;     Kills both the Electron app AND the standalone daemon. Always
;     runs in both upgrade and full-uninstall flows — we never want
;     stale processes holding file locks on the install dir.
;   - customUnInstall: runs at the END of the uninstall section. Used
;     for registry + user-data cleanup once files are gone. The
;     destructive parts (autostart removal, user-data wipe) are guarded
;     by ${ifNot} ${isUpdated} so they ONLY fire on a real uninstall.
;     On upgrades electron-builder reuses the same uninstaller stub to
;     wipe the old install dir, but the user's DB / pairing state / Run
;     key must survive — otherwise every version bump re-onboards the
;     user.

; --- App + daemon kill, used by both installer and uninstaller flows ---
!macro customCheckAppRunning
  DetailPrint "Stopping any running WebPilot processes..."
  ; Daemon first (most likely to hold file locks on the install dir).
  nsExec::Exec 'taskkill.exe /F /IM "webpilot-server-for-chrome-extension.exe" /T'
  Pop $0
  ; Then the Electron main app.
  nsExec::Exec 'taskkill.exe /F /IM "WebPilot.exe" /T'
  Pop $0
  ; Let Windows release handles before file ops.
  Sleep 800
!macroend

; --- Post-uninstall cleanup: registry + user data ---
; ${isUpdated} is defined by electron-builder's uninstaller template
; (see node_modules/app-builder-lib/templates/nsis/uninstaller.nsh) and
; is true when this uninstaller stub is being run as part of an upgrade
; installer's preflight (i.e. "install new version on top of old").
; In that case we must preserve user state.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Belt and suspenders - if anything still holds port 3456 after the
    ; taskkill pass, drop it. PowerShell ships on every supported Windows.
    ; NSIS uses $ for variable substitution; doubling ($$_) escapes so
    ; PowerShell receives the literal $_.OwningProcess.
    nsExec::Exec 'powershell.exe -NoProfile -WindowStyle Hidden -Command "try { Get-NetTCPConnection -LocalPort 3456 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force -ErrorAction SilentlyContinue } } catch {}"'
    Pop $0
    Sleep 400

    DetailPrint "Removing autostart registry entry..."
    ; Mirrors the in-app service.uninstall() path so users who uninstall
    ; via Programs and Features (bypassing the app's own uninstall flow)
    ; still get the autostart removed.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WebPilotServer"

    DetailPrint "Removing WebPilot user data..."
    ; v1.1.6+ writes user data to %APPDATA%\WebPilot (Electron's userData
    ; path), which survives upgrades. Older installs (<= 1.1.5) wrote to
    ; <install>\data\ (gone with the install dir) and dev-mode wrote to
    ; %LOCALAPPDATA%\WebPilot. Wipe both for backward compat.
    ; /REBOOTOK defers any locked items to next boot rather than failing.
    RMDir /r /REBOOTOK "$APPDATA\WebPilot"
    RMDir /r /REBOOTOK "$LOCALAPPDATA\WebPilot"

    DetailPrint "WebPilot uninstall complete."
  ${else}
    DetailPrint "Upgrade in progress — preserving user data and autostart."
  ${endIf}
!macroend
