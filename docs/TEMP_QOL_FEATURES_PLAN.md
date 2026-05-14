# TEMP: QOL Features — Chrome Process Management & Async Pairing

> **Status:** Spec / planning doc, not permanent project documentation. Delete or fold into permanent docs after v1 lands.
>
> **Branch:** `QOL-Features` (local only, not yet pushed)
>
> **Date:** 2026-05-14

## 1. Goal

Make WebPilot resilient to the most common failure mode — Chrome running without the `--silent-debugger-extension-api` flag — by giving the server the ability to detect Chrome state, restart it with the flag when needed, and manage multiple profiles. Add a web UI that owns pairing approval, profile management, and paired-agent administration.

## 2. Key facts validated empirically (2026-05-13/14)

These were verified by running real PowerShell commands against the user's actual Chrome installation. Do not re-debate them — they are facts:

1. **`--silent-debugger-extension-api` is a per-process launch flag.** It cannot be applied to a running Chrome process. The flag is set on `chrome.exe`'s command line at launch.
2. **One Chrome browser process per `--user-data-dir`.** All profile windows sharing a user-data-dir share one browser process and one set of launch flags. The "browser parent" is identifiable by absence of `--type=` in its command line (children are `--type=renderer`, `--type=gpu-process`, etc.).
3. **Chrome's per-profile session restore works automatically when launched with `--profile-directory=<name>`** — regardless of the user's `restore_on_startup` Preferences setting. We do not need to track which URLs were open, only which profiles.
4. **Process command-line is readable per-user without admin.** On Windows via `Get-CimInstance Win32_Process`, on macOS via `ps -ww -o command= -p <pid>`, on Linux via `/proc/<pid>/cmdline` (NUL-separated).
5. **Per-profile activity detection** works reliably via filesystem write activity in `<user-data-dir>\<profile>\`. Active profiles write to `SharedStorage-wal` and similar files constantly (verified: 13 file writes in 60s for an active profile, 9 for another). Inactive profiles have no recent writes.
6. **Graceful close on Windows works via `PostMessage(WM_CLOSE)`** to each visible Chrome window — Chrome runs its normal shutdown path (saves session state). `CloseMainWindow()` only closes one window per process; for multi-window processes use raw `PostMessage` to every visible Chrome HWND.
7. **The browser parent command-line shows only the FIRST launch's args.** Subsequent launches (e.g., `chrome.exe --profile-directory="Profile 2"` while a Chrome process already exists for that user-data-dir) IPC into the existing process and exit. The flag is locked in at first launch.

## 3. v1 scope

### IN scope

- Chrome state detection, cross-platform (Win/Mac/Linux) with thorough logging on every code path
- Process kill (graceful) + relaunch with `--silent-debugger-extension-api` + `--profile-directory=<name>` per active-and-needed profile
- PID-based cache with cheap liveness check (`process exists?`) on every MCP tool call; full re-detection only on cache miss
- Multi-extension WebSocket support: server tracks N simultaneous extension connections (one per profile)
- Extension self-identifies its profile on connect: `chrome.identity.getProfileUserInfo()` auto-detect + manual popup picker fallback, cached in `chrome.storage.local`
- `browser_create_tab` becomes the readiness gate that may launch/restart Chrome. Other tools error helpfully if no extension connected for the agent's paired profile
- Async pairing API:
  - `request_pairing(agent_name)` is idempotent — returns existing pending/approved entry if one exists for this agent name
  - New `check_pairing_status(pairing_id)` MCP tool
  - Server persists pending pairings to `<dataDir>/config/pending-pairings.json`
- Pairing tab fully **removed** from Chrome extension popup (also remove paired-agents view from popup)
- New Next.js web UI package `packages/server-web-ui/`, static export, bundled into pkg via `assets`, mounted at `/ui` by Express. Pages:
  - Pairings (pending + history, approve/deny, profile selection)
  - Profiles (list known profiles from `Local State`, create new sandbox profile)
  - Paired Agents (list, rename, revoke)
  - Settings (network mode toggle, formatter update controls)
- Web UI reachable over LAN when server is in network mode (auth via existing API key mechanism)
- Network-mode toggle moves from extension popup → web UI. Changing it **restarts the server** (clean process restart) instead of the current in-process rebind
- Server-side native notifications (Win toast / macOS osascript / Linux notify-send) for pairing requests — body includes the WebPilot UI URL
- Silent restart UX after first-time pairing (user explicitly authorized that profile via web UI; future restarts are silent + logged)

### OUT of scope (deferred to v1.5+)

- Per-agent profile binding at MCP-tool-routing level beyond v1's "one agent → one profile" model
- Click-to-open from system notifications (notification body has URL, user opens browser manually)
- Bundling Electron app to host the web UI
- Auto-installing the extension into new profiles (Chrome doesn't allow this — Developer Mode + Load Unpacked is unavoidable)
- Cross-user-data-dir Chrome management for non-standard Chrome installations beyond default location

## 4. Architecture

### 4.1 New module: `packages/server-for-chrome-extension/src/chrome/`

```
src/chrome/
  index.js              — module entry point / factory
  manager.js            — ChromeManager: orchestrates detect+close+launch; owns PID cache
  detector.js           — Cross-platform process inspection; dispatches to OS-specific impl
  windows-detector.js   — Win32_Process via PowerShell (no native deps)
  macos-detector.js     — ps -ww -o command= -p <pid>
  linux-detector.js     — /proc/<pid>/cmdline
  launcher.js           — Cross-platform Chrome launch with flag + profile args
  closer.js             — Graceful close: WM_CLOSE on Win, SIGTERM on macOS/Linux
  profile-activity.js   — Per-profile fs-mtime check for "active in last N seconds"
  local-state.js        — Read profile list from <user-data-dir>/Local State
  paths.js              — Per-OS default Chrome path + default user-data-dir
  logger.js             — Wraps console.log with [chrome:<component>] prefix for grep-ability
