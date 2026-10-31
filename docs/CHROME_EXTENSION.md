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

1. Manages the WebSocket connection to the MCP server (connect, disconnect, keepalive, reconnect on close, and a `chrome.alarms` heartbeat that reconnects after the service worker is suspended)
2. Receives command messages (JSON with `id`, `type`, `params`)
3. Routes each command to the appropriate handler based on `type`
4. Sends results back to the server (JSON with `id`, `success`, `result` or `error`)
5. Listens for Chrome events (tab closed, navigation complete) to clean up state

On startup, the extension auto-connects to `localhost:3456` by fetching `/connect` to obtain the server URL, SSE URL, and network mode, then stores those values in `chrome.storage.local` and establishes the WebSocket connection. The extension's own persistent `webpilot.installId` (minted on first install) is its identity — `/connect` no longer hands out a transport key (retired in the 2026-05-17 cutover; the audit document that originally described the retirement has since been removed from `docs/`). If configuration is already stored in `chrome.storage.local`, that is used directly. On every successful WebSocket connection (including reconnects), `refreshConnectionMetadata()` fetches `/connect` again to update the stored `serverUrl`, `sseUrl`, and `networkMode` values -- this ensures the extension picks up any server-side changes. The WebSocket `serverUrl` returned by `/connect` is **always** loopback (`ws://127.0.0.1:<port>`) regardless of network mode, so the extension — which always runs on the same machine as the server — always connects to localhost; the extension WS upgrade is itself loopback-gated server-side. The extension auto-reconnects after a close, with the delay and popup status depending on the close code (see [Reconnect and close codes](#reconnect-and-close-codes)). On a 1006 close it also self-heals a stale non-loopback `serverUrl` left over in `chrome.storage.local` (e.g. a previously-stored LAN address), resetting the dial target to the `localhost:3456` default before the retry fires. A `manuallyDisconnected` flag prevents auto-reconnect when the user explicitly disconnects via the popup. A `chrome.alarms` heartbeat (`webpilot-reconnect`, every 0.5 min) backs up the timer-based retries; see [Reconnect and close codes](#reconnect-and-close-codes).

### Reconnect and close codes
When the WebSocket closes, `ws.onclose` picks the popup status and retry delay from the close code. Retries only run while the extension is enabled, not `manuallyDisconnected`, and has a `serverUrl`.

| Code | Meaning | Popup status | Retry |
|---|---|---|---|
| 1000, 1001 (server-initiated) | Clean close | `disconnected` (no error) | 5 s |
| 1006 | Server unreachable | `server_unreachable` | 5 s |
| 1008 / `Unauthorized` | Missing or malformed `installId` | `auth_failed` | None. Clears stored `serverUrl`, `enabled` and `apiKey`, then re-runs auto-connect; `installId` is kept |
| 1011 | Server error | `server_error` | 5 s |
| 4000 | Server replaced this socket (same install reconnecting, or stale previous socket) | `connection_lost` | 5 s |
| 4001 | Extension closed its own socket after exhausting identify retries (`CLOSE_CODE_IDENTIFY_FAILED`) | `identify_failed`, "Identification failed" | 5 s |
| 4409 | Server refused a takeover: a live connection from a different install holds this profile (`connection_in_use`) | `connection_in_use`, "Another WebPilot connection is active for this browser profile" | 30 s (`CONNECTION_IN_USE_RETRY_MS`), also enforced against the alarm heartbeat via `nextRetryAt`; config kept |
| Other | Unexpected close | `connection_lost` | 5 s |

**Identify timeout.** If no `hello_ack` arrives within `HELLO_TIMEOUT_MS`, the extension closes the socket itself with code 1000 and reason `identify_timeout`. `onclose` skips its normal retry in this case because the identify backoff has already scheduled the reconnect.

