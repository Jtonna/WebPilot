# DEPLOYMENT.md Audit

Audit of `docs-old/DEPLOYMENT.md` against the actual codebase at `packages/`.

## Inaccuracies

### 1. macOS packaged data directory path is wrong

**Doc claim (line 119):**
> Packaged macOS: `<app-bundle>/../data/`

**Actual behavior:**

In `packages/electron/electron/main.js` line 27:
```js
return path.join(path.dirname(process.resourcesPath), 'data');
```
`process.resourcesPath` on macOS is `/Applications/WebPilot.app/Contents/Resources`, so `path.dirname()` yields `/Applications/WebPilot.app/Contents`, making the data dir `/Applications/WebPilot.app/Contents/data/`.

In `packages/server-for-chrome-extension/src/service/paths.js` line 33:
```js
return path.resolve(path.dirname(process.execPath), '..', '..', 'data');
```
The server binary lives at `.../Contents/Resources/server/webpilot-server-for-chrome-extension`, so going up two levels yields `.../Contents/data`.

Both resolve to `/Applications/WebPilot.app/Contents/data/`, not `<app-bundle>/../data/` (which would be `/Applications/data/`).

**Fix:** Change the macOS packaged row to `<app-bundle>/Contents/data/` or `<install-dir>/Contents/data/`.

---

### 2. Auto-start section omits Linux

**Doc claim (lines 126-128):**
> - **Windows**: Adds a Registry Run key
> - **macOS**: Creates a launchd plist

**Actual behavior:**

`packages/server-for-chrome-extension/src/service/linux.js` implements full auto-start registration via a systemd user service (`webpilot-server.service` in `~/.config/systemd/user/`). The service index (`src/service/index.js`) dispatches to `linux.js` on the `linux` platform. Linux auto-start is fully implemented, not just Windows and macOS.

**Fix:** Add a bullet: `**Linux**: Creates a systemd user service unit`.

---

## Verified Correct

### extraResources config (lines 54-61)
The YAML block matches `packages/electron/electron-builder.yml` exactly:
- `from: ../server-for-chrome-extension/dist` to `server`
- `from: ../chrome-extension-unpacked` to `chrome-extension`

### Server binary compilation (lines 67-76)
The `pkg` commands match the `build:win`, `build:mac`, `build:linux` scripts in `packages/server-for-chrome-extension/package.json`. The `@yao-pkg/pkg` dependency is confirmed in devDependencies. The `"bin": "cli.js"`, `"assets"`, and `"outputPath"` in the `pkg` config all match.

### NSIS installer is per-user, no admin required (line 82)
`packages/electron/electron-builder.yml` confirms `perMachine: false` in the nsis config.

### Windows install path (lines 84-91)
NSIS with `perMachine: false` installs to `%LOCALAPPDATA%\Programs\WebPilot\`. The resources subdirectories (`chrome-extension`, `server`) are correct per the extraResources config.

### macOS install target is DMG (lines 95-99)
`electron-builder.yml` confirms `target: dmg` for mac. The extension and server paths inside `Contents/Resources/` are correct per extraResources.

### Linux install target is AppImage (lines 103-107)
`electron-builder.yml` confirms `target: AppImage` for linux.

### Path resolution via process.resourcesPath (line 109)
`packages/electron/electron/main.js` uses `process.resourcesPath` in `getServerBinaryPath()` (line 13) and `getExtensionPath()` (line 34).

### Windows data dir in dev mode (line 120)
`packages/electron/electron/main.js` line 19 and `packages/server-for-chrome-extension/src/service/paths.js` line 38 both use `process.env.LOCALAPPDATA` + `'WebPilot'`. Correct.

### macOS data dir in dev mode (line 120)
Both `main.js` line 21 and `paths.js` line 40 use `~/Library/Application Support/WebPilot/`. Correct.

### Linux data dir in dev mode (line 120)
Both `main.js` line 23 and `paths.js` line 42 use `$XDG_CONFIG_HOME/WebPilot/` with fallback to `~/.config/WebPilot/`. Correct.

### Windows packaged data dir (line 119)
Both `main.js` (`path.dirname(process.resourcesPath)` + `data`) and `paths.js` (two levels up from exe + `data`) resolve to `<install-dir>\data\`. Correct.

### Windows auto-start uses Registry Run key (line 126)
`packages/server-for-chrome-extension/src/service/windows.js` line 14 confirms `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Correct.

### macOS auto-start creates launchd plist (line 127)
`packages/server-for-chrome-extension/src/service/macos.js` creates a plist at `~/Library/LaunchAgents/com.webpilot.server.plist`. Correct.

### Extension communicates via WebSocket (line 133)
`packages/chrome-extension-unpacked/background.js` uses `new WebSocket(wsUrl.toString())` to connect to the server. Authenticates with an API key passed as a query parameter. Correct.

### Electron UI polls /health every 3 seconds (line 135)
`packages/electron/app/page.js` line 44: `setInterval(checkHealth, 3000)` polling `http://localhost:${port}/health`. Correct.

### Onboarding UI is a placeholder (line 146)
`packages/electron/app/page.js` line 67: `Onboarding goes here`. Correct.

### Dashboard shows MCP Server status, extension connection, extension files, extension path (lines 139-144)
`packages/electron/app/page.js` renders all four: server status (Running/Starting.../Offline), Chrome Extension (Connected/Not connected), Extension files (Available/Not found), Extension path. Correct.

### Extension version is 0.2.0, out of sync with 0.3.0 (lines 156-161)
`packages/chrome-extension-unpacked/manifest.json` has `"version": "0.2.0"`. Root `package.json`, `packages/electron/package.json`, and `packages/server-for-chrome-extension/package.json` all have `"version": "0.3.0"`. Correct.

### release.sh does not update manifest.json (line 161)
`release.sh` lines 45-53 only update `package.json`, `packages/server-for-chrome-extension/package.json`, and `packages/electron/package.json`. It does not touch `manifest.json`. Correct.

### Extension uses chrome.debugger (restricted permission) (lines 41, 48)
`packages/chrome-extension-unpacked/manifest.json` includes `"debugger"` in permissions. Correct.

### Key Files table (lines 194-202)
All file paths in the table exist and serve the described purpose. Verified against the filesystem.

### Server auto-registers on first launch (line 124)
`packages/server-for-chrome-extension/cli.js` lines 167-183: `autoRegister()` checks `service.status().registered` and calls `service.install()` if not registered. This runs in both background and foreground modes. Correct.
