# MCP Server Architecture

Node.js server that bridges AI agents to the Chrome extension. Exposes browser automation tools via the MCP protocol (over SSE) and communicates with the extension via WebSocket.

## Overview

The MCP server is the middle layer between AI agents and the browser. It:

1. Accepts MCP connections from AI agents via Server-Sent Events (SSE)
2. Receives tool call requests (JSON-RPC 2.0)
3. Translates them into commands and sends them to the Chrome extension via WebSocket
4. Returns results back to the agent via the SSE stream

The MCP endpoints are open (no authentication). The WebSocket endpoint requires an API key to prevent unauthorized browser control.

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

Server bootstrap. Reads configuration using a three-tier loading chain via `getPort()` and `getApiKey()` from `src/service/paths.js`:

1. **Config file** at `<dataDir>/config/server.json` (if it exists)
2. **Environment variables** (`PORT`, `API_KEY`) as fallback
3. **Hardcoded defaults** (`3456`, `dev-123-test`) as final fallback

| Source | Variable | Default | Description |
|--------|----------|---------|-------------|
| Config file / Environment | `PORT` | `3456` | HTTP/WebSocket port |
| Config file / Environment | `API_KEY` | `dev-123-test` | WebSocket authentication key |
| Environment | `NETWORK` | `0` | Enable network mode if set to `1` |
| CLI flag | `--network` | off | Enable network mode (listen on `0.0.0.0`) |

In network mode, the server listens on `0.0.0.0` and advertises the machine's LAN IP address. In default mode, it listens on `127.0.0.1` only.

Calls `createServer()` from `src/server.js` with the resolved configuration.

### `src/server.js`

Sets up the Express HTTP server and WebSocket server:

- Creates an Express app with CORS and JSON body parsing
- Creates an HTTP server and a `WebSocketServer` (noServer mode, manual upgrade handling)
- Authenticates WebSocket connections via `?apiKey=` query parameter
- Handles WebSocket `{ type: 'ping' }` messages from the extension by responding with `{ type: 'pong' }` (keep-alive mechanism)
- On WebSocket connection, registers with the extension bridge
- Writes `server.pid` and `server.port` files to the data directory on listen; cleans them up on SIGTERM, SIGINT, and `exit` events
- Mounts MCP handler routes (`GET /sse`, `POST /message`)
- Exposes `GET /health` (server status) and `GET /connect` (connection string)
- Generates a connection string (`vf://` + base64url-encoded JSON) for the extension popup

## Source Files

### `src/mcp-handler.js`

Implements the MCP protocol:

- **SSE session management** -- Each `GET /sse` request creates a session with a UUID. The session ID is sent as the first SSE event so the client knows where to POST messages. Each session maintains a message queue that is flushed every 100ms via `setInterval`, plus a separate keepalive comment sent every 30 seconds. On client disconnect, both intervals are cleared and the session is removed from the Map.
- **Message handling** -- `POST /message?session_id=<id>` processes JSON-RPC requests and queues responses for delivery via the SSE stream.
- **Protocol methods** -- Handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- **Tool routing** -- Maps MCP tool names to extension command types and parameters.
- **Known issue** -- `serverInfo.version` is hardcoded as `0.2.0` in `mcp-handler.js`, but `package.json` declares version `0.3.0`. These are out of sync.
- **Script fetching** -- For `browser_inject_script`, the server fetches the script from the provided URL before sending the content to the extension. This allows injecting scripts from localhost or external URLs regardless of page CSP.

### `src/extension-bridge.js`

WebSocket bridge to the Chrome extension:

- Maintains a single WebSocket connection (one extension at a time)
- `sendCommand(type, params)` -- Sends a command to the extension with a unique UUID and returns a Promise. The Promise resolves when the extension sends a matching response, or rejects on timeout (30 seconds) or disconnect.
- `handleResponse(message)` -- Routes incoming responses to their pending Promise by ID.
- Connection lifecycle: `setConnection(ws)`, `clearConnection()`, `isConnected()`.

## MCP Tools

Nine tools are exposed to AI agents. All tools require the Chrome extension to be connected.

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `browser_create_tab` | Open a new tab with a URL | `url` |
| `browser_close_tab` | Close a tab by ID | `tab_id` |
| `browser_get_tabs` | List all open tabs | (none) |
| `browser_get_accessibility_tree` | Get the accessibility tree of a tab | `tab_id`, `usePlatformOptimizer?` |
| `browser_inject_script` | Inject a script from a URL into a tab | `tab_id`, `script_url`, `keep_injected?` |
| `browser_execute_js` | Execute JavaScript in page context | `tab_id`, `code` |
| `browser_click` | Click by ref, selector, or coordinates | `tab_id`, `ref?`, `selector?`, `x?`, `y?`, `button?`, `clickCount?`, `delay?`, `showCursor?` |
| `browser_scroll` | Scroll to element or by pixel amount | `tab_id`, `ref?`, `selector?`, `pixels?` |
| `browser_type` | Type text with CDP keyboard simulation | `tab_id`, `text`, `ref?`, `selector?`, `delay?`, `pressEnter?` |

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
| GET | `/connect` | None | Connection string and server URL for extension setup |
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
| `NETWORK` | `0` | Set to `1` for network mode |
| `WEBPILOT_FOREGROUND` | unset | Set to `1` to run in foreground (used internally by daemon self-spawn) |

### Network Mode

By default the server only accepts connections from `localhost`. Use `--network` flag or `NETWORK=1` to listen on all interfaces:

```bash
npm run dev:network     # Development with auto-reload
npm run start:network   # Production
```

In network mode, the server prints the machine's LAN IP so other devices can connect.

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

Contents: `daemon.log`, `server.pid`, `server.port`, `logs/` subdirectory, `config/server.json`

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
