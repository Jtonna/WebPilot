# WebPilot - MCP Browser Control

Self-contained Chrome extension and MCP server for AI agent browser control.

## Quick Start

### 1. Start the MCP Server

```bash
cd packages/server-for-chrome-extension
npm install
npm run dev    # Auto-reloads on changes
```

Or from the workspace root:
```bash
npm run dev:server
```

You should see:
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
connection_string: vf://eyJ2IjoxLCJzIjoid3M6Ly9sb2NhbGhvc3Q6MzQ1NiIsImsiOiJkZXYtMTIzLXRlc3QifQ
```

### 2. Load the Chrome Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `packages/chrome-extension-unpacked/` folder

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
│  ┌──────────────────────────┐  ┌─────────────────────┐     │
│  │ chrome-extension-unpacked│  │  server-for-chrome-  │     │
│  │                          │◄─WS──►  extension      │     │
│  │  Chrome Extension        │ (key) │  Express + WS   │     │
│  │  (background.js)         │       │  :3456           │     │
│  └──────────────────────────┘  └──────────┬──────────┘     │
│                                           │                 │
│  ┌─────────────────────┐                  │                 │
│  │     electron         │                 │                 │
│  │  Deployment, auto-   │                 │                 │
│  │  start, packaging    │                 │                 │
│  └─────────────────────┘                  │                 │
│                                           │                 │
└───────────────────────────────────────────│─────────────────┘
                                            │
                                       MCP SSE (open)
                                            │
                                            ▼
                                   Claude Code / AI Agents
```

**Authentication:**
- Extension <-> Server: API key required (via connection string)
- Claude Code <-> Server: No auth (open endpoints)

## MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `browser_create_tab` | Create new tab with URL | `url: string` |
| `browser_close_tab` | Close tab by ID | `tab_id: number` |
| `browser_get_tabs` | List all open tabs | _(none)_ |
| `browser_get_accessibility_tree` | Get accessibility tree of a tab | `tab_id: number`, `usePlatformOptimizer?: boolean` |
| `browser_inject_script` | Inject script from URL into page | `tab_id: number`, `script_url: string`, `keep_injected?: boolean` |
| `browser_execute_js` | Execute JS in page context, return result | `tab_id: number`, `code: string` |
| `browser_click` | Click at coordinates, CSS selector, or accessibility tree ref | `tab_id`, `ref?`, `selector?`, `x?`, `y?`, `button?`, `clickCount?`, `delay?`, `showCursor?` |
| `browser_scroll` | Scroll to element OR by pixel amount (75ms per 50px) | `tab_id`, `ref?`, `selector?`, `pixels?` |
| `browser_type` | Type text into focused element or element by ref/selector | `tab_id: number`, `text: string`, `ref?`, `selector?`, `delay?`, `pressEnter?` |

## Folder Structure

```
webpilot/
├── packages/
│   ├── chrome-extension-unpacked/   # Chrome extension (load in chrome://extensions)
│   │   ├── manifest.json
│   │   ├── background.js            # Thin orchestrator (~350 lines)
│   │   ├── accessibility-storage.js # Ref->backendNodeId mapping
│   │   ├── accessibility-tree.js    # A11y tree formatter
│   │   ├── handlers/                # Command handlers
│   │   │   ├── click.js             # Mouse click with cursor animation
│   │   │   ├── keyboard.js          # CDP keyboard simulation (browser_type)
│   │   │   ├── scroll.js            # Smooth scroll with easing
│   │   │   ├── tabs.js              # Tab create/close/list
│   │   │   ├── accessibility.js     # Tree and Threads feed
│   │   │   └── scripts.js           # Inject/execute JS
│   │   ├── utils/                   # Shared utilities
│   │   │   ├── windmouse.js         # WindMouse human-like path algorithm
│   │   │   ├── mouse-state.js       # Per-tab virtual position tracking
│   │   │   ├── cursor.js            # Cursor animation (RGB glow, particle burst)
│   │   │   ├── scroll.js            # Scroll animation and viewport helpers
│   │   │   ├── timing.js            # Random delays
│   │   │   └── debugger.js          # CDP attach/detach helpers
│   │   ├── formatters/
│   │   │   ├── threads.js           # Threads router (detects page type, delegates)
│   │   │   ├── threads_home.js      # Threads home/profile page (posts extraction)
│   │   │   ├── threads_activity.js  # Threads activity page (follows, likes, milestones, replies, polls)
│   │   │   ├── threads_search.js    # Threads search (landing, autocomplete, results)
│   │   │   ├── zillow.js            # Zillow router (detects page type, delegates)
│   │   │   ├── zillow_detail.js     # Zillow property detail
│   │   │   ├── zillow_detail_page.js # Zillow detail page variant
│   │   │   ├── zillow_home.js       # Zillow home page
│   │   │   └── zillow_search.js     # Zillow search results
│   │   ├── popup/
│   │   │   ├── popup.html
│   │   │   ├── popup.css
│   │   │   └── popup.js
│   │   └── icons/
│   │
│   ├── server-for-chrome-extension/ # Node.js MCP server
│   │   ├── package.json
│   │   ├── cli.js                   # CLI entry point (pkg binary entry)
│   │   ├── index.js
│   │   └── src/
│   │       ├── server.js
│   │       ├── mcp-handler.js
│   │       ├── extension-bridge.js
│   │       └── service/             # Platform-specific service management
│   │           ├── index.js
│   │           ├── paths.js         # Config loading, defaults, data paths
│   │           ├── logger.js        # Daemon log writer
│   │           ├── windows.js       # Windows Registry auto-start
│   │           ├── macos.js         # macOS launchd service
│   │           └── linux.js         # Linux systemd service
│   │
│   └── electron/                    # Electron app for deployment
│       └── ...                      # Packaging, auto-start, onboarding UI
│
├── package.json                     # Workspace root (monorepo scripts)
├── release.sh
├── release.ps1
├── docs/
└── docs-old/
```

