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

On startup, the extension auto-connects to `localhost:3456` by fetching `/connect` to obtain the server URL, SSE URL, and network mode, then stores those values in `chrome.storage.local` and establishes the WebSocket connection. The extension's own persistent `webpilot.installId` (minted on first install) is its identity — `/connect` no longer hands out a transport key (retired 2026-05-17, see `docs/SECURITY_AUDIT_2026-05-17.md`). If configuration is already stored in `chrome.storage.local`, that is used directly. On every successful WebSocket connection (including reconnects), `refreshConnectionMetadata()` fetches `/connect` again to update the stored `serverUrl`, `sseUrl`, and `networkMode` values -- this ensures the extension picks up any server-side changes. It uses HTTP(S) derived from the current `serverUrl`, so it works for both local and network-mode setups. The extension auto-reconnects on transient connection failures (code 1006, server unreachable) with a 5-second delay. A `manuallyDisconnected` flag prevents auto-reconnect when the user explicitly disconnects via the popup.

### Hello handshake

Once the WebSocket is open the extension sends a `hello` message **before any other traffic** — the server gates all non-hello messages until the handshake completes. The handshake carries:

- `profileId` -- previously-resolved Chrome profile directoryName (e.g. `"Default"`, `"Profile 1"`), if any.
- `gaiaEmail` -- the result of `chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })`, if available (wire field name is `gaiaEmail`).
- `installId` -- a persistent UUID minted on first install (stored as `webpilot.installId` in `chrome.storage.local`). The id is intentionally kept across `FORGET_CONFIG` resets so the server's `installId → profileId` map (the `extension_installs` SQLite table) survives config wipes.

The server resolves the binding in five ordered steps (see `server.js` around lines 980-1090):

1. **Direct `profileId`** — if the extension already has a previously-resolved profile in `chrome.storage.local`, the hello message carries it and the server uses it as-is.
2. **`installId` lookup** — the server consults the `extension_installs` SQLite table (`installId → profileId` map) and uses the cached profile if it still corresponds to a real directory under Chrome's user-data-dir.
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

#### From popup / other extension contexts (chrome.runtime.onMessage)

The new minimal popup (Phase 6) does **not** send any `chrome.runtime.sendMessage` — it queries the server's REST surface directly. The remaining `chrome.runtime.onMessage` handlers in `background.js` are kept for internal extension messaging only (cross-context config updates, future programmatic disconnect paths):

| Message type | Action |
|--------------|--------|
| `CONNECT_REQUEST` | Loads stored config and initiates a WebSocket connection if config is available. |
| `RECONNECT` | Clears `manuallyDisconnected`, re-enables the extension, and initiates a WebSocket connection. |
| `FORGET_CONFIG` | Disconnects, clears stored config (`serverUrl`, `enabled`, legacy `apiKey`), resets state, and restarts auto-connect to pick up server again. `webpilot.installId` is intentionally preserved. |
| `SERVICE_STATUS_CHANGED` | Updates `isEnabled` and connects/disconnects WebSocket accordingly. |
| `CONFIG_UPDATED` | Updates stored config and reconnects if enabled. |

> Removed in P2 phase 7 (all dormant after the Phase-6 popup rewrite, no remaining listeners in the extension):
> `GET_STATUS`, `DISCONNECT`, `RETRY_AUTO_CONNECT`, `RESET_PROFILE_ID`, `SET_PROFILE_ID`, `GET_PROFILE_IDENTITY`, `CHECK_FORMATTER_UPDATES`. Background broadcasts `IDENTIFY_REQUIRED` and `CONNECTION_STATUS_CHANGED` also removed for the same reason.
>
> Removed in Phase 6: `SET_NETWORK_MODE` — network mode is configured via `POST /api/ui/settings/network-mode` from the web UI.

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

P2 phase 6 gutted the popup to a **minimal status-and-escape-hatch panel** themed to match the webapp. All admin (agent management, sites management, pairing approval, profile picker, network-mode toggle, restricted-mode whitelist) moved to the server-hosted web UI at `http://localhost:3456/ui/`. The popup files are still `popup/popup.html` + `popup/popup.js` + `popup/popup.css`.

### What the popup shows

Four components, top to bottom:

