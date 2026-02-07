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

- `--install` / `--uninstall` / `--status` -- Service management (currently stubs, logs platform and exits)
- `--help` / `--version` -- Print help text or version from `package.json`
- `--network` -- Forwarded to `index.js` via `process.argv`
- No flags -- Requires `index.js` to start the server

### `index.js`

Server bootstrap. Reads configuration from environment variables and `process.argv`:

| Source | Variable | Default | Description |
|--------|----------|---------|-------------|
| Environment | `PORT` | `3456` | HTTP/WebSocket port |
| Environment | `API_KEY` | `dev-123-test` | WebSocket authentication key |
| Environment | `NETWORK` | `0` | Enable network mode if set to `1` |
| CLI flag | `--network` | off | Enable network mode (listen on `0.0.0.0`) |

In network mode, the server listens on `0.0.0.0` and advertises the machine's LAN IP address. In default mode, it listens on `127.0.0.1` only.

Calls `createServer()` from `src/server.js` with the resolved configuration.

### `src/server.js`

Sets up the Express HTTP server and WebSocket server:

- Creates an Express app with CORS and JSON body parsing
- Creates an HTTP server and a `WebSocketServer` (noServer mode, manual upgrade handling)
- Authenticates WebSocket connections via `?apiKey=` query parameter
- On WebSocket connection, registers with the extension bridge
- Mounts MCP handler routes (`GET /sse`, `POST /message`)
- Exposes `GET /health` (server status) and `GET /connect` (connection string)
- Generates a connection string (`vf://` + base64url-encoded JSON) for the extension popup

## Source Files

### `src/mcp-handler.js`

Implements the MCP protocol:

- **SSE session management** -- Each `GET /sse` request creates a session with a UUID. The session ID is sent as the first SSE event so the client knows where to POST messages.
- **Message handling** -- `POST /message?session_id=<id>` processes JSON-RPC requests and queues responses for delivery via the SSE stream.
- **Protocol methods** -- Handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.
- **Tool routing** -- Maps MCP tool names to extension command types and parameters.
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

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `API_KEY` | `dev-123-test` | API key for WebSocket authentication |
| `NETWORK` | `0` | Set to `1` for network mode |

### Network Mode

By default the server only accepts connections from `localhost`. Use `--network` flag or `NETWORK=1` to listen on all interfaces:

```bash
npm run dev:network     # Development with auto-reload
npm run start:network   # Production
```

In network mode, the server prints the machine's LAN IP so other devices can connect.

## CLI and Background Service

The CLI (`cli.js`) supports `--install`, `--uninstall`, and `--status` flags for background service management. These are currently stubs that detect the platform and print a "not yet implemented" message. When implemented:

| Platform | Service Mechanism |
|----------|-------------------|
| Windows  | Task Scheduler (run at login, hidden) |
| macOS    | launchd (LaunchAgent plist) |
| Linux    | systemd (user service unit) |

## Build

The server compiles to standalone binaries via `@yao-pkg/pkg`:

```bash
npm run build
```

Targets: `node18-win-x64`, `node18-macos-x64`, `node18-linux-x64`. Output directory: `dist/`.

The compiled binary includes Node.js, all dependencies, and the server source. It can run on machines without Node.js installed. The `cli.js` file is the `bin` entry point in `package.json`, so pkg uses it as the binary's main entry.

## Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server and routing |
| `cors` | Cross-origin resource sharing |
| `ws` | WebSocket server |
| `uuid` | UUID generation for session and command IDs |
| `@yao-pkg/pkg` (dev) | Compile to standalone binaries |
