# MCP Server Architecture

Node.js server that bridges AI agents to the Chrome extension. Exposes browser automation tools via the MCP protocol (over SSE) and communicates with the extension via WebSocket.

## Overview

The MCP server is the middle layer between AI agents and the browser. It:

1. Accepts MCP connections from AI agents via Server-Sent Events (SSE)
2. Receives tool call requests (JSON-RPC 2.0)
3. Translates them into commands and sends them to the Chrome extension via WebSocket
4. Returns results back to the agent via the SSE stream

MCP tool calls now require a paired API key, except for `request_pairing` which is publicly accessible so agents can initiate the pairing flow. The key can be provided via the `X-API-Key` HTTP header, the `apiKey` query parameter on the SSE/message endpoints, or as an `api_key` parameter in individual tool call arguments. The WebSocket endpoint (used by the Chrome extension, not MCP agents) requires a separate server API key to prevent unauthorized browser control.

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
| Data file | `network.enabled` | (absent) | Persisted network mode preference (`1` or `0`). Written by the runtime `set_network_mode` WebSocket handler. If present, overrides both the `--network` flag and the `NETWORK` env var. |

In network mode, the server listens on `0.0.0.0` and advertises the machine's LAN IP address. In default mode, it listens on `127.0.0.1` only.

Calls `createServer()` from `src/server.js` with the resolved configuration.

### `src/server.js`

Sets up the Express HTTP server and WebSocket server:

- Creates an Express app with CORS and JSON body parsing
- Creates an HTTP server and a `WebSocketServer` (noServer mode, manual upgrade handling)
- Authenticates WebSocket connections via `?apiKey=` query parameter
- Handles WebSocket messages from the extension: `{ type: 'ping' }` responds with `{ type: 'pong' }` (keep-alive mechanism); `{ type: 'revoke_key' }` removes a paired agent API key; `{ type: 'rename_agent' }` renames a paired agent; `{ type: 'list_paired_agents' }` returns all currently paired agents; `{ type: 'set_network_mode' }` toggles between local-only and LAN mode at runtime (see [Network Mode](#network-mode))
- On WebSocket connection, registers with the extension bridge
- Writes `server.pid` and `server.port` files to the data directory on listen; cleans them up on SIGTERM, SIGINT, and `exit` events
- Mounts MCP handler routes (`GET /sse`, `POST /message`)
- Exposes `GET /health` (server status with `extensionConnected` and `sessions` count) and `GET /connect` (returns `apiKey`, `serverUrl`, `sseUrl`, and `networkMode` for extension auto-connect)

## Source Files

### `src/mcp-handler.js`

Implements the MCP protocol:

- **SSE session management** -- Each `GET /sse` request creates a session with a UUID. The session ID is sent as the first SSE event so the client knows where to POST messages. Each session maintains a message queue that is flushed every 100ms via `setInterval`, plus a separate keepalive comment sent every 30 seconds. On client disconnect, both intervals are cleared and the session is removed from the Map.
- **Message handling** -- `POST /message?session_id=<id>` processes JSON-RPC requests and queues responses for delivery via the SSE stream. Late-arriving API keys (sent on `/message` requests via `X-API-Key` header or `apiKey` query parameter) update the session's stored key. The `processMessage` function enforces authentication on `tools/call` requests: it checks `session.mcpApiKey` first, then falls back to `params.arguments.api_key`, and validates the effective key via `pairedKeys.validateKey()`. Only `request_pairing` is exempted from this check. After successful authentication, `pairedKeys.touchKey()` is called to update the key's `lastAccessed` timestamp.
- **Protocol methods** -- Handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- **Tool routing** -- Maps MCP tool names to extension command types and parameters.
- **Script fetching** -- For `browser_inject_script`, the server fetches the script from the provided URL before sending the content to the extension. This allows injecting scripts from localhost or external URLs regardless of page CSP.
- **Chain execution** -- `browser_request_chain` is handled entirely server-side. It calls `handleToolCall()` internally for each step and never sends a command directly to the extension bridge.

### `src/extension-bridge.js`

WebSocket bridge to the Chrome extension:

- Maintains a single WebSocket connection (one extension at a time)
- `sendCommand(type, params)` -- Sends a command to the extension with a unique UUID and returns a Promise. The Promise resolves when the extension sends a matching response, or rejects on timeout (30 seconds) or disconnect.
- `notify(message)` -- Sends a server-initiated message object to the extension without waiting for a response (fire-and-forget). Used for push notifications such as updated paired agent lists after pairing approval.
- `handleResponse(message)` -- Routes incoming responses to their pending Promise by ID.
- Connection lifecycle: `setConnection(ws)`, `clearConnection()`, `isConnected()`.
- The `sendCommand` timeout is configurable via the `options` parameter (e.g., `{ timeout: 60000 }`).

### `src/paired-keys.js`

CRUD module for managing paired agent API keys:

- Reads and writes `config/paired-keys.json` in the data directory
- Provides `addKey(agentName)` -- generates a new UUID API key, persists it with agent name and creation timestamp, and returns the key
- Provides `validateKey(apiKey)` -- checks whether a given key exists in the store; returns the matching entry object or null
- Provides `renameKey(apiKey, newName)` -- updates the `agentName` for a given key; returns true if found and renamed, false if not found
- Provides `touchKey(apiKey)` -- updates the `lastAccessed` timestamp for a given key (called on every authenticated tool call)
- Provides `revokeKey(apiKey)` -- removes a specific API key from the store; returns true if removed, false if not found
- Provides `listKeys()` -- returns all paired agents with their `agentName`, `createdAt`, `lastAccessed` (or null), full `key`, and truncated `keyDisplay` (first 8 characters)

## MCP Tools

Eleven tools are exposed to AI agents. All tools except `request_pairing` require both the Chrome extension to be connected and a valid paired API key. Every tool except `request_pairing` includes an optional `api_key` string parameter in its schema, allowing per-call authentication as an alternative to the session-level `X-API-Key` header.

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `request_pairing` | Initiate agent pairing to obtain an API key | `agent_name` |
| `browser_create_tab` | Open a new tab with a URL | `url` |
| `browser_close_tab` | Close a tab by ID | `tab_id` |
| `browser_get_tabs` | List all open tabs | (none) |
| `browser_get_accessibility_tree` | Get the accessibility tree of a tab | `tab_id`, `usePlatformOptimizer?` |
| `browser_inject_script` | Inject a script from a URL into a tab | `tab_id`, `script_url`, `keep_injected?` |
| `browser_execute_js` | Execute JavaScript in page context | `tab_id`, `code` |
| `browser_click` | Click by ref, selector, or coordinates | `tab_id`, `ref?`, `selector?`, `x?`, `y?`, `button?`, `clickCount?`, `delay?`, `showCursor?` |
| `browser_scroll` | Scroll to element or by pixel amount | `tab_id`, `ref?`, `selector?`, `pixels?` |
| `browser_type` | Type text with CDP keyboard simulation | `tab_id`, `text`, `ref?`, `selector?`, `delay?`, `pressEnter?` |
| `browser_request_chain` | Execute multiple tool calls sequentially with result referencing | `steps`, `return_mode?` |

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

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/sse` | None | SSE stream for MCP communication |
| POST | `/message?session_id=<id>` | None | JSON-RPC message endpoint |
| GET | `/health` | None | Server status (`extensionConnected`, `sessions` count) |
| GET | `/connect` | None | Returns `{ apiKey, serverUrl, sseUrl, networkMode }` for extension auto-connect |
| WS | `/` (upgrade) | `?apiKey=<key>` | WebSocket for extension connection |

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

By default the server only accepts connections from `localhost`. Use `--network` flag or `NETWORK=1` to listen on all interfaces:

```bash
npm run dev:network     # Development with auto-reload
npm run start:network   # Production
```

In network mode, the server prints the machine's LAN IP so other devices can connect.

Network mode can also be toggled at runtime via the Chrome extension's Settings tab. The extension sends a `set_network_mode` WebSocket message to the server, which:

1. Updates the listen address (`127.0.0.1` or `0.0.0.0`)
2. Persists the preference to `<dataDir>/network.enabled` (survives server restarts)
3. Calls `server.closeAllConnections()` and re-listens on the new address
4. The extension automatically reconnects and calls `refreshConnectionMetadata()` to update its stored URLs

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

Contents: `daemon.log`, `server.pid`, `server.port`, `network.enabled` (persisted network mode preference), `logs/` subdirectory, `config/server.json`, `config/paired-keys.json` (stores paired agent API keys)

## Build

The server compiles to standalone binaries via `@yao-pkg/pkg`. Use the platform-specific build commands (`npm run build` prints an error and exits):

```bash
npm run build:win    # node18-win-x64
npm run build:mac    # node18-macos-x64
npm run build:linux  # node18-linux-x64
```

Output directory: `dist/`.

The compiled binary includes Node.js, all dependencies, and the server source. It can run on machines without Node.js installed. The `cli.js` file is the `bin` entry point in `package.json`, so pkg uses it as the binary's main entry.

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and routing |
| `cors` | Cross-origin resource sharing |
| `ws` | WebSocket server |
| `uuid` | UUID generation for session and command IDs |
| `@yao-pkg/pkg` (dev) | Compile to standalone binaries |
