# Build Architecture

## Overview

WebPilot produces a single distributable artifact: an Electron application packaged with NSIS (on Windows). The Electron app bundles the compiled MCP server binary and the unpacked Chrome extension as extra resources. On first launch (and on updates), the Electron app deploys the server binary and extension files to the user's local app data directory. The Electron app itself serves as the management UI (onboarding wizard, status dashboard).

## Build Pipeline

The build is a two-step process:

1. **Build the server binary** -- `@yao-pkg/pkg` compiles the MCP server into a standalone executable with Node.js baked in.
2. **Build the Electron app** -- `electron-builder` packages the Electron app, bundling the server binary and extension as `extraResources`, and produces an NSIS installer on Windows.

The NSIS installer is not a separate build step. It is the output format configured in `electron-builder`. The installer places the Electron app into the user's programs directory; the Electron app itself handles deploying the server and extension to app data on launch.

## pkg Configuration

Defined in `packages/server-for-chrome-extension/package.json`:

```json
{
  "pkg": {
    "targets": [
      "node18-win-x64",
      "node18-macos-x64",
      "node18-linux-x64"
    ],
    "outputPath": "dist",
    "assets": [
      "src/**/*.js",
      "index.js"
    ]
  }
}
```

Build command:

```bash
cd packages/server-for-chrome-extension
npm run build
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
  chrome-extension-unpacked/
    manifest.json
    background.js
    popup/
    handlers/
    ...                                            All extension files
```

The Electron app (Next.js inside Electron) provides:

1. **Onboarding wizard** -- guides users through extension sideloading, displays connection strings, verifies setup
2. **Status dashboard** -- shows whether the server is running, extension is connected, provides configuration management

## What the App Does on Launch

When the Electron app starts, it runs a deployment check:

1. Checks whether the server binary exists at the expected app data path.
2. Checks whether the extension files exist at the expected app data path.
3. If either is missing or outdated, copies them from the Electron app's bundled `resources/` directory to the app data directory.
4. Generates a secure API key and persists it to the config directory (if one does not already exist).

The Electron app does **not** register the server as a background service at this time. Service registration is planned but not yet implemented. Currently, the app only deploys the files.

## Deployment Paths

### Electron App Install Location

| Platform | Install Path |
|----------|-------------|
| Windows  | `%LOCALAPPDATA%\Programs\WebPilot\` |
| macOS    | `/Applications/WebPilot.app/` |
| Linux    | `/opt/WebPilot/` or AppImage |

### App Data (deployed by Electron app on launch)

| Platform | App Data Directory | Config Location |
|----------|-------------------|-----------------|
| Windows  | `%LOCALAPPDATA%\WebPilot\` | `%LOCALAPPDATA%\WebPilot\config\` |
| macOS    | `~/Library/Application Support/WebPilot/` | Same |
| Linux    | `~/.config/WebPilot/` | Same |

Within the app data directory:

```
WebPilot/
  webpilot-server-for-chrome-extension[.exe]    Server binary
  chrome extension/
    unpacked-extension/                          Unpacked Chrome extension files
      manifest.json
      background.js
      popup/
      handlers/
      ...
  config/                                        API key and server configuration
```

The extension is deployed specifically to `chrome extension/unpacked-extension/` within the app data directory. This is the path users point Chrome to when loading the unpacked extension.

## CLI Flags

The server binary (`cli.js` / compiled binary) supports these flags:

| Flag | Description |
|------|-------------|
| `--install` | Register the server as a background service |
| `--uninstall` | Remove the background service registration |
| `--status` | Check whether the background service is running |
| `--help` | Show usage information |
| `--version` | Print version number |
| `--network` | Start in network mode (listen on `0.0.0.0` instead of `127.0.0.1`) |

Running with no flags starts the server in the foreground.

## Service Registration

Service registration is currently stubbed in `cli.js`. It is **not yet implemented**. When implemented, `--install` will register the server as a background service that starts on login.

| Platform | Mechanism | Status |
|----------|-----------|--------|
| Windows  | Task Scheduler | Planned |
| macOS    | launchd (LaunchAgent) | Planned |
| Linux    | systemd (user service) | Planned |

Planned behavior per platform:

- **Windows**: Create a Task Scheduler task that runs the binary at user login, hidden
- **macOS**: Write a LaunchAgent plist to `~/Library/LaunchAgents/`
- **Linux**: Write a systemd user service to `~/.config/systemd/user/`

## Extension Sideloading

The Chrome extension cannot be distributed via the Chrome Web Store (it uses the `debugger` API for CDP access). Users must load it manually:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the extension directory deployed by the Electron app:
   - Windows: `%LOCALAPPDATA%\WebPilot\chrome extension\unpacked-extension\`
   - macOS: `~/Library/Application Support/WebPilot/chrome extension/unpacked-extension/`
   - Linux: `~/.config/WebPilot/chrome extension/unpacked-extension/`

Chrome will show a "Developer mode extensions" warning on each browser launch. This is expected and cannot be suppressed for sideloaded extensions.

The extension files must remain at the deployed location. If deleted, re-launching the Electron app will re-deploy them.

## Root npm Scripts

Defined in the root `package.json`:

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `npm run dev` | Prints available dev commands and exits |
| `dev:server` | `npm run dev:server` | Starts the MCP server in watch mode (`node --watch`) |
| `dev:onboarding` | `npm run dev:onboarding` | Starts the Electron/Next.js onboarding UI in dev mode |
| `build:server` | `npm run build` | Builds the MCP server binary via pkg |
| `build:electron` | *(to be added)* | Builds the Electron app via electron-builder |
| `build:all` | *(to be added)* | Runs `build:server` then `build:electron` in sequence |

Currently defined scripts in root `package.json`:

```json
{
  "scripts": {
    "dev": "echo Available commands: ...",
    "dev:server": "npm run dev --workspace=packages/server-for-chrome-extension",
    "dev:onboarding": "npm run dev --workspace=packages/electron",
    "start": "npm run start --workspace=packages/server-for-chrome-extension",
    "build": "npm run build --workspace=packages/server-for-chrome-extension"
  }
}
```

The `build:electron` and `build:all` scripts will be added when the electron-builder configuration is finalized.

## Architecture Diagram

```
[NSIS Installer]
       |
       | installs
       v
[Electron App]  ──────────────────────────────────────┐
  %LOCALAPPDATA%\Programs\WebPilot\                   |
       |                                              |
       | on launch, deploys to AppData                |
       v                                              |
%LOCALAPPDATA%\WebPilot\                              |
  ├── server binary                                   |
  ├── chrome extension/unpacked-extension/            |
  └── config/                                         |
       |                                              |
       | server binary runs                           |
       | (service registration planned)               |
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
