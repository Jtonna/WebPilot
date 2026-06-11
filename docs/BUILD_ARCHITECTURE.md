# Build Architecture

## Overview

WebPilot produces a single distributable artifact: an Electron application packaged with NSIS (on Windows). The Electron app bundles the compiled MCP server binary and the unpacked Chrome extension as extra resources. The server binary and extension files run directly from their bundled locations inside the Electron app's `resources/` directory -- no file copying to app data occurs. The Electron app itself is a minimal status pane that polls `/health`; the canonical management UI is the server-hosted web UI at `/ui/`.

## Build Pipeline

The build is a two-step process:

1. **Build the server binary** -- `@yao-pkg/pkg` compiles the MCP server into a standalone executable with Node.js baked in.
2. **Build the Electron app** -- `electron-builder` packages the Electron app, bundling the server binary and extension as `extraResources`, and produces an NSIS installer on Windows.

The NSIS installer is not a separate build step. It is the output format configured in `electron-builder`. The installer places the Electron app into the user's programs directory; the server and extension run directly from the bundled `resources/` directory within the install location.

## pkg Configuration

Defined in `packages/server-for-chrome-extension/package.json`:

```json
{
  "pkg": {
    "outputPath": "dist",
    "assets": [
      "src/**/*.js",
      "src/**/*.sql",
      "index.js",
      "../server-web-ui/out/**/*"
    ]
  }
}
```

`src/**/*.sql` ships the SQL migration files for `better-sqlite3` into the snapshot. `better-sqlite3` itself ships a native binding (`build/Release/better_sqlite3.node`) that **cannot** be baked into the pkg snapshot — see the `copy-native-deps.js` step below.

The `../server-web-ui/out/**/*` glob bundles the Next.js static export into the pkg snapshot so the binary ships with the web UI baked in. The platform-specific build scripts (`build:win`, `build:mac`, `build:linux`) run `build:web-ui` first (which executes `next build` in `packages/server-web-ui`) before invoking `pkg`. At runtime the server resolves the snapshot path and serves `/ui/...` via `fs.readFileSync` (express.static is bypassed so the pkg-patched `fs` works correctly — see QOL fix F8).

### accessibility-tree-formatters/ Package

`accessibility-tree-formatters/` lives at the repo root (a sibling of `packages/`). Each formatter occupies its own subdirectory:

```
accessibility-tree-formatters/
  manifest.json        Top-level "download index" — entry points + files[] for the auto-updater
  default.js           Fallback formatter (always loaded)
  discord/
    manifest.json      Per-formatter manifest (name, version, match, description, workflows[])
    discord.js         Formatter entry
    workflows.js       Workflow implementations (optional)
  threads/
    manifest.json
    router.js          Multi-page router → page-specific sub-formatters
    ...
  zillow/
    manifest.json
    router.js
    ...
```

The **per-formatter `manifest.json`** is the source of truth for that formatter's metadata — see [`accessibility-tree-formatters/MANIFEST_SCHEMA.md`](../accessibility-tree-formatters/MANIFEST_SCHEMA.md). The top-level `manifest.json` remains as a slim routing index (`platforms[name] = { match, entry }`) plus the `files[]` array the auto-updater fetches.

Formatters are **not bundled** into the server binary. Instead, the server downloads them from GitHub on first run and stores them in `<dataDir>/formatters/`. The auto-updater checks for new versions on startup and every hour.

Three server modules handle formatter lifecycle:

- **`formatter-manager.js`** -- loads formatters from `<dataDir>/formatters/`, parses each per-formatter manifest, cross-checks sibling `workflows.js` against the manifest's declared workflow names, and runs the appropriate formatter for each accessibility-tree request
- **`formatter-updater.js`** -- auto-updates formatters from GitHub by comparing the local `manifest.json` version against the remote version on the `main` branch
- **`formatter-logs.js`** -- in-memory ring buffer (50 entries per formatter, 7-day TTL on disk) + health tracking. Powers `/api/ui/formatters` and the Web UI Formatters tab

Targets are specified as CLI flags in the per-platform npm scripts, not in the `pkg` config. The `build` script itself errors with "Use build:win, build:mac, or build:linux". Each per-platform script runs `build:web-ui` first to refresh the static export:

```bash
cd packages/server-for-chrome-extension
npm run build:win    # build:web-ui && pkg . --target node22-win-x64   --out-path dist && node scripts/copy-native-deps.js
npm run build:mac    # build:web-ui && pkg . --target node22-macos-x64 --out-path dist && node scripts/copy-native-deps.js
npm run build:linux  # build:web-ui && pkg . --target node22-linux-x64 --out-path dist && node scripts/copy-native-deps.js
```

