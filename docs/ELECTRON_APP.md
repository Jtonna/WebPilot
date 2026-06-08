# Electron App

Thin Electron shell that ships the MCP server binary + Chrome extension as `extraResources`, spawns the server as a managed child on launch, and renders the server's own web UI (`/ui/`) inside a `BrowserWindow`. Lives in `packages/electron/`; main entry is `packages/electron/electron/main.js`.

> The management UI for WebPilot lives **inside the server** at `http://localhost:<port>/ui/` (served by the server pkg binary, see `BUILD_ARCHITECTURE.md`). The Electron app exists to install the binary + extension files onto disk, bootstrap the server process, and host its UI in a desktop window with a tray icon. It is not where the management UI is implemented.

## Purpose

The Electron app exists to:

1. Ship the compiled MCP server binary and the Chrome extension files as `extraResources`.
2. Spawn the server binary as a managed child process on app start (`startServer()` in `electron/main.js`), and tear it down on tray Exit.
3. Show a splash window, then swap to the server-hosted `/ui/` once `/health` responds.
4. Install a tray icon (single-instance, hide-to-tray on close) so the daemon keeps running in the background.

The server-hosted web UI is the canonical surface for pairing, profile management, agent administration, and notification preferences. The Electron shell points its window at that UI; it does not implement its own management surface.

## Features

### Window lifecycle (splash -> dashboard)

`createWindow()` opens a `BrowserWindow` (1200x800, dark background, no menu bar, app icon) and loads `electron/splash.html` immediately. In parallel, `waitForServerHealthThenSwap()` polls `server.port` from the data dir and probes `http://127.0.0.1:<port>/health` every 500ms for up to 30 seconds. On success it `loadURL`s `http://127.0.0.1:<port>/ui/`; on timeout it renders an inline error page asking the user to quit from the tray and relaunch.

External `http(s)` links opened from the dashboard are routed to the user's default browser via `shell.openExternal` (`setWindowOpenHandler`), not navigated inside the window.

### Tray + single-instance

A single-instance lock (`app.requestSingleInstanceLock()`) ensures a second launch focuses the running window instead of spawning a second server + tray. The tray icon is built from a multi-resolution Windows `.ico` (or PNG on macOS/Linux) and exposes:

- **Open WebPilot** — restores/shows the window.
- **Exit** — sets `app.isQuitting`, kills the server child (plus PID-file fallback), and quits.

Closing the window does **not** quit the app — `win.on('close')` preempts the default and hides to tray. Only tray Exit (or `before-quit`) actually quits.

### Server lifecycle

`startServer()` resolves the server binary path (dev: monorepo `server-for-chrome-extension/dist/`; packaged: `<resourcesPath>/server/`) and `spawn`s it with:

- `windowsHide: true`, `stdio: 'ignore'`.
- `env.WEBPILOT_NO_OPEN = '1'` — suppresses the server's default-browser pop; the dashboard renders inside our window instead.
- `env.WEBPILOT_DATA_DIR = app.getPath('userData')` — pins the daemon's data dir to Electron's `userData` path so the shell and the daemon agree.

The child handle is retained (no `detached`/`unref`). `killServer()` runs from tray Exit and `before-quit`, and tries **both** the spawned handle and the PID written to `<dataDir>/server.pid` — the PID-file fallback covers the case where the Electron app attached to an already-running daemon rather than spawning it itself.

If the server binary is missing, `startServer()` logs and skips; the window will then fall through to the 30-second timeout and show its error page.

### Single user data directory

User data (DB, paired-key state, formatter config, `server.pid`, `server.port`) lives at `app.getPath('userData')`:

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\WebPilot` |
| macOS    | `~/Library/Application Support/WebPilot` |
| Linux    | `~/.config/WebPilot` (or `$XDG_CONFIG_HOME/WebPilot`) |

This path sits **outside** the install directory that electron-builder wipes on upgrade, so user data survives version bumps. Dev and prod resolve to the same path so the upgrade story can be tested locally. The daemon receives the path via `WEBPILOT_DATA_DIR`.

### Status & onboarding

There is no Electron-side wizard or status pane in the active runtime — the window is pointed at the server's `/ui/`, which owns extension sideloading guidance, profile setup, pairing, configuration, and health surfacing. The earlier Next.js `app/page.js` status pane and the `electron/preload.js` IPC bridge have been removed; `BrowserWindow` is created with no `preload`, `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.

## Architecture

The app is a thin Electron `33.4.11` shell (no Next.js / React bundle — the renderer loads a static splash, then `loadURL`s the server-hosted `/ui/`), producing platform-specific installers:

| Platform | Installer Format |
|----------|-----------------|
| Windows  | NSIS `.exe` (non-oneClick, per-user install) |
| macOS    | `.dmg` |
| Linux    | AppImage |

The installer bundles the compiled MCP server binary, the unpacked extension, and the `assets/` directory via `extraResources` in `electron-builder.yml`. These land at `<resourcesPath>/server/`, `<resourcesPath>/chrome-extension/`, and `<resourcesPath>/assets/` respectively. No service registration occurs during installation; the server is launched by the Electron main process on each app start (see [Server lifecycle](#server-lifecycle)).

### Assets / icons

`assets/` (copied to `<resourcesPath>/assets/` in packaged builds) holds:

| File | Use |
|------|-----|
| `icon.ico` | Multi-resolution Windows app icon (`BrowserWindow.icon` on win32, also `win.icon` in `electron-builder.yml`). |
| `logo.png` | Window icon on macOS / Linux. |
| `tray-icon.ico` | Multi-resolution Windows tray icon — required because PNGs passed to `Tray()` on Windows get composited onto a white square at non-100% DPI scales. |
| `tray-icon.png` | RGBA tray icon for macOS / Linux. |

Icons are regenerated via `npm run generate:icons` (see `scripts/generate-icons.js`).

### Security posture

The active `BrowserWindow` runs with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and no `preload`. The dashboard is served by the local daemon over `http://127.0.0.1:<port>/ui/`; the renderer has no Node API access.

### Build scripts

From `packages/electron/package.json`:

| Script | Description |
|--------|-------------|
| `dev` | Launches Electron against the local main process. Pair with `npm run dev` at the repo root (or `npm run dev:server`) so the MCP server is up to serve `/ui/`. |
| `start` | Launches Electron directly. |
| `dist` | `electron-builder --publish never`. |
| `dist:win` | Windows installer. |
| `dist:mac` | macOS installer. |
| `dist:linux` | Linux installer. |
| `generate:icons` | Regenerates multi-resolution `.ico` + PNG icons under `assets/`. |

There is no Next.js build step inside this package — the renderer's only HTML is `electron/splash.html`, and the dashboard is served by the MCP server at `/ui/`.

Electron-builder output directory is `../../dist`, placing built installers in the monorepo root `dist/` directory rather than inside the electron package.

## Current Status

The package is `@webpilot/onboarding` (see `packages/electron/package.json` for the current version, which tracks the rest of the monorepo).

```
packages/electron/
  package.json            # Name: @webpilot/onboarding
  electron/
    main.js               # Splash + tray + server lifecycle + window swap to /ui/
    splash.html           # Static splash shown before /ui/ is reachable
    splash-logo.png       # Splash artwork
  assets/                 # icon.ico, logo.png, tray-icon.ico, tray-icon.png
  scripts/generate-icons.js
  electron-builder.yml    # Installer + extraResources config
```

The Electron shell is intentionally thin: it boots the daemon, hosts the daemon's `/ui/`, and provides a tray. Configuration management, API key regeneration, pairing, and agent administration are all handled inside the server-hosted UI — not in this app.
