# README.md Audit Report

## Inaccuracies

### 1. Folder paths do not match actual codebase structure
The doc references top-level folders `unpacked-extension/` and `mcp-server/`. The actual codebase uses a monorepo layout under `packages/`:
- `packages/chrome-extension-unpacked/` (not `unpacked-extension/`)
- `packages/server-for-chrome-extension/` (not `mcp-server/`)
- `packages/electron/` (not mentioned at all)

All `cd mcp-server` and `unpacked-extension/` references are wrong. The correct commands would be:
```bash
cd packages/server-for-chrome-extension
npm install
npm run dev
```

### 2. Server startup output format is wrong
The doc shows a decorative banner with `MCP Server running on :3456` and a boxed connection string. The actual output is YAML-formatted:
```
server:
  host: 127.0.0.1
  port: 3456
  local:
    sse: http://localhost:3456/sse
    ws: ws://localhost:3456
  network:
    sse: disabled
    ws: disabled
connection_string: vf://...
```

### 3. Missing MCP tool: `browser_type`
The MCP Tools table lists 8 tools but the server actually defines 9. The `browser_type` tool is missing from the documentation. It has parameters: `tab_id` (required), `text` (required), `ref?`, `selector?`, `delay?`, `pressEnter?`.

### 4. `browser_scroll` timing is wrong
The doc says "50ms per 50px" in the scroll tool description. The actual code and tool description say "75ms per 50px" (confirmed in `handlers/scroll.js`, `handlers/click.js`, and `utils/scroll.js`).

### 5. `browser_click` is missing the `delay` parameter
The doc's parameter list for `browser_click` includes `tab_id`, `ref?`, `selector?`, `x?`, `y?`, `button?`, `clickCount?`, `showCursor?` but omits the `delay` parameter. The actual tool schema includes `delay?: number` (override delay in ms between press and release).

### 6. Folder structure is inaccurate in multiple ways
- **Missing handler**: `handlers/keyboard.js` exists in the codebase but is not listed in the folder tree.
- **Missing formatters**: The codebase has Zillow formatters (`zillow.js`, `zillow_detail.js`, `zillow_detail_page.js`, `zillow_home.js`, `zillow_search.js`) not shown in the folder tree.
- **Server `src/` directory**: The doc shows `src/server.js`, `src/mcp-handler.js`, `src/extension-bridge.js`. While those files exist, there is also a `src/service/` directory (containing `index.js`, `linux.js`, `logger.js`, `macos.js`, `paths.js`, `windows.js`) that is not shown.
- **Missing `cli.js`**: The server package has `cli.js` at its root (the pkg binary entry point) which is not shown.
- **Root-level files**: The doc shows `README.md`, `MCP_INTEGRATION.md`, `EXTENSION.md` at root. `MCP_INTEGRATION.md` is in `docs-old/`, `EXTENSION.md` does not exist anywhere in the repo. The root also has `package.json`, `release.sh`, `release.ps1`, `docs/`, `docs-old/`, `dist/`, etc.

### 7. background.js line count is approximately wrong
The doc says "~330 lines". Actual count is 350 lines. Minor -- the `~` prefix signals an approximation, but the gap is ~6%.

### 8. "Manual connect" claim is incorrect
The doc says "The extension uses **manual connect** - it does NOT auto-connect on browser startup." This is only true for the initial setup (user must paste a connection string and click Connect). After that, the extension **does** auto-reconnect on browser startup. `background.js` registers a `chrome.runtime.onStartup` listener that calls `loadConfig()`, which checks if the extension was previously enabled and, if so, calls `connectWebSocket()` automatically. The doc should say: "Initial setup requires a manual connection string paste. After first connect, the extension auto-reconnects on browser restart."

### 9. Link to EXTENSION.md is broken
The doc ends with `See [EXTENSION.md](./EXTENSION.md)` but no `EXTENSION.md` file exists in the `docs-old/` directory or anywhere in the repo.

### 10. Environment variable priority is understated
The doc says `PORT` and `API_KEY` are environment variables with defaults. In reality, the priority order is: config file (`data/config/server.json`) > environment variable > hardcoded default. The config file mechanism is not mentioned at all.

### 11. Connecting view is undocumented
The doc lists three popup views: Setup, Connected, Disconnected. The actual code has four views: Setup, **Connecting**, Connected, Disconnected. The Connecting view shows the server URL and a spinner/error while the WebSocket connection is being established.

### 12. Tab organization description is slightly misleading
The doc says the alternative to "Existing window" is "a dedicated WebPilot window." The actual UI label is "New window" (not "dedicated WebPilot window"). However, the doc's claim that "Both modes use a cyan 'WebPilot' tab group" is correct -- in window mode, `createTab()` in `handlers/tabs.js` calls `addTabToGroup(tab.id)` after creating or moving the tab to the WebPilot window, so tabs are grouped in both modes.

## Missing from Documentation

### 1. `packages/electron/` package
The entire Electron package is unmentioned. This is a significant part of the monorepo that handles deployment, auto-start registration, and packaging the server + extension together.