```

#### Module API (sketch)

```js
// manager.js
class ChromeManager {
  constructor({ userDataDir, log }) { /* ... */ }

  // Cheap: O(1) PID liveness check. Returns cached state if PID still alive.
  async getStatus() {
    /* returns { running: bool, browserPid, hasFlag, userDataDir, knownProfiles: [...] } */
  }

  // Full re-detection: enumerate processes, read command lines, list profile activity.
  async refresh() { /* ... */ }

  // Returns array of profile directory names with recent fs activity
  async getActiveProfiles() { /* ... */ }

  // Kills Chrome gracefully and waits for all chrome.exe to exit
  async closeAll({ timeoutMs = 20000 } = {}) { /* ... */ }

  // Launches Chrome with given profiles + the flag. Idempotent: if Chrome already
  // running with flag and the right profiles, this is a no-op.
  async ensureReady(requiredProfiles) {
    /* algorithm:
       1. getStatus() — fast path
       2. if running && hasFlag && all requiredProfiles already have an active extension WebSocket: return
       3. if running && !hasFlag: getActiveProfiles() → closeAll() → launchProfiles(active ∪ required)
       4. if !running: launchProfiles(required)
       5. wait for extension WebSocket(s) to connect (with timeout)
    */
  }
}
```

#### Logging conventions

- Every public method logs entry + key parameters + outcome
- Format: `[chrome:<file>] <message>` so `grep "\[chrome:" daemon.log` extracts the full trail
- Include PIDs, paths, profile names, durations
- Errors logged with stack trace at error level
- On unsupported OS code paths, log `[chrome:detector] platform=darwin/linux not yet fully implemented` (so the scaffold is honest)

### 4.2 Async pairing — server-side changes

#### `src/paired-keys.js` — extend with pending pairings

Add new functions / new store file (`<dataDir>/config/pending-pairings.json`):

```js
// Each pending pairing:
// { pairingId, agentName, status: 'pending'|'approved'|'denied', createdAt, decidedAt?, apiKey? }

requestPairing(agentName)
  // Idempotent. If an existing pairing for this agentName is 'pending' or 'approved', return it.
  // Otherwise create new 'pending' entry, generate pairingId, persist, return entry.

