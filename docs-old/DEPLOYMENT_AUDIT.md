# DEPLOYMENT.md Audit

## Inaccuracies

### 1. Extension folder name is wrong throughout
The doc consistently refers to the extension folder as `unpacked-extension/` and the deployment path as `extension/`. In the actual codebase:
- **Source directory**: `packages/chrome-extension-unpacked/` (not `unpacked-extension/`)
- **extraResources target**: `chrome-extension` (not `extension`)
- **Installed path on Windows**: `<install-dir>\resources\chrome-extension\` (not `%LOCALAPPDATA%\WebPilot\extension\`)

Confirmed in `packages/electron/electron-builder.yml` lines 17-18:
```yaml
- from: ../chrome-extension-unpacked
  to: chrome-extension
```

### 2. Windows installation path is wrong
The doc states: `%LOCALAPPDATA%\WebPilot\extension\`

The actual path is relative to the Electron app install directory, not `%LOCALAPPDATA%`. The extension ships as an `extraResource` inside the app's `resources/` directory. For a default NSIS per-user install this would be something like:
```
%LOCALAPPDATA%\Programs\WebPilot\resources\chrome-extension\
```
Confirmed by examining the built output at `packages/electron/dist/win-unpacked/resources/chrome-extension/` and by `getExtensionPath()` in `packages/electron/electron/main.js` (line 34): `path.join(process.resourcesPath, 'chrome-extension')`.

### 3. macOS installation path is wrong
The doc states: `~/Library/Application Support/WebPilot/extension/`

The extension is not extracted to Application Support on macOS. It ships inside the `.app` bundle's `Resources/` directory as `chrome-extension/`, same as Windows. The `~/Library/Application Support/WebPilot/` path is only used as the **data directory** in dev mode (for PID files, config, etc.), not for the extension itself.

### 4. extraResources config in electron-builder.yml is wrong
The doc shows:
```yaml
extraResources:
  - from: "../webpilot/unpacked-extension"
    to: "extension"
    filter:
      - "**/*"
```
The actual config is:
```yaml
extraResources:
  - from: ../server-for-chrome-extension/dist
    to: server
  - from: ../chrome-extension-unpacked
    to: chrome-extension
