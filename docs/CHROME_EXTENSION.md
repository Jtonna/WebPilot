# Chrome Extension Architecture

Manifest V3 Chrome extension for AI-driven browser automation. Receives commands from the MCP server via WebSocket and executes them in the browser using Chrome APIs and the Chrome DevTools Protocol (CDP).

## Overview

The extension acts as the execution layer of WebPilot. It does not make decisions -- it receives structured commands from the MCP server (which in turn receives them from an AI agent) and translates them into browser actions: opening tabs, clicking elements, scrolling, typing, reading page content, and executing JavaScript.

All interaction with web pages uses CDP via the `chrome.debugger` API, which allows the extension to simulate real input events (mouse clicks, keyboard presses) that work with React, Vue, and other SPA frameworks.

## Architecture

```
background.js (service worker)
    |
    +-- WebSocket connection to MCP server
    |   (receives commands, sends results)
    |
    +-- Command router (switch on message type)
    |
    +-- handlers/
    |     tabs.js          Tab management
    |     click.js         Mouse click simulation
    |     scroll.js        Smooth scrolling
    |     keyboard.js      Keyboard input simulation
    |     scripts.js       Script injection and execution
    |     accessibility.js Accessibility tree extraction
    |
    +-- formatters/
    |     threads.js       Threads platform router
    |     threads_home.js  Threads home/profile page
    |     threads_activity.js  Threads activity page
    |     threads_search.js    Threads search pages
    |     zillow.js        Zillow platform router
    |     zillow_home.js   Zillow homepage
    |     zillow_search.js Zillow search results
    |     zillow_detail.js Zillow property detail overlay
    |     zillow_detail_page.js  Zillow full detail page
    |
    +-- utils/
    |     debugger.js      CDP session management
    |     windmouse.js     Human-like mouse path generation
    |     mouse-state.js   Per-tab virtual cursor position
    |     cursor.js        Visual cursor animation (SVG + particles)
    |     scroll.js        Scroll animation and viewport helpers
    |     timing.js        Weighted random delays
    |
    +-- accessibility-tree.js    Default a11y tree formatter
    +-- accessibility-storage.js Ref-to-backendNodeId mapping
    +-- popup/                   Extension popup UI
```

## background.js -- Service Worker

The service worker is the entry point and command router. It:

1. Manages the WebSocket connection to the MCP server (connect, disconnect, keepalive, reconnect on error)
2. Receives command messages (JSON with `id`, `type`, `params`)
3. Routes each command to the appropriate handler based on `type`
4. Sends results back to the server (JSON with `id`, `success`, `result` or `error`)
5. Listens for Chrome events (tab closed, navigation complete) to clean up state

On startup, the extension auto-connects to `localhost:3456` by fetching `/connect` to obtain the API key, server URL, SSE URL, and network mode, then stores all values in `chrome.storage.local` and establishes the WebSocket connection. If configuration is already stored in `chrome.storage.local`, that is used directly. On every successful WebSocket connection (including reconnects), `refreshConnectionMetadata()` fetches `/connect` again to update the stored `serverUrl`, `sseUrl`, and `networkMode` values -- this ensures the extension picks up any server-side changes (e.g., network mode toggle). The extension auto-reconnects on transient connection failures (code 1006, server unreachable) with a 5-second delay. Authentication failures (code 1008) clear stored config and restart auto-connect. A `manuallyDisconnected` flag prevents auto-reconnect when the user explicitly disconnects via the popup.

### Message handlers

#### From server

| Message type | Action |
|--------------|--------|
| `pairing_request` | Stores the pending request and forwards it to the popup via `chrome.runtime.sendMessage` so the user can Approve or Deny. |

#### From popup (chrome.runtime.onMessage)