checkPairingStatus(pairingId) → { status, apiKey? }
approvePairing(pairingId)  // generates api key via existing addKey() flow; sets status='approved', apiKey=<key>; persists
denyPairing(pairingId)     // sets status='denied'; persists
listPendingPairings()      // returns all non-terminal pairings
cleanupOldPairings(maxAgeDays) // optional housekeeping for denied/old entries
```

#### `src/mcp-handler.js` — update tools

- **`request_pairing`**: instead of waiting on `extensionBridge.sendCommand('pairing_request')` with a 120s timeout, this tool now:
  1. Calls `pairedKeys.requestPairing(agentName)` immediately
  2. Returns `{ pairing_id, status, api_key? }` in the MCP response text
  3. Description updated to instruct AI agents: "If status is `pending`, surface this to your human and stop making other tool calls; the human will approve in the WebPilot UI. To get your key later, call `check_pairing_status` with the `pairing_id`."

- **`check_pairing_status`**: new MCP tool, exempt from auth (like `request_pairing`). Schema: `{ pairing_id: string }`. Returns `{ status, api_key? }`.

#### Tool descriptions

The agent-facing description text must clearly explain the async flow. Example for `request_pairing`:

> "Initiate pairing. **Asynchronous flow**: returns immediately with a `pairing_id` and current `status` ('pending', 'approved', or 'denied'). If 'pending', the user has not yet approved — tell the human to approve in the WebPilot UI (notification will fire), then on a later turn call `check_pairing_status` with the `pairing_id` to get your `api_key`. Idempotent: if you call this twice with the same `agent_name`, you get the same `pairing_id` back."

### 4.3 Multi-extension WebSocket support

#### `src/extension-bridge.js` — track N connections

Replace single `wsConnection` with `Map<profileId, ws>`:

```js
class ExtensionBridge {
  // profileId → ws
  #connections = new Map();

  setConnection(profileId, ws) { /* ... */ }
  clearConnection(profileId) { /* ... */ }
  isConnected(profileId) { /* ... */ }
  isAnyConnected() { /* convenience for legacy checks */ }
  getConnectedProfiles() { /* returns string[] */ }

  // sendCommand now requires routing
  async sendCommand(profileId, type, params, options) { /* ... */ }
  notify(profileId, message) { /* ... */ }
  notifyAll(message) { /* broadcast — for paired_agents_list updates */ }
}
```

#### Extension handshake

When the extension connects, before any commands flow, it sends `{type:'hello', profileId:'Default', profileDisplayName:'Your Chrome', gaiaEmail?:'...'}` over the WebSocket. Server records this in the connection map.

`profileId` is determined by the extension via `chrome.identity.getProfileUserInfo()` + manual popup picker fallback. Cached in `chrome.storage.local` after first identification.

If the extension cannot determine its profile, the WebSocket connects but the server returns `{type:'identify_required', knownProfiles:[...]}` — the extension shows the popup picker, user picks, extension stores choice + retries handshake.

#### Routing tool calls

The MCP handler now resolves the target profileId from the agent's API key (in v1: just the single "managed profile" from server config, since per-agent profile binding is out of scope). Then `extensionBridge.sendCommand(profileId, ...)`.

### 4.4 Web UI

#### Package structure

```
packages/server-web-ui/
  package.json          — Next.js + React; build script outputs static export
  next.config.js        — output: 'export', assetPrefix matches the /ui mount path
  app/
    layout.js
    page.js             — Home/dashboard (status overview)
    pairings/page.js    — Pending approvals + history
    profiles/page.js    — List + create sandbox
    agents/page.js      — Paired agents (rename, revoke, last-active)
    settings/page.js    — Network mode toggle, formatter updates
  components/
    StatusCard.js
    PairingPromptCard.js
    ProfileCreator.js
    AgentRow.js
  lib/
    api.js              — fetch wrappers for server REST
    ws.js               — WebSocket client for live updates
  styles/
