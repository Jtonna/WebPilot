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

Connection configuration (server URL, API key) is stored in `chrome.storage.local` and loaded on service worker startup. The extension auto-reconnects on transient connection failures (code 1006, server unreachable) with a 5-second delay. Authentication failures (code 1008) clear stored config and stop retrying.

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

The extension popup (`popup/popup.html`, `popup/popup.js`, `popup/popup.css`) provides connection management with four views:

| View | When Shown | Actions |
|------|-----------|---------|
| Setup | No stored config | Paste connection string, click Connect |
| Connecting | Connecting to server | Shows server URL, displays errors if server unreachable |
| Connected | WebSocket open | Shows server URL, Disconnect button, Settings |
| Disconnected | Has stored config but not connected | Reconnect button, Forget button (clears config), Settings |

The popup header displays the extension version (from `chrome.runtime.getManifest()`).

### Settings

When connected or disconnected, the popup shows a settings section with:

- **Focus new tabs** (toggle, defaults to false) -- Controls whether newly created tabs receive focus via `chrome.tabs.create({ active: focusNewTabs })`. When false, tabs open in the background.
- **Tab organization** (select) -- Choose between "Existing window" (group mode, default: adds tabs to a cyan tab group) or "New window" (window mode: moves tabs to a dedicated WebPilot Chrome window). When window mode is active, the extension persists the window's size and position to `chrome.storage.local` under `webPilotWindowBounds` and restores them when creating a new WebPilot window.
- **Restricted mode** (toggle, defaults to true) -- Blocks all MCP commands on non-whitelisted domains. When enabled, reveals the whitelist management panel.

#### Whitelist Management

When restricted mode is enabled, the popup displays whitelist controls:

- **Whitelist this site** (button) -- Quick toggle to add or remove the current tab's domain. Shows "Remove this site" for whitelisted domains. Hidden if the current tab is not on a valid HTTP/HTTPS URL.
- **Manual domain input** (text field + Add button) -- Enter a domain manually (e.g., `example.com`, `https://example.com`). Domains are normalized: protocol and `www.` prefix stripped, path/query/hash removed. Duplicate domains are rejected silently.
- **Domain list** (scrollable container) -- Shows all whitelisted domains with remove (×) buttons.

Domain matching is domain-level and covers all subdomains (e.g., whitelisting `yahoo.com` allows `www.yahoo.com`, `mail.yahoo.com`, etc.).

These settings are stored in `chrome.storage.local` as `focusNewTabs`, `tabMode`, `restrictedModeEnabled` (boolean, default true), and `whitelistedDomains` (string array).

The connection string format is `vf://<base64url>` encoding `{"v":1,"s":"<ws_url>","k":"<api_key>"}`.

Authentication failures (invalid API key) automatically clear stored config and return to the Setup view.

## Communication Protocol

### Server to Extension (WebSocket)

```json
{
  "id": "uuid",
  "type": "command_type",
  "params": { ... }
}
```

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
