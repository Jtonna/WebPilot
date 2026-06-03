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

MCP tool calls require a paired API key by default, except for `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, and `webpilot_dev_get_formatter_logs`. The key can be provided via the `X-API-Key` HTTP header, the `apiKey` query parameter on the SSE/message endpoints, or as an `api_key` parameter in individual tool call arguments. The server's resolved key for each call drives both authentication and per-agent profile routing via `resolveTargetProfile` in `mcp-handler.js`.

The extension-facing WebSocket endpoint identifies the connecting extension by `?installId=<uuid>` — there is no shared transport key. The `/api/ui/*` REST and WebSocket endpoints are **localhost-only** and require no API key (rejected from non-loopback addresses with HTTP 403).

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

Server bootstrap. Sets up logging via `setupLogging()` from `src/service/logger.js` (writes to the log path returned by `getLogPath()`), then reads configuration using a two-tier loading chain via `getPort()` from `src/service/paths.js`:

1. **Config file** at `<dataDir>/config/server.json` (if it exists)
2. **Environment variables** (`PORT`) as fallback
3. **Hardcoded defaults** (`3456`) as final fallback

The `apiKey` field in `server.json` (and the legacy `API_KEY` env var) is no longer consulted — the shared transport key has been retired. Any value present in `server.json` is silently ignored.

| Source | Variable | Default | Description |
|--------|----------|---------|-------------|
| Config file / Environment | `PORT` | `3456` | HTTP/WebSocket port |
| Environment / CLI flag | `NETWORK` / `--network` | `0` / off | Enable network mode if set to `1` |
| SQLite row | `config.network_enabled` | (absent) | Persisted network mode preference (`'true'` / `'false'`). Written by `POST /api/ui/settings/network-mode` from the web UI; the endpoint spawn-and-exits a replacement daemon so the new binding takes effect. If present, overrides both the `--network` flag and the `NETWORK` env var. The legacy `<dataDir>/network.enabled` flag file is read as a fallback only when the DB row is absent (first-boot path) — migration imports it on first boot and renames it to `network.enabled.imported.<ISO>`. |

In network mode, the server listens on `0.0.0.0` and advertises the machine's LAN IP address. In default mode, it listens on `127.0.0.1` only.

Calls `createServer()` from `src/server.js` with the resolved configuration.

### `src/server.js`

Sets up the Express HTTP server and two WebSocket servers (one for extensions, one for the web UI):

- Creates an Express app with CORS and JSON body parsing
- Creates an HTTP server and two `WebSocketServer`s in `noServer` mode (manual upgrade routing): the extension WS at the root path, and the web-ui events WS at `/api/ui/events`. Extension upgrades require `?installId=<uuid>` on the URL — the server records the mapping in `extension_installs` and uses it purely for routing (claiming any installId grants zero agent power; agent-layer auth is the security boundary for tool calls). UI upgrades are accepted only from loopback addresses with no API key.
- Mounts the web UI at `/ui/`. In production (and inside the pkg snapshot), serves the Next.js static export via a manual `fs.readFileSync` handler (express.static is bypassed so the pkg-snapshot patched `fs` works correctly). In dev (`WEBPILOT_DEV=1`, set by `npm run dev` at the repo root), instead proxies `/ui/*` to `http://localhost:3100` via `http-proxy-middleware` with `ws: true` so Next.js HMR works. The pkg/Electron path never sets `WEBPILOT_DEV` so installed users always go through the static branch.
- Mounts the `/api/ui/*` REST endpoints (status, pairings, agents, profiles, chrome, server, settings) — see [Web UI API](#web-ui-api).
- On startup, calls `formatterManager.init()`, then `formatterUpdater.init(formatterManager)`. An immediate update check runs against GitHub (downloads formatters on first run if none exist locally), followed by hourly recurring checks. Also loads `notificationsSettings`, runs an initial `pairedKeys.cleanupExpiredPairings()` pass, and runs `pairedKeys.cleanupUnusedKeys()` to auto-revoke 48h-stale never-used keys. Both cleanup passes also run hourly thereafter.
- Maintains an N-connection extension bridge keyed by Chrome profile directory name. Every extension WS connection runs a `hello` handshake (`profileId`, optional `gaiaEmail` (the field name on the wire), persistent `installId`) before any other messages are processed. The server uses `installId` to remember which profile an extension install belongs to (persisted in the `extension_installs` SQLite table), and replies with `hello_ack` once the binding resolves. A 5-second server-side `helloDeadline` watchdog pushes `identify_required` pre-emptively if the extension never sends `hello` in time (see `server.js`).
- Handles WebSocket messages from the extension: `{ type: 'ping' }` → `{ type: 'pong' }` (keep-alive); `{ type: 'hello' }` → `{ type: 'hello_ack' }` or `{ type: 'identify_required' }`; `{ type: 'revoke_key' }`, `{ type: 'rename_agent' }`, `{ type: 'list_paired_agents' }` for paired-agent management; `{ type: 'check_formatter_updates' }` → `{ type: 'formatter_update_result' }`. `{ type: 'set_network_mode' }` and `{ type: 'set_pairing_required' }` are **deprecated** — the server logs and ignores them; network mode is now owned by `POST /api/ui/settings/network-mode`, and the pairing-required toggle has been retired (pairing is always on).
- Auto-opens the web UI in the default browser on `--foreground` start (via `service/open-browser.js`).
- On startup, opens `chromeManager` for the user's default Chrome `user-data-dir`. The manager is queried per tool call via a cheap PID liveness check, with full re-detection only on cache miss.
- Writes `server.pid` and `server.port` files to the data directory on listen; cleans them up on SIGTERM, SIGINT, and `exit` events
- Mounts MCP handler routes (`GET /sse`, `POST /message`)
- Exposes `GET /health` (server status with `extensionConnected`, `connectedProfiles`, and `sessions` count) and `GET /connect` (returns `serverUrl`, `sseUrl`, and `networkMode` for extension auto-connect — no credentials; the extension's own installId is its identity)

## Source Files

### `src/mcp-handler.js`

Implements the MCP protocol:

- **SSE session management** -- Each `GET /sse` request creates a session with a UUID. The session ID is sent as the first SSE event so the client knows where to POST messages. Each session maintains a message queue that is flushed every 100ms via `setInterval`, plus a separate keepalive comment sent every 30 seconds. On client disconnect, both intervals are cleared and the session is removed from the Map.
- **Message handling** -- `POST /message?session_id=<id>` processes JSON-RPC requests and queues responses for delivery via the SSE stream. Late-arriving API keys (sent on `/message` requests via `X-API-Key` header or `apiKey` query parameter) update the session's stored key. The `processMessage` function enforces authentication on `tools/call` requests: it checks `session.mcpApiKey` first, then falls back to `params.arguments.api_key`, and validates the effective key via `pairedKeys.validateKey()`. The auth-exempt set is `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, and `webpilot_dev_get_formatter_logs`. After successful authentication, `pairedKeys.touchKey()` is called to update the key's `lastAccessed` timestamp. Auth enforcement is gated by `isPairingRequired()` — the server retains a legacy code path where pairing-required can be disabled. In the current build it is always true.
- **Per-agent profile routing** -- `resolveTargetProfile(apiKey)` looks up the entry's `profileId` (set during approval or via `PATCH /api/ui/agents/:key`) and returns it. Tool calls are then routed to the extension WS bound to that profile via `extensionBridge.sendCommand(profileId, ...)`. Legacy entries with `profileId: null` fall back to the server-wide `managedProfile` config. The auth gate's resolved key is threaded into `handleToolCall(params, effectiveKey)` so routing and auth share a single key resolution.
- **request_pairing short-circuit** -- If the caller already presents a valid API key, `request_pairing` returns the existing identity (`agentName`, `profileId`) instead of minting a new pending entry. This handles subagents that inherit `.mcp.json` from a parent and reflexively re-pair.
- **Protocol methods** -- Handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- **Tool routing** -- Maps MCP tool names to extension command types and parameters.
- **Server-side formatting** -- For `browser_get_accessibility_tree`, the server receives raw nodes from the extension and formats them via `formatterManager.formatTree(url, nodes)`. Passing `usePlatformOptimizer: false` forces the default formatter instead of a platform-matched one. After formatting, ancestry context is built using `extractAncestryContext`, and a `store_refs` notification is pushed to the extension via `extensionBridge.notify()`.
- **Script fetching** -- For `browser_inject_script`, the server fetches the script from the provided URL before sending the content to the extension. This allows injecting scripts from localhost or external URLs regardless of page CSP.
- **Chain execution** -- `browser_request_chain` is handled entirely server-side. It calls `handleToolCall()` internally for each step and never sends a command directly to the extension bridge.
- `createMcpHandler(extensionBridge, pairedKeys, formatterManager, isPairingRequired, options)` — 4 positional dependencies plus an options object (`options.port`, `options.chromeManager`). The `apiKey` positional parameter was retired in `f7f2bb8` along with the shared transport key. The Express app is NOT passed; routes are mounted by the caller using the returned `handleSSE` and `handleMessage` functions.

### `src/extension-bridge.js`

WebSocket bridge supporting **multiple simultaneous extension connections**, keyed by Chrome profile directory name. One extension install per profile is expected; the most recent connection wins for a given profile.

- `setConnection(profileId, ws)` / `clearConnection(ws)` / `getConnectedProfiles()` -- per-profile connection lifecycle. `clearConnection(ws)` only removes the matching profile, not all connections.
- `sendCommand(profileId, type, params, options)` — `profileId` is the first positional arg. Sends a command to the extension bound to that profile (resolved by per-agent routing in the MCP handler). Returns a Promise that resolves on matching response, or rejects on timeout (30 seconds) or disconnect.
- `notify(profileId, message)` / `notifyAll(message)` -- Push-only fire-and-forget. Used for `store_refs` after formatting, `paired_agents_list` broadcasts after approve/revoke/rename, and similar.
- `handleResponse(message)` -- Routes incoming responses to their pending Promise by ID.

### `src/extension-installs.js`

Persistent `installId → profileId` map. SQLite-backed (P2 phase 7) via the `extension_installs` table — replaces the legacy `<dataDir>/config/extension-installs.json` JSON store (imported on first boot and renamed to `.imported.<TS>`). The extension mints a UUID `webpilot.installId` on first install (kept across `FORGET_CONFIG` resets), sends it in the `hello` handshake, and the server uses it to skip the profile-picker UI on subsequent connects. Includes housekeeping to drop entries with `last_seen_at` older than 90 days.

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

Manages paired agent API keys **and** the async pending-pairings ledger. SQLite-backed (P2 phase 2) — replaces the legacy JSON stores `<dataDir>/config/paired-keys.json` and `<dataDir>/config/pending-pairings.json` (imported on first boot and renamed to `.imported.<TS>`):

- `agents` table — approved/active agents, columns `{ id, name, api_key_hash, profile_id, created_at, last_seen_at, state }`. API keys are HMAC-SHA-256 hashed with a per-server pepper stored in `config.api_key_pepper`.
- `pairings` table — async pairing ledger, columns `{ id, pairing_id, agent_name, requested_at, expires_at, decided_at, state, approved_agent_id, metadata_json }`. Pending entries TTL out at 24 hours of inactivity; terminal-state entries (approved/denied/expired) are hard-dropped after 7 days by the periodic cleanup.

Key APIs:

- `requestPairing(agentName)` -- Idempotent. Returns the existing pending/approved entry for this `agentName`, or mints a new pending entry with a fresh `pairingId` (UUID). The `created` flag tells the caller whether a fresh entry was minted (so they can fire the system notification only on first creation).
- `approvePairing(pairingId, { profileId })` -- Moves a pending entry to approved, mints an API key via `addKey(agentName, profileId, /*source*/ null)`, and returns the new entry. The `profileId` is the Chrome profile directoryName the operator picked in the web UI.
- `denyPairing(pairingId)` -- Marks a pending entry as denied.
- `createPairedAgent({ agentName, profileId })` -- **Direct pre-provisioning** path used by `POST /api/ui/agents` (no `request_pairing` round-trip). Mints a key directly with `source: 'web-ui-direct'` for audit.
- `updateProfileBinding(apiKey, profileId)` -- Field-flip used by `PATCH /api/ui/agents/:key` to re-bind an existing agent to a different profile. No socket teardown — routing re-resolves per call.
- `validateKey(apiKey)` -- Returns the entry object or null. Reads from an in-memory cache populated lazily on first read and invalidated on every write via `saveKeys()`; an mtime-compare also picks up external edits on the next read. Called by both the auth gate and `resolveTargetProfile`, but each call is an in-memory lookup rather than a disk read.
- `touchKey(apiKey)` -- Updates `lastAccessed`. Called on every authenticated tool call.
- `renameKey(apiKey, newName)`, `revokeKey(apiKey)`, `listKeys()` -- standard CRUD + listing. `listKeys()` returns `{ agentName, createdAt, lastAccessed, key, keyDisplay, profileId }`.
- `listPendingPairings()`, `listAllPairings()` -- read the async ledger. `listAllPairings()` returns terminal-state pairings too (used by `GET /api/ui/pairings/history`).
- `cleanupExpiredPairings()` -- expiry + housekeeping pass; runs at startup and every hour.
- `cleanupUnusedKeys()` runs at startup and hourly. Any paired-keys entry whose `lastAccessed` is still `null` more than 48 hours after `createdAt` is revoked — prevents the agents list from accumulating dead keys that were copied but never used. Used keys (any tool call → `lastAccessed` set) are kept indefinitely. Entries with missing/unparseable `createdAt` are skipped defensively. The threshold is the `UNUSED_KEY_EXPIRY_MS` constant at the top of `paired-keys.js`. When the pass revokes anything, `server.js` broadcasts `agents_changed` over the UI WebSocket so open Agents tabs refresh.

### `src/formatter-manager.js`

Loads and runs accessibility tree formatters:

- `init()` -- Creates the `custom-formatters/` directory if absent and seeds an empty `manifest.json` there. Reads and merges the auto-updated manifest (`formatters/`) with the custom manifest (`custom-formatters/`). Custom platform entries override auto-updated ones with the same key. If no auto-updated manifest exists yet (first run), defers to the updater while still loading any custom formatters. Also loads each formatter's sibling `manifest.json` (per-formatter schema, see [`accessibility-tree-formatters/MANIFEST_SCHEMA.md`](../accessibility-tree-formatters/MANIFEST_SCHEMA.md)) and any sibling `workflows.js` file, cross-checking the implementations against the manifest's declared workflow names.
- `getCustomFormatterDir()` -- Returns the absolute path to `{dataDir}/custom-formatters/`.
- `formatTree(url, rawNodes)` -- Matches the URL's hostname against platform entries in the merged manifest and runs the matched formatter. Resolves formatter file paths from `custom-formatters/` for custom platforms and `formatters/` for auto-updated ones. Falls back to the default formatter (always from `formatters/`) if no platform matches. Records success/error to `formatter-logs.js`; honors per-formatter `errorHandling.fallbackToRawTree` (re-raises when `false`).
- `reload()` -- Clears the require cache for all loaded formatter modules and re-merges both manifests. Called after an auto-update is applied and on each `webpilot_get_formatter_info` call.
- `getFormatterInfo(platform?)` -- Returns formatter metadata including `customFormatterDir` path, per-platform `name`/`match`/`version`/`description`/`notes`/`source`/`errorHandling`, and a `workflows[]` array where each entry is annotated with `implemented: boolean`. Triggers `reload()` so callers always see the latest state.
- `getPerFormatterManifests()` -- Snapshot of every loaded per-formatter manifest, keyed by formatter name. Used by `GET /api/ui/formatters` to render the Web UI Formatters tab without re-reading manifest.json from disk.
- `getWorkflow(formatterName, workflowName)` -- Returns the single workflow implementation `{ description, parameters, run }` or `null`. Used by `webpilot_run_workflow` to look up and execute the workflow.
- `listWorkflows()` -- Flat list of every loaded workflow across every formatter.

### `src/formatter-logs.js`

In-memory cache (10 most recent per formatter) + SQLite write-through for per-formatter health tracking (P2 phase 3). Records success and error invocations of `format()` plus workflow runtime errors as rows in the `formatter_incidents` table. The cache hydrates from the DB on boot; the legacy `<dataDir>/formatter-logs.json` JSON ring buffer is imported on first boot and renamed to `.imported.<TS>`. Health rule: HEALTHY if total invocations < 3, OR if the last 10 invocations contain no errors; UNHEALTHY otherwise; UNKNOWN if the formatter has never run. Stack traces are truncated to ~1024 chars. Exports: `recordSuccess`, `recordError`, `getStatus`, `getLogs`, `listAll`, `flush`. Constants named at the top: `RING_CAPACITY`, `STACK_MAX`.

### `src/lib/tree-query.js`

Text-based helpers for querying a formatted accessibility tree from inside workflow `run()` functions. The formatted result handed to a workflow is `{ tree, refs, ...extras }` — a flat refs map plus a human-readable `tree` string with lines like `[e42] Message textbox`. `findInTree(treeResult, selector)` returns `{ ref, line }` for the first matching line (or `null`); `findAllInTree` returns the full match list. Selectors support `role` (substring), `name` (exact), `name_starts_with`, and `name_contains`. Intentionally minimal — workflows that need richer queries can have the platform formatter emit them as `extras` and read them directly.

### `src/formatter-updater.js`

GitHub-based auto-updater for accessibility tree formatters:

- `init(manager)` -- Wires the updater to the given formatter manager instance. Runs an immediate update check on startup, then schedules recurring checks every hour.
- `checkForUpdates()` -- Fetches the remote manifest from `raw.githubusercontent.com/Jtonna/WebPilot/main/accessibility-tree-formatters/manifest.json`, compares versions against the locally installed manifest, downloads all files listed in the `files` array for any updated formatters, then calls `manager.reload()`. Each fetch uses a 10-second timeout.

## MCP Tools

Tools are exposed to AI agents. All tools except `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, and `webpilot_dev_get_formatter_logs` require a valid paired API key and a connected extension for the agent's bound Chrome profile. Every tool except those four auth-exempt tools includes an optional `api_key` parameter in its schema, allowing per-call authentication as an alternative to the session-level `X-API-Key` header. `agent_name` is required only on `request_pairing`; other tools route via `resolveTargetProfile(apiKey)` and do not look at the agent name. See the **Authentication & authorization** section below for the full policy.

