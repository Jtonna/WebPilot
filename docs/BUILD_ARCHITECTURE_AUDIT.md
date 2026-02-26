# BUILD_ARCHITECTURE.md — Audit

## Inaccuracies

### 1. Service Registration Claimed as "Stubs" — Actually Fully Implemented
- **Doc says**: "Service registration is currently stubbed in cli.js. It is not yet implemented."
- **Reality**: Fully implemented across all 3 platforms:
  - Windows: Registry Run key (HKCU) in `service/windows.js`
  - macOS: launchd plist in `service/macos.js`
  - Linux: systemd user service in `service/linux.js`
- All have working `install()`, `uninstall()`, and `status()` methods.
- **Evidence**: `cli.js` lines 72-91 call `require('./src/service')` which delegates to `service/index.js`, routing by `process.platform` to the platform-specific module.

### 2. Windows Service Mechanism Wrong
- **Doc says**: "Windows: Task Scheduler | Planned"
- **Reality**: Uses Registry Run key (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`), not Task Scheduler. Already implemented in `service/windows.js` line 14.

### 3. pkg Targets Config Misrepresented
- **Doc says**: pkg config in package.json contains a `targets` array with `node18-win-x64`, etc.
- **Reality**: The `pkg` section in `packages/server-for-chrome-extension/package.json` only has `outputPath` and `assets`. Targets are specified as CLI flags in the per-platform npm scripts (`build:win`, `build:mac`, `build:linux`). The `build` script itself errors with "Use build:win, build:mac, or build:linux".

### 4. CLI Flags Incomplete
- **Doc lists**: `--install`, `--uninstall`, `--status`, `--help`, `--version`, `--network`
- **Missing**: `--stop` (kills running server by PID file) and `--foreground` (runs server in this process rather than spawning a detached daemon)
- **Evidence**: `cli.js` lines 11-21 define all 8 flags via `parseArgs`. Both `--stop` and `--foreground` appear in the `--help` output text (lines 38-56).

### 5. Deployment Paths Fundamentally Wrong
- **Doc says**: Electron app copies server binary and extension files from bundled resources to `%LOCALAPPDATA%\WebPilot\` on launch, then the server runs from that AppData location.
- **Reality**: No copying occurs at all. In production:
  - Server binary runs directly from `process.resourcesPath/server/` (i.e., inside the Electron install directory).
  - Extension files stay at `process.resourcesPath/chrome-extension/`.
  - Data directory is `<installDir>/data/` (sibling to `resources/`), computed via `path.resolve(path.dirname(process.execPath), '..', '..', 'data')` in `paths.js` lines 28-33.
- The `%LOCALAPPDATA%\WebPilot\` path is only used in **dev mode** (when `app.isPackaged` is false / `process.pkg` is not set).
- **Evidence**: `electron/main.js` lines 8-35, `service/paths.js` lines 27-44.

### 6. Extension Directory Name Wrong
- **Doc says**: `chrome extension/unpacked-extension/`
- **Reality**: `electron-builder.yml` line 18 shows `to: chrome-extension`. In production, the path is `process.resourcesPath/chrome-extension/`, not `chrome extension/unpacked-extension/`.
- The sideloading paths in the doc's "Extension Sideloading" section are all wrong for production builds.

### 7. Root npm Scripts Outdated
- **Doc shows**: `build` (mapping to server build), `build:electron` and `build:all` (marked "to be added"), plus a `scripts` JSON block with `start` and `build`.
- **Reality**: Root `package.json` has `dist:win`, `dist:mac`, `dist:linux` which each chain the server build and Electron build (e.g., `npm run build:win --workspace=packages/server-for-chrome-extension && npm run dist:win --workspace=packages/electron`). There is no `build` script in root. The `start` script still exists.

### 8. Default Server Behavior Described Backwards
- **Doc says**: "Running with no flags starts the server in the foreground."
- **Reality**: Running with no flags starts the server as a **background daemon** (spawns a detached child with `WEBPILOT_FOREGROUND=1` and exits). The `--foreground` flag is needed to run in the foreground. See `cli.js` lines 190-278 and help text line 52: "Running with no options starts the server as a background daemon."

### 9. API Key Generation Claim is Wrong
- **Doc says**: Electron app "Generates a secure API key and persists it to the config directory (if one does not already exist)."
- **Reality**: `electron/main.js` only calls `ensureDataDir()` (creates the data directory) and `startServer()` (spawns the server binary). There is no API key generation logic in the Electron app. The server reads `apiKey` from `<dataDir>/config/server.json` via `getApiKey()` in `paths.js`, falling back to the hardcoded default `'dev-123-test'` if no config file exists.

## Missing from Documentation

### 10. Auto-Registration on First Run
- Server automatically registers itself as a background service on first startup via `autoRegister()` in `cli.js` lines 167-183. This function checks `service.status().registered` and calls `service.install()` if not registered. Called from both foreground and background code paths.

### 11. Health Check Polling
- After spawning the background daemon, CLI polls `http://127.0.0.1:<port>/health` to verify startup: 6 attempts at 500ms intervals (up to 3 seconds). See `cli.js` lines 239-278.

### 12. Config File Structure
- Config stored at `<dataDir>/config/server.json` with `apiKey` and `port` fields. Falls back to env vars `API_KEY`/`PORT`, then to defaults (`'dev-123-test'` and `3456`). See `paths.js` lines 79-100.

### 13. Daemon Logging System
- `SizeManagedWriter` in `service/logger.js`: 1 GB max file size, rotation discards oldest 25%, strips ANSI escape codes from output. Log file is truncated fresh on each daemon start (line 12). Logging is set up by intercepting `process.stdout.write` and `process.stderr.write`.

### 14. PID/Port File Management
- Server writes `server.pid` and `server.port` to the data directory. CLI checks these for already-running detection (`isAlreadyRunning()` in `cli.js` lines 150-164), cleans up stale files when the referenced process is dead, and `--stop` removes them after killing the process.

### 15. Electron App Does Not Deploy Files
- The doc's "What the App Does on Launch" section describes a deployment/copy step that does not exist. The Electron app on launch: (1) ensures the data directory exists, (2) spawns the server binary from its bundled location, and (3) opens the UI window. That is all. See `electron/main.js` lines 89-97.

## Verified By

**Date**: 2026-02-25

**Verification method**: Every claim checked against source files in `packages/server-for-chrome-extension/` (cli.js, index.js, package.json, src/service/*.js) and `packages/electron/` (electron/main.js, package.json, electron-builder.yml), plus root package.json.

**Changes from original audit**:
- Claims 1-4, 6 confirmed accurate; added specific line-number evidence.
- Claim 5 expanded with precise paths and dev-vs-production distinction.
- Claim 7 corrected to note `build` script does not exist in root (not just renamed).
- Added new claim 8: doc describes default no-flag behavior backwards (foreground vs background).
- Added new claim 9: API key generation claim in doc is fabricated; no such logic exists.
- Added new claim 15: explicit note that the "deployment/copy on launch" narrative is fictional.
- Renumbered "Missing from Documentation" items (10-15) for clarity.
- Original claims 8-12 confirmed accurate with added evidence.