| Message type | Action |
|--------------|--------|
| `GET_STATUS` | Returns current connection state: `enabled`, `connected`, `connectionStatus`, `connectionError`, `errorType`, `manuallyDisconnected`, and config info (`hasApiKey`, `serverUrl`). |
| `CONNECT_REQUEST` | Loads stored config and initiates a WebSocket connection if config is available. |
| `DISCONNECT` | Sets `manuallyDisconnected = true`, then calls `disconnectWebSocket()` which nulls `wsConnection.onclose` before closing to prevent the onclose handler from auto-reconnecting. |
| `RECONNECT` | Clears `manuallyDisconnected`, re-enables the extension, and initiates a WebSocket connection. |
| `FORGET_CONFIG` | Disconnects, clears stored config (`apiKey`, `serverUrl`, `enabled`), resets state, and restarts auto-connect to pick up server again. |
| `RETRY_AUTO_CONNECT` | Restarts the auto-connect polling loop (fetches `/connect` from the default server URL). |
| `PAIRING_RESPONSE` | Relays the user's approve/deny decision to the server with the original request ID. Removes the request from the pending list in storage. |
| `REVOKE_KEY` | Sends a `revoke_key` message to the server over WebSocket with the specified `apiKey`. |
| `RENAME_AGENT` | Sends a `rename_agent` message to the server over WebSocket with the specified `apiKey` and `newName`. |
| `GET_PAIRED_AGENTS` | Reads `pairedAgents` from `chrome.storage.local` and returns the list to the popup. |
| `GET_PENDING_PAIRING` | Reads `pendingPairingRequests` from `chrome.storage.local` and returns them to the popup. |
| `SET_NETWORK_MODE` | Sends a `set_network_mode` message to the server over WebSocket with the `enabled` flag. The server switches listen address and persists the preference. |
| `SERVICE_STATUS_CHANGED` | Updates `isEnabled` and connects/disconnects WebSocket accordingly. |
| `CONFIG_UPDATED` | Updates stored config and reconnects if enabled. |

## Handlers

### `handlers/tabs.js`

Tab lifecycle management.

- `createTab(params)` -- Opens a new tab with the given URL. The tab's `active` state is controlled by the `focusNewTabs` setting (defaults to false, meaning tabs open in the background). Automatically organizes the tab via `organizeTab`.
- `closeTab(params)` -- Closes a tab by ID.
- `getTabs()` -- Returns all open tabs with their ID, URL, title, active state, window ID, and group ID.
- `organizeTab(tabId)` -- Reads the `tabMode` setting from `chrome.storage.local` and routes to either `addTabToGroup(tabId)` (group mode, default) or `addTabToWindow(tabId)` (window mode). Called automatically when any command interacts with a tab.
- `addTabToGroup(tabId)` -- Adds a tab to a cyan "WebPilot" tab group, creating the group if it does not exist.
- `addTabToWindow(tabId)` -- Moves a tab to the dedicated WebPilot Chrome window if one already exists. Returns a failure if no WebPilot window has been created yet. Window creation happens exclusively in `createTab` when `tabMode` is set to `'window'` and no WebPilot window exists.

### `handlers/click.js`

CDP mouse simulation with human-like cursor movement.

- Resolves click targets from accessibility tree refs, CSS selectors, or raw coordinates
- Uses the WindMouse algorithm (`utils/windmouse.js`) to generate a curved path from the last cursor position to the target
- Dispatches `Input.dispatchMouseEvent` (mouseMoved, mousePressed, mouseReleased) along the path
- Shows a visual SVG cursor with RGB glow animation and particle burst on click
- Auto-scrolls off-screen elements into view before clicking, checking for scrollable containers first (using a temporary `data-webpilot-scroll-target` attribute to bridge CDP node resolution and in-page JavaScript), then falling back to window scrolling
- Re-identifies elements after scroll using ancestry context (handles virtualized DOM recycling)
- Tracks last cursor position per tab so subsequent clicks start from where the previous one ended

### `handlers/scroll.js`

Smooth animated scrolling.

- Scrolls to an element (by ref or CSS selector) or by a pixel amount
- Detects scrollable parent containers (elements with `overflow-y: auto|scroll` and `scrollHeight > clientHeight`) before falling back to window scrolling
- Uses `requestAnimationFrame` with cubic ease-in-out for 60fps animation
- Duration auto-calculated: 50ms per 50px for window scrolls, 75ms per 50px for container scrolls
- Centers the target element in the viewport when scrolling to a ref/selector
- Skips scrolling if the element is already visible (returns `scrolled: false`)

### `handlers/keyboard.js`

CDP keyboard input simulation.

- Types text character by character using `Input.dispatchKeyEvent` (keyDown + keyUp per character)
- Optionally clicks a ref or selector first to focus the target element
- Supports special keys: Enter, Tab, Backspace, Escape, arrow keys
- Adds human-like timing variance to the delay between keystrokes (default 50ms with +/-30% jitter)

### `handlers/scripts.js`

JavaScript injection and execution in page context.