Navigational tools (`browser_create_tab`, `browser_close_tab`, `browser_click`, `browser_scroll`, `browser_type`, `webpilot_run_workflow`) also accept an optional `intent` string — a short human-readable description of *why* the call is being made. The value is purely additive: it surfaces in server-side debug logs as `[mcp:intent] <tool>: <text>` and is ignored by tool execution. Not validated, not required — but strongly encouraged for non-trivial flows to make debug traces readable.

**Error responses for formatter-related tools** (`webpilot_run_workflow`, `browser_get_accessibility_tree`) include an inline `diagnostics` object — `{ phase, workflow, platform, tabId, topFrame, more }` — so agents can see what failed without calling `webpilot_dev_get_formatter_logs` for history.

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
| `webpilot_get_formatter_info` | Get info on available platform-specific formatters and instructions for creating custom platform optimizers. When `tab_id` is provided with a valid API key and the URL matches a gated formatter, also records an unlock side-effect so the agent can interact with that tab. | `platform?`, `tab_id?` |
| `webpilot_reload_formatters` | DEVELOPER TOOL. Reload all formatters (auto-updated + custom) without restarting the server. Auth-gated (reloads code from disk → mutates server state). | (none) |
| `webpilot_dev_get_formatter_logs` | Get error history for a platform formatter. Workflow and tool errors already include the most recent diagnostic inline, so this is typically only needed when investigating multiple failures, comparing across runs, or developing a new formatter. Returns up to 50 entries from the per-formatter ring buffer. | `platform`, `limit?` |
| `webpilot_dev_reload_extension` | Triggers `chrome.runtime.reload()` in the extension service worker bound to the caller's profile, so edits under `packages/chrome-extension-unpacked/` take effect without manually reloading from `chrome://extensions/`. Per-profile scope only — other paired agents must call it from their own profile to reload everywhere. WS drops momentarily; the paired API key persists. | `api_key?` |
| `webpilot_run_workflow` | Execute a platform-specific workflow (e.g. `discord/send_message`) that bundles multiple primitive actions into one named operation. Workflow names + parameters come from each formatter's manifest. | `platform`, `workflow`, `tab_id`, `params?` |

