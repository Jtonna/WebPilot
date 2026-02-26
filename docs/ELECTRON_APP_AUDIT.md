# ELECTRON_APP.md Audit

Audit performed against the codebase at `packages/electron/`.

## Inaccuracies

### 1. "deploys these to the platform app data directory and registers the server as a background service" (line 54)

The doc states:

> The installer bundles both the compiled MCP server binary and the unpacked extension files via `extraResources` in `electron-builder.yml`. During installation, it deploys these to the platform app data directory and registers the server as a background service.

Two problems:

**a) "platform app data directory" is wrong.** `extraResources` in electron-builder copies files into the app's `resources/` subdirectory within the installation directory (e.g., `C:\Users\<user>\AppData\Local\Programs\WebPilot\resources\server\`). It does not deploy to a separate "platform app data directory." The production `getDataDir()` in `main.js` returns `path.join(path.dirname(process.resourcesPath), 'data')`, which is also relative to the install location, not a platform-standard app data path like `%LOCALAPPDATA%\WebPilot`.

Evidence from `electron/main.js` lines 27-28:
```js
  return path.join(path.dirname(process.resourcesPath), 'data');
```

Evidence from `electron-builder.yml` lines 14-18:
```yaml
extraResources:
  - from: ../server-for-chrome-extension/dist
    to: server
  - from: ../chrome-extension-unpacked
    to: chrome-extension
```

**b) "registers the server as a background service" during installation is wrong.** There is no `afterInstall` script or similar installer hook in `electron-builder.yml`. The server is launched by `startServer()` in `main.js` each time the Electron app starts, as a detached child process. Service registration (`--install` flag) is exposed via the preload bridge but is not triggered during installation.

## Verified Correct

- **Package name and version**: `@webpilot/onboarding` version `0.3.0` matches `package.json`.
- **Next.js `^15.0.0` and React `^19.0.0`**: Match `package.json` dependencies.
- **Electron `33.4.11`**: Matches `package.json` devDependencies.
- **Installer formats**: Windows NSIS `.exe` (non-oneClick, per-user via `perMachine: false`), macOS `.dmg`, Linux AppImage all match `electron-builder.yml`.
- **7 preload methods**: `getServerPort`, `getDataDir`, `getExtensionPath`, `isExtensionAvailable`, `installService`, `uninstallService`, `getServiceStatus` confirmed in `preload.js`.
- **`getServerPort()` reads `server.port` file**: Confirmed at `preload.js` line 21.
- **Paths passed via `additionalArguments`**: Confirmed in `main.js` lines 71-75 and `preload.js` lines 7-15.
- **`sandbox: false` in webPreferences**: Confirmed in `main.js` line 70.
- **Preload uses Node.js APIs directly (`fs`, `child_process`)**: Confirmed in `preload.js`.
- **Server launched as detached child process with `detached: true`, `windowsHide: true`, `stdio: 'ignore'`, `child.unref()`**: All confirmed in `main.js` lines 52-57.
- **Graceful skip if server binary not found**: Confirmed in `main.js` lines 44-47.
- **Health polling every 3 seconds**: Confirmed in `page.js` line 44.
- **Status states (Running/Offline/Starting...) with color-coded indicators**: Confirmed in `page.js` lines 48-51.
- **Extension connection status via `/health` endpoint**: Confirmed in `page.js` line 32.
- **Extension availability check via `manifest.json`**: Confirmed in `preload.js` line 33.
- **Extension path displayed**: Confirmed in `page.js` lines 96-100.
- **"Onboarding goes here" placeholder**: Confirmed in `page.js` line 67.
- **`installService()` and `uninstallService()` exist but are not wired to the UI**: Confirmed; `page.js` does not call either method.
- **Build scripts (`dev`, `build:next`, `start`, `dist`, `dist:win`, `dist:mac`, `dist:linux`)**: All match `package.json` scripts.
- **`assetPrefix: './'` and static export**: Confirmed in `next.config.js`.
- **Output directory `../../dist`**: Confirmed in `electron-builder.yml` line 7.
- **File tree listing**: All listed files exist with correct descriptions.