### 2. `browser_type` tool
A complete MCP tool for typing text into focused elements or elements specified by ref/selector, with CDP keyboard simulation. See Inaccuracy #3 above.

### 3. Config file support (`server.json`)
The server supports a JSON config file at `{dataDir}/config/server.json` that can set `port` and `apiKey`, and this takes priority over environment variables. Not documented.

### 4. `cli.js` and pkg binary support
The server has a CLI entry point (`cli.js`) with flags like `--foreground`, `--install`, `--uninstall`, `--stop`, `--status`, `--network`, `--help`, `--version`. It is designed to be compiled into a standalone `.exe` via `@yao-pkg/pkg`. The doc only mentions `npm run dev` and `npm start`.

### 5. Network mode (`--network` flag)
The server supports a `--network` flag (or `NETWORK=1` env var) to bind to `0.0.0.0` instead of `127.0.0.1`, enabling LAN access. Scripts `dev:network` and `start:network` exist in the server package.json.

### 6. Service management infrastructure
The `src/service/` directory contains platform-specific service management code for Windows (Registry), macOS (launchd), and Linux (systemd). This is unmentioned.

### 7. Zillow platform formatter
The extension includes Zillow-specific formatters (`zillow.js`, `zillow_detail.js`, `zillow_detail_page.js`, `zillow_home.js`, `zillow_search.js`) in addition to the documented Threads formatters.

### 8. `keyboard.js` handler
The extension has a `handlers/keyboard.js` file (for the `browser_type` tool) that is not listed in the folder structure.

### 9. `/connect` endpoint
The server exposes a `/connect` endpoint that returns the connection string and server URL as JSON. Only `/health` and `/sse` are mentioned in the doc.

### 10. PID and port file management
The server writes `server.pid` and `server.port` files to the data directory for service management, and cleans them up on shutdown.

### 11. Root-level monorepo scripts
The root `package.json` defines workspace scripts (`dev:server`, `dev:onboarding`, `start`, `dist:win`, `dist:mac`, `dist:linux`) that delegate to the individual packages. The doc only references running commands directly inside the server subdirectory.

### 12. Auto-reconnect with retry logic
The extension has retry logic for reconnecting after connection failures. On non-auth errors (e.g., server unreachable), it retries every 5 seconds while enabled. On auth failures, it clears stored credentials and stops retrying. None of this is documented.

## Verified Correct

### 1. Default port and API key values
- `PORT` default: `3456` -- Confirmed in `src/service/paths.js` (`DEFAULT_PORT = 3456`)
- `API_KEY` default: `dev-123-test` -- Confirmed in `src/service/paths.js` (`DEFAULT_API_KEY = 'dev-123-test'`)

### 2. `npm run dev` uses `--watch` for hot reload
- Confirmed: `"dev": "node --watch index.js"` in `packages/server-for-chrome-extension/package.json`

### 3. Connection string format (`vf://` + base64url JSON)
- Confirmed in `server.js` `generateConnectionString()`: builds `{ v: 1, s: wsUrl, k: apiKey }`, encodes as base64url, prefixes with `vf://`
- Confirmed in `popup.js` `parseConnectionString()`: expects `vf://` prefix, decodes base64, parses JSON with `v`, `s`, `k` fields

### 4. Authentication model
- Extension to server: API key required via WebSocket URL query param (`?apiKey=...`) -- Confirmed in `server.js` upgrade handler
- Claude Code to server: No auth on `/sse` and `/message` endpoints -- Confirmed, no auth middleware on these routes

### 5. MCP tools (8 of 9) exist with correct parameters
All 8 documented tools (`browser_create_tab`, `browser_close_tab`, `browser_get_tabs`, `browser_get_accessibility_tree`, `browser_inject_script`, `browser_execute_js`, `browser_click`, `browser_scroll`) are confirmed in `src/mcp-handler.js` with the documented parameter schemas (except the noted omissions/errors above).

### 6. SSE endpoint path
- `/sse` is correct -- Confirmed in `server.js`: `app.get('/sse', mcpHandler.handleSSE)`

### 7. Health endpoint returns `extensionConnected`
- Confirmed in `server.js`: `res.json({ status: 'ok', extensionConnected: extensionBridge.isConnected(), sessions: mcpHandler.getSessionCount() })`

