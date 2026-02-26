# WebPilot Extension Deployment

How the Chrome extension and server binary are packaged and installed for end users.

## Overview

Due to Chrome's security restrictions, the extension must be sideloaded via Developer Mode on Windows, macOS, and Linux. The Electron installer deploys both the unpacked extension and a compiled server binary to the app's resources directory, and the app guides users through a one-time setup.

```
[Build Time]
packages/chrome-extension-unpacked/ -+-> electron-builder --> bundled in installer
server-for-chrome-extension (pkg) --+

[Install Time - Windows]
NSIS installs to: %LOCALAPPDATA%\Programs\WebPilot\
  Extension at:   resources\chrome-extension\
  Server at:      resources\server\

[Install Time - macOS]
DMG installs to: /Applications/WebPilot.app/
  Extension at:   Contents/Resources/chrome-extension/
  Server at:      Contents/Resources/server/

[Install Time - Linux]
AppImage contains:
  Extension at:   resources/chrome-extension/
  Server at:      resources/server/

[First Launch]
Server binary auto-starts and registers as a background service
App shows status dashboard with extension path
User enables Developer Mode --> clicks "Load unpacked" --> selects extension folder
```

## Why Sideloading?

Chrome restricts extension installation to protect users:

| Method | Windows | macOS | Limitation |
|--------|---------|-------|------------|
| Chrome Web Store | -- | -- | Extension uses `chrome.debugger` (restricted permission) |
| External CRX (local file) | -- | -- | Blocked since Chrome 33/44 |
| External CRX (self-hosted URL) | -- | -- | Windows requires Web Store |
| Registry/JSON + Web Store | -- | -- | Requires Web Store listing |
| Enterprise Policy (self-hosted) | -- | -- | Requires AD domain |
| Developer Mode sideload | Yes | Yes | Works everywhere |

Developer Mode sideloading is the only approach that works reliably without Chrome Web Store approval. The extension uses the `chrome.debugger` permission (Chrome DevTools Protocol), which is restricted and would prevent Chrome Web Store approval.

## Build Integration

The extension and server binary are bundled with the Electron app via `extraResources`:

```yaml
# packages/electron/electron-builder.yml
extraResources:
  - from: ../server-for-chrome-extension/dist
    to: server
  - from: ../chrome-extension-unpacked
    to: chrome-extension
```

This copies both `packages/chrome-extension-unpacked/` and the compiled server binary into the app resources during build.

### Server Binary Compilation

The server is compiled to a standalone executable using `@yao-pkg/pkg`:

```bash
# packages/server-for-chrome-extension/package.json
pkg . --target node18-win-x64 --out-path dist   # Windows
pkg . --target node18-macos-x64 --out-path dist  # macOS
pkg . --target node18-linux-x64 --out-path dist  # Linux
```

The resulting binary is a self-contained Node.js application that requires no runtime dependencies.

## Installation Paths

### Windows

The NSIS installer places the app (per-user, no admin required) at:
```
%LOCALAPPDATA%\Programs\WebPilot\
```

The extension and server live inside the app's `resources/` directory:
```
%LOCALAPPDATA%\Programs\WebPilot\resources\chrome-extension\
%LOCALAPPDATA%\Programs\WebPilot\resources\server\
```

### macOS

The app bundle contains the extension and server in its Resources directory:
```
/Applications/WebPilot.app/Contents/Resources/chrome-extension/
/Applications/WebPilot.app/Contents/Resources/server/
```

### Linux

The AppImage contains the extension and server in its resources directory:
```
resources/chrome-extension/
resources/server/
```

These paths are resolved at runtime via `process.resourcesPath` in the Electron main process (see `packages/electron/electron/main.js`).

Note: The extension and server files inside `resources/` are **replaced on every app update**. The directory path remains the same, so Chrome continues to find the sideloaded extension without reconfiguration.

### Data Directory

The server stores PID files, port files, config, and logs in a separate data directory:

| Mode | Windows | macOS | Linux |
|------|---------|-------|-------|
| Packaged | `<install-dir>\data\` | `<app-bundle>/Contents/data/` | `<app-dir>/data/` |
| Dev | `%LOCALAPPDATA%\WebPilot\` | `~/Library/Application Support/WebPilot/` | `$XDG_CONFIG_HOME/WebPilot/` (default `~/.config/WebPilot/`) |

## Auto-Start Service Registration

On first launch, the server binary auto-registers itself as a background service so it starts automatically on login:

- **Windows**: Adds a Registry Run key (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`)
- **macOS**: Creates a launchd plist
- **Linux**: Creates a systemd user service unit (`~/.config/systemd/user/webpilot-server.service`)

This allows the MCP server to be available immediately when the user logs in, without requiring the Electron app to be open.

## Communication Architecture

The extension communicates with the server via **WebSocket**, not native messaging. The extension's service worker (`packages/chrome-extension-unpacked/background.js`) connects to the server's WebSocket endpoint and authenticates with an API key. Commands are sent and received over this persistent connection.

The Electron UI separately polls the server's `/health` HTTP endpoint every 3 seconds to display status information (server running, extension connected, etc.).

## User Onboarding Flow

On first launch, the app shows a status dashboard that displays:

- **MCP Server status**: Running / Starting / Offline
- **Chrome Extension connection status**: Connected / Not connected
- **Extension files availability**: Whether extension files exist on disk
- **Extension path**: The full path to the extension directory for use with Chrome's "Load unpacked"

The onboarding UI is currently a placeholder (with text "Onboarding goes here"). Users must manually:
1. Open `chrome://extensions` in Chrome
2. Enable Developer Mode
3. Click "Load unpacked" and select the extension path shown in the app

## Version Management

The extension version is in `packages/chrome-extension-unpacked/manifest.json`:

```json
{
  "version": "0.2.0"
}
```

Note: The extension manifest version (0.2.0) is currently out of sync with the rest of the project (0.3.0 in all `package.json` files). The `release.sh` script bumps all `package.json` versions and creates git tags, but does not update `manifest.json`.

When updating:
1. Run `release.sh` to bump versions across all `package.json` files (note: `manifest.json` must be updated manually)
2. Rebuild the app with `npm run dist:win`, `npm run dist:mac`, or `npm run dist:linux`
3. Users reinstall the app (new extension and server files are deployed)
4. Chrome detects the updated unpacked extension on next launch

## Developer Mode Considerations

- **Warning banner**: Chrome shows "Developer mode extensions" warning on launch. This is expected and cannot be avoided for sideloaded extensions.
- **Persistence**: The extension stays loaded until the user removes it or the folder is deleted.
- **Updates**: Unlike Web Store extensions, sideloaded extensions don't auto-update. Users get updates when they reinstall the app.

## Testing

1. Build the app:
   - Windows: `npm run dist:win`
   - macOS: `npm run dist:mac`
   - Linux: `npm run dist:linux`
2. Run the installer
3. Launch WebPilot app
4. Verify the status dashboard shows the server as Running
5. Follow the sideloading steps to load the extension in Chrome
6. Verify extension appears in `chrome://extensions`
7. Verify the dashboard shows "Connected" for the Chrome Extension

To reset for re-testing:
1. Remove the extension from `chrome://extensions`
2. Uninstall and reinstall the app

## Key Files

| File | Purpose |
|------|---------|
| `packages/chrome-extension-unpacked/` | The extension source (deployed to users) |
| `packages/chrome-extension-unpacked/manifest.json` | Extension metadata and version |
| `packages/chrome-extension-unpacked/background.js` | Service worker with WebSocket communication |
| `packages/electron/electron-builder.yml` | Bundles extension and server via extraResources |
| `packages/electron/electron/main.js` | Extension/server path resolution, server launch |
| `packages/server-for-chrome-extension/package.json` | Server pkg build config |
| `release.sh` | Version bump automation and git tagging |

## Notes

- The extension folder must remain in place for Chrome to load it. If the user deletes or moves the app, Chrome will lose access to the extension.
- Chrome may disable the extension after major Chrome updates. Users can re-enable it from `chrome://extensions`.
- The "Developer mode extensions" warning appears on every Chrome launch. This is a Chrome security feature and cannot be suppressed.
- The server binary runs as a background process and auto-registers for login startup. It does not require the Electron app to remain open.
