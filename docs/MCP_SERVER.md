# MCP Server Architecture

Node.js server that bridges AI agents to the Chrome extension(s), hosts the WebPilot web UI, and manages the local Chrome process. Exposes browser automation tools via the MCP protocol (over SSE) and communicates with each connected extension via WebSocket.

The server identifies itself to MCP clients as `WebPilot` in the `initialize` handshake (`serverInfo.name`, see `mcp-handler.js`).

## Overview

The MCP server is the middle layer between AI agents and the browser. It:

1. Accepts MCP connections from AI agents via Server-Sent Events (SSE)
2. Receives tool call requests (JSON-RPC 2.0) and authenticates them by API key
3. Routes each call to the Chrome profile bound to that key (per-agent routing) and forwards it to the corresponding extension WebSocket
4. Returns results to the agent via the SSE stream
5. Hosts the static web UI at `/ui` (Next.js export bundled into the pkg snapshot) and the supporting JSON API under `/api/ui/*`
6. Manages local Chrome state: detects whether Chrome is running with `--silent-debugger-extension-api`, can launch/kill+relaunch Chrome per profile, and tracks per-profile filesystem-mtime activity
7. Sends native OS notifications (Windows toast / macOS osascript / Linux notify-send) when a new pairing request arrives

MCP tool calls require a paired API key by default, except for `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, and `webpilot_reload_formatters`. The key can be provided via the `X-API-Key` HTTP header, the `apiKey` query parameter on the SSE/message endpoints, or as an `api_key` parameter in individual tool call arguments. The server's resolved key for each call drives both authentication and per-agent profile routing via `resolveTargetProfile` in `mcp-handler.js`.

The extension-facing WebSocket endpoint requires the server's WebSocket auth key (`?apiKey=`); the `/api/ui/*` REST and WebSocket endpoints are **localhost-only** and require no API key (rejected from non-loopback addresses with HTTP 403).

## Entry Points

The server has three entry points forming a chain:

```
cli.js  -->  index.js  -->  src/server.js
(binary)     (bootstrap)    (Express + WS setup)
```

### `cli.js`

Binary entry point. Parses command-line flags using Node 18's built-in `util.parseArgs`:

- `--install` / `--uninstall` / `--status` -- Service management (fully implemented, see [CLI and Background Service](#cli-and-background-service))
- `--stop` -- Kills a running server by reading its PID file, sends SIGTERM, and cleans up PID/port files (on Windows, SIGTERM kills immediately without running exit handlers, so manual file cleanup is required)
- `--foreground` -- Runs the server in the foreground (in the current process) instead of spawning a background daemon
- `--help` / `--version` -- Print help text or version from `package.json`
- `--network` -- Forwarded to `index.js` via `process.env.NETWORK = '1'` (also readable from `process.argv` in foreground mode, but the env var is the reliable mechanism since the background daemon spawns with empty args)
- No flags -- Starts the server as a **background daemon**: spawns a detached child process with `WEBPILOT_FOREGROUND=1` env var and exits. The `--foreground` flag (or the env var) is needed to run the server in the current process.

### `index.js`

Server bootstrap. Sets up logging via `setupLogging()` from `src/service/logger.js` (writes to the log path returned by `getLogPath()`), then reads configuration using a three-tier loading chain via `getPort()` and `getApiKey()` from `src/service/paths.js`:

1. **Config file** at `<dataDir>/config/server.json` (if it exists)
2. **Environment variables** (`PORT`, `API_KEY`) as fallback
3. **Hardcoded defaults** (`3456`, `dev-123-test`) as final fallback

| Source | Variable | Default | Description |
|--------|----------|---------|-------------|
| Config file / Environment | `PORT` | `3456` | HTTP/WebSocket port |
| Config file / Environment | `API_KEY` | `dev-123-test` | WebSocket authentication key |
| Environment / CLI flag | `NETWORK` / `--network` | `0` / off | Enable network mode if set to `1` |
| Data file | `network.enabled` | (absent) | Persisted network mode preference (`1` or `0`). Written by `POST /api/ui/settings/network-mode` from the web UI; the endpoint spawn-and-exits a replacement daemon so the new binding takes effect. If present, overrides both the `--network` flag and the `NETWORK` env var. |

In network mode, the server listens on `0.0.0.0` and advertises the machine's LAN IP address. In default mode, it listens on `127.0.0.1` only.

Calls `createServer()` from `src/server.js` with the resolved configuration.

### `src/server.js`

Sets up the Express HTTP server and two WebSocket servers (one for extensions, one for the web UI):

- Creates an Express app with CORS and JSON body parsing
- Creates an HTTP server and two `WebSocketServer`s in `noServer` mode (manual upgrade routing): the extension WS at the root path, and the web-ui events WS at `/api/ui/events`. Extension upgrades authenticate via `?apiKey=`; UI upgrades are accepted only from loopback addresses with no API key.
- Mounts the web UI static files at `/ui/` via a manual `fs.readFileSync` handler (express.static is bypassed so the pkg-snapshot patched `fs` works correctly). The static dir is resolved both in dev (`packages/server-web-ui/out`) and in pkg snapshot.
- Mounts the `/api/ui/*` REST endpoints (status, pairings, agents, profiles, chrome, server, settings) — see [Web UI API](#web-ui-api).
- On startup, calls `formatterManager.init()`, then `formatterUpdater.init(formatterManager)`. An immediate update check runs against GitHub (downloads formatters on first run if none exist locally), followed by hourly recurring checks. Also loads `notificationsSettings` and runs an initial `pairedKeys.cleanupExpiredPairings()` pass.
- Maintains an N-connection extension bridge keyed by Chrome profile directory name. Every extension WS connection runs a `hello` handshake (`profileId`, optional `email`, persistent `installId`) before any other messages are processed. The server uses `installId` to remember which profile an extension install belongs to (persisted in `<dataDir>/config/extension-installs.json`), and replies with `hello_ack` once the binding resolves.
- Handles WebSocket messages from the extension: `{ type: 'ping' }` → `{ type: 'pong' }` (keep-alive); `{ type: 'hello' }` → `{ type: 'hello_ack' }` or `{ type: 'identify_required' }`; `{ type: 'revoke_key' }`, `{ type: 'rename_agent' }`, `{ type: 'list_paired_agents' }` for paired-agent management; `{ type: 'check_formatter_updates' }` → `{ type: 'formatter_update_result' }`. `{ type: 'set_network_mode' }` and `{ type: 'set_pairing_required' }` are **deprecated** — the server logs and ignores them; network mode is now owned by `POST /api/ui/settings/network-mode`, and the pairing-required toggle has been retired (pairing is always on).
- Auto-opens the web UI in the default browser on `--foreground` start (via `service/open-browser.js`).
- On startup, opens `chromeManager` for the user's default Chrome `user-data-dir`. The manager is queried per tool call via a cheap PID liveness check, with full re-detection only on cache miss.
- Writes `server.pid` and `server.port` files to the data directory on listen; cleans them up on SIGTERM, SIGINT, and `exit` events
- Mounts MCP handler routes (`GET /sse`, `POST /message`)
- Exposes `GET /health` (server status with `extensionConnected` and `sessions` count) and `GET /connect` (returns `apiKey`, `serverUrl`, `sseUrl`, and `networkMode` for extension auto-connect)

## Source Files

### `src/mcp-handler.js`

Implements the MCP protocol:

- **SSE session management** -- Each `GET /sse` request creates a session with a UUID. The session ID is sent as the first SSE event so the client knows where to POST messages. Each session maintains a message queue that is flushed every 100ms via `setInterval`, plus a separate keepalive comment sent every 30 seconds. On client disconnect, both intervals are cleared and the session is removed from the Map.
- **Message handling** -- `POST /message?session_id=<id>` processes JSON-RPC requests and queues responses for delivery via the SSE stream. Late-arriving API keys (sent on `/message` requests via `X-API-Key` header or `apiKey` query parameter) update the session's stored key. The `processMessage` function enforces authentication on `tools/call` requests: it checks `session.mcpApiKey` first, then falls back to `params.arguments.api_key`, and validates the effective key via `pairedKeys.validateKey()`. The auth-exempt set is `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, and `webpilot_reload_formatters`. After successful authentication, `pairedKeys.touchKey()` is called to update the key's `lastAccessed` timestamp.
- **Per-agent profile routing** -- `resolveTargetProfile(apiKey)` looks up the entry's `profileId` (set during approval or via `PATCH /api/ui/agents/:key`) and returns it. Tool calls are then routed to the extension WS bound to that profile via `extensionBridge.sendCommand(..., { profileId })`. Legacy entries with `profileId: null` fall back to the server-wide `managedProfile` config. The auth gate's resolved key is threaded into `handleToolCall(params, effectiveKey)` so routing and auth share a single key resolution.
- **request_pairing short-circuit** -- If the caller already presents a valid API key, `request_pairing` returns the existing identity (`agentName`, `profileId`) instead of minting a new pending entry. This handles subagents that inherit `.mcp.json` from a parent and reflexively re-pair.
- **Protocol methods** -- Handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- **Tool routing** -- Maps MCP tool names to extension command types and parameters.
- **Server-side formatting** -- For `browser_get_accessibility_tree`, the server receives raw nodes from the extension and formats them via `formatterManager.formatTree(url, nodes)`. Passing `usePlatformOptimizer: false` forces the default formatter instead of a platform-matched one. After formatting, ancestry context is built using `extractAncestryContext`, and a `store_refs` notification is pushed to the extension via `extensionBridge.notify()`.
- **Script fetching** -- For `browser_inject_script`, the server fetches the script from the provided URL before sending the content to the extension. This allows injecting scripts from localhost or external URLs regardless of page CSP.
- **Chain execution** -- `browser_request_chain` is handled entirely server-side. It calls `handleToolCall()` internally for each step and never sends a command directly to the extension bridge.
- `createMcpHandler()` accepts 5 parameters: the Express app, extension bridge, paired keys store, formatter manager, and an `isPairingRequired` getter function (returns a boolean indicating whether API key authentication is currently enforced).

### `src/extension-bridge.js`

WebSocket bridge supporting **multiple simultaneous extension connections**, keyed by Chrome profile directory name. One extension install per profile is expected; the most recent connection wins for a given profile.

- `setConnection(ws, profileId)` / `clearConnection(ws)` / `getConnectedProfiles()` -- per-profile connection lifecycle. `clearConnection(ws)` only removes the matching profile, not all connections.
- `sendCommand(type, params, { profileId })` -- Sends a command to the extension bound to `profileId` (resolved by per-agent routing in the MCP handler). Returns a Promise that resolves on matching response, or rejects on timeout (30 seconds) or disconnect.
- `notify(message, { profileId })` / `notifyAll(message)` -- Push-only fire-and-forget. Used for `store_refs` after formatting, `paired_agents_list` broadcasts after approve/revoke/rename, and similar.
- `handleResponse(message)` -- Routes incoming responses to their pending Promise by ID.

### `src/extension-installs.js`

Persistent `installId → profileId` map (`<dataDir>/config/extension-installs.json`). The extension mints a UUID `webpilot.installId` on first install (kept across `FORGET_CONFIG` resets), sends it in the `hello` handshake, and the server uses it to skip the profile-picker UI on subsequent connects. Includes housekeeping to drop entries with `lastResolved` older than 90 days.

### `src/chrome/`

Chrome process management (cross-platform):

- `manager.js` -- `ChromeManager` orchestrates detect/close/launch with a PID-based cache. `getStatus()` is O(1) liveness; `refresh()` runs full detection; `ensureReady(profiles)` is the readiness gate (no-op if Chrome is already running with the flag and the right profiles; otherwise kill+relaunch).
- `detector.js` + per-OS modules (`windows-detector.js`, `macos-detector.js`, `linux-detector.js`) -- enumerate Chrome processes, identify the "browser parent" (no `--type=`), parse its command line for `--silent-debugger-extension-api`.
- `launcher.js` -- Spawns Chrome detached with `--profile-directory=<name>` and the silent-debugger flag. Only passes `--user-data-dir` when non-default.
- `closer.js` -- Graceful close. On Windows uses `PostMessage(WM_CLOSE)` on every visible Chrome HWND so multi-window processes shut down cleanly.
- `profile-activity.js` -- Filesystem-mtime check for "active in last N seconds" on per-profile session files.
- `local-state.js` -- Reads the profile list from `<user-data-dir>/Local State`.
- `paths.js` -- Per-OS default Chrome binary path + default user-data-dir.

### `src/notifications/`

Cross-platform native notifications fired on new pairing requests:

- `windows.js` -- Windows toast via `ToastNotificationManager` + PowerShell. Self-registers `WebPilot.MCPServer` AppUserModelID under `HKCU\Software\Classes\AppUserModelId\` on every call (Windows silently drops toasts whose AppUserModelID isn't registered). The toast is clickable: `activationType="protocol" launch="<webUiUrl>"` hands the URL to the default browser when the user clicks the toast.
- `macos.js` -- `osascript display notification` (no native click handler).
- `linux.js` -- `notify-send` (no native click handler).
- `index.js` -- Dispatches by `process.platform`; honors per-user prefs from `notifications-settings.js` (system notifications on/off, sound on/off).

### `src/notifications-settings.js`

Reads / writes `<dataDir>/config/notifications.json` (`systemNotifications`, `sound`). Eagerly loaded at startup; consulted by the pairing-notification call site.

### `src/paired-keys.js`

Manages paired agent API keys **and** the async pending-pairings ledger:

- `<dataDir>/config/paired-keys.json` -- approved/active agents, each entry `{ key, agentName, profileId, createdAt, lastAccessed, source? }`.
- `<dataDir>/config/pending-pairings.json` -- async pairing ledger. Pending entries TTL out at 24 hours of inactivity; terminal-state entries (approved/denied/expired) are hard-dropped after 7 days by the periodic cleanup.

Key APIs:

- `requestPairing(agentName)` -- Idempotent. Returns the existing pending/approved entry for this `agentName`, or mints a new pending entry with a fresh `pairingId` (UUID). The `created` flag tells the caller whether a fresh entry was minted (so they can fire the system notification only on first creation).
- `approvePairing(pairingId, { profileId })` -- Moves a pending entry to approved, mints an API key via `addKey(agentName, profileId, /*source*/ null)`, and returns the new entry. The `profileId` is the Chrome profile directoryName the operator picked in the web UI.
- `denyPairing(pairingId)` -- Marks a pending entry as denied.
- `createPairedAgent({ agentName, profileId })` -- **Direct pre-provisioning** path used by `POST /api/ui/agents` (no `request_pairing` round-trip). Mints a key directly with `source: 'web-ui-direct'` for audit.
- `updateProfileBinding(apiKey, profileId)` -- Field-flip used by `PATCH /api/ui/agents/:key` to re-bind an existing agent to a different profile. No socket teardown — routing re-resolves per call.
- `validateKey(apiKey)` -- Returns the entry object or null. Called by both the auth gate and `resolveTargetProfile` (currently twice per tool call; see `QOL_FOLLOWUPS.md` P2).
- `touchKey(apiKey)` -- Updates `lastAccessed`. Called on every authenticated tool call.
- `renameKey(apiKey, newName)`, `revokeKey(apiKey)`, `listKeys()` -- standard CRUD + listing. `listKeys()` returns `{ agentName, createdAt, lastAccessed, key, keyDisplay, profileId }`.
- `listPendingPairings()`, `listAllPairings()` -- read the async ledger. `listAllPairings()` returns terminal-state pairings too (used by `GET /api/ui/pairings/history`).
- `cleanupExpiredPairings()` -- expiry + housekeeping pass; runs at startup and every hour.

### `src/formatter-manager.js`

Loads and runs accessibility tree formatters:

- `init()` -- Creates the `custom-formatters/` directory if absent and seeds an empty `manifest.json` there. Reads and merges the auto-updated manifest (`formatters/`) with the custom manifest (`custom-formatters/`). Custom platform entries override auto-updated ones with the same key. If no auto-updated manifest exists yet (first run), defers to the updater while still loading any custom formatters.
- `getCustomFormatterDir()` -- Returns the absolute path to `{dataDir}/custom-formatters/`.
- `formatTree(url, rawNodes)` -- Matches the URL's hostname against platform entries in the merged manifest and runs the matched formatter. Resolves formatter file paths from `custom-formatters/` for custom platforms and `formatters/` for auto-updated ones. Falls back to the default formatter (always from `formatters/`) if no platform matches.
- `reload()` -- Clears the require cache for all loaded formatter modules and re-merges both manifests. Called after an auto-update is applied and on each `webpilot_get_formatter_info` call.
- `getFormatterInfo(platform?)` -- Returns formatter metadata including `customFormatterDir` path and a `source: "auto-updated" | "custom"` field per platform. Triggers `reload()` so callers always see the latest state.

### `src/formatter-updater.js`

GitHub-based auto-updater for accessibility tree formatters:

- `init(manager)` -- Wires the updater to the given formatter manager instance. Runs an immediate update check on startup, then schedules recurring checks every hour.
- `checkForUpdates()` -- Fetches the remote manifest from `raw.githubusercontent.com/Jtonna/WebPilot/main/accessibility-tree-formatters/manifest.json`, compares versions against the locally installed manifest, downloads all files listed in the `files` array for any updated formatters, then calls `manager.reload()`. Each fetch uses a 10-second timeout.

## MCP Tools

Fourteen tools are exposed to AI agents. All tools except `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, and `webpilot_reload_formatters` require a valid paired API key and a connected extension for the agent's bound Chrome profile. Every tool except `request_pairing` and `check_pairing_status` includes an optional `api_key` string parameter in its schema, allowing per-call authentication as an alternative to the session-level `X-API-Key` header. `agent_name` is required only on `request_pairing`; other tools route via `resolveTargetProfile(apiKey)` and do not look at the agent name.

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `request_pairing` | Initiate **async** pairing — returns a `pairing_id` immediately; the human approves via the web UI. Short-circuits and returns the existing identity if the caller already presents a valid API key. | `agent_name` |
| `check_pairing_status` | Poll the status of a pending `pairing_id`. When `approved`, returns the `api_key`. | `pairing_id` |
| `browser_create_tab` | Open a new tab with a URL | `url` |
| `browser_close_tab` | Close a tab by ID | `tab_id` |
| `browser_get_tabs` | List all open tabs | (none) |
| `browser_get_accessibility_tree` | Get the accessibility tree of a tab. Server formats the raw nodes via `formatterManager.formatTree`; set `usePlatformOptimizer: false` to force the default formatter. Sends a `store_refs` notification to the extension as a side-effect. | `tab_id`, `usePlatformOptimizer?` |
| `browser_inject_script` | Inject a script from a URL into a tab | `tab_id`, `script_url`, `keep_injected?` |
| `browser_execute_js` | Execute JavaScript in page context | `tab_id`, `code` |
| `browser_click` | Click by ref, selector, or coordinates | `tab_id`, `ref?`, `selector?`, `x?`, `y?`, `button?`, `clickCount?`, `delay?`, `showCursor?` |
| `browser_scroll` | Scroll to element or by pixel amount | `tab_id`, `ref?`, `selector?`, `pixels?` |
| `browser_type` | Type text with CDP keyboard simulation | `tab_id`, `text`, `ref?`, `selector?`, `delay?`, `pressEnter?` |
| `browser_request_chain` | Execute multiple tool calls sequentially with result referencing | `steps`, `return_mode?` |
| `webpilot_get_formatter_info` | Get info on available platform-specific formatters and instructions for creating custom platform optimizers | `platform?` |
| `webpilot_reload_formatters` | Reload all formatters without server restart | (none) |

