# Vantage Feed Extension - Technical Documentation

## Overview

Vantage Feed is a Chrome extension that enables AI agents to control browser tabs via the Model Context Protocol (MCP). It consists of two components:

1. **Chrome Extension** - Executes browser commands using Chrome APIs
2. **MCP Server** - Bridges MCP-compatible agents to the extension via WebSocket

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│   Claude Code              MCP Server (:3456)        Chrome Extension   │
│   or AI Agent                                                           │
│                                                                         │
│   ┌─────────┐    SSE     ┌─────────────────┐    WS    ┌─────────────┐  │
│   │         │◄──────────►│                 │◄────────►│             │  │
│   │  Agent  │  (no auth) │  Express Server │(API key) │ background  │  │
│   │         │            │                 │          │    .js      │  │
│   └─────────┘            └─────────────────┘          └─────────────┘  │
│                                                                         │
│   - GET /sse             - Bridges SSE↔WS            - Chrome APIs     │
│   - POST /message        - Session management        - Tab control     │
│                          - Tool routing                                 │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Components

### Chrome Extension (`unpacked-extension/`)

#### manifest.json
- Manifest V3 Chrome extension
- Permissions: `storage`, `activeTab`, `tabs`
- Service worker: `background.js`

#### background.js
WebSocket client that:
- Connects to the MCP server with API key authentication
- Receives commands (create_tab, close_tab, get_tabs)
- Executes commands via Chrome APIs
- Returns results to the server
- **Manual connect only** - does not auto-connect on browser startup

#### popup/
Configuration UI with three views:
- **Setup View**: First-time configuration with connection string
- **Connected View**: Shows connection status, disconnect button
- **Disconnected View**: Shows stored config, reconnect/forget buttons

### MCP Server (`mcp-server/`)

#### server.js
- Express HTTP server on port 3456
- WebSocket server for extension connection (requires API key)
- Generates connection string for easy extension setup

#### mcp-handler.js
MCP protocol implementation:
- SSE endpoint for agent connections (`GET /sse`) - **no auth required**
- Message endpoint for tool calls (`POST /message`) - **no auth required**
- Tool definitions (browser_create_tab, browser_close_tab, browser_get_tabs)
- Queue-based message delivery via SSE

#### extension-bridge.js
WebSocket-to-extension communication:
- Command queuing with unique IDs
- Timeout handling (30s)
- Response routing to pending promises

## Authentication Model

| Connection | Auth Required | Method |
|------------|---------------|--------|
| Claude Code → MCP Server (SSE) | **No** | Open endpoint |
| Claude Code → MCP Server (Message) | **No** | Open endpoint |
| Extension → MCP Server (WebSocket) | **Yes** | `?apiKey=` query param |

The MCP endpoints are open to simplify Claude Code integration. The WebSocket endpoint requires authentication to prevent unauthorized browser control.

## Message Protocol

### SSE Connection (Agent → Server)

On connect, server sends:
```
event: endpoint
data: /message?session_id={uuid}
```

This tells the agent where to POST messages for this session.

### Message Responses (Server → Agent via SSE)

```
event: message
data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

### Extension ↔ Server (WebSocket)

**Command (Server → Extension):**
```json
{
  "id": "uuid-here",
  "type": "create_tab",
  "params": {
    "url": "https://example.com"
  }
}
```

**Result (Extension → Server):**
```json
{
  "id": "uuid-here",
  "success": true,
  "result": {
    "tab_id": 42,
    "url": "https://example.com",
    "title": "Example"
  }
}
```

**Keep-alive (Extension ↔ Server):**
```json
{"type": "ping"}
{"type": "pong"}
```

## API Endpoints

### GET /sse
Establishes SSE connection for MCP communication.
- **No authentication required**
- Returns: Event stream with endpoint URL containing session ID

### POST /message
Handles MCP JSON-RPC requests.
- **No authentication required**
- Query: `session_id` (required)
- Body: JSON-RPC 2.0 request
- Returns: 202 Accepted (response delivered via SSE)

### GET /health
Server health check.
- Returns: `{ status, extensionConnected, sessions }`

### GET /connect
Get connection string for extension setup.
- Returns: `{ connectionString, serverUrl }`

### WebSocket /
Extension connection (upgrade from HTTP).
- Query: `apiKey` (required)
- Returns: 401 if key invalid

## Connection String Format

The connection string encodes server URL and API key in base64url:

```
vf://eyJ2IjoxLCJzIjoid3M6Ly9sb2NhbGhvc3Q6MzQ1NiIsImsiOiJkZXYtMTIzLXRlc3QifQ
```

Decoded:
```json
{"v":1,"s":"ws://localhost:3456","k":"dev-123-test"}
```

Users paste this into the extension popup for one-step setup.

## Tool Schemas

### browser_create_tab
```json
{
  "name": "browser_create_tab",
  "description": "Create a new browser tab with the specified URL",
  "inputSchema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "The URL to open in the new tab" }
    },
    "required": ["url"]
  }
}
```

Returns: `{ tab_id, url, title }`

### browser_close_tab
```json
{
  "name": "browser_close_tab",
  "description": "Close a browser tab by its ID",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tab_id": { "type": "number", "description": "The ID of the tab to close" }
    },
    "required": ["tab_id"]
  }
}
```

Returns: `{ success: true }`

### browser_get_tabs
```json
{
  "name": "browser_get_tabs",
  "description": "Get a list of all open browser tabs",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

Returns: `[{ id, url, title, active, windowId }, ...]`

## Extension User Flow

```
First Launch (no config)
       │
       ▼
┌─────────────────┐
│   Setup View    │──── paste connection string + Connect ────►
│ "Paste your     │                                     │
│  connection     │                                     ▼
│  string"        │                              ┌───────────┐
└─────────────────┘                              │ Connected │
       ▲                                         │   View    │
       │                                         └─────┬─────┘
  auth failure                                         │
  (clears config)                                 disconnect
       │                                               │
       │         ┌─────────────────┐                   │
       │         │ Disconnected    │◄──────────────────┘
       │         │ View            │
       │         │                 │
       │         │ [Reconnect]     │─── click Reconnect ──► Connected
       │         │ [Forget]        │
       │         └────────┬────────┘
       │                  │
       └──── click Forget ┘

Browser Restart with stored config → Disconnected View (manual reconnect)
```

## Error Handling

### Extension Errors
- Invalid command type → Error response
- Chrome API errors → Error with message
- WebSocket disconnect → Shows disconnected view (no auto-reconnect)
- Auth failure → Clears config, returns to setup view

### Server Errors
- Session not found → 400 Bad Request
- Extension not connected → Error in tool result
- Command timeout (30s) → Error in tool result

## Development

### Making Changes

1. Edit files in the appropriate directory
2. For extension: Go to `chrome://extensions/` and click refresh
3. For server: Use `npm run dev` for auto-reload

### Debugging

- **Extension Popup**: Right-click the popup → Inspect
- **Extension Background**: Click "Service Worker" link on `chrome://extensions/`
- **Server**: Check console output

### Testing Checklist

- [ ] Server starts without errors
- [ ] Extension loads without errors
- [ ] Paste connection string → Extension connects
- [ ] Status shows "Connected"
- [ ] `browser_get_tabs` returns tab list
- [ ] `browser_create_tab` opens new tab
- [ ] `browser_close_tab` closes specified tab
- [ ] Disconnect → Shows disconnected view
- [ ] Reconnect → Reconnects successfully
- [ ] Forget → Returns to setup view
- [ ] Browser restart → Shows disconnected view (not auto-connect)