### 8. Initial setup requires manual connect
- Confirmed: `popup.js` requires user to paste connection string and click Connect for initial setup. However, after initial setup, the extension auto-reconnects on browser startup (see Inaccuracy #8).

### 9. Extension popup views (Setup, Connected, Disconnected)
- The three documented views exist. (A fourth "Connecting" view also exists but was not documented -- see Inaccuracy #11.)

### 10. Extension settings
- **Focus new tabs** toggle: Confirmed, default is `false` (`result.focusNewTabs === true`, unchecked by default)
- **Tab organization** select: Confirmed, options are "Existing window" (`group`) and "New window" (`window`), default `group`
- **Both modes use cyan "WebPilot" tab group**: Confirmed in `handlers/tabs.js` -- window mode calls `addTabToGroup()` after creating/moving tabs

### 11. Forget button clears config and returns to Setup view
- Confirmed in `popup.js`: `handleForget()` sends `FORGET_CONFIG` message and shows setup view
- Confirmed in `background.js`: `FORGET_CONFIG` handler calls `disconnectWebSocket()`, clears storage, resets config and `isEnabled`

### 12. Troubleshooting: health endpoint check
- `curl http://localhost:3456/health` returning `extensionConnected` is valid and correct

### 13. Extension files listed in folder structure
- `manifest.json`, `background.js`, `accessibility-storage.js`, `accessibility-tree.js` all exist
- `handlers/click.js`, `handlers/scroll.js`, `handlers/tabs.js`, `handlers/accessibility.js`, `handlers/scripts.js` all exist
- `utils/windmouse.js`, `utils/mouse-state.js`, `utils/cursor.js`, `utils/scroll.js`, `utils/timing.js`, `utils/debugger.js` all exist
- `formatters/threads.js`, `formatters/threads_home.js`, `formatters/threads_activity.js`, `formatters/threads_search.js` all exist
- `popup/popup.html`, `popup/popup.css`, `popup/popup.js` all exist
- `icons/` directory exists

### 14. Manual extension reload instructions
- Edit files, go to `chrome://extensions/`, click refresh icon -- Standard and correct procedure

### 15. Claude Code MCP configuration
- `claude mcp add -s project --transport sse webpilot "http://localhost:3456/sse"` -- Valid command syntax
- `.mcp.json` format with `type: "sse"` and `url` -- Correct format

### 16. Reset extension via `chrome.storage.local.clear()`
- Valid approach; the extension stores config in `chrome.storage.local`

## Verified By

### Initial Audit
- **Date**: 2025-02-25
- **Method**: Manual code audit comparing every claim in `docs-old/README.md` against the actual source files in `packages/server-for-chrome-extension/` and `packages/chrome-extension-unpacked/`

### Verification Pass
- **Date**: 2026-02-25
- **Method**: Systematic verification of every audit claim against the actual codebase. Each inaccuracy, missing item, and verified-correct claim was checked by reading the relevant source files.
- **Files examined**:
  - `packages/server-for-chrome-extension/package.json` (scripts, dependencies, pkg config)
  - `packages/server-for-chrome-extension/index.js` (entry point, env vars, --network flag)
  - `packages/server-for-chrome-extension/cli.js` (CLI flags, background/foreground mode, service management)
  - `packages/server-for-chrome-extension/src/server.js` (startup output, endpoints, WebSocket auth, /connect endpoint)
  - `packages/server-for-chrome-extension/src/mcp-handler.js` (all 9 MCP tool definitions with full schemas)
  - `packages/server-for-chrome-extension/src/service/paths.js` (defaults, config loading, port/apiKey priority)
  - `packages/chrome-extension-unpacked/background.js` (350 lines, auto-reconnect on startup, command routing)
  - `packages/chrome-extension-unpacked/popup/popup.js` (views, settings, connection flow, parseConnectionString)
  - `packages/chrome-extension-unpacked/handlers/tabs.js` (tab group + window mode, both use addTabToGroup)
  - `packages/chrome-extension-unpacked/handlers/` (all 6 handler files: accessibility, click, keyboard, scripts, scroll, tabs)
  - `packages/chrome-extension-unpacked/utils/` (all 6 utility files: cursor, debugger, mouse-state, scroll, timing, windmouse)
  - `packages/chrome-extension-unpacked/formatters/` (9 files: 4 Threads + 5 Zillow)
  - `package.json` (root monorepo config with workspace scripts)
  - Directory listings of all relevant folders
- **Changes from initial audit**:
  - **UPDATED Inaccuracy #7**: Line count changed from 349 to 350, softened language since `~330` is an approximation
  - **ADDED Inaccuracy #8**: "Manual connect" claim is incorrect -- the extension auto-reconnects on browser startup if previously enabled (`chrome.runtime.onStartup` -> `loadConfig()` -> `connectWebSocket()`)
  - **ADDED Inaccuracy #12**: Tab organization "dedicated WebPilot window" phrasing is slightly misleading; actual UI label is "New window". Confirmed that both modes do use the cyan tab group (resolving the original audit's uncertainty)
  - **REMOVED old Inaccuracy #8 doubt**: The original audit questioned whether both modes use the tab group. Code review of `handlers/tabs.js` confirms they do -- `createTab()` calls `addTabToGroup()` in both group and window modes
  - **UPDATED Verified Correct #8**: Changed from "No auto-connect on startup" to "Initial setup requires manual connect" with cross-reference to new Inaccuracy #8
  - **UPDATED Verified Correct #10**: Added confirmation that both tab modes use the cyan tab group
  - **UPDATED Verified Correct #11**: Added detail about what `FORGET_CONFIG` does in `background.js`
  - **ADDED Missing #4 detail**: Expanded CLI flags list to include `--install`, `--uninstall`, `--stop`, `--status`, `--help`, `--version` (not just `--foreground`)
  - **ADDED Missing #11**: Root-level monorepo scripts (`dev:server`, `start`, `dist:win`, etc.)
  - **ADDED Missing #12**: Auto-reconnect retry logic (5s retry on non-auth failures, credential clear on auth failures)