### `copy-native-deps.js`

`packages/server-for-chrome-extension/scripts/copy-native-deps.js` runs as the final stage of every platform build. `@yao-pkg/pkg` cannot embed native `.node` bindings inside the snapshot, so the script locates the hoisted `node_modules/better-sqlite3/build/Release/better_sqlite3.node` (checking the monorepo root first, then the package-local `node_modules/` as a fallback) and copies it into `dist/better_sqlite3.node` next to the built binary. The runtime shim in `src/db/connection.js` then points better-sqlite3 at that file via `BETTER_SQLITE3_BINDING_PATH`. The script exits non-zero on failure so the parent build halts.

Output goes to `packages/server-for-chrome-extension/dist/`:

| Platform | Binary |
|----------|--------|
| Windows  | `webpilot-server-for-chrome-extension.exe` |
| macOS    | `webpilot-server-for-chrome-extension` (x64) |
| Linux    | `webpilot-server-for-chrome-extension` (x64) |

## Electron Build

The Electron app is built with `electron-builder`. Configuration lives in `packages/electron/electron-builder.yml`. Key shape:

```yaml
appId: com.webpilot.app
productName: WebPilot
npmRebuild: false
directories:
  output: ../../dist
files:
  - electron/**/*
  - package.json
extraResources:
  - from: ../server-for-chrome-extension/dist   # → resources/server/
    to: server
  - from: ../chrome-extension-unpacked          # → resources/chrome-extension/
    to: chrome-extension
  - from: assets                                 # → resources/assets/
    to: assets
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: false
  perMachine: false
  include: build/installer.nsh
```

- **Target**: NSIS installer (Windows), `.dmg` (macOS), AppImage (Linux)
- **Install location**: `%LOCALAPPDATA%\Programs\WebPilot\` (Windows default for per-user NSIS installs; `perMachine: false`)
- **extraResources**: The server binary, the unpacked Chrome extension, and the icon assets ship inside the Electron app's `resources/` folder but are not part of the Asar archive.
- **NSIS hook**: `build/installer.nsh` plugs in `customCheckAppRunning` and `customUnInstall` macros — see below.

### `generate-icons.js`

`packages/electron/scripts/generate-icons.js` (run manually via `npm run generate:icons` in the Electron workspace) regenerates icon assets from `packages/electron/assets/logo.png` using `sharp`. Outputs:

| Output | Sizes | Purpose |
|---|---|---|
| `packages/electron/assets/icon.ico` | 16/24/32/48/64/128/256 | Windows app icon (referenced by `electron-builder.yml` → `win.icon`) |
| `packages/electron/assets/tray-icon.ico` | 16/20/24/32/40/48 | Windows tray icon — `Tray()` on Windows needs an `.ico`, passing a PNG composites on a white square |
| `packages/electron/assets/tray-icon.png` | 32×32 | Tray icon fallback for macOS / Linux |
| `packages/server-web-ui/app/icon.png` | 512×512 | Next.js auto-discovered favicon for `/ui/` |
| `packages/electron/electron/splash-logo.png` | 192×192 | Splash window logo |

The `.ico` files are written by hand — modern Windows accepts PNG-encoded payloads inside `.ico`, so each `ICONDIRENTRY` carries the raw PNG bytes at that size.

### `installer.nsh` macros

The default electron-builder NSIS uninstaller knows about `WebPilot.exe` but not the standalone daemon, leaves the HKCU Run key in place, and does not touch user data. `packages/electron/build/installer.nsh` overrides two hook points:

- **`customCheckAppRunning`** — runs at both install and uninstall time. `taskkill /F /IM "webpilot-server-for-chrome-extension.exe" /T` first (the daemon holds file handles on its own `.exe` inside the install dir, which otherwise aborts the uninstall), then `taskkill /F /IM "WebPilot.exe" /T`, then `Sleep 800` to let Windows release handles before file ops. Always runs for both upgrade and full-uninstall flows.
- **`customUnInstall`** — runs at the end of the uninstall section. Belt-and-suspenders kills anything still bound to port 3456 via PowerShell, removes the `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` entry under `WebPilotServer`, and wipes user data at `$APPDATA\WebPilot` and `$LOCALAPPDATA\WebPilot` (the latter for back-compat with pre-1.1.6 dev-mode writes).

The destructive parts of `customUnInstall` (autostart removal, user-data wipe) are guarded by `${ifNot} ${isUpdated}`. `${isUpdated}` is set by electron-builder's uninstaller template when this stub is being run as the preflight of an upgrade installer ("install new version on top of old"). On upgrades we must preserve the user's DB, paired-key state, and Run key — otherwise every version bump re-onboards the user. The `${else}` branch just prints "Upgrade in progress — preserving user data and autostart."

What gets bundled into the Electron app:

```
resources/
  server/
    webpilot-server-for-chrome-extension[.exe]    Compiled server binary
  chrome-extension/
    manifest.json
    background.js
    accessibility-storage.js
    handlers/
    icons/
    popup/
    utils/