- `injectScript(params)` -- Injects script content (fetched by the MCP server from a URL) into the page via `Runtime.evaluate`. Supports `keep_injected` mode which re-injects the script on page navigation via `webNavigation.onCompleted`.
- `executeJs(params)` -- Executes arbitrary JavaScript in the page context and returns the result. Return value must be JSON-serializable.
- Both functions reject execution on protected pages (`chrome://`, `chrome-extension://`, `about:`).
- Uses CDP `Runtime.evaluate` which bypasses Content Security Policy restrictions.

### `handlers/accessibility.js`

Accessibility tree extraction with platform-specific formatting.

- Fetches the full accessibility tree via `Accessibility.getFullAXTree` (CDP)
- Detects the current platform (Threads, Zillow) from the tab URL and routes to the appropriate formatter
- Falls back to the default generic formatter (`accessibility-tree.js`) for unrecognized sites
- Assigns element refs (`e1`, `e2`, ...) mapped to CDP `backendDOMNodeId` values for later interaction
- Builds ancestry context for each ref (role, name, parent info, ancestor content) to support re-identification after scrolling

## Formatters

Formatters transform raw accessibility tree nodes into structured JSON optimized for AI consumption. Each platform has a router file that detects the page type and delegates to a sub-formatter.

### Router Pattern

Each platform router (`threads.js`, `zillow.js`):

1. Builds a node map for fast lookups
2. Sets up shared ref tracking and helper functions
3. Extracts common elements (navigation, source info)
4. Detects the page type from the URL
5. Delegates to the appropriate page formatter
6. Returns the formatted tree as a JSON string with element refs

### Threads Formatters

| File | Page Type | Detection | Extracts |
|------|-----------|-----------|----------|
| `threads_home.js` | Home / profile | Default (no URL match) | Posts (url, content, timestamp, likes, replies, refs), ghost posts (ephemeral content with expiry) |
| `threads_activity.js` | Activity | `/activity` in URL | Follows, likes, milestones, replies, polls |
| `threads_search.js` | Search | `/search` in URL | Landing (trends, suggestions), autocomplete (threads, terms, profiles), results (posts with filter) |

### Zillow Formatters

| File | Page Type | Detection | Extracts |
|------|-----------|-----------|----------|
| `zillow_home.js` | Homepage | Default | Search box, listings, saved searches, autocomplete suggestions |
| `zillow_search.js` | Search results | `searchQueryState` param or `/homes/` path | Property cards with price, address, beds, baths, sqft, refs |
| `zillow_detail.js` | Detail overlay | Region with comma in name (address) | Property details from the slide-over overlay on search pages |
| `zillow_detail_page.js` | Full detail page | `/homedetails/` in URL | Full property listing details |

The Zillow router also checks for a property detail overlay on search pages and includes overlay data alongside search results when present.

## Utils

### `utils/windmouse.js`

Implements the WindMouse algorithm for generating human-like mouse movement paths. Produces an array of `{x, y, dt}` points where `dt` is the delay in milliseconds before the next point.

- Uses gravity (pull toward target) and wind (random deviation) forces
- Distance-based Hz caps: short moves cap at 250Hz, long moves reach up to 1000Hz
- Acceleration curve: slow start, peak speed at 50-80% of path, slow end
- Returns path statistics (points, duration, average/min/max Hz) for logging

### `utils/mouse-state.js`

Tracks the last virtual cursor position per tab. When a click is performed, the ending position is stored. The next click on the same tab starts its WindMouse path from that position (or viewport center on first interaction).

### `utils/cursor.js`

Generates JavaScript code injected into the page to render a visual cursor. The cursor is an SVG arrow pointer with a "WebPilot" text label, both with an animated RGB color-shifting outer glow. On click, a Twitter-like particle burst animation plays. The cursor fades out after a configurable linger delay.

### `utils/scroll.js`

Scroll animation utilities.

- `animateScroll(target, scrollDelta, duration)` -- Runs an in-page `requestAnimationFrame` animation with cubic ease-in-out easing. Includes a hard timeout to prevent hangs on background tabs.
- `calculateScrollDelta(target, elementAbsoluteY)` -- Calculates how far to scroll to center an element in the viewport.
- `generateViewportCheckCode(x, y)` -- Generates JavaScript to check if coordinates are within the viewport.
- `calculateScrollDuration(scrollDelta)` -- Returns animation duration based on distance (50ms per 50px for window scrolls).
- `scrollElementIntoView(target, elementExpression)` -- Walks up the DOM from the target element looking for scrollable ancestor containers (`overflow-y: auto|scroll` with `scrollHeight > clientHeight`). If found, scrolls within that container at 75ms per 50px. Used by both click.js and the scroll handler for container scrolling.
- `generateScrollIntoViewCode(selector)` -- Generates JavaScript code to scroll an element into view within its scrollable container.

