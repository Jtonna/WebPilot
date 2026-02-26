# README.md Audit Report

Audit of `docs-old/README.md` against the codebase at `packages/`.

## Inaccuracies

### 1. CLI help text includes `--network` but actual help does not

**README (line 233):**
```
  --network      Bind to 0.0.0.0 for LAN access (instead of 127.0.0.1)
```

The README's CLI usage block (lines 225-236) lists `--network` as one of the options. However, the actual `--help` output in `packages/server-for-chrome-extension/cli.js` (lines 38-53) does NOT include `--network`:

```js
const helpText = `
WebPilot MCP Server

Usage: webpilot-mcp [options]

Options:
  --foreground   Run server in the foreground (for development/testing)
  --install      Register as a background service
  --uninstall    Remove the background service
  --stop         Stop the running server
  --status       Check service status
  --help         Show this help message
  --version      Show version number

Running with no options starts the server as a background daemon.
`;
```

The `--network` flag IS a valid parsed option (cli.js line 20) and works at runtime, but it is missing from the actual help text. The README should either match the real help output (no `--network`) or the help text in cli.js should be updated to include `--network`.

### 2. `dev:network` and `start:network` are server-only scripts, not root workspace scripts

**README (lines 251-253):**
```bash
npm run dev:network     # Dev mode with network access
npm run start:network   # Production mode with network access
```

These scripts exist only in `packages/server-for-chrome-extension/package.json` (lines 10-11), not in the root `package.json`. Running `npm run dev:network` from the workspace root will fail. The README does not specify that these must be run from within the server package directory, unlike the Quick Start section which correctly says `cd packages/server-for-chrome-extension`.

## Verified Correct

### Architecture and Package Structure
- **Three packages confirmed:** `chrome-extension-unpacked/`, `server-for-chrome-extension/`, `electron/` all exist under `packages/`.
- **Monorepo structure:** Root `package.json` has `"workspaces": ["packages/*"]` confirming monorepo setup.

### Server Details
- **Default port 3456:** Confirmed in `src/service/paths.js` line 10: `const DEFAULT_PORT = 3456`.
- **Default API key `dev-123-test`:** Confirmed in `src/service/paths.js` line 11: `const DEFAULT_API_KEY = 'dev-123-test'`.
- **Express + WebSocket server:** Confirmed in `src/server.js` -- uses `express`, `http`, and `ws` (WebSocketServer).
- **SSE endpoint at `/sse`:** Confirmed in `src/server.js` line 95.
- **Health endpoint at `/health`:** Confirmed in `src/server.js` lines 98-104, returns `extensionConnected` field.
- **Connection string format (`vf://` + base64url):** Confirmed in `src/server.js` lines 29-34.
- **Server startup output (YAML format):** Confirmed in `src/server.js` lines 120-136 -- matches the documented output exactly.
- **Config file path `{dataDir}/config/server.json`:** Confirmed in `src/service/paths.js` line 64.
- **Priority order (config > env > default):** Confirmed in `src/service/paths.js` lines 92-99: `config.port || process.env.PORT || DEFAULT_PORT`.
- **PID and port files (`server.pid`, `server.port`):** Confirmed written in `src/server.js` lines 13-21, cleaned up on shutdown (lines 140-150).

### Data Directory Locations
- **Windows:** `%LOCALAPPDATA%\WebPilot` -- Confirmed in `src/service/paths.js` line 38.
- **macOS:** `~/Library/Application Support/WebPilot` -- Confirmed in `src/service/paths.js` line 39.
- **Linux:** `$XDG_CONFIG_HOME/WebPilot` (or `~/.config/WebPilot`) -- Confirmed in `src/service/paths.js` lines 41-43.

### CLI Entry Point
- **`cli.js` as entry point:** Confirmed in server `package.json` line 6: `"bin": "cli.js"`.
- **`@yao-pkg/pkg` for standalone binary:** Confirmed in server `package.json` line 38.
- **Build command `pkg . --target node18-win-x64 --out-path dist`:** Confirmed in server `package.json` line 13.
- **Background daemon as default mode:** Confirmed in `cli.js` lines 207-278 -- spawns detached child process.
- **All CLI flags (foreground, install, uninstall, stop, status, help, version):** All confirmed parsed and handled in `cli.js`.
- **WEBPILOT_FOREGROUND env var workaround:** Confirmed in `cli.js` lines 228-233.

### Service Management
- **`src/service/` directory with platform files:** Confirmed: `index.js`, `paths.js`, `logger.js`, `windows.js`, `macos.js`, `linux.js` all exist.
- **Windows Registry Run key (HKCU):** Confirmed by file existence (`windows.js`).

### Chrome Extension
- **background.js ~350 lines:** Confirmed at 349 lines.
- **All handler files exist:** `click.js`, `keyboard.js`, `scroll.js`, `tabs.js`, `accessibility.js`, `scripts.js` confirmed in `handlers/`.
- **All utility files exist:** `windmouse.js`, `mouse-state.js`, `cursor.js`, `scroll.js`, `timing.js`, `debugger.js` confirmed in `utils/`.
- **All formatter files exist:** `threads.js`, `threads_home.js`, `threads_activity.js`, `threads_search.js`, `zillow.js`, `zillow_detail.js`, `zillow_detail_page.js`, `zillow_home.js`, `zillow_search.js` confirmed in `formatters/`.
- **`accessibility-storage.js` and `accessibility-tree.js`:** Both confirmed at extension root.
- **Popup files (`popup.html`, `popup.css`, `popup.js`):** Confirmed in `popup/`.
- **Icons directory:** Confirmed with `icon16.png`, `icon48.png`, `icon128.png`.

### Extension Behavior
- **Auto-reconnect via `chrome.runtime.onStartup`:** Confirmed in `background.js` line 35.
- **5-second retry interval:** Confirmed in `background.js` line 216: `}, 5000);`.
- **Four popup views (Setup, Connecting, Connected, Disconnected):** All confirmed in `popup/popup.html` with IDs `setupView`, `connectingView`, `connectedView`, `disconnectedView`.
- **Focus new tabs setting (default off):** Confirmed in `popup.js` line 228 and `handlers/tabs.js` line 48.
- **Tab organization setting (default: Existing window / `group`):** Confirmed -- `popup.html` line 122 shows `value="group"` labeled "Existing window", `handlers/tabs.js` line 47 defaults to `'group'`.
- **Cyan "WebPilot" tab group:** Confirmed in `handlers/tabs.js` lines 120-122: `color: 'cyan'`, and line 29: `title: 'WebPilot'`.

### Workspace Scripts (root package.json)
- **`dev:server`:** Confirmed.
- **`dev:onboarding`:** Confirmed.
- **`start`:** Confirmed.
- **`dist:win`, `dist:mac`, `dist:linux`:** All confirmed.

### MCP Tools
- **All 9 tools listed:** Confirmed present in `src/mcp-handler.js` tool definitions (browser_create_tab, browser_close_tab, browser_get_tabs, browser_get_accessibility_tree, browser_inject_script, browser_execute_js, browser_click, browser_scroll, browser_type).

### Root-Level Files
- **`release.sh` and `release.ps1`:** Both confirmed to exist.
- **`docs/` and `docs-old/` directories:** Both confirmed to exist.