```

The Electron app provides:

1. A minimal status pane (server up/down, extension files present), polled via `/health` every 3 seconds.
2. A placeholder for future onboarding — the canonical setup UI is the server-hosted web UI at `/ui/`, not the Electron window.

## What the App Does on Launch

When the Electron app starts, it performs these steps:

1. Ensures the data directory exists (creates it if necessary).
2. Spawns the server binary from its bundled location (`process.resourcesPath/server/`), passing `WEBPILOT_DATA_DIR=app.getPath('userData')` in the child env so the daemon writes to the same location the Electron shell reads from.
3. Opens the management UI window.

No file copying or deployment occurs. The server binary and extension files run directly from their bundled locations inside the Electron app's `resources/` directory. The data directory (DB, paired-key state, formatter config, PID/port files, logs) lives **outside** the install dir at Electron's `userData` path — see *Deployment Paths* below — so that user state survives the install-dir wipe that electron-builder performs on every version bump.

## Deployment Paths

### Electron App Install Location

| Platform | Install Path |
|----------|-------------|
| Windows  | `%LOCALAPPDATA%\Programs\WebPilot\` |
| macOS    | `/Applications/WebPilot.app/` |
| Linux    | AppImage (portable; runs from wherever the user places it) |

### Bundled Resources (inside install directory)

The server binary and extension files remain in the Electron app's `resources/` directory. They are not copied elsewhere. **User data does not live here** — it lives at Electron's `userData` path (see below).

```
<installDir>/
  resources/
    server/
      webpilot-server-for-chrome-extension[.exe]    Compiled server binary
      better_sqlite3.node                            Native sqlite binding (copied by copy-native-deps.js)
    chrome-extension/                                Unpacked Chrome extension files
      manifest.json
      background.js
      accessibility-storage.js
      handlers/
      icons/
      popup/
      utils/
    assets/                                          Icons used by tray + windows
```

### User Data Directory (outside install dir, survives upgrades)

User state lives at Electron's `userData` path. The Electron main process resolves this via `app.getPath('userData')`, and the standalone daemon receives the same value through the `WEBPILOT_DATA_DIR` environment variable when Electron spawns it. When the daemon is launched by the HKCU Run key autostart (no env var), `service/paths.js` hardcodes the same platform path so both processes land on the same directory.

| Platform | User-data path |
|---|---|
| Windows | `%APPDATA%\@webpilot\onboarding\` |
| macOS   | `~/Library/Application Support/WebPilot/` |
| Linux   | `$XDG_CONFIG_HOME/WebPilot/` (or `~/.config/WebPilot/`) |

The Windows path uses `@webpilot\onboarding` — not `WebPilot` — because `app.getName()` returns the `name` field from `packages/electron/package.json` (`@webpilot/onboarding`), which takes precedence over electron-builder's `productName` for the userData path. Do not change that `name` without also writing a migration: the autostart-launched daemon hardcodes this exact string in `service/paths.js`.

```
<userDataDir>/
  config/
    server.json                                    Port configuration (apiKey field is silently ignored — legacy)
  daemon.log                                       Daemon log output
  server.pid                                       PID of running daemon
  server.port                                      Port of running daemon
  logs/
    server.log                                     Server log output
    server-error.log                               Server error log output
