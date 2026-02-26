# WebPilot - MCP Browser Control

Self-contained Chrome extension and MCP server for AI agent browser control.

## Quick Start

### 1. Start the MCP Server

```bash
cd mcp-server
npm install
npm run dev    # Auto-reloads on changes
```

You should see:
```
MCP Server running on :3456
  SSE endpoint: http://localhost:3456/sse
  WebSocket: ws://localhost:3456

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Connection String (paste in extension):

  vf://eyJ2IjoxLCJzIjoid3M6Ly9sb2NhbGhvc3Q6MzQ1NiIsImsiOiJkZXYtMTIzLXRlc3QifQ

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 2. Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `unpacked-extension/` folder

### 3. Configure the Extension

1. Click the WebPilot extension icon
2. **Copy the connection string** from the server output
3. **Paste it** into the extension popup
4. Click **Connect**
5. Status should show **Connected**

### 4. Configure Claude Code

Run this command in your project:

```bash
claude mcp add -s project --transport sse webpilot "http://localhost:3456/sse"
```

Or add to your `.mcp.json` manually:

```json
{
  "mcpServers": {
    "webpilot": {
      "type": "sse",
      "url": "http://localhost:3456/sse"
    }
  }
}
```

**Note:** No authentication headers needed - the MCP endpoints are open for Claude Code compatibility.

### 5. Test It

In Claude Code, try:
- "List all my browser tabs"
- "Open a new tab to google.com"
- "Close tab 123"

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         webpilot                            │
│                                                             │
│  ┌─────────────────────┐       ┌─────────────────────┐     │
│  │  unpacked-extension │       │     mcp-server      │     │
│  │                     │◄─WS──►│                     │     │
│  │  Chrome Extension   │ (key) │  Express + WS       │     │
│  │  (background.js)    │       │  :3456              │     │
│  └─────────────────────┘       └──────────┬──────────┘     │
│                                           │                 │
└───────────────────────────────────────────│─────────────────┘
                                            │
                                       MCP SSE (open)
                                            │
                                            ▼
                                   Claude Code / AI Agents
```

**Authentication:**
- Extension ↔ Server: API key required (via connection string)
- Claude Code ↔ Server: No auth (open endpoints)

## MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `browser_create_tab` | Create new tab with URL | `url: string` |
| `browser_close_tab` | Close tab by ID | `tab_id: number` |
| `browser_get_tabs` | List all open tabs | _(none)_ |
| `browser_get_accessibility_tree` | Get accessibility tree of a tab | `tab_id: number`, `usePlatformOptimizer?: boolean` |
| `browser_inject_script` | Inject script from URL into page | `tab_id: number`, `script_url: string`, `keep_injected?: boolean` |
| `browser_execute_js` | Execute JS in page context, return result | `tab_id: number`, `code: string` |
| `browser_click` | Click at coordinates, CSS selector, or accessibility tree ref | `tab_id`, `ref?`, `selector?`, `x?`, `y?`, `button?`, `clickCount?`, `showCursor?` |
| `browser_scroll` | Scroll to element OR by pixel amount (50ms per 50px) | `tab_id`, `ref?`, `selector?`, `pixels?` |

## Folder Structure

```
webpilot/
├── unpacked-extension/           # Chrome extension (load in chrome://extensions)
│   ├── manifest.json
│   ├── background.js             # Thin orchestrator (~330 lines)
│   ├── accessibility-storage.js  # Ref→backendNodeId mapping
│   ├── accessibility-tree.js     # A11y tree formatter
│   ├── handlers/                 # Command handlers
│   │   ├── click.js              # Mouse click with cursor animation
│   │   ├── scroll.js             # Smooth scroll with easing
│   │   ├── tabs.js               # Tab create/close/list
│   │   ├── accessibility.js      # Tree and Threads feed
│   │   └── scripts.js            # Inject/execute JS
│   ├── utils/                    # Shared utilities
│   │   ├── windmouse.js          # WindMouse human-like path algorithm
│   │   ├── mouse-state.js        # Per-tab virtual position tracking
│   │   ├── cursor.js             # Cursor animation (RGB glow, particle burst)
│   │   ├── scroll.js             # Scroll animation and viewport helpers
│   │   ├── timing.js             # Random delays
│   │   └── debugger.js           # CDP attach/detach helpers
│   ├── formatters/
│   │   ├── threads.js            # Threads router (detects page type, delegates)
│   │   ├── threads_home.js       # Threads home/profile page (posts extraction)
│   │   ├── threads_activity.js   # Threads activity page (follows, likes, milestones, replies, polls)
│   │   └── threads_search.js     # Threads search (landing, autocomplete, results)
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.css
│   │   └── popup.js
│   └── icons/
│
├── mcp-server/                   # Node.js MCP server
│   ├── package.json
│   ├── index.js
│   └── src/
│       ├── server.js
│       ├── mcp-handler.js
│       └── extension-bridge.js
│
├── README.md
├── MCP_INTEGRATION.md            # MCP tools reference
└── EXTENSION.md                  # Detailed technical docs
```

## Environment Variables

The MCP server supports these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `API_KEY` | `dev-123-test` | API key for extension auth |

## Extension Behavior

The extension uses **manual connect** - it does NOT auto-connect on browser startup.

**Views:**
- **Setup View**: First-time setup, paste connection string
- **Connected View**: Shows status, disconnect button, settings
- **Disconnected View**: Reconnect or Forget buttons, settings

**Settings:**
- **Focus new tabs** (default: off): When disabled, new tabs open in the background without stealing focus
- **Tab organization** (default: Existing window): Choose between opening tabs in the current window or a dedicated WebPilot window. Both modes use a cyan "WebPilot" tab group

**After browser restart:** Extension shows Disconnected view. Click Reconnect to connect.

## Troubleshooting

### Extension shows "Disconnected"
- Ensure the MCP server is running (`npm run dev`)
- Click the "Reconnect" button

### Extension shows Setup view unexpectedly
- Connection string may have been cleared due to auth failure
- Re-paste the connection string from the server output

### Claude Code can't connect
- Check the SSE endpoint: `curl http://localhost:3456/health`
- Verify the response shows `extensionConnected: true`
- Restart Claude Code after adding the MCP server

### Commands not working
- Ensure the extension shows "Connected"
- Check the browser console for errors (Service Worker link)
- Check the MCP server console for logs

### Reset Extension to Fresh State

**Option 1: Use the Forget button**
- If on the Disconnected view, click "Forget"

**Option 2: Clear storage via DevTools**
1. Go to `chrome://extensions/`
2. Find WebPilot and click the "Service worker" link
3. In the DevTools console, run:
   ```js
   chrome.storage.local.clear()
   ```
4. Close and reopen the extension popup

## Development

### Hot Reload

Use `npm run dev` for auto-reload on server changes:
```bash
cd mcp-server
npm run dev
```

### Manual Reload

For extension changes:
1. Edit files in `unpacked-extension/`
2. Go to `chrome://extensions/`
3. Click the refresh icon on the WebPilot extension

See [EXTENSION.md](./EXTENSION.md) for detailed technical documentation.
