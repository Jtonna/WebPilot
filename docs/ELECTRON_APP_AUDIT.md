# ELECTRON_APP.md — Audit

## Inaccuracies

### 1. Claims "Empty Placeholder" — Substantial Implementation Exists
- **Doc says**: "Phase 2 placeholder. The packages/electron/ directory contains only a package.json stub... No implementation exists yet."
- **Reality**: Contains real, functional code at version 0.3.0:
  - `app/layout.js` — Next.js layout with metadata
  - `app/page.js` — Status dashboard (105 lines) with health polling
  - `electron/main.js` — Full Electron main process (102 lines)
  - `electron/preload.js` — Preload script with IPC bridge (79 lines)
  - `next.config.js` — Next.js config with static export
  - `electron-builder.yml` — Full installer configuration

### 2. Package Name Wrong
- **Doc says**: `@webpilot/electron`
- **Reality**: `@webpilot/onboarding`

### 3. Package Version Wrong
- **Doc says**: `0.0.1`
- **Reality**: `0.3.0` (with commit history showing iterative development)

### 4. Status Dashboard Partially Implemented (Not Just "Planned")
- **Doc says**: Status dashboard is a planned feature
- **Reality**: Basic implementation exists:
  - Shows server status (Running/Offline/Starting)
  - Shows extension connection status
  - Shows extension file availability
  - Polls `/health` endpoint every 3 seconds
  - Missing: start/stop/restart controls (methods exist in preload but not wired to UI)
  - Missing: active MCP sessions display

### 5. Onboarding Wizard Partially Implemented (Not Just "Planned")
- **Doc says**: Onboarding wizard is a planned feature
- **Reality**: Skeleton exists with "Onboarding goes here" placeholder, plus server health checking and extension availability detection are working.

## Missing from Documentation

### 6. Preload IPC Bridge
- `preload.js` exposes methods: `getServerPort()`, `isExtensionAvailable()`, `installService()`, `uninstallService()`, `getServiceStatus()`
- Not documented.

### 7. Server Launching
- Electron main process spawns the server as a detached child process on startup
- Not documented (contradicts old claim of "does NOT run the MCP server" — it launches it).

### 8. Build Scripts
- Full build pipeline exists: `dev`, `build:next`, `dist`, `dist:win`, `dist:mac`, `dist:linux`
- Not documented.

## Not Yet Implemented (Doc Claims as Planned — Confirmed Missing)

### 9. Configuration Management UI
- No UI for viewing/updating server port, API key, or network mode toggle
- Only `getServerPort()` available in preload, not used in UI

### 10. API Key Regeneration
- No implementation exists

## Verified Correct

- Uses Next.js inside Electron (Next.js 15.0.0, React 19.0.0)
- Installer formats: NSIS (Windows), DMG (macOS), AppImage (Linux)
- Server binary and extension bundled via extraResources
- Purpose: graphical interface for setup/management (though it does also launch the server)
