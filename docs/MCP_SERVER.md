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

The extension-facing WebSocket endpoint identifies the connecting extension by `?installId=<uuid>` — there is no shared transport key. The extension WS upgrade is **loopback-only** (rejected from non-loopback addresses), so it is never LAN-reachable even in network mode; the extension always runs on the same machine as the server. The `/api/ui/*` REST and WebSocket endpoints are likewise **localhost-only** and require no API key (rejected from non-loopback addresses with HTTP 403).

The `/api/popup/*` endpoints are also loopback-gated (via the shared `src/loopback.js` helper). On top of the loopback gate they authenticate by `X-Install-Id` and reject web (http/https) Origins.

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
| SQLite row | `config.network_enabled` | (absent) | Persisted network mode preference (`'true'` / `'false'`). Written by `POST /api/ui/settings/network-mode` from the web UI; the endpoint spawn-and-exits a replacement daemon so the new binding takes effect. If present, overrides both the `--network` flag and the `NETWORK` env var. |
| SQLite row | `config.global_tier_enabled` | (absent, treated as enabled) | Whole-global-tier toggle, written by `POST /api/ui/site-policy/global-tier/toggle`. See [SITE_POLICY.md#global-tier-toggle](SITE_POLICY.md#global-tier-toggle) for on/off semantics. |

In network mode, the server listens on `0.0.0.0` and advertises the machine's LAN IP address. In default mode, it listens on `127.0.0.1` only.

Calls `createServer()` from `src/server.js` with the resolved configuration.

### `src/server.js`

Sets up the Express HTTP server and two WebSocket servers (one for extensions, one for the web UI):

- Creates an Express app with CORS and JSON body parsing
- Creates an HTTP server and two `WebSocketServer`s in `noServer` mode (manual upgrade routing): the extension WS at the root path, and the web-ui events WS at `/api/ui/events`. Extension upgrades require `?installId=<uuid>` on the URL. The server records the mapping in `extension_installs` and uses it for routing; see [Authentication & authorization](#authentication--authorization) for what an installId does and does not grant. UI upgrades are accepted only from loopback addresses with no API key.
- Mounts the web UI at `/ui/`. In production (and inside the pkg snapshot), serves the Next.js static export via a manual `fs.readFileSync` handler (express.static is bypassed so the pkg-snapshot patched `fs` works correctly). In dev (`WEBPILOT_DEV=1`, set by `npm run dev` at the repo root), instead proxies `/ui/*` to `http://localhost:3100` via `http-proxy-middleware` with `ws: true` so Next.js HMR works. The pkg/Electron path never sets `WEBPILOT_DEV` so installed users always go through the static branch.
- Mounts the `/api/ui/*` REST endpoints (status, pairings, agents, profiles, chrome, server, settings, site-policy, agents' site-rules, site-events); see [HTTP Endpoints](#http-endpoints).
- Separately mounts the `/api/popup/*` endpoints (`popup-routes.js`); these are not part of the localhost-only `/api/ui/*` surface. See [Authentication & authorization](#authentication--authorization).
- On startup, calls `formatterManager.init()`, then `formatterUpdater.init(formatterManager)`. An immediate update check runs against GitHub (downloads formatters on first run if none exist locally), then hourly recurring checks.
- Also on startup: loads `notificationsSettings`, runs `pairedKeys.cleanupExpiredPairings()`, and runs `pairedKeys.cleanupUnusedKeys()` (auto-revokes 48h-stale never-used keys). Both cleanup passes repeat hourly.
- Also on startup: runs `sitePolicyEvents.cleanup()` for the site policy event log, repeated hourly; see [SITE_POLICY.md#event-log](SITE_POLICY.md#event-log) for the retention rule and the `site_policy_events_changed` reason it emits.
- Also on startup, calls `globalSiteBlocklistUpdater.init({})` (`server.js:1918-1937`): a boot check 5 seconds after listen (deferred so a slow/unreachable GitHub doesn't drag out cold-start), then a recurring check every 24 hours. See [SITE_POLICY.md#signed-global-blocklist-updater](SITE_POLICY.md#signed-global-blocklist-updater) for why that cadence is slower than the formatter updater's hourly one.
- Maintains an N-connection extension bridge keyed by Chrome profile directory name. Every extension WS connection runs a `hello` handshake (`profileId`, optional `gaiaEmail` (the field name on the wire), persistent `installId`) before any other messages are processed. The server uses `installId` to remember which profile an extension install belongs to (persisted in the `extension_installs` SQLite table), and replies with `hello_ack` once the binding resolves. A 5-second server-side `helloDeadline` watchdog pushes `identify_required` pre-emptively if the extension never sends `hello` in time (see `server.js`).
- Handles WebSocket messages from the extension: `{ type: 'ping' }` → `{ type: 'pong' }` (keep-alive); `{ type: 'hello' }` → `{ type: 'hello_ack' }` or `{ type: 'identify_required' }`. The paired-agent management messages (`revoke_key`, `rename_agent`, `list_paired_agents`) and the `paired_agents_list` push were **removed in #129**: agent administration is a loopback-gated web-UI concern that flows exclusively through `/api/ui/agents/*` (keyed by the agent's non-secret row `id`). The extension WS no longer carries any agent-list traffic, which previously leaked the agents' stored key hashes. `{ type: 'set_network_mode' }` and `{ type: 'set_pairing_required' }` are **deprecated** — the server logs and ignores them; network mode is now owned by `POST /api/ui/settings/network-mode`, and the pairing-required toggle has been retired (pairing is always on). (No `check_formatter_updates` WS handler is implemented; formatter metadata is inspected via the `webpilot_get_formatter_info` MCP tool.)
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

Persistent `installId → profileId` map. SQLite-backed via the `extension_installs` table (formerly stored in `<dataDir>/config/extension-installs.json`). The extension mints a UUID `webpilot.installId` on first install (kept across `FORGET_CONFIG` resets), sends it in the `hello` handshake, and the server uses it to skip the profile-picker UI on subsequent connects. Includes housekeeping to drop entries with `last_seen_at` older than 90 days.

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

Manages paired agent API keys **and** the async pending-pairings ledger. SQLite-backed; the `agents` and `pairings` tables are the durable store:

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

In-memory cache (10 most recent per formatter) + SQLite write-through for per-formatter health tracking. Records success and error invocations of `format()` plus workflow runtime errors as rows in the `formatter_incidents` table. The cache hydrates from the DB on boot. Health rule: HEALTHY if total invocations < 3, OR if the last 10 invocations contain no errors; UNHEALTHY otherwise; UNKNOWN if the formatter has never run. Stack traces are truncated to ~1024 chars. Exports: `recordSuccess`, `recordError`, `getStatus`, `getLogs`, `listAll`, `flush`. Constants named at the top: `RING_CAPACITY`, `STACK_MAX`.

### `src/lib/tree-query.js`

Text-based helpers for querying a formatted accessibility tree from inside workflow `run()` functions. The formatted result handed to a workflow is `{ tree, refs, ...extras }` — a flat refs map plus a human-readable `tree` string with lines like `[e42] Message textbox`. `findInTree(treeResult, selector)` returns `{ ref, line }` for the first matching line (or `null`); `findAllInTree` returns the full match list. Selectors support `role` (substring), `name` (exact), `name_starts_with`, and `name_contains`. Intentionally minimal — workflows that need richer queries can have the platform formatter emit them as `extras` and read them directly.

### `src/formatter-updater.js`

GitHub-based auto-updater for accessibility tree formatters:

- `init(manager)` -- Wires the updater to the given formatter manager instance. Runs an immediate update check on startup, then schedules recurring checks every hour.
- `checkForUpdates()` -- Fetches the remote manifest from `raw.githubusercontent.com/Jtonna/WebPilot/main/accessibility-tree-formatters/manifest.json`, compares versions against the locally installed manifest, downloads all files listed in the `files` array for any updated formatters, then calls `manager.reload()`. Each fetch uses a 10-second timeout.

### `src/site-policy.js`

Resolves `(agent_id, url)` to an allow/block verdict across the per-agent, global-user, and signed-global-blocklist tiers, and owns the `config.global_tier_enabled` read/write. See [SITE_POLICY.md#precedence](SITE_POLICY.md#precedence) and [SITE_POLICY.md#domain-matching](SITE_POLICY.md#domain-matching).

### `src/global-site-blocklist-updater.js`

GitHub-based signed auto-updater for the `global_site_blocklist_rules` table (boot + 5s, then every 24h). Verifies the signed manifest via `manifest-verifier.js` before writing. When no verified remote or cache is available it writes nothing and keeps the existing rows. See [SITE_POLICY.md#signed-global-blocklist-updater](SITE_POLICY.md#signed-global-blocklist-updater).

### `src/global-user-rules.js`

Single shared write path (`upsertGlobalUserRule`, `clearGlobalUserRule`) for the `global_user_site_rules` table, used by both the Site Policy admin page and the popup toggle. See [SITE_POLICY.md#storage](SITE_POLICY.md#storage).

### `src/site-policy-events.js`

Deduplicated (agent, domain) event log backing the site-policy admin UI's live event view. See [SITE_POLICY.md#event-log](SITE_POLICY.md#event-log).

### `src/site-policy-events-routes.js`

Mounts `GET /api/ui/site-policy/events` and the per-agent site-events allow/revoke endpoints. See [SITE_POLICY.md#admin-surfaces-and-live-events](SITE_POLICY.md#admin-surfaces-and-live-events).

### `src/popup-routes.js`

Mounts the install-id-scoped `/api/popup/*` endpoints (state + site-toggle) used by the extension popup. See [SITE_POLICY.md#admin-surfaces-and-live-events](SITE_POLICY.md#admin-surfaces-and-live-events).

### `src/lib/manifest-verifier.js`

Ed25519 signature + SHA-256 verification for signed formatter and global-site-blocklist releases against the bundled `PUBKEY.pem`. See [SITE_POLICY.md#signed-global-blocklist-updater](SITE_POLICY.md#signed-global-blocklist-updater).

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

WebPilot runs three distinct trust boundaries: MCP tool calls from AI agents (paired API keys), the loopback-only extension WebSocket transport (installId-as-identity), and the localhost-only Web UI admin surface (loopback gate, no key). Each is gated independently so that compromising one credential does not silently expose the others.

**Extension transport: installId is identity, not credential — and loopback-only.**

- Extension mints `webpilot.installId` on first install, persisted in `chrome.storage.local`.
- On WS upgrade the extension sends `?installId=<uuid>`; the server records it in `extension_installs` (installId → profileId) for routing.
- The extension WS upgrade is **loopback-gated** (`src/loopback.js`): non-loopback callers are rejected, so an installId is only ever presented from the same machine, even when network mode is on. The extension always dials loopback (see `/connect` below).
- An installId is an identity, not a credential. It carries no MCP tool power; agent-layer API-key auth is the only gate on MCP tools.
- It does authorize the popup endpoints (`/api/popup/state`, `/api/popup/site-toggle`), which write global site rules. Those endpoints are **loopback-gated** as well, then additionally authenticate via the `X-Install-Id` header (resolved through `extension_installs`) and reject web (http/https) Origins.
- Popup endpoints operate in profile-context: global tier rules apply if enabled, per-agent rules do not.
- Replaces the legacy shared transport key (`server.json` apiKey + `?apiKey=` on WS).

**MCP tool calls — paired API keys (unchanged).** Agent-layer keys are obtained through the **pairing handshake**. An AI agent without a key calls the `request_pairing` MCP tool with a memorable `agent_name`. The server creates a pending pairing entry, surfaces an approval URL through the desktop notification path, and returns a `pairing_id` to the agent. The human reviewer approves (or denies) the request in the local Web UI and chooses which Chrome profile the new key will be bound to. The agent then calls `check_pairing_status` with that `pairing_id` and — once the status flips to `approved` — receives the freshly minted `api_key`. The same key can be re-used across sessions; it is presented either as the `X-API-Key` HTTP header or as an `api_key` argument on each tool call. Keys are persisted in the `agents` SQLite table (HMAC-SHA-256 hash + per-server pepper, never the plaintext) along with their bound profile, `created_at`, and `last_seen_at` timestamps; unused keys auto-expire after 48 hours and pending pairings expire after 24 hours. The stored `api_key_hash` is **never sent to any client** and is **not a credential**: `validateKey` hashes the presented plaintext and compares it against the stored hash, so presenting a raw hash authenticates nothing (there is deliberately no raw-hash fallback).

**Agent admin is keyed by the row `id`, not the key.** The UI and `/api/ui/*` endpoints identify each agent by its non-secret `agents.id` (surfaced by `listKeys()` / `GET /api/ui/status`, which never include the hash or plaintext). Because an existing agent's plaintext cannot be recovered from the stored hash, the per-agent "Copy config" button has been replaced by **"Regenerate key"** (`POST /api/ui/agents/:id/regenerate`): it mints a fresh plaintext key, invalidates the old hash, and reveals the new plaintext **once**. Copy-config with a working plaintext remains available only in the post-pairing-approval modal, while the freshly minted key is still in memory.

Four tools are intentionally exempt from the API-key auth gate: `request_pairing` and `check_pairing_status` (because they *are* the handshake — requiring a key would be circular), and `webpilot_get_formatter_info` plus `webpilot_dev_get_formatter_logs` (strictly read-only inspection of formatter metadata and the in-memory error ring buffer; nothing sensitive is exposed). Note that the **formatter guide gate** (see below) is a separate enforcement layer with its own exemption list — `webpilot_get_formatter_info`, `webpilot_dev_get_formatter_logs`, `request_pairing`, `check_pairing_status`, `browser_get_tabs`, `browser_close_tab`, `webpilot_reload_formatters`, and `webpilot_dev_reload_extension` are exempt; every other tool is gated when its target tab is on a formatter-covered URL. Every other tool — `browser_*`, `webpilot_run_workflow`, `webpilot_reload_formatters`, `webpilot_dev_reload_extension`, `browser_request_chain` — requires a valid paired key. `webpilot_reload_formatters` reloads formatter code from disk and therefore mutates server state, so it is auth-gated like the other mutating tools.

Every comparison of a caller-supplied API key against a stored key uses `crypto.timingSafeEqual` (wrapped in the `constantTimeEqual` helper in `src/paired-keys.js`). This applies to the MCP tool-call auth path (`pairedKeys.validateKey`) and every paired-keys lookup the Web UI admin endpoints perform (rename, re-bind, revoke, touch). A naive `===` short-circuits at the first differing byte and leaks position information; the constant-time compare prevents that. The extension WS upgrade no longer does a secret compare — installId is a non-secret identifier looked up by exact match in SQLite.

The Web UI admin surface is **localhost-only**. The general `makeUiAuth` middleware rejects every `/api/ui/*` request whose remote address is not `127.0.0.1` or `::1` with HTTP 403, and the `/api/ui/events` WebSocket upgrade is gated identically.

On top of that, a second, narrower `mutatingUiAuth` localhost check layers on the mutating endpoints as defense-in-depth: `POST /api/ui/agents`, `POST /api/ui/agents/:id/rename`, `POST /api/ui/agents/:id/regenerate`, `PATCH /api/ui/agents/:id`, `DELETE /api/ui/agents/:id`, `POST /api/ui/profiles`, `POST /api/ui/settings/network-mode`, and the site-policy mutating routes (see [Site-policy admin endpoints](#site-policy-admin-endpoints)). If the broader UI auth policy is ever relaxed to permit read-only network access, these mutating admin actions still stay loopback-only.

Read-only endpoints (`GET /api/ui/status`, the events WebSocket) skip the extra gate, so they'd remain reachable if a future change exposes read-only views over the network.

### Site-policy gate

The gate lives in `mcp-handler.js`, runs after the auth gate (no valid key means no agent identity, so the per-agent tier is skipped), and resolves via `sitePolicy.isAllowed()` in `src/site-policy.js` at two checkpoints:

1. **Checkpoint A** gates `browser_create_tab` on `args.url`, before dispatch.
2. **Checkpoint B** gates every tool in `TAB_ID_TOOLS` (`browser_click`, `browser_type`, `browser_scroll`, `browser_get_accessibility_tree`, `browser_inject_script`, `browser_execute_js`, `webpilot_run_workflow`), by resolving the tab's current URL first.

Each check made for a known agent is recorded to `site_policy_events` (exclusions in [Event log](SITE_POLICY.md#event-log)).

More on the gate:
- [SITE_POLICY.md#precedence](SITE_POLICY.md#precedence) — the four-tier decision flow
- [SITE_POLICY.md#checked-and-exempt-tools](SITE_POLICY.md#checked-and-exempt-tools) — which tools are gated versus exempt
- [SITE_POLICY.md#blocked-response](SITE_POLICY.md#blocked-response) — the denial shape
- [SITE_POLICY.md#fail-closed-cases](SITE_POLICY.md#fail-closed-cases) — when a verdict can't be reached

The minimal extension popup exposes its own Block/Allow surface; see [CHROME_EXTENSION.md#popup-ui](CHROME_EXTENSION.md#popup-ui) and [SITE_POLICY.md#admin-surfaces-and-live-events](SITE_POLICY.md#admin-surfaces-and-live-events).

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
| GET | `/health` | Loopback-only | Server status (`extensionConnected`, `connectedProfiles`, `sessions` count); rejected from non-loopback addresses |
| GET | `/connect` | Loopback-only | Returns `{ serverUrl, sseUrl, networkMode }` for extension auto-connect (no credentials — the extension's installId is its identity). `serverUrl` is **always** `ws://127.0.0.1:<port>` regardless of network mode, so the same-machine extension always dials loopback |
| WS | `/` (upgrade) | Loopback-only + `?installId=<uuid>` | Extension WebSocket connection (multi-extension support, keyed by `profileId`); loopback-gated, so never LAN-reachable even in network mode. See [Authentication & authorization](#authentication--authorization) for what the installId does and does not grant |

The web UI / management surfaces (localhost-only — non-loopback rejected with HTTP 403):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/ui/...` | Static web UI (Next.js export) served via `fs.readFileSync` for pkg-snapshot compatibility |
| WS | `/api/ui/events` (upgrade) | Web UI event stream (pairing changes, agent changes, extension connect/disconnect, site-policy event log changes via `site_policy_events_changed`, and site-rule/tier changes via `site_policy_changed`; see [SITE_POLICY.md#admin-surfaces-and-live-events](SITE_POLICY.md#admin-surfaces-and-live-events) for the `reason` values) |
| GET | `/api/ui/status` | Snapshot: Chrome status, profiles with per-profile `webPilotStatus` (`active`/`ready`/`needs_setup`), `connectedProfiles`, `pendingPairings`, `pairedAgents`, `networkMode`, `paths`, `notifications`, `port`, and `globalSiteBlocklist` (`{ enabled, version, lastFetchedAt, domainCount, lastCheckedAt, lastCheckError }`) (`server.js:583-589`) |
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

See [SITE_POLICY.md](SITE_POLICY.md) for the tier model and precedence these endpoints manage; this table is the canonical REST reference. Mounted under the same localhost-only `/api/ui/*` surface and gated by the same `makeUiAuth` middleware; mutating routes layer the narrower `mutatingUiAuth` check on top. All mutating routes emit `site_policy_changed` over `/api/ui/events` on success (the Site Policy admin page refetches on any reason); see [SITE_POLICY.md#admin-surfaces-and-live-events](SITE_POLICY.md#admin-surfaces-and-live-events) for the reason values, including `popup_toggle` from `POST /api/popup/site-toggle`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ui/site-policy/global-rules` | Returns `{ globalRules, globalSiteBlocklist }`. `globalRules` is the union of `global_user_site_rules` (`source: 'user'`) and `global_site_blocklist_rules` (`source: 'global_site_blocklist'`, `decision` always `'block'`), sorted by `(source, domain)` with `{ domain, decision, source, createdAt, updatedAt }` per row. The same domain may appear once per source. `globalSiteBlocklist` is a summary of the signed blocklist (`enabled`, `version`, `lastFetchedAt`, `domainCount`, `lastCheckedAt`, `lastCheckError`); `lastCheckedAt`/`lastCheckError` describe the most recent check and are in memory only (`null` after a daemon restart until the next check); `enabled` reflects `config.global_tier_enabled` (the whole-global-tier toggle), not a blocklist-only flag. |
| POST | `/api/ui/site-policy/global-rules` | Body `{ domain, decision: 'allow' \| 'block' }`. Upserts a `source='user'` global rule via `upsertGlobalUserRule` (`src/global-user-rules.js`, the write path shared with the popup toggle). Returns 201 with the persisted row (`domain`, `decision`, `source`, `createdAt`, `updatedAt`) after normalizing the domain. 400 `{ error, reason }` on invalid domain or decision. Upserts into `global_user_site_rules`. A `*` domain is rejected with 400 `{ error: 'invalid domain', reason }` (wildcard rules are per-agent only). |
| DELETE | `/api/ui/site-policy/global-rules/:domain` | Removes the domain's row from `global_user_site_rules` via `clearGlobalUserRule` (`src/global-user-rules.js`). If the domain is also on the signed blocklist, removal restores the signed `block` verdict. If the domain has no user rule but is on the signed blocklist, returns 400 `{ error: 'cannot delete signed blocklist rule', reason, domain, source: 'global_site_blocklist' }` whose `reason` tells the user to turn off the global block list on the Site Policy page. Otherwise 404. 400 `{ error: 'invalid domain', reason }` on an unparseable domain. Returns `{ ok, domain }`. |
| POST | `/api/ui/site-policy/global-tier/toggle` | Body `{ enabled: boolean }` (coerced with `Boolean()`; the string `"false"` counts as true, a missing body as false). Writes `config.global_tier_enabled` via `sitePolicy.setGlobalTierEnabled`; see [SITE_POLICY.md#global-tier-toggle](SITE_POLICY.md#global-tier-toggle) for what toggling it does and does not affect. Emits `site_policy_changed` with `reason: 'global_tier_toggle'`. Returns `{ enabled, globalSiteBlocklist }`, where `globalSiteBlocklist` is a fresh `globalSiteBlocklistUpdater.getStatus()` snapshot. |
| GET | `/api/ui/agents/:agentId/site-rules` | List per-agent rules. `:agentId` is the `api_key_hash` exposed as `key` by `listKeys()`; the route resolves it to the numeric `agents.id` for the lookup. Returns an array of `{ domain, decision, createdAt }` sorted by domain. 404 if the agent isn't found. |
| POST | `/api/ui/agents/:agentId/site-rules` | Body `{ domain, decision: 'allow' \| 'block' }`. Upserts a per-agent rule via `sitePolicy.setAgentRule`. Returns 201 with the persisted row. 400 on invalid domain or decision; 404 if the agent isn't found. `domain` may be the literal `*`, which sets the agent's default decision for every site. |
| DELETE | `/api/ui/agents/:agentId/site-rules/:domain` | Clears a single per-agent rule row. 404 `{ error: 'agent rule not found', domain }` if no matching rule exists. Returns `{ ok, domain }`. `:domain` may be `*` (URL-encoded as `%2A`) to remove the agent's wildcard row. 404 `{ error: 'agent not found' }` if the agent isn't active; 400 `{ error: 'invalid domain', reason }` on an unparseable domain. |
| GET | `/api/ui/site-policy/events` | Site policy event log, one row per (agent, domain), newest `lastSeenAt` first. Query: `agentId` (the agent's `key` / `api_key_hash`; 404 `{ error: 'agent not found' }` if it doesn't match an active agent), `decision` (`allow` \| `block`; anything else → 400 `{ error: 'invalid decision', reason }`), `limit` (default 50, max 200; non-positive or non-numeric falls back to 50), `cursor` (the opaque `nextCursor` from a previous page; malformed → 400 `{ error: 'invalid cursor', reason }`). Returns `{ entries, hasMore, nextCursor }`. Each entry: `{ agentKey, agentName, domain, decision, source, matchedDomain, firstSeenAt, lastSeenAt, decisionChangedAt, hitCount, actionable, agentRuleDecision }`. `actionable` is false for IP / single-label hosts that can't take a per-agent rule; `agentRuleDecision` is the agent's exact-domain rule (`allow` / `block`) or `null`. Revoked agents' rows are excluded and numeric ids are never exposed. Read-only; emits nothing. |
| POST | `/api/ui/agents/:agentId/site-events/allow` | Body `{ domain }`. Upserts a per-agent `allow` rule for the exact normalized domain via `sitePolicy.setAgentRule`. Returns 201 `{ agentKey, domain, decision: 'allow', createdAt }` (`createdAt` is the rule row's original creation time). 404 `{ error: 'agent not found' }` if the agent isn't active; 400 `{ error: 'invalid domain', reason }` for IP literals, single-label hosts (e.g. `localhost`), `*`, or unparseable input. Does not modify `site_policy_events` rows, and no event row is required. Emits `site_policy_changed` with `reason: 'site_event_allow'`. |
| POST | `/api/ui/agents/:agentId/site-events/revoke` | Same request, validation and response shape as `…/allow`, but always writes `decision: 'block'`: an existing same-domain `allow` rule is overwritten in place, never deleted. Emits `site_policy_changed` with `reason: 'site_event_revoke'`. |

Changes to the event log itself broadcast separately as `{ type: 'site_policy_events_changed', reason }`; see [SITE_POLICY.md#admin-surfaces-and-live-events](SITE_POLICY.md#admin-surfaces-and-live-events) for the `reason` values.

## Configuration

Configuration is resolved in order of priority: config file, then environment variables, then hardcoded defaults.

### Config File

The server reads `<dataDir>/config/server.json` if it exists. This file can specify `port`. (The legacy `apiKey` field is retained for read-compatibility but no longer consumed — the shared transport key was retired 2026-05-17.) See [Data Directory](#data-directory) for the data directory location.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port (overridden by config file if present) |
| `NETWORK` | `0` | Set to `1` for network mode (overridden by SQLite `config.network_enabled` if present) |
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

Even when network mode is enabled, **only the API-key-gated MCP surface (`/sse` and `/message`) becomes reachable over the LAN.** Everything else stays loopback-only: the `/api/ui/*` REST and WebSocket surfaces, the extension WebSocket upgrade, `/api/popup/*`, `/connect`, and `/health` are all rejected from non-loopback addresses (see `src/loopback.js`).

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

Contents:
- `daemon.log`, `server.pid`, `server.port` — process bookkeeping.
- `webpilot.db` (+ WAL sidecars), the durable store: `agents`, `pairings`, `formatter_incidents`, `global_user_site_rules`, `global_site_blocklist_rules`, `agent_site_rules`, `global_site_blocklist_meta`, `site_policy_events`, `config`, `extension_installs`, `schema_migrations`. See `src/db/schema.sql`, `docs/SCHEMA_MIGRATIONS.md`.
- `logs/` subdirectory.
- `config/server.json` (port override file; still file-backed because it's read at the earliest possible bootstrap moment. A legacy `apiKey` field is silently ignored — the shared transport key was retired 2026-05-17).
- `config/notifications.json` (per-user notification preferences — still file-backed for now).
- `formatters/` (auto-updated formatters from GitHub).
- `custom-formatters/` (user-managed formatters that override auto-updated ones for the same domain; never touched by the auto-updater).
- `global-site-blocklists/` (local cache of the signed global site blocklist manifest + lists, written by `global-site-blocklist-updater.js` so an offline boot can still trust what it read last).

## Build

The server compiles to standalone binaries via `@yao-pkg/pkg`. Use the platform-specific build commands (`npm run build` prints an error and exits):

```bash
npm run build:win    # node18-win-x64
npm run build:mac    # node18-macos-x64
npm run build:linux  # node18-linux-x64
```

Output directory: `dist/`.

The compiled binary includes Node.js, all dependencies, and the server source. It can run on machines without Node.js installed. The top-level `"bin": "cli.js"` field in `package.json` points pkg at the binary's main entry; it is not a pkg-specific config knob. Formatters and the global site blocklist are not bundled; only `PUBKEY.pem` ships with the app.

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and routing |
| `cors` | Cross-origin resource sharing |
| `ws` | WebSocket server |
| `uuid` | UUID generation for session and command IDs |
| `@yao-pkg/pkg` (dev) | Compile to standalone binaries |