**Alarm heartbeat.** MV3 suspends the service worker after about 30 s idle, and `setTimeout` retries die with it. A `webpilot-reconnect` alarm (period 0.5 min) survives suspension and wakes the worker. It is created on install, on startup, and on every worker load, and the `onAlarm` listener is registered at top level so a woken worker handles the tick. Each tick re-reads `enabled`, `serverUrl`, `manuallyDisconnected` and `webpilot.installId` from `chrome.storage.local`, and reconnects only if no socket is live, the extension is enabled and not manually disconnected, and `nextRetryAt` has expired. `scheduleReconnect()` is the single retry path and sets `nextRetryAt`. `nextRetryAt` is in-memory, so the 30 s hold after a 4409 is only guaranteed while the worker stays alive.

**Socket guards.** `connectWebSocket()` returns early if the current socket is OPEN or CONNECTING. Every handler ignores events from a socket that is no longer the current `wsConnection`; this matters because the server closes the previous socket with 4000 when it replaces it.

### Hello handshake

Once the WebSocket is open the extension sends a `hello` message **before any other traffic** — the server gates all non-hello messages until the handshake completes. The handshake carries:

- `profileId` -- previously-resolved Chrome profile directoryName (e.g. `"Default"`, `"Profile 1"`), if any.
- `gaiaEmail` -- the result of `chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })`, if available (wire field name is `gaiaEmail`). Sent only when no `profileId` is stored.
- `installId` -- a persistent UUID minted on first install (stored as `webpilot.installId` in `chrome.storage.local`). The id is intentionally kept across `FORGET_CONFIG` resets so the server's `installId → profileId` map (the `extension_installs` SQLite table) survives config wipes.
- `extensionId` -- `chrome.runtime.id`, so the server can locate this install's storage on disk for the install scan. The server ignores a value that isn't 32 characters of `a`-`p` and logs that it did.

The server resolves the binding in six ordered steps (see `resolveHelloProfile()` in `server.js`):