```

#### Build & bundling

- Build step: `npm run build:web-ui` runs `next build` in `packages/server-web-ui/` with `output: 'export'`, producing static files in `packages/server-web-ui/out/`
- The server's `pkg` config includes `"../server-web-ui/out/**/*"` in its `assets` array (paths relative to the server package)
- At runtime, server resolves the static directory at `path.join(__dirname, '..', '..', 'server-web-ui', 'out')` in dev mode and via pkg's snapshot filesystem in production
- Server's `dist:win` / `dist:mac` / `dist:linux` scripts updated to run `npm run build:web-ui` first

#### Server routes for web UI

Mounted on the existing Express app:

| Route | Purpose |
|---|---|
| `GET /ui` and `GET /ui/*` | Static-serve the Next.js `out/` directory |
| `GET /api/ui/status` | Returns aggregate state (Chrome status, profiles, connected extensions, pending pairings, paired agents) |
| `POST /api/ui/pairings/:id/approve` | Approve a pending pairing; body includes selected `profileId` |
| `POST /api/ui/pairings/:id/deny` | Deny pending pairing |
| `POST /api/ui/profiles` | Create new sandbox profile (launches Chrome with `--profile-directory="<name>"`, persists profile metadata) |
| `POST /api/ui/agents/:key/rename` | Rename paired agent |
| `DELETE /api/ui/agents/:key` | Revoke paired agent |
| `POST /api/ui/settings/network-mode` | Toggle network mode (writes config, triggers server restart) |
| `WS /api/ui/events` | WebSocket for live updates (new pairing requests, status changes) |

All `/api/ui/*` routes require localhost or valid API key (configurable: localhost-only by default if you want stricter security).

### 4.5 Notifications

#### Module: `packages/server-for-chrome-extension/src/notifications/`

```
notifications/
  index.js         — public API: notify({ title, body, url })
  windows.js       — PowerShell + WinRT ToastNotificationManager
  macos.js         — osascript -e 'display notification "..." with title "..." sound name "default"'
  linux.js         — notify-send -u critical "title" "body"
  logger.js        — [notify:*] logging
```

Public API:
```js
notify({ title, body, url, sound = true }) → Promise<void>
```

Implementation per OS:

- **Windows**: shell out to `powershell.exe -NoProfile -Command "<inline-script>"` that builds a toast XML and shows via `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]`. Sound default. URL placed in toast body (clickable launch URI is v1.5 polish).
- **macOS**: shell out to `osascript -e 'display notification "<body>" with title "<title>" subtitle "Open <url>" sound name "default"'`
- **Linux**: shell out to `notify-send -u critical "<title>" "<body>"` (sound is handled by the desktop environment based on urgency level)

Notification fired when:
- A new pairing request enters `pending-pairings.json`
- (Future) Other significant events

All shell-out commands logged with full command line for cross-platform debugging.

### 4.6 Network mode change

Current behavior: extension popup sends `set_network_mode` WS message → server calls `closeAllConnections()` + re-listens on the new bind address, persists to `<dataDir>/network.enabled`.

New behavior: web UI POSTs to `/api/ui/settings/network-mode` → server writes preference → server triggers full daemon restart via the existing service-restart machinery (kill current process, the daemon re-spawn handler relaunches with new bind).

Restart approach: server writes the preference, sends itself SIGTERM, the parent daemon supervisor (or absent that, the user-facing exit + auto-relaunch via the Run-key auto-start) brings it back. If no supervisor is in place, the server can `spawn` a fresh detached copy of itself before exiting.

### 4.7 Server config additions

`<dataDir>/config/server.json` gains:

```json
{
  "port": 3456,
  "apiKey": "...",
  "managedProfile": "Default",
  "managedUserDataDir": null
}
```

- `managedProfile`: which Chrome profile is the "agent target" when an agent needs Chrome launched. v1 supports one. `null` = default ("Default").
- `managedUserDataDir`: `null` = use Chrome's default location for the OS.

Existing `paired-keys.json` entries continue to work; a future migration tags them with `profileId = managedProfile` for forward compatibility.

## 5. Extension changes

### Files affected

- `packages/chrome-extension-unpacked/popup/popup.html` — remove Pairing tab markup
- `packages/chrome-extension-unpacked/popup/popup.js` — remove pairing tab logic, paired-agents view, related message handlers
- `packages/chrome-extension-unpacked/popup/popup.css` — drop pairing-tab styles
- `packages/chrome-extension-unpacked/background.js` — keep pairing message handlers minimal (extension still needs to relay nothing if pairing is web-UI-only; ALL pairing flow moves out of the extension)
- New: profile self-identification flow. On first run (no `webpilot.profileId` in storage), call `chrome.identity.getProfileUserInfo()` and try to match against the server's known profiles. If unambiguous → store. If not → show a popup view with a dropdown of known profiles (fetched from `GET /connect` or `GET /api/ui/status`) and require user to pick.

### Extension popup after these changes

- **Dashboard** tab — connection status, restricted mode, whitelist (unchanged)
- ~~**Pairing** tab~~ — REMOVED
- **Settings** tab — `Focus new tabs`, `Tab organization`, `Check for formatter updates` (network mode toggle MOVED to web UI; remove from popup)

## 6. Implementation order / dependencies

```
Wave 1 (parallel — no shared files):
  A1. Chrome management module (src/chrome/, src/notifications/)
  A2. Async pairing (paired-keys.js + mcp-handler.js pairing tools + pending-pairings.json persistence)
  A3. Web UI scaffolding (packages/server-web-ui/ — pure new package, no server integration yet)

Wave 2 (sequential, depends on Wave 1):
  B1. Multi-extension WebSocket support + extension self-identify handshake (depends on A1 for profile concepts)
  B2. Integrate ChromeManager into browser_create_tab + auth routing for other tools (depends on A1, A2, B1)
  B3. Wire web UI to server REST + WebSocket (depends on A2, A3, B1)
  B4. Remove Pairing tab from extension popup (depends on A2 — pairing must work elsewhere first)
  B5. Network mode toggle move (depends on A3 settings page)
  B6. pkg build pipeline integration (depends on A3)

Wave 3 (review pass):
  C1. Review Wave 1 + Wave 2 code for clean-code violations, suggest improvements
  C2. Update docs/ (MCP_SERVER.md, MCP_INTEGRATION.md, CHROME_EXTENSION.md) to reflect new architecture
```

## 7. Testing strategy

- Unit tests for `ChromeManager` are hard because everything depends on real Chrome processes. Pragmatic approach: shell out to a mockable adapter (`detector.js` exposes pure functions that can be stubbed in tests).
- Integration smoke test: a manual checklist in this doc — "kill Chrome, call browser_create_tab, verify Chrome relaunched with flag" — that we run by hand before declaring v1 done.
- Web UI: visual smoke test only; no automation in v1.

## 8. Manual verification checklist (run before declaring v1 done)

- [ ] Server starts, web UI reachable at `http://localhost:3456/ui`
- [ ] Pairing tab removed from extension popup; web UI shows pending pairing
- [ ] System notification fires when agent calls `request_pairing` on a fresh state
- [ ] Notification body contains web UI URL
- [ ] Web UI approve grants key, deny rejects
- [ ] `request_pairing` returns immediately (no 120s wait); `check_pairing_status` works
- [ ] Calling `request_pairing` twice with same agent_name returns same pairing_id (idempotent)
- [ ] With Chrome closed: agent calls `browser_create_tab` → Chrome launches with flag → tab opens
- [ ] With Chrome open without flag: agent calls `browser_create_tab` → Chrome killed → relaunched with flag for active profile(s) → tab opens
- [ ] With Chrome open with flag: agent calls `browser_create_tab` → fast path, no restart
- [ ] PID liveness cache: kill Chrome manually, next tool call detects PID dead, full re-detection runs
- [ ] Multiple profile windows: both extensions connect, server tracks both, each identifies its profile
- [ ] Cross-platform: Windows verified manually; macOS + Linux have scaffolded code with TODOs honestly logged