```

The legacy `<installDir>\data\` location (pkg builds ≤ 1.1.5) and the dev-mode `%LOCALAPPDATA%\WebPilot\` location are both wiped by the NSIS uninstaller's `customUnInstall` macro on a clean uninstall but preserved on upgrades (guarded by `${isUpdated}`). Dev mode now aligns with prod — `app.isPackaged === false` still uses `app.getPath('userData')` so the upgrade path can be exercised locally.

The extension directory users point Chrome to is `<installDir>/resources/chrome-extension/`.

## CLI Flags

The server binary (`cli.js` / compiled binary) supports these flags:

| Flag | Description |
|------|-------------|
| `--install` | Register the server as a background service |
| `--uninstall` | Remove the background service registration |
| `--status` | Check whether the background service is running |
| `--stop` | Kill the running server by PID file |
| `--foreground` | Run the server in this process (not as a detached daemon) |
| `--help` | Show usage information |
| `--version` | Print version number |
| `--network` | Start in network mode (listen on `0.0.0.0` instead of `127.0.0.1`) |

Running with no flags starts the server as a **background daemon** (spawns a detached child process with `WEBPILOT_FOREGROUND=1` and exits). Use `--foreground` to run the server in the current process.

> **pkg-binary self-spawn gotcha:** Inside a pkg binary, `spawn(process.execPath, ['--foreground'])` fails because pkg treats the first argument as a module path (`Cannot find module 'C:\...\--foreground'`). The CLI works around this by passing the flag via the `WEBPILOT_FOREGROUND=1` environment variable to the spawned child and re-checking the env var in addition to the parsed CLI flag. Any external doc that walks through the build / daemon flow must follow the env-var convention.

## Service Registration

Service registration is fully implemented across all three platforms. The `cli.js` entry point calls `require('./src/service')` which delegates to `service/index.js`, routing by `process.platform` to the platform-specific module. Each module provides working `install()`, `uninstall()`, and `status()` methods.

| Platform | Mechanism | Implementation |
|----------|-----------|----------------|
| Windows  | Registry Run key (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) | `service/windows.js` |
| macOS    | launchd (LaunchAgent) | `service/macos.js` |
| Linux    | systemd (user service) | `service/linux.js` |

Behavior per platform:

- **Windows**: Writes a Registry Run key under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` to launch the binary at user login (no admin elevation required)
- **macOS**: Writes a LaunchAgent plist to `~/Library/LaunchAgents/`
- **Linux**: Writes a systemd user service to `~/.config/systemd/user/`

### Auto-Registration on First Run

The server automatically registers itself as a background service on first startup via `autoRegister()` in `cli.js`. This function checks `service.status().registered` and calls `service.install()` if not already registered. Auto-registration runs from both the foreground and background code paths.

## Server Runtime Behavior

### Health Check Polling

After spawning the background daemon, the CLI polls `http://127.0.0.1:<port>/health` to verify startup: 6 attempts at 500ms intervals (up to 3 seconds). If the health check fails after all attempts, the CLI reports a startup failure.

### Config File

Server configuration is stored at `<dataDir>/config/server.json`:

| Field | Env Var Fallback | Default |
|-------|-----------------|---------|
| `port` | `PORT` | `3456` |

The server reads from the config file first, then falls back to environment variables, then to the hardcoded defaults. See `paths.js` for the resolution logic. A legacy `apiKey` field is silently ignored — the shared transport key has been retired.

### Daemon Logging

The daemon uses `SizeManagedWriter` (implemented in `service/logger.js`) which manages log file output:

- Uses synchronous `fs.appendFileSync` for guaranteed flush (avoids buffering issues on Windows)
- Maximum file size: 1 GB
- Rotation: discards the oldest 25% of the file when the limit is reached
- Strips ANSI escape codes from output
- Log file is truncated fresh on each daemon start
- Logging is set up by intercepting `process.stdout.write` and `process.stderr.write`

### PID and Port File Management

The server writes `server.pid` and `server.port` to the data directory on startup. The CLI uses these files for:

- **Already-running detection**: `isAlreadyRunning()` checks if the PID in `server.pid` corresponds to a live process
- **Stale file cleanup**: If the referenced process is dead, the PID and port files are removed
- **`--stop` flag**: Kills the process by PID and removes both files

## Extension Sideloading