## Configuration

### Environment Variables

The MCP server supports these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `API_KEY` | `dev-123-test` | API key for extension auth |
| `NETWORK` | _(unset)_ | Set to `1` to enable network/LAN access |

### Config File

The server also supports a JSON config file at `{dataDir}/config/server.json`:

```json
{
  "port": 3456,
  "apiKey": "your-custom-key"
}
```

**Priority order:** config file > environment variable > hardcoded default.

The data directory location depends on the platform:
- **Windows:** `%LOCALAPPDATA%\WebPilot`
- **macOS:** `~/Library/Application Support/WebPilot`
- **Linux:** `$XDG_CONFIG_HOME/WebPilot` (or `~/.config/WebPilot`)

## CLI and Standalone Binary

The server has a CLI entry point (`cli.js`) designed to be compiled into a standalone `.exe` via `@yao-pkg/pkg`.

```
Usage: webpilot-mcp [options]

Options:
  --foreground   Run server in the foreground (for development/testing)
  --install      Register as a background service
  --uninstall    Remove the background service
  --stop         Stop the running server
  --status       Check service status
  --help         Show help message
  --version      Show version number
```

> **Note:** The `--network` flag (bind to `0.0.0.0` for LAN access) is also supported at runtime but is not listed in `--help` output.

Running with no options starts the server as a background daemon.

### Building the binary

```bash
cd packages/server-for-chrome-extension
pkg . --target node18-win-x64 --out-path dist
```

### Network Mode

To expose the server on your local network (bind to `0.0.0.0` instead of `127.0.0.1`):

```bash
npm run dev:network     # Dev mode with network access
npm run start:network   # Production mode with network access
```

> **Note:** These scripts are defined in `packages/server-for-chrome-extension/package.json`, not the root workspace. Run them from within `packages/server-for-chrome-extension/`, or use `npm run dev:network --workspace=packages/server-for-chrome-extension` from the root.

Or use the `--network` flag or `NETWORK=1` environment variable.

### Service Management

The `src/service/` directory contains platform-specific service management:
- **Windows:** Registry Run key (`HKCU`) for auto-start on login
- **macOS:** launchd plist for auto-start
- **Linux:** systemd user service for auto-start

The server writes `server.pid` and `server.port` files to the data directory for process management, and cleans them up on shutdown.

## Extension Behavior

Initial setup requires a manual connection string paste. After first connect, the extension **auto-reconnects on browser restart** (via `chrome.runtime.onStartup` listener). On non-auth connection failures, it retries every 5 seconds while enabled. On auth failures, it clears stored credentials and stops retrying.

**Views:**
- **Setup View**: First-time setup, paste connection string
- **Connecting View**: Shows server URL and spinner while WebSocket connection is being established
- **Connected View**: Shows status, disconnect button, settings
- **Disconnected View**: Reconnect or Forget buttons, settings

**Settings:**
- **Focus new tabs** (default: off): When disabled, new tabs open in the background without stealing focus
- **Tab organization** (default: Existing window): Choose between opening tabs in the current window or a new window. Both modes use a cyan "WebPilot" tab group

**After browser restart:** Extension auto-reconnects if previously connected. If the server is unreachable, it shows the Disconnected view with a Reconnect button.

## Workspace Scripts

The root `package.json` defines these workspace scripts:

| Script | Description |
|--------|-------------|
| `npm run dev:server` | Start MCP server in watch mode |
| `npm run dev:onboarding` | Start the Electron onboarding UI |
| `npm run start` | Start MCP server (production) |
| `npm run dist:win` | Build Windows installer (server binary + Electron) |
| `npm run dist:mac` | Build macOS installer |
| `npm run dist:linux` | Build Linux installer |

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
cd packages/server-for-chrome-extension
npm run dev
```

### Manual Reload

For extension changes:
1. Edit files in `packages/chrome-extension-unpacked/`
2. Go to `chrome://extensions/`
3. Click the refresh icon on the WebPilot extension
