# ELECTRON_APP.md — Audit

## Inaccuracies

### 1. Claims "Empty Placeholder" — Substantial Implementation Exists
- **Doc says**: "Phase 2 placeholder. The packages/electron/ directory contains only a package.json stub... No implementation exists yet."
- **Reality**: Contains real, functional code at version 0.3.0:
  - `app/layout.js` — Next.js layout with metadata (13 lines)
  - `app/page.js` — Status dashboard with health polling (104 lines)
  - `electron/main.js` — Full Electron main process with server launching (101 lines)
  - `electron/preload.js` — Preload script with IPC bridge (78 lines)
  - `next.config.js` — Next.js config with static export and `assetPrefix: './'` for Electron file:// compatibility (9 lines)
  - `electron-builder.yml` — Full installer configuration (43 lines)

### 2. Package Name Wrong
- **Doc says**: `@webpilot/electron`
- **Reality**: `@webpilot/onboarding` (package.json line 2)

### 3. Package Version Wrong
- **Doc says**: `0.0.1`
- **Reality**: `0.3.0` (package.json line 3)

### 4. Status Dashboard Partially Implemented (Not Just "Planned")
- **Doc says**: Status dashboard is a planned feature
- **Reality**: Basic implementation exists in `app/page.js`:
  - Shows server status (Running/Offline/Starting...) with color-coded indicators (lines 48-51)
  - Shows extension connection status via `/health` endpoint response (lines 32-33, 82-86)
  - Shows extension file availability by checking for `manifest.json` (lines 14, 89-95)
  - Displays the extension file path (lines 96-100)
  - Polls `/health` endpoint every 3 seconds (line 44)
  - Missing: start/stop/restart controls for the running server. Note: preload exposes `installService()` and `uninstallService()` which register/unregister the auto-start service, but these are not the same as start/stop controls and are not wired to the UI.
  - Missing: active MCP sessions display

### 5. Onboarding Wizard Not Implemented (Not Just "Planned")
- **Doc says**: Onboarding wizard is a planned feature
- **Reality**: Only a placeholder string exists — `"Onboarding goes here"` (page.js line 67). Server health checking and extension availability detection support the dashboard, not the onboarding flow. No step-by-step wizard, no sideloading instructions, no connection string display, no MCP config snippet display exist.

## Missing from Documentation

### 6. Preload IPC Bridge
- `preload.js` exposes 7 methods via `contextBridge.exposeInMainWorld('webpilot', ...)`:
  - `getServerPort()` — reads port from `server.port` file in data dir
  - `getDataDir()` — returns the data directory path
  - `getExtensionPath()` — returns the extension directory path
  - `isExtensionAvailable()` — checks if `manifest.json` exists in extension dir
  - `installService()` — runs server binary with `--install` flag
  - `uninstallService()` — runs server binary with `--uninstall` flag
  - `getServiceStatus()` — runs server binary with `--status` flag
- Paths are passed from main process to preload via `webPreferences.additionalArguments`, not via standard IPC channels.
- Not documented.

### 7. Server Launching
- Electron main process spawns the server binary as a detached child process on startup (`main.js` lines 42-58, called at line 91).
- Uses `detached: true`, `windowsHide: true`, `stdio: 'ignore'` with `child.unref()` so the server outlives the Electron window.
- Gracefully skips if the server binary is not found (line 44-47).
- This directly contradicts the doc's claim: "It does NOT run the MCP server -- the server runs independently as a background service."

### 8. Build Scripts
- Full build pipeline exists in package.json:
  - `dev` — runs Next.js dev server and Electron concurrently (using `concurrently` and `wait-on`)
  - `build:next` — static Next.js export
  - `start` — launches Electron directly
  - `dist` — electron-builder (no publish)
  - `dist:win`, `dist:mac`, `dist:linux` — platform-specific builds (each runs `build:next` first)
- Not documented.

### 9. Security: Sandbox Disabled in Preload
- `electron/main.js` line 70 sets `sandbox: false` in `webPreferences`. This is required because the preload script directly uses Node.js APIs (`fs`, `child_process`) rather than routing through IPC handlers in the main process. This is a pragmatic choice for the current stage but means the renderer has broader system access than a sandboxed configuration would allow.
- Not documented.

### 10. Electron Builder Output Directory
- `electron-builder.yml` line 7 sets output to `../../dist`, meaning built installers go to the monorepo root `dist/` directory, not within the electron package.
- Not documented.

### 11. Electron Version
- Uses Electron `33.4.11` (package.json devDependencies). Not mentioned in the doc.

## Not Yet Implemented (Doc Claims as Planned — Confirmed Missing)

### 12. Configuration Management UI
- No UI for viewing/updating server port, API key, or network mode toggle
- `getServerPort()` is available in preload and is used by the health check, but no configuration editing UI exists

### 13. API Key Regeneration
- No implementation exists

### 14. Onboarding Wizard Steps
- No sideloading instructions UI
- No connection string display
- No MCP config snippet display
- No setup verification flow

## Verified Correct

- Uses Next.js inside Electron (Next.js `^15.0.0`, React `^19.0.0` — caret ranges, not pinned versions)
- Installer formats: NSIS for Windows, DMG for macOS, AppImage for Linux (electron-builder.yml)
- Server binary and extension files bundled via `extraResources` (electron-builder.yml lines 14-18)
- Purpose: graphical interface for setup/management (though it also launches the server, contradicting the doc)
- NSIS configured as non-oneClick, per-user install (`perMachine: false`)

## Verified By

**Date**: 2026-02-25
**Reviewer**: Claude Opus 4.6 (automated audit verification)
**Changes from original audit**:
- Corrected line counts for source files (page.js: 104 not 105, main.js: 101 not 102, preload.js: 78 not 79)
- Added `next.config.js` details (static export + assetPrefix) to item 1
- Corrected item 4: clarified that preload's `installService`/`uninstallService` are auto-start registration, not start/stop controls
- Corrected item 5: the original audit overstated the onboarding implementation; only a placeholder string exists, no skeleton or working onboarding logic
- Expanded item 6: added 2 missing preload methods (`getDataDir`, `getExtensionPath`) and noted the `additionalArguments` pattern
- Expanded item 7: added specific spawn options and graceful skip behavior
- Added item 8 `start` script that was missing
- Added new items 9-11: sandbox disabled (security note), builder output directory, Electron version
- Added item 14: specific onboarding wizard features confirmed missing
- Updated "Verified Correct" section: noted caret ranges vs pinned versions, added NSIS config detail