### `browser_request_chain`

Executes an array of tool calls sequentially within a single MCP request. Each step specifies a `tool` name and `arguments` object. String argument values can reference prior step results using `$N.path.to.value` syntax (e.g., `$0.tab_id` resolves to the `tab_id` field from step 0's result).

Pre-validation runs before any step executes: all tool names must be valid (and cannot be `browser_request_chain` itself), and all `$N` references must point to earlier steps. If any step fails during execution, the response includes partial results from completed steps plus an error object identifying the failed step.

The `return_mode` parameter controls the response shape: `"all"` (default) returns an array of all step results, `"last"` returns only the final step's raw result.

## Authentication & authorization

WebPilot runs three distinct trust boundaries: MCP tool calls from AI agents (paired API keys), the extension's WebSocket transport (installId-as-identity), and the localhost-only Web UI admin surface (loopback gate, no key). Each is gated independently so that compromising one credential does not silently expose the others.

**Extension transport — installId is identity, not credential.** Each Chrome profile's extension mints a UUID `webpilot.installId` on first install and persists it in `chrome.storage.local`. On every WS upgrade the extension presents `?installId=<uuid>`; the server records the binding in the `extension_installs` table (`installId -> profileId`) and uses it for routing. Anyone who can reach the server's port can claim any installId — that's fine, because claiming an installId grants zero agent power. All real power is gated at the agent layer. Popup endpoints (`/api/popup/state`, `/api/popup/site-toggle`) auth via the `X-Install-Id` header — the server resolves it through the same `extension_installs` table; the popup operates in profile-context (global site rules apply; per-agent overrides do not). This replaces the legacy shared transport-key model (`server.json` apiKey + `?apiKey=` on the WS).

**MCP tool calls — paired API keys (unchanged).** Agent-layer keys are obtained through the **pairing handshake**. An AI agent without a key calls the `request_pairing` MCP tool with a memorable `agent_name`. The server creates a pending pairing entry, surfaces an approval URL through the desktop notification path, and returns a `pairing_id` to the agent. The human reviewer approves (or denies) the request in the local Web UI and chooses which Chrome profile the new key will be bound to. The agent then calls `check_pairing_status` with that `pairing_id` and — once the status flips to `approved` — receives the freshly minted `api_key`. The same key can be re-used across sessions; it is presented either as the `X-API-Key` HTTP header or as an `api_key` argument on each tool call. Keys are persisted in the `agents` SQLite table (HMAC-SHA-256 hash + per-server pepper, never the plaintext) along with their bound profile, `created_at`, and `last_seen_at` timestamps; unused keys auto-expire after 48 hours and pending pairings expire after 24 hours.

Four tools are intentionally exempt from the API-key auth gate: `request_pairing` and `check_pairing_status` (because they *are* the handshake — requiring a key would be circular), and `webpilot_get_formatter_info` plus `webpilot_dev_get_formatter_logs` (strictly read-only inspection of formatter metadata and the in-memory error ring buffer; nothing sensitive is exposed). Note that the **formatter guide gate** (see below) is a separate enforcement layer with its own exemption list — `webpilot_get_formatter_info`, `webpilot_dev_get_formatter_logs`, `request_pairing`, `check_pairing_status`, `browser_get_tabs`, `browser_close_tab`, `webpilot_reload_formatters`, and `webpilot_dev_reload_extension` are exempt; every other tool is gated when its target tab is on a formatter-covered URL. Every other tool — `browser_*`, `webpilot_run_workflow`, `webpilot_reload_formatters`, `webpilot_dev_reload_extension`, `browser_request_chain` — requires a valid paired key. `webpilot_reload_formatters` reloads formatter code from disk and therefore mutates server state, so it is auth-gated like the other mutating tools.

Every comparison of a caller-supplied API key against a stored key uses `crypto.timingSafeEqual` (wrapped in the `constantTimeEqual` helper in `src/paired-keys.js`). This applies to the MCP tool-call auth path (`pairedKeys.validateKey`) and every paired-keys lookup the Web UI admin endpoints perform (rename, re-bind, revoke, touch). A naive `===` short-circuits at the first differing byte and leaks position information; the constant-time compare prevents that. The extension WS upgrade no longer does a secret compare — installId is a non-secret identifier looked up by exact match in SQLite.

The Web UI admin surface is **localhost-only**. The general `makeUiAuth` middleware rejects every `/api/ui/*` request whose remote address is not `127.0.0.1` or `::1` with HTTP 403, and the `/api/ui/events` WebSocket upgrade is gated identically. On top of that, the mutating endpoints (`POST /api/ui/agents`, `POST /api/ui/agents/:key/rename`, `PATCH /api/ui/agents/:key`, `DELETE /api/ui/agents/:key`, `POST /api/ui/profiles`, `POST /api/ui/settings/network-mode`) layer a second, narrower `mutatingUiAuth` localhost check as defense-in-depth — if the broader UI auth policy is ever relaxed to permit read-only network access, those mutating admin actions stay loopback-only. Read-only endpoints (`GET /api/ui/status`, the events WebSocket) do not use the extra gate, so they remain reachable if a future change exposes read-only views over the network.

### Site-policy gate (P2 phase 4)

Independently of API-key authentication, every `browser_*` tool call (`browser_create_tab`, `browser_click`, `browser_type`, `browser_scroll`, `browser_get_accessibility_tree`, `browser_inject_script`, `browser_execute_js`) and `webpilot_run_workflow` runs through a server-side site-policy check before any extension command is dispatched. See `src/site-policy.js`.

The decision flow for `(agent_id, url)`:

1. Normalize the URL's hostname (lowercase, strip scheme/port, drop leading `www.`).
2. Look up `agent_site_overrides` for `(agent_id, domain)`. If present, the row's `decision` wins (per-agent fine-tuning).
3. Else, look up `global_site_rules` for `domain`. If present, the row's `decision` wins. `source='user'` means a user-set rule (from the popup toggle or webapp `/ui/sites/`); `source='global_site_blocklist'` means it came from the auto-updated global site blocklist (`src/global-site-blocklist-updater.js`).
4. Else, default to `allow`.

Subdomain matching is public-suffix-aware: a rule on `chase.com` covers `secure.chase.com` and `www.chase.com`. A rule on `secure.chase.com` covers only that subdomain.

When the gate denies a call:

- `browser_create_tab` returns `{ ok: false, error: "site blocked by policy", domain, policySource }` and the tab is never opened.
- Tools that operate on an existing `tab_id` return the same error plus `{ tabId, tabWillCloseAt, tabCloseInSeconds: 5 }`. The server schedules `chrome.tabs.remove(tab_id)` via the extension after the countdown, so the agent sees the error and the tab is cleaned up.

`browser_get_tabs` and `browser_close_tab` are always allowed — agents can see what's open and can close blocked tabs themselves.

The webapp's `/ui/sites/` admin page is the canonical surface for managing both `global_site_rules` and `agent_site_overrides`. The minimal popup exposes a single Block/Allow toggle that mutates `global_site_rules` for the current tab's domain.

### Formatter guide gate

Independently of site-policy, every gated tool call (`browser_get_accessibility_tree`, `browser_click`, `browser_type`, `browser_scroll`, `browser_execute_js`, `browser_inject_script`, `browser_request_chain`, `webpilot_run_workflow`) runs through the `enforceFormatterGuide` middleware. If the target tab's URL is covered by a platform formatter (detected via `formatterManager.getFormatterNameForUrl(url)`) and the agent has not yet unlocked that formatter+tab pair, the call is blocked with error code `platform_guide_required`.

**Allowlist** (never blocked): `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, `webpilot_dev_get_formatter_logs`, `browser_get_tabs`, `browser_close_tab`, `webpilot_reload_formatters`, `webpilot_dev_reload_extension`.

**Unlock mechanism:** Agents unlock a formatter+tab pair by calling `webpilot_get_formatter_info({ platform, tab_id })`. The server records the unlock in per-agent in-memory state (`formatterUnlockState`), keyed by `agentId`. Subsequent calls to gated tools on that tab pass. Cross-domain navigation **within the same formatter** (e.g. `discord.com` ↔ `discordapp.com`) preserves the unlock; navigation to a **different** formatter invalidates it.

**Block envelope (returned as MCP `isError: true`):**

```json
{
  "error": "platform_guide_required",
  "platform": "discord",
  "tab_id": 123,
  "message": "This tab is on a platform with a WebPilot formatter. Call webpilot_get_formatter_info(...) before interacting with this tab. The response will include the navigation guide, instructions for operating the platform, and available sub-workflows / tools for doing tasks within the platform.",
  "unlock_call": { "tool": "webpilot_get_formatter_info", "params": { "platform": "discord", "tab_id": 123 } }
}
```

**Bypass:** Pass `usePlatformOptimizer: false` on `browser_get_accessibility_tree` (or any tool that accepts it) to skip the gate when intentionally inspecting raw transient UI.

**Per-step enforcement in `browser_request_chain`:** Locking is evaluated per step. A locked step's result is the inline block envelope; other steps continue. An earlier step that calls `webpilot_get_formatter_info({ platform, tab_id })` unlocks the tab for later steps in the same chain.

**Fail-closed:** If the gate's own code throws an internal error, the request is blocked with a `formatter_guide_gate_error` envelope and the original exception is logged server-side. The gate does NOT silently pass through on internal errors.

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
| GET | `/health` | None | Server status (`extensionConnected`, `connectedProfiles`, `sessions` count) |
| GET | `/connect` | None | Returns `{ serverUrl, sseUrl, networkMode }` for extension auto-connect (no credentials — the extension's installId is its identity) |
| WS | `/` (upgrade) | `?installId=<uuid>` | Extension WebSocket connection (multi-extension support, keyed by `profileId`). The installId is routing-only; agent-layer auth gates real power |

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
| GET | `/api/ui/formatters` | List all loaded formatters with per-formatter manifest metadata fused with runtime health (`health`, `successCount`, `errorCount`, `lastSuccessAt`, `lastErrorAt`, `lastError`). Powers the Formatters tab. |
| GET | `/api/ui/formatters/:name/logs?limit=N` | Recent ring-buffer log entries + status for a single formatter. `limit` defaults to 50, max 500. |
| POST | `/api/ui/chrome/restart` | Calls `chromeManager.ensureReady()` — no-op if Chrome is already running with the flag and the right profiles; otherwise kill+relaunch. |
| POST | `/api/ui/server/restart` | Spawn-and-exit replacement daemon (identical pattern to the network-mode toggle). |
| GET / POST | `/api/ui/settings/notifications` | Get/set notification preferences (`systemNotifications`, `sound`). |
| POST | `/api/ui/settings/network-mode` | Body `{ enabled }`. Persists the preference and spawn-and-exits to rebind to `0.0.0.0` (or back to `127.0.0.1`). |
| POST | `/api/ui/incidents/:id/dismiss` | Dismiss a single formatter-incident row by numeric id. Sets `dismissed_at`, returns `{ ok, incidentId, formatter, status }`, and broadcasts a `changed` event. 404 if the id doesn't exist; 400 if the id isn't numeric. |
| POST | `/api/ui/formatters/:name/dismiss-all` | Bulk-dismiss every undismissed incident for formatter `:name` (the dashboard "Dismiss all" button). Returns `{ ok, name, affected, status }` with the affected row count for toast UX. |

### Site-policy admin endpoints

Mounted under the same localhost-only `/api/ui/*` surface and gated by the same `makeUiAuth` middleware; mutating routes layer the narrower `mutatingUiAuth` check on top. All routes emit a `sites_changed` event over the `/api/ui/events` WebSocket on success so the Sites admin page re-renders without a refetch.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ui/sites` | Returns `{ globalRules, globalSiteBlocklist }`. `globalRules` is the full `global_site_rules` list (user + global site blocklist) sorted by `(source, domain)` with `{ domain, decision, source, createdAt, updatedAt }` per row. `globalSiteBlocklist` is a summary of the auto-updated blocklist pack (`enabled`, `version`, `lastFetchedAt`, `domainCount`). |
| POST | `/api/ui/sites` | Body `{ domain, decision: 'allow' \| 'block' }`. Upserts a `source='user'` global rule via `sitePolicy.setGlobalRule`. Returns 201 with the persisted row (`domain`, `decision`, `source`, `createdAt`, `updatedAt`) after normalizing the domain. 400 on invalid domain or decision. |
| DELETE | `/api/ui/sites/:domain` | Removes a `source='user'` global rule. Refuses `source='global_site_blocklist'` rows with 400 and a hint pointing the operator at the global blocklist toggle. 404 if the rule doesn't exist. Returns `{ ok, domain }`. |
| POST | `/api/ui/sites/global-site-blocklist/toggle` | Body `{ enabled }`. Writes `config.global_site_blocklist_enabled = 'true' \| 'false'`. The flag is consulted at lookup time by `_findGlobalRule`, so disabling it suppresses every `source='global_site_blocklist'` row from the next policy check onward without waiting for the fetch cycle or touching stored rows. The response includes a fresh `blocklistUpdater.getStatus()` snapshot. Returns `{ enabled, globalSiteBlocklist }`. |
| GET | `/api/ui/agents/:agentId/site-overrides` | List per-agent overrides. `:agentId` is the `api_key_hash` exposed as `key` by `listKeys()`; the route resolves it to the numeric `agents.id` for the lookup. Returns an array of `{ domain, decision, createdAt }` sorted by domain. 404 if the agent isn't found. |
| POST | `/api/ui/agents/:agentId/site-overrides` | Body `{ domain, decision: 'allow' \| 'block' }`. Upserts a per-agent override via `sitePolicy.setAgentOverride`. Returns 201 with the persisted row. 400 on invalid domain or decision; 404 if the agent isn't found. |
| DELETE | `/api/ui/agents/:agentId/site-overrides/:domain` | Clears a single per-agent override row. 404 if no matching override exists. Returns `{ ok, domain }`. |

## Configuration

Configuration is resolved in order of priority: config file, then environment variables, then hardcoded defaults.

### Config File

The server reads `<dataDir>/config/server.json` if it exists. This file can specify `port`. (The legacy `apiKey` field is retained for read-compatibility but no longer consumed — the shared transport key was retired 2026-05-17.) See [Data Directory](#data-directory) for the data directory location.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port (overridden by config file if present) |
| `NETWORK` | `0` | Set to `1` for network mode (overridden by SQLite `config.network_enabled` if present; legacy `<dataDir>/network.enabled` flag file is consulted only as a fallback before first-boot migration) |
| `WEBPILOT_FOREGROUND` | unset | Set to `1` to run in foreground (used internally by daemon self-spawn) |

### Network Mode

By default the server only accepts extension/MCP connections from `localhost`. Use `--network` flag or `NETWORK=1` to listen on all interfaces:

```bash
npm run dev:network     # Development with auto-reload
npm run start:network   # Production
```

In network mode, the server prints the machine's LAN IP so other devices can connect.

Network mode can also be toggled at runtime from the web UI's Settings page (`POST /api/ui/settings/network-mode`). The endpoint:

1. Persists the preference to the `config.network_enabled` row in SQLite (survives restarts)
2. Spawn-and-exits a replacement daemon (clean process restart, not an in-process rebind)
3. The new daemon reads the DB row in `index.js` and binds to the chosen interface on startup

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

The data directory is resolved by `getDataDir()` in `src/service/paths.js`:

1. **`WEBPILOT_DATA_DIR` env var** — when set (Electron main passes `app.getPath('userData')` here when it spawns the daemon), this wins outright.
2. **Platform user-data path** — otherwise, the platform-appropriate userData-equivalent path (mirrors what Electron's `app.getPath('userData')` resolves to for this build, so the autostart-launched daemon and the Electron-spawned daemon land on the same dir):
   - Windows: `%APPDATA%\@webpilot\onboarding` (matches `app.getName()` from `packages/electron/package.json`; do not change without migrating user data)
   - macOS: `~/Library/Application Support/WebPilot`
   - Linux: `$XDG_CONFIG_HOME/WebPilot` (defaults to `~/.config/WebPilot`)

The legacy pre-1.1.6 in-install location (`../../data/` relative to the pkg binary's `execPath`) is consulted only by the one-shot `migrateLegacyInstallData()` upgrade path and is not used at runtime.

Contents (post-P2):
- `daemon.log`, `server.pid`, `server.port` — process bookkeeping.
- `webpilot.db` (plus `webpilot.db-wal` + `webpilot.db-shm` sidecars when WAL mode is active) — primary durable store. Holds the `agents`, `pairings`, `formatter_incidents`, `global_site_rules`, `agent_site_overrides`, `global_site_blocklist_meta`, `config`, and `extension_installs` tables. See `src/db/schema.sql`.
- `logs/` subdirectory.
- `config/server.json` (port override file; still file-backed because it's read at the earliest possible bootstrap moment. A legacy `apiKey` field is silently ignored — the shared transport key was retired 2026-05-17).
- `config/notifications.json` (per-user notification preferences — still file-backed for now).
- `formatters/` (auto-updated formatters from GitHub).
- `custom-formatters/` (user-managed formatters that override auto-updated ones for the same domain; never touched by the auto-updater).
- `*.imported.<ISO>` — legacy JSON stores (`paired-keys.json`, `pending-pairings.json`, `formatter-logs.json`, `extension-installs.json`) and the `network.enabled` flag file, renamed after first-boot import. Safe to delete once the new version has been verified.

## Build

The server compiles to standalone binaries via `@yao-pkg/pkg`. Use the platform-specific build commands (`npm run build` prints an error and exits):

```bash
npm run build:win    # node18-win-x64
npm run build:mac    # node18-macos-x64
npm run build:linux  # node18-linux-x64
```

Output directory: `dist/`.

The compiled binary includes Node.js, all dependencies, and the server source. It can run on machines without Node.js installed. The top-level `"bin": "cli.js"` field in `package.json` points pkg at the binary's main entry; it is not a pkg-specific config knob. Formatters are not bundled in the binary -- they are downloaded from GitHub on first run.

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and routing |
| `cors` | Cross-origin resource sharing |
| `ws` | WebSocket server |
| `uuid` | UUID generation for session and command IDs |
| `@yao-pkg/pkg` (dev) | Compile to standalone binaries |
