# Electron App

Minimal Next.js + Electron wrapper that ships the MCP server binary, launches it as a detached child on app start, and renders a basic status pane.

> The primary management UI for WebPilot now lives **inside the server** at `http://localhost:3456/ui/` (served by the server pkg binary, see `BUILD_ARCHITECTURE.md`). The Electron app is intentionally minimal: it exists to install the binary + extension files onto disk and to bootstrap the server process; it is not where users configure profiles, approve pairings, or manage agents.

## Purpose

The Electron app exists to:

1. Ship the compiled MCP server binary and the Chrome extension files as `extraResources`.
2. Spawn the server binary as a detached child process on app start (`startServer()` in `electron/main.js`).
3. Render a minimal status pane (server up/down, extension files present, polled via `/health`) so users have a visible sign the daemon is running.

The server-hosted web UI is the canonical surface for pairing, profile management, agent administration, and notification preferences. Users open it by visiting `http://localhost:3456/ui/` (the server also auto-opens it on `--foreground` start via `service/open-browser.js`).

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

### Onboarding (intentionally minimal here)

The Electron page renders only the placeholder string `"Onboarding goes here"`. There is no Electron-side wizard. The server-hosted web UI at `/ui/` covers extension sideloading guidance, profile setup, pairing, and configuration. The Electron app is just the installer + binary launcher.

### Configuration Management

Configuration (port, network mode, notifications, paired agents) is managed in the server-hosted web UI, not in this Electron app. `getServerPort()` is exposed via the preload bridge solely so the status pane can hit `/health`.

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

The package is `@webpilot/onboarding`, version `1.0.0` (unified with the rest of the monorepo on the QOL-Features branch).

```
packages/electron/
  package.json          # Name: @webpilot/onboarding, version 1.0.0
  app/layout.js         # Next.js layout with metadata
  app/page.js           # Status pane (server up/down, extension files present)
  electron/main.js      # Electron main process; spawns the server binary on start
  electron/preload.js   # Preload script with IPC bridge (7 methods)
  next.config.js        # Static export config with file:// compatibility
  electron-builder.yml  # Full installer configuration
```

The Electron status pane is intentionally simple — the rich management UI lives in the server's `/ui/` surface. The "Onboarding goes here" placeholder string in `page.js` is a known gap; in practice users open the server-hosted UI for setup. Configuration management and API key regeneration are not implemented in this app; both are handled by the web UI.
