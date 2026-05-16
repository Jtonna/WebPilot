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
    +-- utils/
    |     debugger.js      CDP session management
    |     windmouse.js     Human-like mouse path generation
    |     mouse-state.js   Per-tab virtual cursor position
    |     cursor.js        Visual cursor animation (SVG + particles)
    |     scroll.js        Scroll animation and viewport helpers
    |     timing.js        Weighted random delays
    |
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

On startup, the extension auto-connects to `localhost:3456` by fetching `/connect` to obtain the API key, server URL, SSE URL, and network mode, then stores all values in `chrome.storage.local` and establishes the WebSocket connection. If configuration is already stored in `chrome.storage.local`, that is used directly. On every successful WebSocket connection (including reconnects), `refreshConnectionMetadata()` fetches `/connect` again to update the stored `serverUrl`, `sseUrl`, and `networkMode` values -- this ensures the extension picks up any server-side changes. It uses HTTP(S) derived from the current `serverUrl`, so it works for both local and network-mode setups. The extension auto-reconnects on transient connection failures (code 1006, server unreachable) with a 5-second delay. Authentication failures (code 1008) clear stored config and restart auto-connect. A `manuallyDisconnected` flag prevents auto-reconnect when the user explicitly disconnects via the popup.

### Hello handshake

Once the WebSocket is open the extension sends a `hello` message **before any other traffic** — the server gates all non-hello messages until the handshake completes. The handshake carries:

- `profileId` -- previously-resolved Chrome profile directoryName (e.g. `"Default"`, `"Profile 1"`), if any.
- `gaiaEmail` -- the result of `chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })`, if available (wire field name is `gaiaEmail`).
- `installId` -- a persistent UUID minted on first install (stored as `webpilot.installId` in `chrome.storage.local`). The id is intentionally kept across `FORGET_CONFIG` resets so the server's `installId → profileId` map (`extension-installs.json`) survives config wipes.

The server resolves the binding in five ordered steps (see `server.js` around lines 980-1090):

1. **Direct `profileId`** — if the extension already has a previously-resolved profile in `chrome.storage.local`, the hello message carries it and the server uses it as-is.
2. **`installId` lookup** — the server consults `extension-installs.json` (`installId → profileId` map) and uses the cached profile if it still corresponds to a real directory under Chrome's user-data-dir.
3. **`gaiaEmail` match** — the server reads Chrome's `Local State` and binds to the profile whose `gaia_email` (case-insensitive) matches the value the extension surfaced from `chrome.identity.getProfileUserInfo`.
4. **Inference by exclusion** — if exactly one known profile is *not yet connected*, *not in the install map*, and *has no `gaiaEmail` of its own*, the server binds the connecting extension to it by elimination. Ambiguity (zero or multiple candidates) falls through to step 5.
5. **`identify_required` push** — the server gives up auto-resolving and sends the list of known profiles to the popup, which renders the picker via `profileIdentifyView`. Once the operator picks, the extension stores `webpilot.profileId` and re-runs `sendHelloHandshake()` so step 1 resolves on the retry.