1. **Direct `profileId`** — if the hello message carries a client-supplied `profileId`, the server validates it against the real local Chrome profiles (`readProfiles(userDataDir)`) before trusting it; an unrecognized value is ignored and resolution falls through to the next step.
2. **`installId` lookup** — the server consults the `extension_installs` SQLite table (`installId → profileId` map) and uses the cached profile only if it still corresponds to a real directory under Chrome's user-data-dir.
3. **`gaiaEmail` match** — the server reads Chrome's `Local State` and binds to the profile whose `gaia_email` (case-insensitive) matches the value the extension surfaced from `chrome.identity.getProfileUserInfo`.
4. **Install scan** — the server reads each local profile's `Local Extension Settings/<extensionId>/` `*.log` and `*.ldb` files for the `installId` bytes (`scanForInstallId()` in `src/chrome/install-scan.js`). It binds only on exactly one match, and only if that profile exists in `Local State`; zero or several matches fall through. The scan is read-only and conservative:
   - It reads nothing unless `extensionId` matches `^[a-p]{32}$` and `installId` is a UUID.
   - It skips symlinks and profile names containing `/`, `\`, `..`, `:` or NUL.
   - It skips files over 8 MB and stops at 32 MB total.
   - Non-single-match results are cached for 30 s, so the 3/10/30 s retries below don't rescan the disk.
   - It logs counts only, never paths or ids.
5. **Inference by exclusion** — if exactly one known profile is *not currently connected* and *has no `gaiaEmail` of its own*, the server binds the connecting extension to it by elimination. There is no install-map check here. Ambiguity (zero or multiple candidates) falls through to step 6.
6. **`identify_required` push** — the server gives up auto-resolving and sends `knownProfiles`, one entry per local profile: `{ directoryName, displayName, gaiaEmail, connected, registered }`. `connected` means a live, bound extension socket holds that profile. `registered` means the profile has a row in the `extension_installs` table, so some install has completed a handshake there before. The socket joins the server's pending-identification tracker, which broadcasts `identification_pending_changed` to the web UI until the socket binds, is refused with `4409`, or closes. The extension stores the list under `webpilot.knownProfiles` in `chrome.storage.local`, and the popup renders the [profile picker](#what-the-popup-shows) from it. The extension keeps any stored `webpilot.profileId` and resends `hello` after a backoff (3 s, 10 s, 30 s), so step 1 or 2 resolves if the server's view changes. A profile picked in the popup arrives as a `reidentify` message, which stores the profile and resends `hello` at once. If all resends still get `identify_required`, the extension sets `webpilot.profileId` to `null`, closes the socket with `4001` (`identify_failed`) and reconnects after 5 s; the next `hello` carries `gaiaEmail` again since no `profileId` is left.

The server replies with either `hello_ack` (handshake complete; `profileId` is the bound profile) or `identify_required` (server can't resolve — the extension caches the candidate list for the popup picker). It can also refuse the connection by closing the socket with code `4409` (`connection_in_use`) instead of sending `hello_ack`, because another install already holds the profile. See [Reconnect and close codes](#reconnect-and-close-codes). The 8-second client watchdog (`HELLO_TIMEOUT_MS = 8000`) covers a server that never replies: on expiry the extension sets error state `identify_timeout`, closes with 1000 and reconnects on the same 3/10/30 s backoff counter, then fails with 4001 as above. The watchdog is cancelled when `identify_required` arrives. The server's parallel 5-second `helloDeadline` pushes `identify_required` if `hello` never arrives. Tool calls and management traffic resume only after `hello_ack`; `hello_ack` also resets the identify retry counter.

### Message handlers

#### From server

| Message type | Action |
|--------------|--------|
| `store_refs` | Stores ref-to-backendDOMNodeId mappings and ancestry context sent by the server after formatting (params: `tabId`, `refs`, `refContexts`). |

#### From popup / other extension contexts (chrome.runtime.onMessage)

The popup sends exactly one message, `reidentify`, when the user picks a profile. It reads everything else from the server's REST surface and from storage. The other `chrome.runtime.onMessage` handlers in `background.js` are kept for internal extension messaging (cross-context config updates):

| Message type | Action |
|--------------|--------|
| `reidentify` | Sent by the popup profile picker with `{ profileId }`. The background is the **only** writer of `webpilot.profileId`. It validates the id against the stored `webpilot.knownProfiles` (if none is stored it accepts the id unvalidated and logs a line), writes it, resets the identify retry cycle, then resends `hello` on an open socket or reconnects. A user-initiated reconnect bypasses the 4409 backoff. Replies `{ success: true }` or `{ success: false, error }`, where `error` is `'No profile selected'`, `'Unknown profile'` or `'WebPilot is disconnected. Reconnect from the popup first.'`. |
| `CONNECT_REQUEST` | Loads stored config and initiates a WebSocket connection if config is available. |
| `RECONNECT` | Clears `manuallyDisconnected`, re-enables the extension, and initiates a WebSocket connection. |
| `FORGET_CONFIG` | Disconnects, clears stored config (`serverUrl`, `enabled`, `manuallyDisconnected`, `webpilot.profileId`, `webpilot.knownProfiles`, legacy `apiKey`), resets state, and restarts auto-connect to pick up server again. `webpilot.installId` is intentionally preserved. |
| `SERVICE_STATUS_CHANGED` | Updates `isEnabled` and connects/disconnects WebSocket accordingly. |
| `CONFIG_UPDATED` | Updates stored config and reconnects if enabled. |

## Handlers

### `handlers/tabs.js`

Tab lifecycle management.

- `createTab(params)` -- Opens a new tab. The URL is validated by `normalizeUrl` first: only http(s) and `about:blank` are accepted, a scheme-less value gets `https://`, and other schemes or other `about:` pages are rejected before anything is created. The URL is always passed at creation, never as a separate navigate step. `active` follows the `focusNewTabs` setting (defaults to false, so tabs open in the background). In window mode, a `windows.create` failure with saved `webPilotWindowBounds` retries once without them. If a step after creation throws, the new window is closed so no orphan is left. Grouping and focus failures are non-fatal: the tab is kept and the result carries a `warning` such as `tab not grouped: ...`. Returns `{ tab_id, url, title, warning? }`.
- `closeTab(params)` -- Closes a tab by ID.
- `getTabs()` -- Returns all open tabs with their ID, URL, title, active state, window ID, and group ID. Also reports `pendingUrl`: the URL a still-loading tab is navigating to (undefined once committed).
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

