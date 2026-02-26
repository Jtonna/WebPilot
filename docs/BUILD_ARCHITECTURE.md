# Build Architecture

## Overview

WebPilot produces a single distributable artifact: an Electron application packaged with NSIS (on Windows). The Electron app bundles the compiled MCP server binary and the unpacked Chrome extension as extra resources. The server binary and extension files run directly from their bundled locations inside the Electron app's `resources/` directory -- no file copying to app data occurs. The Electron app itself serves as the management UI (onboarding wizard, status dashboard).

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
      "index.js"
    ]
  }
}
```

Targets are specified as CLI flags in the per-platform npm scripts, not in the `pkg` config. The `build` script itself errors with "Use build:win, build:mac, or build:linux":

```bash
cd packages/server-for-chrome-extension
npm run build:win    # pkg . --target node18-win-x64 --out-path dist
npm run build:mac    # pkg . --target node18-macos-x64 --out-path dist
npm run build:linux  # pkg . --target node18-linux-x64 --out-path dist
```

Output goes to `packages/server-for-chrome-extension/dist/`:

| Platform | Binary |
|----------|--------|
| Windows  | `webpilot-server-for-chrome-extension.exe` |
| macOS    | `webpilot-server-for-chrome-extension` (x64) |
| Linux    | `webpilot-server-for-chrome-extension` (x64) |

## Electron Build

The Electron app is built with `electron-builder`. The key configuration points:

- **Target**: NSIS installer (Windows), `.dmg` (macOS), AppImage (Linux)
- **Install location**: `%LOCALAPPDATA%\Programs\WebPilot\` (Windows default for per-user NSIS installs)
- **extraResources**: The server binary and extension directory are declared as `extraResources` in the electron-builder config so they ship inside the Electron app's `resources/` folder but are not part of the Asar archive.

What gets bundled into the Electron app:

```
resources/
  server/
    webpilot-server-for-chrome-extension[.exe]    Compiled server binary
  chrome-extension/
    manifest.json
    background.js
    accessibility-storage.js
    accessibility-tree.js
    formatters/
    handlers/
    icons/
    popup/
    utils/
```

The Electron app (Next.js inside Electron) provides:

1. **Onboarding wizard** -- guides users through extension sideloading, displays connection strings, verifies setup
2. **Status dashboard** -- shows whether the server is running, extension is connected, provides configuration management

## What the App Does on Launch

When the Electron app starts, it performs these steps:

1. Ensures the data directory exists (creates it if necessary).
2. Spawns the server binary from its bundled location (`process.resourcesPath/server/`).
3. Opens the management UI window.

No file copying or deployment occurs. The server binary and extension files run directly from their bundled locations inside the Electron app's `resources/` directory. The data directory (for config, logs, PID files) is at `<installDir>/data/`, a sibling of the `resources/` directory.

## Deployment Paths

### Electron App Install Location

| Platform | Install Path |
|----------|-------------|
| Windows  | `%LOCALAPPDATA%\Programs\WebPilot\` |
| macOS    | `/Applications/WebPilot.app/` |
| Linux    | `/opt/WebPilot/` or AppImage |

### Bundled Resources (inside install directory)

The server binary and extension files remain in the Electron app's `resources/` directory. They are not copied elsewhere.

```
<installDir>/
  resources/
    server/
      webpilot-server-for-chrome-extension[.exe]    Compiled server binary
    chrome-extension/                                Unpacked Chrome extension files
      manifest.json
      background.js
      accessibility-storage.js
      accessibility-tree.js
      formatters/
      handlers/
      icons/
      popup/
      utils/
  data/                                              Created at runtime
    config/
      server.json                                    API key and port configuration
    server.pid                                       PID of running daemon
    server.port                                      Port of running daemon
    logs/                                            Daemon log files
```

The data directory is at `<installDir>/data/`, computed as a sibling of `resources/` via `path.resolve(path.dirname(process.execPath), '..', '..', 'data')`. In dev mode (when `app.isPackaged` is false), the data directory falls back to `%LOCALAPPDATA%\WebPilot\` (Windows) or platform equivalent.

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

Server configuration is stored at `<dataDir>/config/server.json` with two fields:

| Field | Env Var Fallback | Default |
|-------|-----------------|---------|
| `apiKey` | `API_KEY` | `'dev-123-test'` |
| `port` | `PORT` | `3456` |

The server reads from the config file first, then falls back to environment variables, then to the hardcoded defaults. See `paths.js` for the resolution logic.

### Daemon Logging

The daemon uses `SizeManagedWriter` (implemented in `service/logger.js`) which manages log file output:

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
| `dev` | `npm run dev` | Prints available dev commands and exits |
| `dev:server` | `npm run dev:server` | Starts the MCP server in watch mode (`node --watch`) |
| `dev:onboarding` | `npm run dev:onboarding` | Starts the Electron/Next.js onboarding UI in dev mode |
| `start` | `npm run start` | Starts the MCP server |
| `dist:win` | `npm run dist:win` | Builds the server binary (Windows) then the Electron installer |
| `dist:mac` | `npm run dist:mac` | Builds the server binary (macOS) then the Electron installer |
| `dist:linux` | `npm run dist:linux` | Builds the server binary (Linux) then the Electron installer |

Each `dist:*` script chains the server build and the Electron build in sequence. For example, `dist:win` runs `npm run build:win --workspace=packages/server-for-chrome-extension && npm run dist:win --workspace=packages/electron`.

```json
{
  "scripts": {
    "dev": "echo Available commands: ...",
    "dev:server": "npm run dev --workspace=packages/server-for-chrome-extension",
    "dev:onboarding": "npm run dev --workspace=packages/electron",
    "start": "npm run start --workspace=packages/server-for-chrome-extension",
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
  %LOCALAPPDATA%\Programs\WebPilot\                   |
       |                                              |
       ├── resources/ (bundled, no copying)             |
       │     ├── server/                               |
       │     │     webpilot-server-for-chrome-extension.exe
       │     └── chrome-extension/                     |
       └── data/ (created at runtime)                  |
             ├── config/server.json                    |
             ├── server.pid / server.port              |
             └── logs/                                 |
       |                                              |
       | on launch, spawns server from resources/     |
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
  Management UI:
    - Onboarding wizard (guides sideloading)
    - Status dashboard (service health, config)
```