The server replies with either `hello_ack` (handshake complete; `profileId` is the bound profile) or `identify_required` (server can't resolve — the popup surfaces a profile picker via `profileIdentifyView`). An 8-second client-side watchdog (`HELLO_TIMEOUT_MS = 8000`) surfaces failures to the popup. The server also runs a parallel 5-second `helloDeadline` that pushes `identify_required` if `hello` never arrives. Tool calls and management traffic resume only after `hello_ack`.

> Step 4 (inference-by-exclusion) is the path most likely to "auto-bind to the wrong profile" when a user has several profiles whose `Local State` entries lack a `gaia_email`. If that happens, click **Change** on the popup's profile row to force `RESET_PROFILE_ID` and pick explicitly.

### Message handlers

#### From server

| Message type | Action |
|--------------|--------|
| `store_refs` | Stores ref-to-backendDOMNodeId mappings and ancestry context sent by the server after formatting (params: `tabId`, `refs`, `refContexts`). |

#### From popup (chrome.runtime.onMessage)

| Message type | Action |
|--------------|--------|
| `GET_STATUS` | Returns current connection state: `enabled`, `connected`, `connectionStatus`, `connectionError`, `errorType`, `manuallyDisconnected`, and config info (`hasApiKey`, `serverUrl`). |
| `CONNECT_REQUEST` | Loads stored config and initiates a WebSocket connection if config is available. |
| `DISCONNECT` | Sets `manuallyDisconnected = true`, then calls `disconnectWebSocket()` which nulls `wsConnection.onclose` before closing to prevent the onclose handler from auto-reconnecting. |
| `RECONNECT` | Clears `manuallyDisconnected`, re-enables the extension, and initiates a WebSocket connection. |
| `FORGET_CONFIG` | Disconnects, clears stored config (`apiKey`, `serverUrl`, `enabled`), resets state, and restarts auto-connect to pick up server again. |
| `RETRY_AUTO_CONNECT` | Restarts the auto-connect polling loop (fetches `/connect` from the default server URL). |
| `GET_PROFILE_IDENTITY` | Reads `webpilot.profileId` and `webpilot.knownProfiles` from `chrome.storage.local` and returns `{ profileId, knownProfiles }` to the popup. |
| `SET_PROFILE_ID` | Stores `webpilot.profileId` to the operator's pick (params: `profileId`) and re-runs `sendHelloHandshake()` so the server can ack the new binding. |
| `SERVICE_STATUS_CHANGED` | Updates `isEnabled` and connects/disconnects WebSocket accordingly. |
| `CONFIG_UPDATED` | Updates stored config and reconnects if enabled. |
| `CHECK_FORMATTER_UPDATES` | Forwards `check_formatter_updates` to server via WebSocket. Relays `formatter_update_result` response back to popup (10s timeout). |
| `RESET_PROFILE_ID` | Clears `webpilot.profileId` (but not `webpilot.installId`) and reconnects to force re-identification through the picker. |

> Removed: `SET_NETWORK_MODE` — the popup no longer exposes a network-mode toggle. Network mode is now configured via `POST /api/ui/settings/network-mode` from the web UI.

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

Accessibility tree extraction.

- Fetches the raw accessibility tree via CDP `Accessibility.getFullAXTree`
- Returns `{ nodes, url, tabId, usePlatformOptimizer }` (raw data) to the server
- Platform detection, formatting, and ref assignment happen server-side

## Formatting (Server-Side)

Accessibility tree formatting is performed by the MCP server, not the extension. The extension sends raw CDP nodes to the server. After formatting, the server sends ref mappings back via a `store_refs` WebSocket message, which the extension persists for interaction commands (click, scroll).

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

The extension popup (`popup/popup.html`, `popup/popup.js`, `popup/popup.css`) uses a tabbed interface with **two tabs**: **Dashboard** and **Settings**. The Pairing tab has been removed — pairing approval, paired-agent management, and network-mode configuration now live in the **server-hosted web UI** at `http://localhost:3456/ui/`. The popup header displays the extension version (from `chrome.runtime.getManifest()`).

### Dashboard Tab

The Dashboard renders one of four views depending on state:

| View | When Shown | Content |
|------|-----------|---------|
| Profile identification | Server can't resolve which Chrome profile this extension belongs to (`identify_required`) | Profile dropdown (populated from server-supplied `knownProfiles`) + "I am this profile" button |
| Connecting | Connecting to server or auto-connect polling | Server URL, error messages if server unreachable |
| Connected | WebSocket open and `hello_ack` received | Server URL, endpoint display (WS, SSE, mode), current profile row with **Change** button, Disconnect button, formatter-update check, restricted-mode controls with whitelist management |
| Disconnected | User manually disconnected | Server URL, Retry button |

#### Connected View Details

- **Server URL / Endpoints section** -- WS URL, SSE URL, and a Mode indicator ("Local only" or "Network (LAN)").
- **Profile row** -- Shows the currently bound Chrome profile (display name resolved during the hello handshake). The **Change** button clears `webpilot.profileId` and forces a re-identification through the picker.
- **Disconnect button** -- Sets `manuallyDisconnected = true` and closes the connection; the `onclose` handler is nulled before closing to prevent auto-reconnect.
- **Check for formatter updates** (button) -- Sends `CHECK_FORMATTER_UPDATES` to the background script, which forwards `check_formatter_updates` over the extension WS and relays the `formatter_update_result` push back to the popup (10s timeout).
- **Restricted mode** (toggle, defaults to true) -- Blocks all MCP commands on non-whitelisted domains. When enabled, reveals the whitelist management panel.

#### Whitelist Management

When restricted mode is enabled, the Dashboard displays whitelist controls:

- **Whitelist this site** (button) -- Quick toggle to add or remove the current tab's domain. Hidden if the current tab is not on a valid HTTP/HTTPS URL.
- **Manual domain input** (text field + Add button) -- Domains are normalized: protocol and `www.` prefix stripped, path/query/hash removed. Duplicate domains are rejected silently.
- **Domain list** (scrollable container) -- All whitelisted domains with remove (x) buttons.

Domain matching is domain-level and covers all subdomains.

### Settings Tab

The Settings tab provides:

- **Focus new tabs** (toggle, defaults to false) -- Controls whether newly created tabs receive focus via `chrome.tabs.create({ active: focusNewTabs })`.
- **Tab organization** (select) -- "Existing window" (group mode, default: adds tabs to a cyan tab group) or "New window" (window mode: moves tabs to a dedicated WebPilot Chrome window). Window position/size is persisted to `webPilotWindowBounds` and restored on next launch.

**Removed from this tab in QOL-Features:**
- Network-mode toggle (now in the web UI's Settings page; the server-side toggle spawn-and-exits to rebind).
- Pairing-required toggle (the toggle is retired; pairing is always on; the legacy `set_pairing_required` WS message is logged and ignored).

### Web UI takeover

The following capabilities that previously lived in the extension popup are now in the web UI:

- Approve / deny pairing requests
- Pick the Chrome profile a new agent binds to during approval
- Pre-provision an API key (skip `request_pairing` entirely; mints via `POST /api/ui/agents`)
- Re-bind an existing agent to a different profile (`PATCH /api/ui/agents/:key`)
- List / rename / revoke paired agents (still available via `REVOKE_KEY` / `RENAME_AGENT` runtime messages too, but the UI is the canonical surface)
- View pairing history (terminal-state pairings persisted with `profileId`)
- Toggle network mode, manage notification preferences, restart server / Chrome

### Storage Keys

Settings and state are stored in `chrome.storage.local`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `focusNewTabs` | boolean | false | Whether new tabs receive focus |
| `tabMode` | string | `'group'` | Tab organization mode (`'group'` or `'window'`) |
| `restrictedModeEnabled` | boolean | true | Whether restricted mode is active |
| `whitelistedDomains` | string[] | `[]` | Whitelisted domains for restricted mode |
| `apiKey` | string | null | Server API key (from `/connect`) |
| `serverUrl` | string | null | WebSocket server URL |
| `sseUrl` | string | null | SSE endpoint URL |
| `networkMode` | boolean | false | Cached network mode flag (UI hint only) |
| `enabled` | boolean | false | Whether the extension is enabled |
| `pairedAgents` | array | `[]` | Cached list of paired agents (server is source of truth) |
| `pendingPairingRequests` | array | `[]` | (legacy) Cached pending requests; no longer surfaced in the popup |
| `webPilotWindowBounds` | object | null | Saved WebPilot window position/size |
| `webpilot.installId` | string | UUID | Persistent install identity — survives `FORGET_CONFIG`; minted on first install |
| `webpilot.profileId` | string | null | Bound Chrome profile directoryName (cleared on `RESET_PROFILE_ID`) |
| `webpilot.profileDisplayName` | string | null | Human-readable profile name resolved during hello |
| `webpilot.knownProfiles` | array | `[]` | Profile choices for the picker, supplied by `identify_required` |

Authentication failures (invalid API key) automatically clear stored config and restart auto-connect. `webpilot.installId` is intentionally **not** cleared on config resets so the server's `installId → profileId` mapping survives storage wipes.

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
| `hello_ack` | Push (no `id`) | `profileId` (string) | Server confirms the hello handshake and the resolved Chrome profile binding. The extension must wait for this before sending non-hello traffic. |
| `identify_required` | Push (no `id`) | `knownProfiles` (array) | Server could not resolve which profile this extension belongs to; popup surfaces a profile picker. |
| `paired_agents_list` | Push (no `id`) | `agents` (array of `{ agentName, createdAt, lastAccessed, key, keyDisplay, profileId }`) | Server pushes the current list of paired agents (e.g. after an approve in the web UI). Includes the bound `profileId` per entry. |
| `store_refs` | Push (no `id`) | `tabId`, `refs`, `refContexts` | Server pushes ref-to-backendDOMNodeId mappings and ancestry context to the extension after formatting an accessibility tree. |
| `formatter_update_result` | Push (no `id`) | _(result payload)_ | Server responds to a `check_formatter_updates` request with the outcome of the update check. |

> Removed: `pairing_request`. Pairing approval no longer goes through the extension popup — pending pairings are surfaced and approved/denied via the web UI at `/ui/pairings`. The legacy `pairing_request` push has no consumer in the current extension.

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
| `hello` | `profileId?`, `profileDisplayName?`, `gaiaEmail?`, `installId?` | First message on every new WS connection. The server gates all other traffic until it resolves the binding and replies with `hello_ack` (or `identify_required` if it needs the popup picker). |
| `revoke_key` | `apiKey` (string) | Invalidate a paired API key. (Still wired; canonical surface is now the web UI.) |
| `rename_agent` | `apiKey` (string), `newName` (string) | Rename the agent associated with the given key. (Still wired; canonical surface is now the web UI.) |
| `list_paired_agents` | _(none)_ | Request the current list. Server responds with a `paired_agents_list` push. |
| `check_formatter_updates` | _(none)_ | Trigger an on-demand formatter update check. Server responds with `formatter_update_result`. |

> **Deprecated (server logs and ignores):** `set_network_mode` and `set_pairing_required`. The extension popup no longer sends these. Network mode and pairing config are now owned by the web UI.

Keepalive: Extension sends `{"type":"ping"}` every 15 seconds, server responds with `{"type":"pong"}`.

## Permissions

From `packages/chrome-extension-unpacked/manifest.json`:

| Permission | Purpose |
|-----------|---------|
| `storage` | Persist connection config (API key, server URL, enabled state, installId, profileId) |
| `activeTab` | Access the currently active tab |
| `tabs` | Query and manage all browser tabs |
| `tabGroups` | Create and manage the WebPilot tab group |
| `debugger` | Attach CDP sessions for input simulation and accessibility tree access |
| `scripting` | Execute scripts in page context |
| `webNavigation` | Listen for navigation events to re-inject persistent scripts |
| `windows` | Manage the dedicated WebPilot window in `'window'` tab-organization mode |
| `identity` + `identity.email` | Read the signed-in profile email via `chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })` to help the server auto-resolve the profile binding during the hello handshake |

Host permission `<all_urls>` allows the extension to operate on any website.

Manifest fields: `manifest_version: 3`, `name: "WebPilot"`, `version: "1.0.0"`. The background service worker is declared with `"type": "module"`.