### `browser_request_chain`

Executes an array of tool calls sequentially within a single MCP request. Each step specifies a `tool` name and `arguments` object. String argument values can reference prior step results using `$N.path.to.value` syntax (e.g., `$0.tab_id` resolves to the `tab_id` field from step 0's result).

Pre-validation runs before any step executes: all tool names must be valid (and cannot be `browser_request_chain` itself), and all `$N` references must point to earlier steps. If any step fails during execution, the response includes partial results from completed steps plus an error object identifying the failed step.

The `return_mode` parameter controls the response shape: `"all"` (default) returns an array of all step results, `"last"` returns only the final step's raw result.

## Communication Flow

```
AI Agent                MCP Server              Chrome Extension          Browser
   |                       |                          |                      |
   |-- GET /sse ---------->|                          |                      |
   |<-- endpoint event ----|                          |                      |
   |                       |                          |                      |
   |-- POST /message ----->|                          |                      |
   |   (tools/call)        |                          |                      |
   |                       |-- WebSocket command ---->|                      |
   |                       |   {id, type, params}     |                      |
   |                       |                          |-- Chrome API ------->|
   |                       |                          |   (tabs, debugger,   |
   |                       |                          |    scripting)        |
   |                       |                          |<-- result -----------|
   |                       |<-- WebSocket response ---|                      |
   |                       |   {id, success, result}  |                      |
   |<-- SSE message -------|                          |                      |
   |   (JSON-RPC result)   |                          |                      |
```

## HTTP Endpoints

The MCP/extension surfaces:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sse` | API key (per-tool-call auth gate) | SSE stream for MCP communication |
| POST | `/message?session_id=<id>` | API key (per-tool-call auth gate) | JSON-RPC message endpoint |
| GET | `/health` | None | Server status (`extensionConnected`, `sessions` count) |
| GET | `/connect` | None | Returns `{ apiKey, serverUrl, sseUrl, networkMode }` for extension auto-connect |
| WS | `/` (upgrade) | `?apiKey=<key>` | Extension WebSocket connection (multi-extension support, keyed by `profileId`) |

The web UI / management surfaces (localhost-only — non-loopback rejected with HTTP 403):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/ui/...` | Static web UI (Next.js export) served via `fs.readFileSync` for pkg-snapshot compatibility |
| WS | `/api/ui/events` (upgrade) | Web UI event stream (pairing changes, agent changes, extension connect/disconnect) |
| GET | `/api/ui/status` | Snapshot: Chrome status, profiles with per-profile `webPilotStatus` (`active`/`ready`/`needs_setup`), `connectedProfiles`, `pendingPairings`, `pairedAgents`, `networkMode`, `paths`, `notifications`, `port` |
| POST | `/api/ui/pairings/:id/approve` | Body `{ profileId, newProfileName? }`. Approves a pending pairing and binds it to the given profile (or to a freshly-created sandbox profile when `profileId === '__new__'`). Returns 409 on terminal state. |
| POST | `/api/ui/pairings/:id/deny` | Denies a pending pairing. Returns 409 on terminal state. |
| GET | `/api/ui/pairings/history` | Cursor-paginated terminal-state pairings (approved/denied/expired) sorted by `decidedAt` DESC. |
| POST | `/api/ui/profiles` | Create a new sandbox Chrome profile by directoryName (validated). |
| POST | `/api/ui/agents` | **Pre-provision** a paired agent without `request_pairing`. Body `{ agentName, profileId }`. Returns 201 with `{ apiKey, agentName, profileId, createdAt }`. |
| POST | `/api/ui/agents/:key/rename` | Rename. |
| PATCH | `/api/ui/agents/:key` | **Re-bind** the agent to a different profile. Body `{ profileId }`. Routing picks up the new binding on the next tool call. |
| DELETE | `/api/ui/agents/:key` | Revoke a paired agent. |
| POST | `/api/ui/chrome/restart` | Calls `chromeManager.ensureReady()` — no-op if Chrome is already running with the flag and the right profiles; otherwise kill+relaunch. |
| POST | `/api/ui/server/restart` | Spawn-and-exit replacement daemon (identical pattern to the network-mode toggle). |
| GET / POST | `/api/ui/settings/notifications` | Get/set notification preferences (`systemNotifications`, `sound`). |
| POST | `/api/ui/settings/network-mode` | Body `{ enabled }`. Persists the preference and spawn-and-exits to rebind to `0.0.0.0` (or back to `127.0.0.1`). |

## Configuration

Configuration is resolved in order of priority: config file, then environment variables, then hardcoded defaults.

### Config File

The server reads `<dataDir>/config/server.json` if it exists. This file can specify `port` and `apiKey`. See [Data Directory](#data-directory) for the data directory location.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port (overridden by config file if present) |
| `API_KEY` | `dev-123-test` | API key for WebSocket authentication (overridden by config file if present) |
| `NETWORK` | `0` | Set to `1` for network mode (overridden by `<dataDir>/network.enabled` if present) |
| `WEBPILOT_FOREGROUND` | unset | Set to `1` to run in foreground (used internally by daemon self-spawn) |

### Network Mode

By default the server only accepts extension/MCP connections from `localhost`. Use `--network` flag or `NETWORK=1` to listen on all interfaces:

```bash
npm run dev:network     # Development with auto-reload
npm run start:network   # Production
```

In network mode, the server prints the machine's LAN IP so other devices can connect.

Network mode can also be toggled at runtime from the web UI's Settings page (`POST /api/ui/settings/network-mode`). The endpoint:

1. Persists the preference to `<dataDir>/network.enabled` (survives restarts)
2. Spawn-and-exits a replacement daemon (clean process restart, not an in-process rebind)
3. The new daemon binds to the chosen interface on startup

The `/api/ui/*` REST and WebSocket surfaces remain **localhost-only** even when network mode is enabled. Only the extension WS / MCP SSE endpoints become reachable over LAN.

> The legacy `set_network_mode` WebSocket message (sent by old extension popups) is now deprecated — the server logs and ignores it. The Chrome extension no longer carries a network-mode toggle.

## CLI and Background Service

### Service Management

The CLI (`cli.js`) supports `--install`, `--uninstall`, and `--status` flags for background service management. These are fully implemented across all three platforms:

| Platform | Service Mechanism | Implementation |
|----------|-------------------|----------------|
| Windows  | Registry Run key (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) — no admin elevation required | `src/service/windows.js` |
| macOS    | launchd (LaunchAgent plist) | `src/service/macos.js` |
| Linux    | systemd (user service unit) | `src/service/linux.js` |

Each platform module provides complete `install()`, `uninstall()`, and `status()` functions with PID/port file management, PID-alive validation, and detailed status output.

**Note (dead code)**: Two of the three platform service modules (Windows and macOS) compute a `portListening` variable (checking whether the port is actually listening via netstat/lsof) but never use it in the status output or return value. Linux's `status()` has no port-listening check.

### Background Daemon

Running the CLI with no flags starts the server as a background daemon:

1. Checks for a stale PID file and cleans it up if the process is no longer alive
2. If a server is already running (valid PID file), prints its status and exits
3. Spawns a detached child process with `WEBPILOT_FOREGROUND=1` env var (this avoids a pkg binary issue where `spawn(process.execPath, ['--foreground'])` treats the flag as a module path)
4. Polls the `/health` endpoint to verify startup (6 attempts, 500ms apart)
5. Auto-registers the service on first run (calls `service.install()` if not already registered)

Use `--foreground` (or set `WEBPILOT_FOREGROUND=1`) to run the server in the current process instead of daemonizing.

### Daemon Logging

Background daemon output is captured by a size-managed log writer (`src/service/logger.js`):

- Intercepts `process.stdout.write` and `process.stderr.write` for dual capture
- Uses synchronous `fs.appendFileSync` for guaranteed flush (avoids buffering issues on Windows)
- Strips ANSI escape codes for clean log files
- Log file is truncated fresh on each startup
- Maximum log size: 1 GB; when exceeded, drops the oldest 25% of the log (automatic rotation)
- Log file location: `<dataDir>/daemon.log`

### PID and Port Files

- `src/server.js` writes `server.pid` and `server.port` to the data directory when the server starts listening
- Cleaned up on process exit via SIGTERM, SIGINT, and `exit` event handlers
- `cli.js` validates and cleans up stale PID/port files when checking if a server is already running
- `--stop` reads the PID file, sends SIGTERM, and manually cleans up the files (necessary on Windows where SIGTERM kills immediately without running exit handlers)

### Data Directory

The data directory location depends on the execution mode:

- **pkg binary mode**: `../../data/` relative to the executable path (designed for the Electron deployment layout)
- **Dev mode**: Platform-specific user-local config directory:
  - Windows: `%LOCALAPPDATA%\WebPilot`
  - macOS: `~/Library/Application Support/WebPilot`
  - Linux: `$XDG_CONFIG_HOME/WebPilot` (defaults to `~/.config/WebPilot`)

Contents: `daemon.log`, `server.pid`, `server.port`, `network.enabled` (persisted network mode preference), `logs/` subdirectory, `config/server.json`, `config/paired-keys.json` (approved paired agents and their `profileId` bindings), `config/pending-pairings.json` (async pairing ledger with 24h pending TTL + 7-day terminal-state retention), `config/extension-installs.json` (persistent `installId → profileId` map; cleaned up after 90 days), `config/notifications.json` (per-user notification preferences), `formatters/` (contains `manifest.json` and formatter JS files; downloaded from GitHub on first run and kept up to date by the auto-updater), `custom-formatters/` (user-managed formatters that override auto-updated ones for the same domain; never touched by the auto-updater)

## Build

The server compiles to standalone binaries via `@yao-pkg/pkg`. Use the platform-specific build commands (`npm run build` prints an error and exits):

```bash
npm run build:win    # node18-win-x64
npm run build:mac    # node18-macos-x64
npm run build:linux  # node18-linux-x64
```

Output directory: `dist/`.

The compiled binary includes Node.js, all dependencies, and the server source. It can run on machines without Node.js installed. The `cli.js` file is the `bin` entry point in `package.json`, so pkg uses it as the binary's main entry. Formatters are not bundled in the binary -- they are downloaded from GitHub on first run.

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and routing |
| `cors` | Cross-origin resource sharing |
| `ws` | WebSocket server |
| `uuid` | UUID generation for session and command IDs |
| `@yao-pkg/pkg` (dev) | Compile to standalone binaries |