The Chrome extension cannot be distributed via the Chrome Web Store (it uses the `debugger` API for CDP access). Users must load it manually:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the extension directory bundled with the Electron app:
   - Windows: `%LOCALAPPDATA%\Programs\WebPilot\resources\chrome-extension\`
   - macOS: `/Applications/WebPilot.app/Contents/Resources/chrome-extension/`
   - Linux: `<install-path>/resources/chrome-extension/`

Chrome will show a "Developer mode extensions" warning on each browser launch. This is expected and cannot be suppressed for sideloaded extensions.

The extension files live inside the Electron app's install directory and must remain there. Uninstalling the Electron app removes the extension files.

## Root npm Scripts

Defined in the root `package.json`:

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | One-command dev mode — runs the MCP server and the Next.js dev server concurrently with hot reload. `/ui/*` requests are proxied from the MCP server to `http://localhost:3100`. |
| `dev:server` | `npm run dev:server` | Starts only the MCP server in dev mode (sets `WEBPILOT_DEV=1` and `--foreground`). |
| `dev:web` | `npm run dev:web` | Starts only the Next.js dev server (port 3100). |
| `dev:onboarding` | `npm run dev:onboarding` | Launches the Electron shell. Pair with `npm run dev` (or `dev:server`) so the MCP server is up and `/ui/` is reachable. |
| `build:web` | `npm run build:web` | Runs `next build` in `packages/server-web-ui` to produce the static export under `out/`. |
| `start` | `npm run start` | Builds the web UI (`build:web`) and starts the MCP server in production mode — serves the UI from `packages/server-web-ui/out/`. |
| `dist:win` | `npm run dist:win` | Builds the server binary (Windows) then the Electron installer. |
| `dist:mac` | `npm run dist:mac` | Builds the server binary (macOS) then the Electron installer. |
| `dist:linux` | `npm run dist:linux` | Builds the server binary (Linux) then the Electron installer. |

Each `dist:*` script chains the server build and the Electron build in sequence. For example, `dist:win` runs `npm run build:win --workspace=packages/server-for-chrome-extension && npm run dist:win --workspace=packages/electron`.

### `npm run dev` vs `npm run start`

`npm run dev` (development, hot reload):

- Starts both processes concurrently via `concurrently`: the MCP server (with `WEBPILOT_DEV=1`) and `next dev` on port 3100.
- The server detects `WEBPILOT_DEV=1` and mounts `/ui` as a proxy to `http://localhost:3100` (via `http-proxy-middleware`, `ws: true` so HMR websockets pass through). Next.js' `basePath: '/ui'` in `next.config.js` keeps URLs aligned.
- Edits to the UI hot-reload immediately. No `next build` step required.
- This mode never runs in production. The pkg binary does not know about `WEBPILOT_DEV` — Electron spawns the binary with a plain inherited environment (see `packages/electron/electron/main.js`), so installed users always go through the static-serve branch.

`npm run start` (production-shaped, no hot reload):

- Runs `npm run build:web` to produce the static Next.js export under `packages/server-web-ui/out/`.
- Starts the MCP server in foreground mode; the server serves `/ui/*` from `out/` via `fs.readFileSync` (see the [pkg-binary self-spawn gotcha](#pkg-configuration) note — this static-serve path is identical to what the pkg binary uses at runtime, so this script is the closest local equivalent to production behavior).
- No `WEBPILOT_DEV` env var is set, so the proxy branch is skipped.

The pkg / Electron / installed binary path is unchanged by these scripts — it never sets `WEBPILOT_DEV` and always serves the bundled static export.

```json
{
  "scripts": {
    "dev": "concurrently -k -n server,web --prefix-colors blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "cross-env WEBPILOT_DEV=1 node packages/server-for-chrome-extension/cli.js --foreground",
    "dev:web": "npm run dev --workspace=packages/server-web-ui",
    "dev:onboarding": "npm run dev --workspace=packages/electron",
    "build:web": "npm run build --workspace=packages/server-web-ui",
    "start": "npm run build:web && node packages/server-for-chrome-extension/cli.js --foreground",
    "dist:win": "npm run build:win --workspace=packages/server-for-chrome-extension && npm run dist:win --workspace=packages/electron",
    "dist:mac": "npm run build:mac --workspace=packages/server-for-chrome-extension && npm run dist:mac --workspace=packages/electron",
    "dist:linux": "npm run build:linux --workspace=packages/server-for-chrome-extension && npm run dist:linux --workspace=packages/electron"
  }
}
```

## Architecture Diagram

```
[NSIS Installer]
       |
       | installs
       v
[Electron App]  ──────────────────────────────────────┐
  install dir: %LOCALAPPDATA%\Programs\WebPilot\      |
       └── resources/ (bundled, no copying)           |
             ├── server/                              |
             │     webpilot-server-for-chrome-extension.exe
             │     better_sqlite3.node                |
             ├── chrome-extension/                    |
             └── assets/                              |
                                                      |
  user data: %APPDATA%\@webpilot\onboarding\          |
       ├── config/server.json                         |
       ├── server.pid / server.port                   |
       └── logs/                                      |
       |                                              |
       | on launch, spawns server with                |
       | WEBPILOT_DATA_DIR=app.getPath('userData')    |
       | (auto-registers as background service)       |
       v                                              |
[MCP Server]  (port 3456)                             |
       |                                              |
       ├──── SSE ──── [AI Agents]                     |
       |              (Claude, etc.)                  |
       |                                              |
       └──── WebSocket ──── [Chrome Extension]        |
                              (loaded unpacked)       |
                                                      |
[Electron App] ───────────────────────────────────────┘
  Status pane:
    - Status pane ("Onboarding goes here" placeholder; canonical UI is server-hosted at /ui/)
    - Status dashboard (service health, config)
```
