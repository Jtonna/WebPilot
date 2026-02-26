# Electron App (Phase 2)

Next.js Electron application for installer onboarding and MCP server service management.

## Purpose

The Electron app provides a graphical interface for setting up and managing WebPilot. On startup, the Electron main process also launches the MCP server as a detached child process (see [Server Launching](#server-launching) below). The Electron app additionally serves as a control panel for service registration and status monitoring.

## Features

### Status Dashboard (Partially Implemented)

The status dashboard has a basic working implementation in `app/page.js`:

**Implemented:**
- Shows server status (Running/Offline/Starting...) with color-coded indicators
- Shows extension connection status via the `/health` endpoint response
- Checks extension file availability by looking for `manifest.json`
- Displays the extension file path
- Polls the `/health` endpoint every 3 seconds

**Not yet implemented:**
- Start/stop/restart controls for the running server (note: preload exposes `installService()` and `uninstallService()` for auto-start registration, but these are not start/stop controls and are not wired to the UI)
- Active MCP sessions display

### Onboarding Wizard (Placeholder Only)

The onboarding wizard currently exists only as a placeholder string (`"Onboarding goes here"` in `page.js`). No step-by-step wizard logic exists yet.

**Planned (not yet implemented):**
- Guide users through Chrome extension sideloading (enable Developer Mode, Load unpacked, select extension folder)
- Display the connection string for pasting into the extension popup
- Show the MCP config snippet for adding to Claude Code or other MCP clients
- Verify setup: check that the server is running, extension is connected, and end-to-end communication works

### Configuration Management (Not Yet Implemented)

- View and update the server port and API key
- Regenerate the API key
- Toggle network mode (localhost vs. LAN access)

Note: `getServerPort()` is available in the preload bridge and used by the health check, but no configuration editing UI exists. API key regeneration has no implementation.

## Architecture

The app is built with Next.js (`^15.0.0`, React `^19.0.0`) inside Electron `33.4.11`, producing platform-specific installers:

| Platform | Installer Format |
|----------|-----------------|
| Windows  | NSIS `.exe` (non-oneClick, per-user install) |
| macOS    | `.dmg` |
| Linux    | AppImage |

The installer bundles both the compiled MCP server binary and the unpacked extension files via `extraResources` in `electron-builder.yml`. These are placed in the app's `resources/` subdirectory within the installation directory (e.g., `resources/server/` and `resources/chrome-extension/`). No service registration occurs during installation; the server is launched by the Electron main process each time the app starts (see [Server Launching](#server-launching) below).

### Server Launching

The Electron main process spawns the server binary as a detached child process on startup (`main.js`). It uses `detached: true`, `windowsHide: true`, `stdio: 'ignore'` with `child.unref()` so the server outlives the Electron window. If the server binary is not found, it gracefully skips the launch.

### Preload IPC Bridge

`electron/preload.js` exposes 7 methods to the renderer via `contextBridge.exposeInMainWorld('webpilot', ...)`:

| Method | Description |
|--------|-------------|
| `getServerPort()` | Reads port from `server.port` file in data dir |
| `getDataDir()` | Returns the data directory path |
| `getExtensionPath()` | Returns the extension directory path |
| `isExtensionAvailable()` | Checks if `manifest.json` exists in extension dir |
| `installService()` | Runs server binary with `--install` flag |
| `uninstallService()` | Runs server binary with `--uninstall` flag |
| `getServiceStatus()` | Runs server binary with `--status` flag |

Paths are passed from the main process to the preload script via `webPreferences.additionalArguments`, not via standard IPC channels.

### Security Note

`electron/main.js` sets `sandbox: false` in `webPreferences`. This is required because the preload script directly uses Node.js APIs (`fs`, `child_process`) rather than routing through IPC handlers in the main process. This is a pragmatic choice for the current stage but means the renderer has broader system access than a sandboxed configuration would allow.

### Build Scripts

Full build pipeline in `package.json`:

| Script | Description |
|--------|-------------|
| `dev` | Runs Next.js dev server and Electron concurrently (using `concurrently` and `wait-on`) |
| `build:next` | Static Next.js export |
| `start` | Launches Electron directly |
| `dist` | electron-builder (no publish) |
| `dist:win` | Windows build (runs `build:next` first) |
| `dist:mac` | macOS build (runs `build:next` first) |
| `dist:linux` | Linux build (runs `build:next` first) |

Next.js is configured with static export and `assetPrefix: './'` for Electron `file://` compatibility (`next.config.js`).

Electron-builder output directory is `../../dist`, placing built installers in the monorepo root `dist/` directory rather than within the electron package.

## Current Status

The package (`@webpilot/onboarding`, version `0.3.0`) contains a working foundation:

```
packages/electron/
  package.json          # Name: @webpilot/onboarding, version 0.3.0
  app/layout.js         # Next.js layout with metadata
  app/page.js           # Status dashboard with health polling
  electron/main.js      # Electron main process with server launching
  electron/preload.js   # Preload script with IPC bridge (7 methods)
  next.config.js        # Static export config with file:// compatibility
  electron-builder.yml  # Full installer configuration
```

The status dashboard is partially functional (health polling and status display work). The onboarding wizard is a placeholder only. Configuration management and API key regeneration are not yet implemented. The MCP server and Chrome extension (Phase 1) are functional independently.