1. **Connection status** — colored dot + one-word label (`Connected` / `Reconnecting…` / `Disconnected`). Reveals the bound profile and server URL underneath.
2. **Current tab** — domain + state pill (`Allowed` / `Blocked (baseline)` / `Blocked (user)` / `Override: Allowed` / `Override: Blocked`).
3. **Block / Allow toggle** — single primary button that flips the **global** `global_site_rules` row for the current tab's domain (i.e. "I don't want any AI touching this site"). Per-agent fine-tuning happens at `/ui/sites/`.
4. **Open dashboard** — opens `http://localhost:<port>/ui/` in a new tab.

The popup reads `webpilot.installId` + `serverUrl` from `chrome.storage.local` (written by the background auto-connect flow) and hits two server endpoints, authenticating with the `X-Install-Id` header:

- `GET  /api/popup/state?tabUrl=<url>` — connection + current-tab pill.
- `POST /api/popup/site-toggle` — flip the global rule.

The legacy `X-API-Key` header (and the `apiKey` storage key) were retired 2026-05-17 along with the shared server transport key — see `docs/SECURITY_AUDIT_2026-05-17.md`.

It does **not** send any `chrome.runtime.sendMessage` to the background service worker, and the worker does not broadcast popup-targeted messages. The popup is decoupled from the worker's runtime state — it polls the server directly.

### Per-profile reload required

The popup change requires a **one-time chrome://extensions/ reload per profile** to install the new HTML/JS/CSS. The extension version was bumped to **`1.1.4`** in Phase 6 and again to **`1.2.0`** at the 2026-05-17 auth cutover (transport-key retirement + `apiKey`-storage purge), so you can confirm which copy is live from `chrome://extensions/`.

For developers: the `webpilot_dev_reload_extension` MCP tool automates the reload on the *calling agent's* paired profile (the server routes `reload_extension` to that one profile's WebSocket). Multi-profile installs still need one tool call per profile (or a manual reload in each profile's `chrome://extensions/` page) — see `accessibility-tree-formatters/DEV_GUIDE.md` for the per-profile-scope details.

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
| `serverUrl` | string | null | WebSocket server URL (from `/connect`) |
| `sseUrl` | string | null | SSE endpoint URL |
| `networkMode` | boolean | false | Cached network mode flag (UI hint only) |
| `enabled` | boolean | false | Whether the extension is enabled |
| `pairedAgents` | array | `[]` | Cached list of paired agents (server is source of truth) |
| `pendingPairingRequests` | array | `[]` | (legacy) Cached pending requests; no longer surfaced in the popup |
| `webPilotWindowBounds` | object | null | Saved WebPilot window position/size |
| `webpilot.installId` | string | UUID | Persistent install identity — survives `FORGET_CONFIG`; minted on first install |
| `webpilot.profileId` | string | null | Bound Chrome profile directoryName (cleared on `RESET_PROFILE_ID`) |
| `webpilot.knownProfiles` | array | `[]` | Profile choices for the picker, supplied by `identify_required` |

`webpilot.installId` is intentionally **not** cleared on config resets (e.g. `FORGET_CONFIG`) so the server's `installId → profileId` mapping survives storage wipes. Any pre-1.2.0 `apiKey` value left in `chrome.storage.local` is purged on first startup after upgrade (one-time migration; the legacy transport key was retired 2026-05-17).

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
| `hello` | `profileId?`, `gaiaEmail?`, `installId?` | First message on every new WS connection. The server gates all other traffic until it resolves the binding and replies with `hello_ack` (or `identify_required` if it needs the popup picker). |
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
| `storage` | Persist connection config (server URL, enabled state, installId, profileId) |
| `activeTab` | Access the currently active tab |
| `tabs` | Query and manage all browser tabs |
| `tabGroups` | Create and manage the WebPilot tab group |
| `debugger` | Attach CDP sessions for input simulation and accessibility tree access |
| `scripting` | Execute scripts in page context |
| `webNavigation` | Listen for navigation events to re-inject persistent scripts |
| `windows` | Manage the dedicated WebPilot window in `'window'` tab-organization mode |
| `identity` + `identity.email` | Read the signed-in profile email via `chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })` to help the server auto-resolve the profile binding during the hello handshake |

Host permission `<all_urls>` allows the extension to operate on any website.

Manifest fields: `manifest_version: 3`, `name: "WebPilot"`, `version: "1.2.0"`. The background service worker is declared with `"type": "module"`.