The popup is a **minimal status-and-escape-hatch panel** themed to match the webapp. Agent management, sites management, pairing approval, network-mode toggle, and site policy live in the web UI at `http://localhost:3456/ui/`. Popup files: `popup/popup.html`, `popup/popup.js`, `popup/popup.css`. For how verdicts are computed and what the global tier toggle does, see [SITE_POLICY.md](SITE_POLICY.md#precedence) and [Global tier toggle](SITE_POLICY.md#global-tier-toggle).

### What the popup shows

Five components, top to bottom:

1. **Connection status** — colored dot + one-word label (`Connected` / `Disconnected`; `Connecting` while loading). Shows the bound profile directory (`profileId`, e.g. `Default`) underneath. The server URL is not shown; "Open dashboard" is the way to reach the server.
2. **Current tab** — domain + state pill. Caption below the pill: "Global policy for this Chrome profile (per-agent rules aren't shown)." A "Rule on <matchedDomain>" line also appears when the matching rule is on a parent domain. Pill states:
   - `Allowed (your rule)`: a global user rule allows it
   - `Allowed`: no rule
   - `Blocked (your rule)`
   - `Blocked (global block list)`
3. **Block / Allow toggle** — single primary button that writes a **global** user rule (a `global_user_site_rules` row) for the current tab's domain. Applies to all agents, unless overridden by a per-agent rule for that agent (including an agent's `*` default). If the global tier is off: the rule still saves but has no effect (see [Global tier toggle](SITE_POLICY.md#global-tier-toggle)), the toggle is disabled, and the popup shows "Global rules are off — this toggle won't apply until they're turned back on in the dashboard." Per-agent fine-tuning happens at `/ui/site-policy/`.
4. **Open dashboard** — opens `<server>/ui/` in a new tab, where `<server>` is the `serverUrl` from `chrome.storage.local` converted to http(s) (default `http://localhost:3456`). Because `/connect` now always returns a loopback `serverUrl` (`ws://127.0.0.1:<port>`), this link always resolves to localhost — which is correct, since `/ui` is loopback-only and the dashboard runs on the same machine.
5. **Profile picker** — replaces the tab section while `GET /api/popup/state` answers 401, meaning the server has not matched this Chrome profile yet. It opens with "WebPilot hasn't matched this Chrome profile yet. Choose it below, or open the WebPilot dashboard to finish setup."
   - One row per `webpilot.knownProfiles` entry, showing the display name and the directory name. While the list is empty it says "Waiting for the server to list profiles…".
   - Row order: **Suggested** (neither connected nor registered), then **Already registered** (registered, not connected), then **in use** (connected, disabled). Servers that predate the `registered` flag are treated as not registered.
   - Picking an "Already registered" row opens an inline confirmation instead of acting: "This profile already has an extension registered. Only pick it if you are using WebPilot from that profile right now." with Replace and Cancel buttons (not `window.confirm`, which is unreliable in popups).
   - A pick sends `reidentify`, shows "Connecting…" and disables every row. The popup then polls `/api/popup/state` every 500 ms for up to 8 s, and loads the normal view once it answers 200.
   - While polling it reads `webpilot.connectionState` from `chrome.storage.session`, ignoring entries older than the pick. A `connection_in_use` refusal shows "Another WebPilot connection is active for that profile. Pick a different one, or close the other WebPilot window." A timeout shows "Still waiting — the profile may be in use or the server is busy. Try again."
   - `chrome.storage.onChanged` re-renders the picker when `webpilot.knownProfiles` changes, and reloads the main view when `webpilot.profileId` gets a value.
6. **Skip / fallback messages** — the tab section is hidden and a plain-text skip surface is shown instead when the popup has nothing renderable:
   - Non-http(s) pages, and loopback hosts (`localhost`, `127.0.0.1`, `::1`), are never sent to the server for a per-tab policy lookup: "Site policy doesn’t apply to this page." (This is a client-side skip only; server-side, an agent's `*` rule still matches loopback hosts.)
   - No active tab resolved: "No active tab."
   - The server responded but didn't return a usable `currentTab`: "No policy data for this page yet."
   - No `webpilot.installId` in storage yet: "Extension has no installId. Reload the extension in chrome://extensions/."
   - A fetch error shows the `Disconnected` connection state plus the error text (e.g. "Could not reach the WebPilot server." for a network failure). A 401 shows no error; it opens the profile picker instead.

The popup reads `webpilot.installId`, `serverUrl` and `webpilot.knownProfiles` from `chrome.storage.local` (written by the background), and `webpilot.connectionState` from `chrome.storage.session`. It never writes storage. It hits two server endpoints, authenticating with the `X-Install-Id` header:

- `GET  /api/popup/state?tabUrl=<url>`: connection + current-tab pill.
- `POST /api/popup/site-toggle`: set the global user rule (`global_user_site_rules`) for the domain.

The legacy `X-API-Key` header (and the `apiKey` storage key) have been retired along with the shared server transport key. Auth is now installId-based end-to-end.

### Popup IPC

The two popup endpoints live in `packages/server-for-chrome-extension/src/popup-routes.js` (`mountPopupRoutes`: the `_authPopup` helper plus the two route handlers), mounted from `server.js`. They are **loopback-gated** (via the shared `src/loopback.js` helper, threaded the daemon's host binding), then additionally gated by an installId resolver and an Origin denylist. The loopback gate means they are same-machine only even when network mode is enabled — only the API-key-gated MCP surface (`/sse`, `/message`) is LAN-reachable in network mode.

**Auth (`_authPopup`).** Every popup request must:

1. Carry `X-Install-Id: <uuid>` (the same `webpilot.installId` the extension sent on its WS upgrade). A `?installId=<uuid>` query-string fallback is accepted to keep ad-hoc curl flows working. Missing or empty values → 401. Strings longer than 256 characters → 401 (defensive cap).
2. Resolve via `extensionInstalls.getProfileForInstall(installId)`. An unknown installId → 401.
3. Pass the **Origin gate (S3)**. The `Origin` header must be absent or use a non-`http(s)` scheme (for example `chrome-extension://…`); any `http://`/`https://` origin → 401. That pattern is a webpage running in some Chrome profile trying to ride the loopback bind to mutate site policy. This is the same hardening as the extension-WS `S1` gate and the UI-WS `S2` gate.

A successful `_authPopup` call returns `{ installId, profileId }`. The popup operates in **profile context**, not agent context: it resolves policy with `sitePolicy.isAllowed(null, …)`, so `agent_site_rules` never apply. See [Precedence](SITE_POLICY.md#precedence) for tier order and matching, and [Global tier toggle](SITE_POLICY.md#global-tier-toggle) for what turning the tier off does.

#### `GET /api/popup/state`

| Aspect | Value |
|---|---|
| Auth | `X-Install-Id` (header preferred, query-param fallback) + Origin gate |
| Query | `tabUrl` (optional). Strings longer than 8192 characters → 400 (`tabUrl too long`). |
| Response | `{ connection, profileId, agent, serverUrl, globalTierEnabled, currentTab? }` |

Response fields:

- `connection`: `'connected'` or `'disconnected'`, based on `extensionBridge.isConnected(profileId)`.
- `profileId`: the bound Chrome profile directoryName.
- `agent`: always `null` (popup is profile-scoped).
- `serverUrl`: `${proto}://${host}` derived from `X-Forwarded-Proto` / `Host` headers (falling back to `localhost:<port>`). Informational; the popup does not use it (the "Open dashboard" link is built from the stored `serverUrl`).
- `globalTierEnabled`: boolean from `sitePolicy.isGlobalTierEnabled()` (see [Global tier toggle](SITE_POLICY.md#global-tier-toggle) for what the key means and its default). When `false`, `currentTab` always resolves to `state: 'allowed'`, `source: 'default'`.
- `currentTab` (present only when a valid `tabUrl` was supplied and normalized): `{ url, domain, state, source, decision, matchedDomain }`, mapped by `_statePillFromPolicy` (exported from `popup-routes.js`):
  - `state`: `'allowed'` (any allow) | `'blocked_global_site_blocklist'` (block from `global_site_blocklist`) | `'blocked_user'` (any other block)
  - `source`: `'global_user' | 'global_site_blocklist' | 'default'` (never `agent_rule`; no agent context here)
  - `matchedDomain`: the matching rule's stored domain, which can be a parent of `domain` via public-suffix walk, or `null` when `source` is `'default'`
  - The popup builds its pill label from `state` + `source` (see "What the popup shows"); it is not a fixed per-state string.

#### `POST /api/popup/site-toggle`

| Aspect | Value |
|---|---|
| Auth | `X-Install-Id` (header preferred, query-param fallback) + Origin gate |
| Body | `{ domain, action: 'block' \| 'allow' }`.<br>`decision` is accepted as an alias for `action`; `action` wins if both are present.<br>`domain` over 512 chars → 400 `{ error: 'domain too long' }`. |
| Response | `{ ok, domain, decision, newState, globalTierEnabled, source, policyDecision }` |
| Errors | 400 `{ error, reason }`:<br>• invalid domain → `error: 'invalid domain'`<br>• invalid decision → `error: 'invalid decision'`, `reason: "decision must be 'allow' or 'block'"`<br>• `*` (wildcard) → `error: 'invalid domain'`, `reason: "wildcard ('*') rules are per-agent only — add them under Per-agent rules on the Site Policy page"`<br>401 `{ error: 'unauthorized' }`<br>500 `{ error }` (exception message) |

Upserts a row in `global_user_site_rules` via `upsertGlobalUserRule` in `src/global-user-rules.js`, the same write path `POST /api/ui/site-policy/global-rules` uses, so validation, error strings and rule semantics are identical.

- Audit log records the truncated installId and bound profileId (no agent identity; popup is not in agent context).
- Broadcasts a `site_policy_changed` event over `/api/ui/events` so the Site Policy admin page stays in sync.
- `decision` echoes the requested `action`.
- `newState` is the recomputed pill key (global tier only, no agent rule), so the popup can update its toggle without a follow-up `GET /api/popup/state`.
- `globalTierEnabled` lets the popup tell that a rule it just wrote isn't in effect: while the global tier is off, `newState` is `'allowed'` even after a `block`.
- `source` and `policyDecision` are the recomputed global-only verdict's `source` and `decision` (`decision` itself just echoes the request).
- On a non-2xx response, the popup shows the body's `reason` (falling back to `error`) inline under the toggle.

The popup sends exactly one `chrome.runtime.sendMessage` to the background service worker: `reidentify`, when the user picks a profile. The worker does not broadcast popup-targeted messages. The popup is otherwise decoupled from the worker's runtime state; it polls the server directly, and reads the `chrome.storage.session` mirror only to explain a refused pick.

### Per-profile installation
Each Chrome profile loads its own copy of the extension. The `webpilot_dev_reload_extension` MCP tool reloads the extension on the calling agent's paired profile; the server routes `reload_extension` to that one profile's WebSocket. Multi-profile installs need one tool call per profile, or a manual reload at `chrome://extensions/` in each profile (see `accessibility-tree-formatters/DEV_GUIDE.md`).

### Web UI takeover

The following capabilities that previously lived in the extension popup are now in the web UI:

- Approve / deny pairing requests
- Pick the Chrome profile a new agent binds to during approval
- Pre-provision an API key (skip `request_pairing` entirely; mints via `POST /api/ui/agents`)
- Re-bind an existing agent to a different profile (`PATCH /api/ui/agents/:key`)
- List / rename / revoke paired agents
- View pairing history (terminal-state pairings persisted with `profileId`)
- Toggle network mode, manage notification preferences, restart server / Chrome

### Storage Keys

Settings and state are stored in `chrome.storage.local`, except where the table says `session`:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `focusNewTabs` | boolean | false | Whether new tabs receive focus |
| `tabMode` | string | `'group'` | Tab organization mode (`'group'` or `'window'`) |
| `serverUrl` | string | null | WebSocket server URL (from `/connect`) |
| `sseUrl` | string | null | SSE endpoint URL |
| `networkMode` | boolean | false | Cached network mode flag (UI hint only) |
| `enabled` | boolean | false | Whether the extension is enabled |
| `pendingPairingRequests` | array | `[]` | (legacy) Cached pending requests; no longer surfaced in the popup |
| `webPilotWindowBounds` | object | null | Saved WebPilot window position/size |
| `webpilot.installId` | string | UUID | Persistent install identity — survives `FORGET_CONFIG`; minted on first install |
| `webpilot.profileId` | string | null | Bound Chrome profile directoryName; cleared to `null` when identify retries are exhausted |
| `webpilot.knownProfiles` | array | `[]` | Profile choices for the popup picker, supplied by `identify_required`: `{ directoryName, displayName, gaiaEmail, connected, registered }` per profile. Cleared by `FORGET_CONFIG` |
| `webpilot.connectionState` (`chrome.storage.session`) | object | unset | `{ status, error, errorType, updatedAt }`, mirrored on every connection status change. The popup reads it to explain a refused pick. Cleared when the browser session ends |

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
| `hello_ack` | Push (no `id`) | `profileId` (string) | Server confirms the hello handshake and the resolved Chrome profile binding. The extension must wait for this before sending non-hello traffic. Not sent if the server refuses the claim; it closes with `4409` instead. |
| `identify_required` | Push (no `id`) | `knownProfiles` (array) | Server could not resolve which profile this extension belongs to; extension caches the list and the popup picker renders it. Each entry is `{ directoryName, displayName, gaiaEmail, connected, registered }`. |
| `store_refs` | Push (no `id`) | `tabId`, `refs`, `refContexts` | Server pushes ref-to-backendDOMNodeId mappings and ancestry context to the extension after formatting an accessibility tree. |

> The server no longer pushes `paired_agents_list` (removed in #129). Agent administration is a web-UI-only concern; the extension never caches the agent roster.

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
| `hello` | `profileId?`, `gaiaEmail?`, `installId?`, `extensionId?` | First message on every new WS connection. The server gates all other traffic until it resolves the binding and replies with `hello_ack` (or `identify_required` if it needs the operator to pick a profile in the extension popup, or closes the socket with `4409` `connection_in_use` if a different install already holds the profile). |

> The popup-to-background `reidentify` message is a `chrome.runtime` message, not a WebSocket one. See the [background message table](#from-popup--other-extension-contexts-chromeruntimeonmessage).
>
> **Removed (#129):** `revoke_key`, `rename_agent`, and `list_paired_agents` are no longer sent by the extension or handled by the server; agent administration (list/rename/revoke) is web-UI-only.
>
> **Deprecated (server logs and ignores):** `set_network_mode` and `set_pairing_required`. Network mode and pairing config are owned by the web UI.

The server binds each pending command to the WebSocket connection it was sent on; a response arriving on a different socket for the same `id` is rejected rather than resolved against the original caller.

Keepalive: Extension sends `{"type":"ping"}` every 15 seconds, server responds with `{"type":"pong"}`. The ping keeps an open socket alive; if the worker is suspended anyway, the `webpilot-reconnect` alarm reconnects it.

## Permissions

From `packages/chrome-extension-unpacked/manifest.json`:

| Permission | Purpose |
|-----------|---------|
| `storage` | Persist connection config (server URL, enabled state, installId, profileId) in `chrome.storage.local`, and mirror connection state to `chrome.storage.session` |
| `alarms` | Schedule the `webpilot-reconnect` heartbeat that wakes the suspended service worker to reconnect |
| `activeTab` | Access the currently active tab |
| `tabs` | Query and manage all browser tabs |
| `tabGroups` | Create and manage the WebPilot tab group |
| `debugger` | Attach CDP sessions for input simulation and accessibility tree access |
| `scripting` | Execute scripts in page context |
| `webNavigation` | Listen for navigation events to re-inject persistent scripts |
| `windows` | Manage the dedicated WebPilot window in `'window'` tab-organization mode |
| `identity` + `identity.email` | Read the signed-in profile email via `chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })` to help the server auto-resolve the profile binding during the hello handshake |

Host permission `<all_urls>` allows the extension to operate on any website.

Manifest fields: `manifest_version: 3`, `name: "WebPilot"`. See `packages/chrome-extension-unpacked/manifest.json` for the current version. The background service worker is declared with `"type": "module"`.