### `utils/timing.js`

- `getWeightedRandomDelay(min, max)` -- Returns a random delay biased toward longer values using an inverted quadratic curve. Used for click press-to-release timing.
- `generateCursorTimings()` -- Returns spawn delay, move duration, and linger delay values.

### `utils/debugger.js`

Persistent CDP debugger session management.

- `getSession(tabId)` -- Returns an existing debugger session for the tab, or attaches a new one. Sessions persist until the tab is closed. Enables focus emulation so CDP commands work on background tabs.
- `cleanup(tabId)` -- Detaches the debugger and removes the session.
- `isProtectedPage(url)` -- Returns true for `chrome://`, `chrome-extension://`, and `about:` URLs.

## Popup UI

The extension popup (`popup/popup.html`, `popup/popup.js`, `popup/popup.css`) uses a tabbed interface with three tabs: **Dashboard**, **Pairing**, and **Settings**. The popup header displays the extension version (from `chrome.runtime.getManifest()`).

### Dashboard Tab

The Dashboard tab shows connection status with three views:

| View | When Shown | Content |
|------|-----------|---------|
| Connecting | Connecting to server or auto-connect polling | Shows server URL, error messages if server unreachable |
| Connected | WebSocket open | Server URL, endpoint display (WS, SSE, network mode), Disconnect button, restricted mode controls with whitelist management |
| Disconnected | User manually disconnected | Shows server URL, Retry button |

#### Connected View Details

When connected, the Dashboard displays:

- **Server URL** -- The WebSocket URL the extension is connected to
- **Endpoints section** -- Shows the WS URL, SSE URL, and network mode indicator ("Local only" or "Network (LAN)")
- **Disconnect button** -- Sets `manuallyDisconnected = true` and closes the connection; the onclose handler is nulled before closing to prevent auto-reconnect
- **Restricted mode** (toggle, defaults to true) -- Blocks all MCP commands on non-whitelisted domains. When enabled, reveals the whitelist management panel.

#### Whitelist Management

When restricted mode is enabled, the Dashboard displays whitelist controls:

- **Whitelist this site** (button) -- Quick toggle to add or remove the current tab's domain. Shows "Remove this site" for whitelisted domains. Hidden if the current tab is not on a valid HTTP/HTTPS URL.
- **Manual domain input** (text field + Add button) -- Enter a domain manually (e.g., `example.com`, `https://example.com`). Domains are normalized: protocol and `www.` prefix stripped, path/query/hash removed. Duplicate domains are rejected silently.
- **Domain list** (scrollable container) -- Shows all whitelisted domains with remove (x) buttons.

Domain matching is domain-level and covers all subdomains (e.g., whitelisting `yahoo.com` allows `www.yahoo.com`, `mail.yahoo.com`, etc.).

### Pairing Tab

The Pairing tab has a badge count showing the number of pending pairing requests. It contains two sections:

#### Pairing Requests

Displays pending pairing requests from AI agents. Each entry shows the agent name and two action buttons:

- **Approve** -- Approves the pairing request, generating an API key for the agent and sending it back to the server.
- **Deny** -- Rejects the pairing request without granting access.

The section is hidden when there are no pending requests.

#### Paired Agents

Lists all agents that have been granted access. Each entry shows:

- **Agent name** -- The display name provided by the agent during pairing. Clicking the **Rename** button switches to an inline edit mode (text input) where the user can change the name. Pressing Enter or blurring the input commits the rename by sending a `RENAME_AGENT` message to the background script, which relays it to the server via WebSocket.
- **Paired date** -- The date the agent was approved.
- **Last active** -- A relative time-ago display (e.g., "5m ago") of the agent's last authenticated tool call. Only shown if the agent has been used since pairing. The server updates this via `touchKey()` on every authenticated `tools/call` request.
- **Revoke** button -- Immediately invalidates the agent's API key, removing its access.

Shows "No paired agents" when the list is empty.

### Settings Tab

The Settings tab provides:

- **Focus new tabs** (toggle, defaults to false) -- Controls whether newly created tabs receive focus via `chrome.tabs.create({ active: focusNewTabs })`. When false, tabs open in the background.
- **Tab organization** (select) -- Choose between "Existing window" (group mode, default: adds tabs to a cyan tab group) or "New window" (window mode: moves tabs to a dedicated WebPilot Chrome window). When window mode is active, the extension persists the window's size and position to `chrome.storage.local` under `webPilotWindowBounds` and restores them when creating a new WebPilot window.
- **Network mode** (toggle, defaults to false) -- Switches the server between local-only (`127.0.0.1`) and LAN (`0.0.0.0`) mode. Sends a `SET_NETWORK_MODE` message to the background script, which relays it to the server via WebSocket. The server re-binds its listener, persists the preference to `network.enabled`, and the extension reconnects and refreshes its stored URLs via `refreshConnectionMetadata()`. The toggle state is synced from `chrome.storage.local` (`networkMode`) and also updates reactively when the storage value changes (e.g., after reconnect metadata refresh).

### Storage Keys

Settings and state are stored in `chrome.storage.local`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `focusNewTabs` | boolean | false | Whether new tabs receive focus |
| `tabMode` | string | `'group'` | Tab organization mode (`'group'` or `'window'`) |
| `restrictedModeEnabled` | boolean | true | Whether restricted mode is active |
| `whitelistedDomains` | string[] | `[]` | Whitelisted domains for restricted mode |
| `apiKey` | string | null | Server API key (from auto-connect) |
| `serverUrl` | string | null | WebSocket server URL |
| `sseUrl` | string | null | SSE endpoint URL |
| `networkMode` | boolean | false | Whether server is in network mode |
| `enabled` | boolean | false | Whether the extension is enabled |
| `pairedAgents` | array | `[]` | Cached list of paired agents |
| `pendingPairingRequests` | array | `[]` | Pending pairing requests |
| `webPilotWindowBounds` | object | null | Saved WebPilot window position/size |

Authentication failures (invalid API key) automatically clear stored config and restart auto-connect.

## Communication Protocol

### Server to Extension (WebSocket)

Standard command envelope:
```json
{
  "id": "uuid",
  "type": "command_type",
  "params": { ... }
}
```

#### Pairing message types (Server → Extension)

| Type | Envelope | Params / Fields | Description |
|------|----------|-----------------|-------------|
| `pairing_request` | Command | `agentName` (string) | Server forwards a pairing request from an AI agent. The extension shows an Approve/Deny prompt in the popup. |
| `paired_agents_list` | Push (no `id`) | `agents` (array of `{ agentName, createdAt, key, keyDisplay }`) | Server pushes the current list of paired agents to the extension (not a command — no response expected). |

### Extension to Server (WebSocket)

Success:
```json
{
  "id": "uuid",
  "success": true,
  "result": { ... }
}
```

Error:
```json
{
  "id": "uuid",
  "success": false,
  "error": "Error message"
}
```

#### Extension → Server message types

| Type | Params | Description |
|------|--------|-------------|
| `revoke_key` | `apiKey` (string) | Extension requests the server to invalidate the specified API key. Sent when the user clicks Revoke in the Paired Agents panel. |
| `rename_agent` | `apiKey` (string), `newName` (string) | Extension requests the server to rename the agent associated with the given API key. Sent when the user renames an agent in the Paired Agents panel. |
| `list_paired_agents` | _(none)_ | Extension requests the current list of paired agents from the server. The server responds with a `paired_agents_list` push message. |
| `set_network_mode` | `enabled` (boolean) | Extension requests the server to switch between local-only and LAN mode. The server re-binds its listener, persists the preference, and the extension reconnects. |

Keepalive: Extension sends `{"type":"ping"}` every 15 seconds, server responds with `{"type":"pong"}`.

## Permissions

From `packages/chrome-extension-unpacked/manifest.json`:

| Permission | Purpose |
|-----------|---------|
| `storage` | Persist connection config (API key, server URL, enabled state) |
| `activeTab` | Access the currently active tab |
| `tabs` | Query and manage all browser tabs |
| `tabGroups` | Create and manage the WebPilot tab group |
| `debugger` | Attach CDP sessions for input simulation and accessibility tree access |
| `scripting` | Execute scripts in page context |
| `webNavigation` | Listen for navigation events to re-inject persistent scripts |

Host permission `<all_urls>` allows the extension to operate on any website.