```
Differences: wrong source path (`../webpilot/unpacked-extension` vs `../chrome-extension-unpacked`), wrong target (`extension` vs `chrome-extension`), no `filter` block in the real config, and the doc omits the server binary resource entirely.

### 5. Onboarding flow description does not match implementation
The doc describes a detailed 4-step onboarding flow (Check via native messaging, Guide with screenshots and buttons, Verify, Done). The actual implementation in `packages/electron/app/page.js` is a minimal status dashboard that:
- Shows MCP Server status (Running/Starting/Offline)
- Shows Chrome Extension connection status
- Shows whether extension files exist on disk and their path
- Has placeholder text: "Onboarding goes here"

There is no "Open Chrome Extensions" button, no "Copy Path" button, no native messaging check, no screenshot-based guide, and no verification step. The described flow appears to be a design spec that was never implemented.

### 6. Native messaging claim is incorrect
The doc states the app "attempts to communicate with extension via native messaging" (step 1 of onboarding). There is no native messaging anywhere in the project. The `manifest.json` has no `nativeMessaging` permission. The server communicates with the extension via WebSocket (see `packages/chrome-extension-unpacked/background.js`), not native messaging. The Electron UI polls the server's `/health` HTTP endpoint for status, but does not communicate with the extension directly at all.

### 7. Extension version in manifest.json is 0.2.0 but all package.json files are at 0.3.0
The doc states version `0.2.0` which matches the current `manifest.json`, but this is out of sync with the rest of the project (root, server, and electron packages are all at `0.3.0`). The `release.sh` script bumps all `package.json` files but does not update `manifest.json`, indicating a version drift bug.

### 8. Key Files table references wrong paths
| Doc claims | Actual path |
|---|---|
| `unpacked-extension/` | `packages/chrome-extension-unpacked/` |
| `unpacked-extension/manifest.json` | `packages/chrome-extension-unpacked/manifest.json` |
| `electron-builder.yml` | `packages/electron/electron-builder.yml` |
| `electron/build/installer.nsh` | Does not exist anywhere in the project |

### 9. Build scripts do not exist
The doc references `build-windows.bat` and `build-mac.sh` for testing. Neither exists in the repository. The actual build commands are:
- `npm run dist:win` (root package.json)
- `npm run dist:mac` (root package.json)

### 10. NSIS installer script does not exist
The doc references `electron/build/installer.nsh` as a "NSIS script that extracts extension folder." No custom `.nsh` file exists in the project. The extension deployment is handled entirely by electron-builder's `extraResources` mechanism, not a custom NSIS script.

### 11. Chrome Web Store rejection reason is vague
The doc states the extension was "rejected (uses CDT)" without elaboration. The extension uses the `chrome.debugger` permission (Chrome DevTools Protocol), which is restricted. The claim that the extension was actually submitted and rejected is unverified from the codebase alone, but the use of `debugger` permission would indeed be problematic for Chrome Web Store approval. This is a documentation clarity issue rather than a factual error.

### 12. "Persistent across app updates" claim is misleading
The doc states the Windows extension path is "Persistent across app updates." Since the extension lives inside the app's `resources/chrome-extension/` directory, the files are replaced on every reinstall or update. The directory path stays the same so Chrome continues to find the extension, but the claim implies the files survive updates untouched, which is not the case.

---

## Missing from Documentation

### 1. Server binary deployment
The doc focuses exclusively on the extension but never mentions that a compiled server binary is also bundled via `extraResources` (from `../server-for-chrome-extension/dist` to `server`). This is a critical part of the deployment.

### 2. Linux support
The `electron-builder.yml` includes a Linux target (AppImage), and the server has Linux service support (`src/service/linux.js`). The doc only covers Windows and macOS.

### 3. Auto-start service registration
On first launch, the server auto-registers itself as a background service (Windows Registry Run key on Windows, launchd plist on macOS). This is a significant deployment behavior not mentioned.

### 4. Server data directory
The server stores PID files, port files, config, and logs in a data directory. For packaged builds this is `<install-dir>/data/`, for dev it is `%LOCALAPPDATA%\WebPilot` (Windows) or `~/Library/Application Support/WebPilot` (macOS). This is not documented.

### 5. The release/versioning process
The project has a `release.sh` script that bumps versions across all `package.json` files and creates git tags. The doc's version management section describes a manual process but misses this automation. Notably, `release.sh` does not bump `manifest.json`, which is a gap.

### 6. Extension communicates via WebSocket, not native messaging
The actual communication architecture between the server and extension is WebSocket (see `packages/chrome-extension-unpacked/background.js`). The extension connects to the server's WebSocket endpoint, authenticates with an API key, and receives commands over this persistent connection. The doc incorrectly implies native messaging. Note: the Electron UI separately polls the server's `/health` HTTP endpoint for status display, but this is Electron-to-server, not extension-to-server.

### 7. pkg binary compilation
The server is compiled to a standalone `.exe` using `@yao-pkg/pkg`. This is a key deployment detail not covered in the doc.

---

## Verified Correct

### 1. Sideloading is necessary
The extension requires the `debugger` permission and uses `chrome.debugger` API extensively (confirmed in `manifest.json` and multiple handler files). This permission is heavily restricted and would likely prevent Chrome Web Store approval. Developer Mode sideloading is indeed the practical distribution method.

### 2. Distribution method comparison table (mostly)
The general trade-offs listed for each method are accurate regarding Chrome's security restrictions. External CRX files are blocked, enterprise policy requires domain management, and Developer Mode sideloading works universally. The specific claim about CWS rejection is plausible but unverified.

### 3. Extension version is 0.2.0 in manifest.json
The `packages/chrome-extension-unpacked/manifest.json` does contain `"version": "0.2.0"` (though this is out of sync with the rest of the project at 0.3.0).

### 4. Developer Mode considerations
The claims about the Developer Mode warning banner, extension persistence, and lack of auto-update are all accurate for Chrome sideloaded extensions.

### 5. Extension uses Manifest V3
The `manifest.json` confirms `"manifest_version": 3` with a service worker background script.

---

## Verified By

### Initial audit: 2026-02-25
- **Method**: Manual audit of codebase at `C:\Users\J\Documents\Github\WebPilot\` on branch `main` (commit `2463b8c`)
- **Files examined**:
  - `packages/chrome-extension-unpacked/manifest.json` - extension metadata and permissions
  - `packages/electron/electron-builder.yml` - build configuration and extraResources
  - `packages/electron/electron/main.js` - extension path resolution, server launch, data directory
  - `packages/electron/electron/preload.js` - exposed APIs for extension detection
  - `packages/electron/app/page.js` - actual onboarding UI implementation
  - `packages/electron/package.json` - version and build scripts
  - `packages/server-for-chrome-extension/cli.js` - server CLI and daemon logic
  - `packages/server-for-chrome-extension/src/service/paths.js` - data directory and path resolution
  - `packages/server-for-chrome-extension/src/service/index.js` - platform service dispatch
  - `packages/server-for-chrome-extension/package.json` - version and pkg config
  - `packages/electron/dist/win-unpacked/resources/` - actual built output structure
  - `package.json` (root) - workspace config and build scripts
  - `release.sh` - version bump automation
- **Summary**: The DEPLOYMENT.md document contains significant inaccuracies in file paths, folder names, installation paths, and the onboarding flow description. The onboarding flow described was never implemented (the UI is a placeholder). Multiple referenced files do not exist. The doc is missing coverage of the server binary deployment, Linux support, auto-start service, and the actual communication architecture. The general claims about why sideloading is necessary and Developer Mode behavior remain accurate.

### Re-verification: 2026-02-25
- **Method**: Code-level verification of every audit claim against the codebase on branch `main` (commit `2463b8c`)
- **Additional files examined**:
  - `packages/chrome-extension-unpacked/background.js` - WebSocket communication (confirms no native messaging)
  - `packages/server-for-chrome-extension/src/service/windows.js` - Windows Registry Run key auto-start
  - `packages/electron/next.config.js` - Next.js static export config
- **Changes made to this audit**:
  - **Inaccuracy #6 (native messaging)**: Refined to clarify that server-to-extension communication is WebSocket only, and that Electron-to-server is a separate HTTP health poll. Removed imprecise mention of `chrome.debugger` being the alternative to native messaging (those are different concerns).
  - **Inaccuracy #11 (CWS rejection)**: Kept but reframed as a documentation clarity issue rather than a factual error, since the `debugger` permission genuinely would prevent CWS approval.
  - **Inaccuracy #12 (NEW)**: Added. The doc claims the extension path is "Persistent across app updates" but the files live inside `resources/` and are replaced on every update.
  - **Missing #6**: Corrected "HTTP polling + WebSocket" to just "WebSocket" for extension-to-server communication. Added detail about the WebSocket authentication flow.
  - **Verified Correct #5 (Electron + Next.js)**: Removed. DEPLOYMENT.md does not make claims about the Electron/Next.js architecture, so there was nothing to verify. This was a tangential observation.
  - **All other claims (Inaccuracies 1-5, 7-10; Missing 1-5, 7; Verified 1-4, 5-6)**: Confirmed correct against the codebase with no changes needed.
