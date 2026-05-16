# Pre-Launch Tracking

Working artifacts kept around until v1 of `QOL-Features` ships. Once the PR
description absorbs the relevant items, this file can be deleted.

This consolidates what used to be five separate files:

- `docs/TEMP_QOL_FEATURES_PLAN.md` — spec / planning doc
- `docs/QOL_FOLLOWUPS.md` — living TODO list
- `docs/REVIEW_SERVER.md` — Wave-3 server review
- `packages/server-web-ui/REVIEW_WEB_UI.md` — Wave-3 web UI review
- `packages/chrome-extension-unpacked/REVIEW_EXTENSION.md` — Wave-3 extension review

Section headings below correspond to each source file. Content is preserved
verbatim with only the original `# H1` titles demoted into `##` section
headers so the document has a single top-level heading.

---

## Plan (from `docs/TEMP_QOL_FEATURES_PLAN.md`)

> **Status:** Spec / planning doc, not permanent project documentation. Delete or fold into permanent docs after v1 lands.
>
> **Branch:** `QOL-Features` (local only, not yet pushed)
>
> **Date:** 2026-05-14

### 1. Goal

Make WebPilot resilient to the most common failure mode — Chrome running without the `--silent-debugger-extension-api` flag — by giving the server the ability to detect Chrome state, restart it with the flag when needed, and manage multiple profiles. Add a web UI that owns pairing approval, profile management, and paired-agent administration.

### 2. Key facts validated empirically (2026-05-13/14)

These were verified by running real PowerShell commands against the user's actual Chrome installation. Do not re-debate them — they are facts:

1. **`--silent-debugger-extension-api` is a per-process launch flag.** It cannot be applied to a running Chrome process. The flag is set on `chrome.exe`'s command line at launch.
2. **One Chrome browser process per `--user-data-dir`.** All profile windows sharing a user-data-dir share one browser process and one set of launch flags. The "browser parent" is identifiable by absence of `--type=` in its command line (children are `--type=renderer`, `--type=gpu-process`, etc.).
3. **Chrome's per-profile session restore works automatically when launched with `--profile-directory=<name>`** — regardless of the user's `restore_on_startup` Preferences setting. We do not need to track which URLs were open, only which profiles.
4. **Process command-line is readable per-user without admin.** On Windows via `Get-CimInstance Win32_Process`, on macOS via `ps -ww -o command= -p <pid>`, on Linux via `/proc/<pid>/cmdline` (NUL-separated).
5. **Per-profile activity detection** works reliably via filesystem write activity in `<user-data-dir>\<profile>\`. Active profiles write to `SharedStorage-wal` and similar files constantly (verified: 13 file writes in 60s for an active profile, 9 for another). Inactive profiles have no recent writes.
6. **Graceful close on Windows works via `PostMessage(WM_CLOSE)`** to each visible Chrome window — Chrome runs its normal shutdown path (saves session state). `CloseMainWindow()` only closes one window per process; for multi-window processes use raw `PostMessage` to every visible Chrome HWND.
7. **The browser parent command-line shows only the FIRST launch's args.** Subsequent launches (e.g., `chrome.exe --profile-directory="Profile 2"` while a Chrome process already exists for that user-data-dir) IPC into the existing process and exit. The flag is locked in at first launch.

### 3. v1 scope

#### IN scope

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

#### OUT of scope (deferred to v1.5+)

- Per-agent profile binding at MCP-tool-routing level beyond v1's "one agent → one profile" model
- Click-to-open from system notifications (notification body has URL, user opens browser manually)
- Bundling Electron app to host the web UI
- Auto-installing the extension into new profiles (Chrome doesn't allow this — Developer Mode + Load Unpacked is unavoidable)
- Cross-user-data-dir Chrome management for non-standard Chrome installations beyond default location

### 4. Architecture

#### 4.1 New module: `packages/server-for-chrome-extension/src/chrome/`

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

##### Module API (sketch)

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

##### Logging conventions

- Every public method logs entry + key parameters + outcome
- Format: `[chrome:<file>] <message>` so `grep "\[chrome:" daemon.log` extracts the full trail
- Include PIDs, paths, profile names, durations
- Errors logged with stack trace at error level
- On unsupported OS code paths, log `[chrome:detector] platform=darwin/linux not yet fully implemented` (so the scaffold is honest)

#### 4.2 Async pairing — server-side changes

##### `src/paired-keys.js` — extend with pending pairings

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

##### `src/mcp-handler.js` — update tools

- **`request_pairing`**: instead of waiting on `extensionBridge.sendCommand('pairing_request')` with a 120s timeout, this tool now:
  1. Calls `pairedKeys.requestPairing(agentName)` immediately
  2. Returns `{ pairing_id, status, api_key? }` in the MCP response text
  3. Description updated to instruct AI agents: "If status is `pending`, surface this to your human and stop making other tool calls; the human will approve in the WebPilot UI. To get your key later, call `check_pairing_status` with the `pairing_id`."

- **`check_pairing_status`**: new MCP tool, exempt from auth (like `request_pairing`). Schema: `{ pairing_id: string }`. Returns `{ status, api_key? }`.

##### Tool descriptions

The agent-facing description text must clearly explain the async flow. Example for `request_pairing`:

> "Initiate pairing. **Asynchronous flow**: returns immediately with a `pairing_id` and current `status` ('pending', 'approved', or 'denied'). If 'pending', the user has not yet approved — tell the human to approve in the WebPilot UI (notification will fire), then on a later turn call `check_pairing_status` with the `pairing_id` to get your `api_key`. Idempotent: if you call this twice with the same `agent_name`, you get the same `pairing_id` back."

#### 4.3 Multi-extension WebSocket support

##### `src/extension-bridge.js` — track N connections

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

##### Extension handshake

When the extension connects, before any commands flow, it sends `{type:'hello', profileId:'Default', profileDisplayName:'Your Chrome', gaiaEmail?:'...'}` over the WebSocket. Server records this in the connection map.

`profileId` is determined by the extension via `chrome.identity.getProfileUserInfo()` + manual popup picker fallback. Cached in `chrome.storage.local` after first identification.

If the extension cannot determine its profile, the WebSocket connects but the server returns `{type:'identify_required', knownProfiles:[...]}` — the extension shows the popup picker, user picks, extension stores choice + retries handshake.

##### Routing tool calls

The MCP handler now resolves the target profileId from the agent's API key (in v1: just the single "managed profile" from server config, since per-agent profile binding is out of scope). Then `extensionBridge.sendCommand(profileId, ...)`.

#### 4.4 Web UI

##### Package structure

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

##### Build & bundling

- Build step: `npm run build:web-ui` runs `next build` in `packages/server-web-ui/` with `output: 'export'`, producing static files in `packages/server-web-ui/out/`
- The server's `pkg` config includes `"../server-web-ui/out/**/*"` in its `assets` array (paths relative to the server package)
- At runtime, server resolves the static directory at `path.join(__dirname, '..', '..', 'server-web-ui', 'out')` in dev mode and via pkg's snapshot filesystem in production
- Server's `dist:win` / `dist:mac` / `dist:linux` scripts updated to run `npm run build:web-ui` first

##### Server routes for web UI

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

#### 4.5 Notifications

##### Module: `packages/server-for-chrome-extension/src/notifications/`

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

#### 4.6 Network mode change

Current behavior: extension popup sends `set_network_mode` WS message → server calls `closeAllConnections()` + re-listens on the new bind address, persists to `<dataDir>/network.enabled`.

New behavior: web UI POSTs to `/api/ui/settings/network-mode` → server writes preference → server triggers full daemon restart via the existing service-restart machinery (kill current process, the daemon re-spawn handler relaunches with new bind).

Restart approach: server writes the preference, sends itself SIGTERM, the parent daemon supervisor (or absent that, the user-facing exit + auto-relaunch via the Run-key auto-start) brings it back. If no supervisor is in place, the server can `spawn` a fresh detached copy of itself before exiting.

#### 4.7 Server config additions

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

### 5. Extension changes

#### Files affected

- `packages/chrome-extension-unpacked/popup/popup.html` — remove Pairing tab markup
- `packages/chrome-extension-unpacked/popup/popup.js` — remove pairing tab logic, paired-agents view, related message handlers
- `packages/chrome-extension-unpacked/popup/popup.css` — drop pairing-tab styles
- `packages/chrome-extension-unpacked/background.js` — keep pairing message handlers minimal (extension still needs to relay nothing if pairing is web-UI-only; ALL pairing flow moves out of the extension)
- New: profile self-identification flow. On first run (no `webpilot.profileId` in storage), call `chrome.identity.getProfileUserInfo()` and try to match against the server's known profiles. If unambiguous → store. If not → show a popup view with a dropdown of known profiles (fetched from `GET /connect` or `GET /api/ui/status`) and require user to pick.

#### Extension popup after these changes

- **Dashboard** tab — connection status, restricted mode, whitelist (unchanged)
- ~~**Pairing** tab~~ — REMOVED
- **Settings** tab — `Focus new tabs`, `Tab organization`, `Check for formatter updates` (network mode toggle MOVED to web UI; remove from popup)

### 6. Implementation order / dependencies

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

### 7. Testing strategy

- Unit tests for `ChromeManager` are hard because everything depends on real Chrome processes. Pragmatic approach: shell out to a mockable adapter (`detector.js` exposes pure functions that can be stubbed in tests).
- Integration smoke test: a manual checklist in this doc — "kill Chrome, call browser_create_tab, verify Chrome relaunched with flag" — that we run by hand before declaring v1 done.
- Web UI: visual smoke test only; no automation in v1.

### 8. Manual verification checklist (run before declaring v1 done)

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

---

## Follow-ups (from `docs/QOL_FOLLOWUPS.md`)

Status as of: 2026-05-14
Branch: `QOL-Features` (local, not pushed)
Spec source-of-truth: see the [Plan](#plan-from-docstemp_qol_features_planmd) section above.

This is the *living* list of items in the QOL-Features scope that are **not done** or were intentionally deferred. Items get checked off (or deleted) as they land. Severity ordering — top items block before push, bottom items are nice-to-have.

---

### P0 — Required before pushing / opening PR

- [ ] **Live extension end-to-end smoke test on Windows** — load the unpacked extension into Default + Profile 2, exercise the full pairing flow + `browser_create_tab` flow + restart-on-flag-missing flow. Spec Section 8 checklist items that can only be validated live.
- [ ] **Decide on misattributed commit `87dd359`** — currently has A3's commit message ("scaffold web UI package") but contains A2's pairing code. Cosmetic only; content is correct. Options: leave + note in PR description / rewrite via filter-branch.
- [ ] **Decide on bd-init working-tree leftovers** — `.beads/`, `AGENTS.md`, `M .gitattributes` from agents running `bd init` to bypass the broken pre-commit hook. User's domain to decide whether to commit, gitignore, or fix the hook.

### P1 — Outstanding correctness / UX issues

- [x] **Profile auto-detect for non-signed-in profiles** — landed in commits `f439589` (inference by exclusion), `fccde12` + `13a0002` (server-side installId mapping store + extension UUID-on-install). Combined effect: anonymous profiles auto-resolve via exclusion on sequential connects; installId provides stable per-install identity that survives storage clears.
- [ ] **macOS detector / launcher / closer / notifications** — scaffolded honestly per spec, never tested on real macOS hardware. Will surface real issues on first non-Windows user.
- [ ] **Linux detector / launcher / closer / notifications** — same as above for Linux.
- [ ] **`pending-pairings.json` history pruning** — currently has a 24h expiry for pending, but denied/approved/expired entries accumulate forever. Add a longer max-age (e.g., 30 days) + cleanup.
- [ ] **Web UI `/pairings` history is session-scoped** — built from event-stream messages, lost on refresh. The server has `listAllPairings()` available; surface a `GET /api/ui/pairings/history` endpoint and have the UI read it.

### P2 — Minor improvements identified by reviews

- [ ] **`validateKey()` is called twice per tool call** (auth + routing). Memoize the entry from the auth gate and thread it to the routing function. Tiny I/O regression, not correctness.
- [ ] **Settings page race guard** — was assessed by the H2 agent as not needing it (no WS-event refresh trigger); revisit if a WS-event for settings is ever added.
- [ ] **Per-row keyboard a11y on agent list** — review I-finding; not addressed.
- [ ] **`formatDate` defensive fallback for null/undefined** — review S-finding.
- [ ] **Magic-number constants** — various places (timeouts, intervals) should be named constants.

### P3 — Larger deferred work (would not block v1 push, but flagged)

- [ ] **Web UI auth model for LAN deployments** — currently localhost-only. If users want LAN-accessible management, design a proper session/cookie auth flow.
- [ ] **Click-to-open from macOS / Linux notifications** — Windows toast got `activationType="protocol" launch=<url>`; macOS osascript and Linux notify-send don't have native click-handlers. Custom helper apps needed for parity.
- [ ] **Bundle the server into the Electron app** — currently distributed as a separate pkg binary that the Electron app spawns. Future iteration consolidates.
- [ ] **Auto-installing the extension into new profiles** — impossible (Chrome forbids it for unsigned extensions). Improve the manual-load instructions in the "Create sandbox profile" flow.
- [ ] **Cross user-data-dir Chrome management** — current model assumes Chrome's default user-data-dir. Power users with custom dirs are unsupported.

---

### Items recently completed (kept temporarily for context, prune as PR is opened)

- [x] Wave 1 — Chrome management, notifications scaffolds, async pairing API, web UI scaffold
- [x] Wave 2 — multi-extension WS, ChromeManager into `browser_create_tab`, web UI wired to server REST/WS, pairing tab removed, network mode moved, pkg build pipeline
- [x] Wave 4 fixes — F1 web UI localhost-only, F2 hello handshake ordering, F3 zombie pairingRequiredCache, F4 `clearConnection(ws)` bug, F5 dead `browser_create_tab` switch case, F6 pending-pairings 24h TTL, F7 themed confirm modal, F8 pkg-safe static serving
- [x] Wave 5 fixes — G1 profile name validation, G2 `profileId` wired through approve, G3 legacy `set_network_mode` WS handler removed, G4 approve/deny terminal-state semantics (409/404)
- [x] Wave 6 polish — H1 change-profile UI in extension, H2 REST/WS race guard, H3 stale `getLocalIP` removed, H5 web UI auto-open on `--foreground`, H6 per-agent `.mcp.json` copy snippet (H4 port change skipped — kept 3456)
- [x] Wave 7 — J1 Profiles page race guard, J2 per-agent tool routing
- [x] Notification fixes — AppUserModelID self-registration, click-to-open `launch` attribute on toast XML
- [x] Profile auto-detect — inference-by-exclusion + installId-based persistent mapping

---

## Server review (from `docs/REVIEW_SERVER.md`)

Scope: `packages/server-for-chrome-extension/src/chrome/`, `src/notifications/`, `src/paired-keys.js`, `src/mcp-handler.js`, `src/server.js`, `src/extension-bridge.js`, `package.json`. Reference: see the [Plan](#plan-from-docstemp_qol_features_planmd) section above.

### Severity legend
- Critical: bug, security issue, or broken behavior
- Important: smell, missing error handling, unclear contract, potential bug
- Suggestion: clean-code improvement, naming, structure, comment

---

### Findings

#### Critical

##### C1. `POST /api/ui/profiles` does not validate / sanitize the profile name — passes user input straight into a Chrome CLI arg

`server.js:169-193` accepts `req.body.name`, trims it, and passes it directly to `launchChromeProfile({ profileDirectory: name })`. The launcher (`chrome/launcher.js:57`) builds the arg as `'--profile-directory=' + profileDirectory`. Because spawn is invoked without a shell, classic shell injection isn't possible, but:

- A name like `"x --remote-debugging-port=9222"` is parsed by Chrome's command-line parser as additional flags (Node's `spawn` passes argv tokens but `child_process.spawn` on Windows joins to a string for non-shell exes via `cmd /c` semantics depending on which underlying API is used — `windowsVerbatimArguments` is not set here, so Node will quote/escape, but Chrome's own parser still splits the value if it contains `"` and an additional `--flag`).
- Path-traversal characters (`..`, `\`, `/`, `:`) let the user create directories anywhere under `userDataDir` — `<UDD>\..\..\anywhere`.
- Reserved Windows names (`CON`, `PRN`, `NUL`, `AUX`, `COM1`-`COM9`, `LPT1`-`LPT9`) and names with `<>:"|?*` will create filesystem mayhem.
- Empty/whitespace name passes the `if (!name)` check via the trim, but names like `.` or `..` get through.

Fix: enforce a strict allowlist regex (e.g. `^[A-Za-z0-9 _-]{1,40}$`), reject reserved Windows names, and 400 on violation.

Spec section 4.4 calls out this endpoint and section 4.4's auth note says "configurable: localhost-only by default if you want stricter security" — input validation is independent of auth and is missing.

---

##### C2. `approvePairing` ignores `profileId` posted by the web UI — silently lost

`server.js:143-154` reads only `req.params.id` and calls `pairedKeys.approvePairing(id)`. The web UI client (`packages/server-web-ui/lib/api.js:55-60`) sends `{ profileId }` in the body, and `paired-keys.js:275-305` `approvePairing()` accepts only `pairingId` and never persists `profileId` on the entry.

The spec (section 4.4 table) says:
> `POST /api/ui/pairings/:id/approve` — Approve a pending pairing; body includes selected profileId

This means:
- The "approve to profile X" UX is non-functional. Whatever profile the user picks in the web UI is silently discarded.
- The `__new__` ("New sandbox profile") option in `app/pairings/page.js:54` is also silently dropped — the server never launches a new profile in response.
- Future "per-agent profile binding" forward-compat (mentioned in spec section 4.7) has no anchor — there's no field on the paired-key entry to carry it.

Fix: accept `profileId` in the approve route, pass through to `approvePairing(id, profileId)`, and either persist it on the pairing entry and/or the paired-keys entry. If `profileId === null` (the `__new__` path), surface a helpful error since the server doesn't currently create a sandbox profile during approval.

The task brief explicitly flags this: "The `_new__` profile selection that server ignores: should it 4xx instead?" — yes; right now it silently approves without the requested action.

---

##### C3. WS upgrade for `/api/ui/events` accepts the **extension API key** as the UI key (key reuse)

`server.js:264-300` shares the same `apiKey` variable for both the extension WebSocket auth (`url.searchParams.get('apiKey') !== apiKey`, line 290-291) and the UI WebSocket auth (`clientApiKey === apiKey`, line 276). The `makeUiAuth` HTTP middleware also uses the same key (line 109).

The task brief asks: "is that compared to the right key store?" The answer is: there is no separate UI key store; the server's single `apiKey` (the WS-handshake key for extensions, persisted in `<dataDir>/config/server.json`) is reused as the UI master key. Compromise of one credential equals compromise of both. The spec doesn't explicitly require separation, but mixing the long-lived extension transport key with the user-facing UI admin key is a meaningful security smell — anyone with the apiKey (e.g. anyone who read the extension popup's `Connect` flow output, or scanned `server.json`) can drive `/api/ui/agents/:key/rename`, revoke, force a network-mode restart, or launch arbitrary Chrome profiles.

Fix: mint a separate per-UI session/admin key, or — at minimum — restrict the mutating UI endpoints (`/api/ui/agents/*`, `/api/ui/settings/network-mode`, `/api/ui/profiles`) to localhost only, regardless of header.

---

##### C4. `uiAuth` middleware comparison is timing-attack-shaped and uses `===` on a possibly-undefined header

`server.js:104-114`: `headerKey === apiKey`. If a request omits `X-API-Key`, `headerKey` is `undefined`, which compares cleanly. But if an attacker spams guesses, the string `===` is short-circuit and timing-leaky. The same pattern repeats at `server.js:276` for the WS handshake.

Important rather than critical because all current deployments are localhost. Promoted toward critical because the spec ships a network-mode toggle that exposes this to LAN. Fix: `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` with length pre-check.

---

##### C5. `setNetworkMode` restart path writes `network.enabled` twice and races with old `set_network_mode` WS handler

The legacy extension popup handler still lives at `server.js:438-460` (`set_network_mode` over the extension WS) and does an *in-process* `server.close()`/`server.listen()` rebind. The new UI handler at `server.js:549-572` writes the same `network.enabled` file and then **spawns a detached copy of the daemon and exits**.

Problems:

1. Both code paths write `network.enabled`. The web UI handler also persists in `mountWebUiRoutes` (`server.js:552`), but `server.js:443-448` does its own write. If the extension still sends `set_network_mode` (B5 only removed the UI toggle — see `b288ef7`; the message handler is still alive) the file gets stomped without the spawn.
2. `args = process.argv.slice(1)` (line 560) drops `argv[0]` (the node interpreter / pkg binary path), but then re-spawns `process.execPath` with those args. In dev mode where `process.execPath` is `node` and `argv[0]` is `node` and `argv[1]` is `index.js`, this works. In pkg mode `argv[0]` is the pkg .exe and `argv[1]` may be undefined or a real arg; passing `[]` or just `['--foreground']` to the same exe is fine, but if the user launched with a custom flag like `--network`, that flag is preserved correctly. However: `WEBPILOT_FOREGROUND=1` is forced into the env — overriding whatever lifecycle mode the spawned daemon is in. The MEMORY note on the pkg self-spawn bug says env-var is the workaround for `--foreground`. This collision is by design but should be commented; right now it looks accidental.
3. The 500 ms `setTimeout` before `process.exit(0)` is fragile — if the spawn fails (caught silently at line 564-566), the daemon exits anyway, leaving the user with no server. The fix would be to verify the child is alive before exiting (or at least not exit on spawn failure).
4. Spec section 4.6 specifies "the parent daemon supervisor (or absent that, the user-facing exit + auto-relaunch via the Run-key auto-start) brings it back". The Run-key relies on user login — if the daemon exits at runtime without spawn succeeding, the user has to log out/in.

Fix: tear out the extension's `set_network_mode` handler entirely (the popup UI for it was removed in B5) so the two paths can't diverge; check spawn success before `process.exit`.

---

#### Important

##### I1. `ChromeManager.refresh()` arbitrarily picks `ours[0]` when multiple browser-parents match

`chrome/manager.js:101` takes `ours[0]` after filtering. If two Chrome browser-parents share a user-data-dir (unusual but possible — e.g. one started fresh after a crash before the old one fully exited), the cache only records the first PID's hasFlag. If `ours[0]` has the flag but `ours[1]` does not (or vice-versa), `ensureReady` may take the wrong action. Log all matches and pick by `hasFlag === true` first (or warn if the set is mixed).

##### I2. `ensureReady`'s "running + hasFlag" case skips the spec's per-profile WS check

`chrome/manager.js:202-211`: spec section 4.1 explicitly says step 2 should also check "all requiredProfiles already have an active extension WebSocket". The code returns `noop` if the flag is present, even if the required profile's WS isn't connected. This is partially compensated by `mcp-handler.js:841-845` doing a separate `extensionBridge.isConnected(targetProfile)` check, but that throws rather than triggering a relaunch — which is the spec's intended UX. The comment at `manager.js:202` explicitly notes "Wave 2 will add per-profile WS check" — but Wave 2 is in. Either complete the integration or update the spec to acknowledge the gap.

##### I3. `ensureReady` reuses `activeBefore` of the now-killed Chrome — relies on filesystem mtime that was already going stale

`chrome/manager.js:215-217` calls `getActiveProfiles()` *after* `getStatus()` and *before* `closeAll()`. `getActiveProfiles` checks mtime within `activityWindowSeconds` (default 30s). Between detection of "running without flag" and the close-all, there's no race. But if the user has Chrome paused, suspended, or with no recent writes (e.g. only a single read-only tab idle for 30s+), no profiles will be detected as active and only the `requiredProfiles` get relaunched — losing the user's other open profiles. Consider falling back to `knownProfiles` ∩ `current --profile-directory` from the live browser-parent command line, or widening the activity window when zero profiles look active.

##### I4. `getActiveProfiles` uses `fs.statSync` synchronously per-file inside an async-named method

`chrome/manager.js:132-138` is `async getActiveProfiles()` but the underlying `chrome/profile-activity.js:53-74` uses `fs.statSync` and `fs.existsSync` synchronously in a loop. With ~20 profiles × 10 hot files this is fine; flagging only because the async signature suggests otherwise. Either convert to `fs.promises.stat` or drop the `async`.

##### I5. `chrome/launcher.js:67-71` — spawn errors caught two ways, child PID may be `undefined`

If `spawn` synchronously throws (rare; e.g. ENOENT on certain platforms), the try/catch at lines 66-75 re-throws. But spawn's async ENOENT fires on the `error` event handler (line 80-82), which just logs and is too late — the function has already returned `{ pid: child.pid, ... }` with `child.pid` set to `undefined` (or 0). Callers like `ChromeManager._launchProfiles` then push `{ profileDirectory: p, pid: undefined }` and proceed as if launch succeeded.

Fix: wrap launch as a Promise that resolves on `spawn` success or rejects on the `error` event, with a short timeout. Or at minimum check `child.pid` and throw if falsy.

##### I6. Pending-pairings file has no cleanup — grows unboundedly

`paired-keys.js:198-202` `savePendingPairings()` writes the full array; `denyPairing` and `approvePairing` keep entries forever (status changes but the entry stays). Spec section 4.2 explicitly lists `cleanupOldPairings(maxAgeDays)` as part of the contract. It's not implemented. Over months a malicious actor (or a buggy MCP client) repeatedly calling `request_pairing` with random agent names grows the file linearly. Also: a denied entry blocks future `request_pairing` calls for that agent_name (see I7) — without cleanup, denial is permanent.

##### I7. `requestPairing` is idempotent on `pending|approved` but NOT on `denied` — and there's no way to un-deny

`paired-keys.js:215-217` finds existing entries with `status === 'pending' || status === 'approved'`. A `denied` entry slips through and a fresh pending entry is created with a new `pairingId`. This is correct UX for the agent (denial isn't permanent), BUT: the array now has both a `denied` and a new `pending` entry for the same agentName. `listPendingPairings` (line 337-339) shows only the new pending one, so the UI is fine, but `listAllPairings` returns both, and history pages will see duplicate agent rows. Document or dedupe.

##### I8. `approvePairing` returns the entry on the `denied` branch (line 292) but caller treats it as success

`paired-keys.js:288-293`: if status is `denied`, we log and `return entry` — the entry has status `denied`, so the caller (`server.js:148`) treats it as if approval succeeded and responds 200. Should return `null` (or a separate error sentinel) so the route can 409.

##### I9. `mcp-handler.js`'s `resolveTargetProfile` is called per tool call and reads + parses `server.json` from disk every time

`mcp-handler.js:56-66`. Cheap but unnecessary I/O on a hot path. Cache the result inside the closure with an invalidation hook (or read once at factory time). Spec section 4.3 talks about routing — this routing is the single profile name from config, so caching is safe until the user edits `server.json`.

##### I10. `mcp-handler.js`'s `waitForExtensionConnection` polls every 250 ms with no jitter or backoff

`mcp-handler.js:76-93`. Adequate for 10 s, but pure polling. The bridge already knows when a connection lands (it emits via `setConnection`). Wiring an event emitter on `ExtensionBridge` would make this deterministic. Not a bug — but as the spec says "wait for the extension WebSocket(s) to connect (with timeout)", an event-driven wait is the better implementation.

##### I11. `handleToolCall` for `browser_create_tab` falls through to the `switch` block but case is a no-op (`commandType = 'create_tab'`)

`mcp-handler.js:814-851` handles `browser_create_tab` and `return`s. `mcp-handler.js:862-867` has `case 'browser_create_tab': /* handled above */ commandType = 'create_tab'; commandParams = ...`. The case is dead code (kept for the comment, presumably) and is misleading — anyone reading the switch could think `browser_create_tab` reaches the bottom-of-function `sendCommand`. Delete it.

##### I12. `extension-bridge.clearConnection(ws)` rejects pending commands when no profile was identified, but the message reads "Extension disconnected" for ALL pending commands

`extension-bridge.js:72-79`: the loop is `for (const [id, pending] of pendingCommands)` and rejects when `!removedProfileId || pending.profileId === removedProfileId`. The `!removedProfileId` branch rejects *every* pending command across *every* connection just because one anonymous connection closed. That's a bug if multiple profiles are connected and one of them never finished its hello before disconnecting. Fix: skip rejection when `removedProfileId` is null.

##### I13. WS upgrade routes `/api/ui/events` to `uiWss` but the UI client probably needs the query param `apiKey` even when on localhost

`server.js:272-287`: the WS upgrade allows local OR `apiKey` query. The Next.js client (`packages/server-web-ui/lib/ws.js` per the scaffold commit) connects with `?apiKey=...`. Need to verify the UI knows the API key without first calling an authenticated endpoint — there's a chicken-and-egg risk where the UI bootstraps over localhost (no header) but the WS code path then expects an apiKey query string. Mark this as a question for the UI reviewer; the server-side `isLocal` short-circuit at line 277 means localhost UI works without the key, which is correct.

##### I14. `mountWebUiStatic` 'fallback' route is registered AFTER `express.static` and conflicts

`server.js:90-98`: `app.use('/ui', express.static(dir, { extensions: ['html'] }))` registers a catch-all on `/ui` first; then `app.get('/ui', ...)` registers an explicit `GET /ui` handler. Order matters in Express — the explicit handler at line 92 will never fire because `express.static` already served `index.html` for the bare `/ui` path. Either the comment is misleading or the fallback is dead code. The Next.js static-export `out/` layout uses trailing-slash subdirs and a top-level `index.html`, so `express.static({ extensions: ['html'] })` should handle the bare `/ui` correctly. Drop the dead fallback.

##### I15. `resolveWebUiDir` only tries two candidates; pkg snapshot path is path.join('..','..','server-web-ui','out') from `__dirname`, but `__dirname` in the snapshot is `/snapshot/packages/server-for-chrome-extension/src` — verify the resolved candidate path

`server.js:53-78`. The comment claims candidate `[0]` is correct in pkg mode. From `__dirname = /snapshot/packages/server-for-chrome-extension/src`, going `..,..` lands at `/snapshot/packages/`, then `server-web-ui/out`. The pkg asset glob `"../server-web-ui/out/**/*"` is relative to the package directory (`packages/server-for-chrome-extension/`), so pkg writes the assets to `/snapshot/packages/server-web-ui/out/`. The candidate path is correct only if pkg's snapshot uses `/snapshot/packages/...` as its layout. **Question for verification**: pkg actually places assets relative to where the source-file claims them, which means `path.join(__dirname, '..', '..', 'server-web-ui', 'out')` will work. This needs a smoke test against the built `.exe` — please confirm via the manual checklist before claiming v1 done.

##### I16. `mcp-handler.js`'s `webpilot_reload_formatters` is exempt from auth (line 538)

This wasn't added in QOL but it's worth flagging: a network-mode-enabled, non-paired client can hit `/sse` and call `webpilot_reload_formatters` to reload arbitrary formatter files on disk. The custom-formatters dir is local, but if combined with another flaw allowing file write, this turns into RCE. Lower the surface by requiring auth, or at least localhost-only for this tool.

##### I17. The `request_pairing` `created && status === 'pending'` notification fires only on FIRST request — but the notification is the user's only signal

`mcp-handler.js:632`: the toast only fires on `result.created === true`. If the agent calls `request_pairing` twice and the user dismissed the first toast, they're stuck with no signal. Consider firing on every "pending" return (with a short de-dupe window), or also firing on `check_pairing_status` if the user has waited too long.

##### I18. `mcp-handler.js:629-650` — `notify()` rejection swallowed silently, never propagates

The `.catch` at 642-644 logs but doesn't reach the agent. The `try/catch` at 633/645 catches the `require()` failure but not async errors. Both behaviors are intentional ("Never throws — failures are logged and swallowed" per notifications/index.js:13), but the agent receives a "pending — system notification sent" message even when the notification silently failed. Either change wording to "a system notification has been attempted" or add a stdout-visible warning back to the response when known-failed.

##### I19. `pairings/page.js` shows `__new__` option but server has no `/api/ui/profiles/new-and-approve` endpoint; user picks it, server silently approves to nothing

See C2 — combined with the silent-drop, the `__new__` UX is doubly broken. Either remove the option until the server supports it, or have the server 400 on `profileId === null`.

##### I20. `cleanupPidAndPortFiles` ran on `process.exit` event but the network-mode setImmediate-spawn-then-exit (server.js:567-570) has a 500ms sleep — pid/port may briefly mismatch the new daemon

Race: spawned child writes its own pid file (it will, via `writePidAndPortFiles` at startup); the parent's `process.on('exit', cleanupPidAndPortFiles)` then unlinks them. Order of operations: parent spawns child → setTimeout 500ms → cleanup → exit. If the child started fast (<500ms), the child wrote its pid, then the parent unlinks it. Net result: server.pid/server.port are deleted right after a successful restart, breaking any later `service status` check. Fix: do not run `cleanupPidAndPortFiles` on the restart path — only on graceful shutdown.

##### I21. `extension-bridge.js`'s "Backwards-compatible" comment says `isConnected()` is an alias for `isAnyConnected()` — but the no-arg call in callers is unclear

Lines 86-92: the function silently bifurcates based on argument presence. This is the kind of "magic" interface that bites later. Prefer two named methods (`isAnyConnected()` and `isConnectedForProfile(profileId)`) and have legacy callers explicitly pick one.

---

#### Suggestion

##### S1. Hardcoded version string `'0.5.4'` in `mcp-handler.js:502` will drift on every release

The version-bump script likely updates this (per memory notes), but it's a single source of truth violation. Read from package.json once at startup.

##### S2. `chrome/logger.js` and `notifications/logger.js` are identical except for prefix string

Both modules implement an identical `formatExtra` + `log/error` pair. Promote to a shared `make-logger.js` factory; saves 40 LOC and prevents drift.

##### S3. Magic number `30000` for command timeout in `extension-bridge.js:19`

Name it `EXTENSION_COMMAND_TIMEOUT_MS = 30000` for grep-ability.

##### S4. Magic number `30` for activity window in `chrome/manager.js:26` and `chrome/profile-activity.js:32`

Define as `DEFAULT_ACTIVITY_WINDOW_SECONDS` once; spec section 2.5 documents the empirical basis (13 file-writes per 60s for active profile) — comment that constant accordingly.

##### S5. Magic number `5000` for hello deadline in `server.js:339`, `10000` for extension reconnect in `mcp-handler.js:831`, `20000` for close timeout in `chrome/closer.js:24`

Many tuned-by-magic timeouts. Constants at top of file.

##### S6. `chrome/profile-activity.js` `HOT_FILES` list is correct but undocumented why each is there

Add a one-line comment per entry pointing to spec section 2.5 / what is written to it.

##### S7. `windows-detector.js`'s embedded PS script is built as a JS array joined by `' '` (line 47-57)

Hard to debug. Prefer a heredoc-style multiline template string — at least the script is greppable. Same applies to `closer.js`'s WM_CLOSE script, but that one already uses backticks.

##### S8. `paired-keys.js` mixes `[pairing]` log prefix with file-scoped `console.log` — vs. the rest of the QOL code that uses `[component:area]`

The QOL spec calls for `[component:area]` prefixes (e.g. `[chrome:manager]`, `[notify:windows]`). `paired-keys.js` uses bare `[pairing]` and `[auth]`. Consider `[pairing:requestPairing]` etc., or accept this as the legacy module's existing convention.

##### S9. `server.js` line 117 destructures `pairedKeys` from `deps` shadowing the module-level import

```js
function mountWebUiRoutes(app, deps) {
  const { apiKey, chromeManager, extensionBridge, pairedKeys, setNetworkMode } = deps;
```

The parameter `pairedKeys` shadows `require('./paired-keys')`. Functionally OK because they're the same value, but linters will warn and a reader has to verify. Rename to `pairedKeysDep` or drop from destructure.

##### S10. `server.js:170-193` — error handling 500s on every failure including expected ones (e.g. Chrome not installed)

`launchChromeProfile` throws if `chromePath` doesn't resolve. The 500 response then says `e.message`. Differentiate "user error" (400) from "server error" (500).

##### S11. `chrome/manager.js:230` non-ASCII unicode `∪` in a log message

`'chrome was running without flag; restarted with active ∪ required profiles'` — fine on UTF-8 stdout but won't survive on `cp850` Windows consoles. Use `union of`.

##### S12. `chrome/closer.js`'s WM_CLOSE PowerShell script doesn't escape PID list

Line 64 builds `$pids = @(${pidList})` from `pids.map(Number).filter(...)`. The filter ensures only finite numbers reach the array, so injection is impossible. Mark with a comment so future modifications don't drop the filter accidentally.

##### S13. `notifications/windows.js` includes the URL inline in the toast body via `body + '\n' + url`

`\n` in a toast `<text>` element doesn't render as a newline; it renders as a space (or is collapsed). Either insert a second `<text>` element or use spec-compliant attribution. Cosmetic.

##### S14. `linux-detector.js` matches `comm` with `comm.startsWith('chrome')`

Will match `chrome_crashpad_h` and other Chrome helpers that are NOT browser-parents. The `isBrowserParent(args)` filter saves the day, but the over-matching wastes work. Tighten the comm filter.

##### S15. `server.js:235` constructor uses object destructuring with explicit defaults inline — long signature

Cosmetic: extract a `DEFAULT_HOST = '127.0.0.1'` constant.

##### S16. `notifications/index.js` re-`require`s the platform impl on every call

Could be top-level. Lazy-require is justified only if there's a CI/test scenario where the impl isn't bundled — pkg's asset glob covers `src/**/*.js` so all three notif impls are in the bundle. Switch to eager require for clarity.

##### S17. `chrome/index.js` re-exports both `ChromeManager` (class) and `createChromeManager` (factory) — pick one

The factory pattern is used everywhere else in the QOL code (`createExtensionBridge`, `createMcpHandler`). Drop the class export from the public API; keep it internal.

##### S18. `paired-keys.js:188` log starts with `[pairing]` but the listener-throw log uses backticks and a different format

```js
console.log(`[pairing] listener for "${event}" threw: ${e.message}`);
```
vs.
```js
console.log(`[pairing] Failed to load pending-pairings.json: ${e.message}`);
```
Inconsistent capitalization within the same file.

---

### Cross-cutting observations

1. **Auth surface fragmentation.** Four different auth checks exist: extension-WS handshake (`server.js:290-294`), UI HTTP middleware (`server.js:104-114`), UI WebSocket (`server.js:272-282`), and MCP tool gate (`mcp-handler.js:539-551`). All four share the same `apiKey`. The MCP gate is the only one that can be bypassed via `isPairingRequired() === false`. Centralize the policy: a single `authPolicy({ source, target, key, remote })` function would prevent the next reviewer from missing a check site.

2. **Silent error swallow vs. user-facing error.** `notifications/*` document "never throws — failures are logged and swallowed" and live up to that. `chrome/launcher.js` partially swallows (the async `'error'` event handler just logs). `chrome/manager.js` `ensureReady` returns `{ action: 'abort' }` on close failure rather than throwing. `mcp-handler.js`'s `browser_create_tab` translates `ensureReady` throw into a useful error message but does NOT check for the `action: 'abort'` return, so an abort silently becomes "no extension connected" downstream. Wire the abort case to throw an explanatory error before the WS-connect wait.

3. **`[component:area]` logging convention is followed in the new modules** (`chrome/*`, `notifications/*`) but the older `paired-keys.js` and `server.js` mix `[pairing]`, `[auth]`, `[ui-api]`, `[ui-ws]`, `[network]`, `[config]`, `[extension-bridge]`, `[mcp-handler]`. Most have the `[area]` form rather than `[component:area]`. The spec doesn't strictly require `:area` everywhere but the consistency drift is jarring.

4. **No use of `async/await` inside `setImmediate(() => setNetworkMode(...))`** — the route handler returns 200 before the spawn happens. If spawn fails the user gets no signal. Either await + then respond, or push an event over `broadcastUiEvent` when restart succeeds.

5. **Pkg-mode path resolution is fragile.** Both `resolveWebUiDir` (`server.js:53`) and `getDataDir` (`service/paths.js:33`) hard-code relative path traversals based on assumed install layout. A test that runs the built binary and exercises `GET /ui` and `GET /api/ui/status` would catch all these.

6. **The Chrome detector for macOS uses `pgrep -x 'Google Chrome'`** — pgrep on macOS does not match the full process name by default; users may have Chrome Beta, Canary, Chromium, etc. Spec scope says default Chrome only, so accept this, but log a TODO already present.

7. **No tests for the `paired-keys.js` async-pairing flow.** The state machine (pending → approved → key minted) is critical infrastructure now; even a unit test for `requestPairing` idempotency would prevent regression.

---

### Things that are well done

- **`chrome/` module separation by responsibility** — detector / closer / launcher / paths / manager — is exemplary. Easy to swap an impl, easy to test each in isolation.
- **Per-OS detector files are honest about scaffold quality.** `macos-detector.js:8` and `linux-detector.js:11` explicitly call themselves out as unverified. The TODO logs at runtime are the right move.
- **`chrome/closer.js`'s Win32 WM_CLOSE approach** correctly implements the spec section 2.6 "raw PostMessage to every visible HWND" — and the PS script logs every HWND it hits, which is exactly the kind of trace the spec asked for.
- **`requestPairing` idempotency** on pending+approved is well-implemented and correctly tested by the `created` flag returned to the caller. The notification-only-on-fresh-creation guard (`mcp-handler.js:632`) prevents toast spam.
- **Pairing events emitter** (`paired-keys.js:27-43`) is a clean way to decouple disk-state changes from WS broadcasts.
- **`chrome/manager.js` getStatus()'s fast-path** with PID liveness check is exactly the spec's requirement and is correctly cache-validated.
- **The `extension-bridge.js` per-profile WebSocket map** is appropriately defensive: it replaces stale connections, cleans up on close, rejects in-flight commands when their target disappears.

---

### Test coverage gaps

The spec acknowledges tests are pragmatic, but these REALLY need integration tests:

1. **`paired-keys.requestPairing` idempotency**: pending entry survives across process restart (load → request again → same pairingId). A 20-line jest test prevents future refactors from silently breaking the contract that downstream MCP agents now rely on.

2. **`approvePairing` after `denyPairing`** — current code returns the denied entry on approve, which would 200 in the route. A unit test asserting "approving a denied pairing returns null/throws" pins down the right behavior (whatever you decide for I8).

3. **`ChromeManager.ensureReady` matrix**: at least these three cases as integration smoke (could be mocked detector):
   - chrome not running → launches with flag
   - chrome running WITH flag → no-op
   - chrome running WITHOUT flag → close-all + relaunch with `activeBefore ∪ requiredProfiles`

4. **Multi-extension WS routing**: open two WebSockets with `profileId=Default` and `profileId="Profile 2"` hellos, send a command, verify it only reaches the targeted connection. This is the riskiest concurrency hazard introduced in B1 and has no test.

5. **`POST /api/ui/profiles` sanitization** — once C1 is fixed, lock the input validation in with a test.

6. **Pkg-build smoke**: a CI step that runs `npm run build:win`, launches the binary, hits `http://localhost:3456/ui` and `/api/ui/status`, and verifies non-500 responses. The path-resolution risks (I15) and pkg-self-spawn risks (the MEMORY note) are otherwise discovered post-release.

---

### Summary

- Critical: 5
- Important: 21
- Suggestion: 18

Top 3 most important:

1. **C1** — `POST /api/ui/profiles` accepts unvalidated profile names that pass straight into a Chrome CLI arg and a filesystem path. Must fix before exposing the UI on the network or making this anything other than localhost-trusted.

2. **C2** — The web UI's profile-selection on pairing approval is silently dropped by the server. The `__new__` sandbox-profile UX is non-functional. Either implement it or 4xx clearly.

3. **C3 + C4** — Single shared `apiKey` reused as the UI admin credential, with non-constant-time string comparison and trivial header-vs-localhost auth on a network-exposed mutating API. With the new network-mode toggle this becomes the largest attack surface in the project.

---

## Web UI review (from `packages/server-web-ui/REVIEW_WEB_UI.md`)

### Severity legend
- Critical: bug, security issue, accessibility failure, or broken behavior
- Important: smell, missing error/loading state, unclear contract, potential bug
- Suggestion: clean-code improvement, naming, structure, UX polish

### Findings

#### Critical

##### C1. `useEffect` cleanup runs `client.disconnect()` which clears the listener map — but in React 19 Strict Mode the effect mounts twice
`app/page.js:26-47`, `app/pairings/page.js:27-50`, `app/profiles/page.js:26-37`, `app/agents/page.js:29-40`.

Every page creates a `UiEventsClient` inside `useEffect`. On unmount the cleanup calls `client.disconnect()` which sets `_closed = true` and (importantly) calls `this._listeners.clear()` (`lib/ws.js:120`). In React 19 dev / Strict Mode, the effect runs once → cleanup runs → effect runs again with a **new** client. That second run constructs a fresh client, so functionally it works, but: each rapid mount/unmount will leak a `setTimeout` reconnect timer in the brief window between `WebSocket.close()` firing and `_closed` being checked. More importantly, **if `disconnect()` is called after `_scheduleReconnect()` has already queued a timer but before that timer fires, the timer still runs and calls `connect()` which then short-circuits at `if (this._closed) return;` — fine — but in `_scheduleReconnect` itself there is no guard checking `this._closed` at the moment the `setTimeout` callback fires beyond the one in `connect()`.** This is borderline; the real bug is below.

More concretely: the cleanup sequence is

```
disconnect() -> this._closed = true
              -> clearTimeout(this._reconnectTimer)   // OK
              -> this._ws.close()                      // triggers 'close' event ASYNC
              -> this._listeners.clear()               // <-- listeners gone
```

Then the async `close` handler at `lib/ws.js:56-61` runs: it sets `this._ws = null` and calls `this._scheduleReconnect()`. `_scheduleReconnect` checks `this._closed` and returns. OK. **But** if `connect()` is in flight (constructor succeeded, listeners attached) when `disconnect()` is called, the `open` / `message` handlers still hold references to `this` and will try to `_emit` on a cleared `_listeners` map. That's fine (empty map = no-op), so this specific path is actually safe.

**The real issue**: each page instantiates its own `UiEventsClient` and connects an independent WebSocket. Navigating Home → Pairings → Profiles → Agents → Settings → Home opens 5 WebSockets (in succession; old ones disconnect on unmount, but during Strict Mode double-invoke the server will see 2× connections per page). A single shared client (module-level singleton or React context) would be cleaner.

Severity: moving this to **Important (I1)** because the actual leak risk is low. Keeping the section header but the only true Critical here is C2 below — please treat C1 as Important.

##### C2. `confirm()` for revoke and network-mode toggle blocks the renderer and is not accessible
`app/agents/page.js:52` — `if (!confirm(...)) return;`
`app/settings/page.js:33` — `if (!confirm(msg)) return;`

`window.confirm()` is a synchronous modal that blocks the JS event loop, is not styleable, does not match the dark theme, cannot be made keyboard-trap-correct for assistive tech beyond what the browser provides, and on some Electron / packaged contexts the dialog may not render at all (especially if the UI is hosted inside a webview without the BrowserWindow's dialog permissions). Worst case in Electron: `confirm()` returns `undefined`/throws, the revoke silently never fires. The review brief explicitly asked us to call out which mechanism is used — it is `window.confirm()` in both places, and that is the wrong choice for a destructive action like **agent key revocation** and **server restart**.

Recommendation: a small dark-themed `<dialog>` modal component, or at minimum a two-step inline confirm (button morphs to "Click again to confirm").

##### C3. Pairing approval flow drops `selectedProfile === '__new__'` into a `null` profileId without ever creating a profile
`app/pairings/page.js:64-65` — `const profile = selectedProfile === '__new__' ? null : selectedProfile;`
`lib/api.js:55-60` — sends `{ profileId: profile || null }`
`packages/server-for-chrome-extension/src/server.js:143-154` — server's `approvePairing` ignores `profileId` entirely.

When the user selects "+ New sandbox profile" the UI sends `profileId: null`. The server-side `approvePairing` doesn't accept or use `profileId` at all (it just calls `pairedKeys.approvePairing(id)` and returns). So:

1. "+ New sandbox profile" is silently equivalent to picking any other option — no sandbox is created.
2. The UI presents an option that has no implementation behind it. This is a stub leaked into shipped code.

Either remove the "+ New sandbox profile" option from `profileOptions` until the server supports it, or implement the create-on-approve flow on the server. Right now the dropdown is misleading.

##### C4. `createProfile` accepts any string and forwards it directly to Chrome's `--profile-directory` flag — no validation
`app/profiles/page.js:39-57`, `lib/api.js:69-74`, server at `packages/server-for-chrome-extension/src/server.js:169-193`.

The only client-side check is `name.trim()` being non-empty. Chrome's `--profile-directory` value becomes a **directory name on disk** under `User Data\`. Characters that are illegal on Windows (`< > : " / \ | ? *`) and the trailing-dot / trailing-space rules will cause Chrome to either silently fall back to "Default" or fail to launch. There is no length cap either (Windows MAX_PATH still bites at ~255 chars combined with the user-data-dir prefix). On Linux/macOS, embedded slashes will create nested directories.

At minimum the UI should:
- Reject characters not in `[A-Za-z0-9 _-]` (matching what Chrome's profile picker allows).
- Cap the length (~64 chars is plenty).
- Reject names that already exist in `data.profiles` (otherwise you launch Chrome onto an existing profile and call it a "sandbox").

Server-side it should mirror the same validation as defence in depth — currently `String(req.body.name).trim()` is the entire validation surface.

##### C5. WebSocket URL ignores `setApiBaseUrl()` for dev mode → events stream broken in `next dev`
`lib/ws.js:20-25` builds the WS URL from `window.location` only. The REST client (`lib/api.js`) has an `API_BASE_URL` overridable via `setApiBaseUrl()` precisely so that `next dev` (port 3100) can point REST at the WebPilot server (some other port). The WS client has no equivalent — running `next dev` will try to open a WebSocket to `ws://localhost:3100/api/ui/events`, which is the Next dev server, not WebPilot. Result: dev mode shows "events unavailable" forever; only the periodic refresh (which there isn't — see I3) keeps the UI alive.

`createUiEventsClient` accepts a `url` option, but no page passes one. Either:
- have `ws.js` read from the same `API_BASE_URL` (and translate `http://` → `ws://`), or
- accept a base URL prop and have a single shared `EventsProvider` at the app root.

#### Important

##### I1. Five independent WebSocket connections — one per page mount
See C1 reclassified. Each page in `app/*/page.js` instantiates its own `UiEventsClient`. Navigating between pages tears down and rebuilds. A module-level singleton or a React context would:
- Reduce server load (uiWsClients churn).
- Avoid the "client connected / disconnected" spam in server logs on every nav.
- Allow the History list on `/pairings` to accumulate **across navigation** rather than being reset every time the user clicks away and back (see I8).

##### I2. Stub `console.log` paths still in production components
`components/AgentRow.js:28, 37` and `components/PairingPromptCard.js:25, 34` log `(stub)` messages if `onRename`/`onRevoke`/`onApprove`/`onDeny` are not provided. Since the pages always provide these handlers now (Wave 2 wired them up), the stub branches are dead code — but they ship to the bundle, and any future caller forgetting to wire up will fail silently with a console log rather than a loud error. Recommendation: remove the stub branches; treat missing handler as a programmer error.

##### I3. No polling fallback — if WebSocket never connects, UI is stale forever
Every page does **one** `refresh()` at mount and then relies on WS events for further updates. If `/api/ui/events` never connects (auth failure, dev-mode wrong port per C5, server restart per Settings page), the UI silently stays stale. There is no "live updates disconnected" indicator anywhere, and no polling fallback. The Home page even claims a "live" status card with no signal to the user that the live channel is down.

Recommendation: add a small "Live"/"Reconnecting…" badge sourced from the WS client's connection state, and/or a 30 s polling fallback when the WS is not in `OPEN` state.

##### I4. `useEffect` deps array is `[]` but uses `refresh` defined in the component body — stale closure waiting to happen
All five pages do this pattern:

```js
useEffect(() => {
  refresh();
  // ...
}, []);
```

`refresh` is defined inside the component on every render. The `[]` deps array fires the lint warning `react-hooks/exhaustive-deps`. Today the function doesn't close over any props/state that change (no params), so this is currently safe — but it's fragile. Either:
- Move `refresh` outside the component (it's literally a `getStatus()` wrapper), or
- Wrap it in `useCallback` and put it in deps, or
- Move the network-and-WS logic into a custom hook (e.g. `useUiStatus()`).

##### I5. Race condition between REST `refresh()` and WS event-driven `refresh()`
`app/page.js:13-24` (and identical patterns on every page): `refresh()` is `async`. If a WS event fires while a previous `refresh()` is in flight, you get two parallel `getStatus()` requests with no ordering guarantee. The later-fired request may resolve **first** and be overwritten by the older response. This is the classic stale-response bug.

Fix: use an incrementing request id (a `useRef`) and discard responses whose id is not the latest, or use `AbortController` to cancel the in-flight request when a new one starts.

##### I6. `setTimeout(refresh, 1000)` on profile-create — magic delay, no cleanup
`app/profiles/page.js:51` — `setTimeout(refresh, 1000);` after `createProfile()` succeeds. The 1 s is presumably to wait for Chrome to actually launch and the extension to connect, but:
- It is not cleared on unmount → if the user navigates away within 1 s, `refresh` runs against an unmounted component (no React warning in 19 but still wasted work and a `setState`-on-unmounted no-op).
- A WS `extension_connected` event will trigger a refresh anyway, making this redundant.

Fix: drop the timer; rely on the WS event, or capture the timer id and clear it in the effect cleanup.

##### I7. `error` state is overloaded: it carries both real errors and "everything is fine, just restarting" messages
`app/settings/page.js:40` — `setError(new Error('Server is restarting — refresh this page in a few seconds.'));`

Putting a benign info message into the `error` slot means it renders inside the error card with no visual distinction, and a downstream developer reading the state model will be confused. Add a separate `info` / `notice` state, or model this as `{kind: 'error'|'info', message}` (the Profiles page already does this correctly with `createMsg`).

##### I8. History list on `/pairings` is reset on every navigation away/back
`app/pairings/page.js:10` — `const [history, setHistory] = useState([]);` State is component-local, so navigating to another page and back clears the history. The Wave 2 doc apparently claims "session-scoped"; the actual scope is **mount-scoped**, which is much narrower (every page click resets it). The user will be surprised.

Options:
- Hoist `history` to a module-level array or React context provider that survives navigation but not full refresh.
- Persist in `sessionStorage` (still session-scoped, survives nav).
- Document the behaviour clearly in the empty state ("History is cleared when you leave this page").

##### I9. Network-mode toggle marks the server as restarting via a fake error, but UI optimistically sets `networkMode = next` first
`app/settings/page.js:38-40`:
```js
await apiSetNetworkMode(next);
setNetworkMode(next);
setError(new Error('Server is restarting — refresh this page in a few seconds.'));
```

The server response is `{ ok: true, restarting: true }` and `setImmediate(() => setNetworkMode({ enabled }))` is fired **after** the response is sent. There is a window where the UI shows "ON" but the server hasn't actually restarted yet, and any `getStatus()` polled during that window would still report the old value. Combined with no polling/WS reconnect indicator (I3), the user has no robust signal that the toggle "took". Consider disabling the toggle entirely until `getStatus()` confirms the new value, with a spinner + a hard timeout (e.g. 10 s).

##### I10. `apiFetch` doesn't pass the dev-mode X-API-Key header
`lib/api.js:18-47` only sets `Accept` and `Content-Type`. The server's `uiAuth` (`server.js:104-114`) accepts `localhost OR X-API-Key`. In `next dev` (port 3100) the request originates from the same machine but with a different port — `req.socket.remoteAddress === '127.0.0.1'`, so localhost auth will pass. Good. But there is no `X-API-Key` plumbing at all, meaning the UI can never be served from a non-localhost device with auth, which is the explicit motivation for `setApiBaseUrl()`. Add an `setApiKey()` and include it in headers when set.

##### I11. The dropdown in `PairingPromptCard` does not refresh `selectedProfile` when `profileOptions` changes
`components/PairingPromptCard.js:18` — `useState(profileOptions[0]?.value || 'Default')`. If `profileOptions` updates (e.g. a new profile was created on the Profiles tab and the WS triggers a refresh), the card keeps its old `selectedProfile`, which may now be stale or refer to a profile that no longer exists. With the current single-page approval flow it's unlikely to hit, but it's classic "derived state stored in state".

Fix: validate `selectedProfile` against current `profileOptions` on each render, falling back to options[0] if not found.

##### I12. The "Default" fallback in `app/pairings/page.js:56-59` masks the empty-profiles case
```js
if (profileOptions.length === 1) {
  profileOptions.unshift({ value: 'Default', label: 'Default' });
}
```

If `/api/ui/status` returns `profiles: []` (e.g. Chrome never ran, or fetching profiles failed) the UI silently adds a magic "Default" option. The user might approve a pairing for the literal directory name "Default" while the server has no idea what profile that maps to. Worse: this fallback only triggers when `profiles.length === 0` because `__new__` always counts as 1. It would be clearer to render a warning "No Chrome profiles detected — approving will use the default profile" and disable the dropdown.

##### I13. `formatDate('never')`-style values get silently passed through
`components/AgentRow.js:10-15` returns `'never'` only when value is falsy; if the server sends a non-date string like `'unknown'` or `0`, it falls through to `String(value)`. Minor robustness issue.

##### I14. Inline `<span onClick>` for "click to rename" is not keyboard-accessible
`components/AgentRow.js:60-67`. The agent name is editable on click, but the span has no `tabIndex`, no `role="button"`, no `onKeyDown` for Enter/Space. Keyboard-only users cannot rename. The `cursor: 'text'` is also a poor affordance — `cursor: 'pointer'` would at least hint at interactivity. Better: an actual `<button>` styled as text, or a small pencil icon button next to the name.

##### I15. Profile-create input has no `onKeyDown="Enter"` submit binding
`app/profiles/page.js:106-112`. Users instinctively press Enter; here that does nothing (no surrounding `<form>`, no `onKeyDown`). Easy win: wrap in `<form onSubmit={handleCreate}>` with `e.preventDefault()`.

##### I16. WebSocket `error` events log only `err.message`, but DOM `Event` objects don't have a `message`
`lib/ws.js:64-67`. `WebSocket` error events are plain `Event` instances (not `ErrorEvent` in all browsers), so `err.message` is typically `undefined` and the log prints `[ui-ws] error undefined`. Not user-visible but unhelpful when debugging.

##### I17. Cleanup pattern `u1 && u1()` is needlessly defensive
`app/profiles/page.js:33-34`, `app/agents/page.js:36-37`. `subscribe()` always returns a function (`lib/ws.js:84`). The `&&` guard implies otherwise. Just call them. The home and pairings pages use `unsubs.forEach((u) => u && u())` — same comment.

#### Suggestion

##### S1. Consolidate the four nearly identical `useEffect` blocks into a `useUiEvents(eventTypes, onChange)` hook
All five pages copy/paste the same pattern: create client, subscribe, refresh on event, cleanup. This is the textbook case for extraction. A hook also lets you share a single `UiEventsClient` across the app (see I1) and centralise the "live" / "reconnecting" state (see I3).

##### S2. Move `refresh` functions out of components — they're just `getStatus()` wrappers with `setState`
Each page defines `refresh`. A `useStatus()` hook returning `{ status, error, loading, refresh }` would DRY this up nicely.

##### S3. `apiFetch` swallows the JSON parse error
`lib/api.js:35` — `await res.json().catch(() => null)`. If the server sends `Content-Type: application/json` but a malformed body, `payload` is silently `null` and the caller doesn't know the response was bad. Log it at minimum.

##### S4. Color contrast: `--wp-fg-muted: #9a9a9a` on `--wp-bg-card: #1a1a1a`
Contrast ratio ≈ 6.0:1 — passes WCAG AA for normal text but the `.wp-muted` class is used at 0.85rem ≈ 13.6px (smallish). Still passes AA, doesn't hit AAA (7:1). Fine, but lift the muted to `#a8a8a8` for AAA without changing the design feel.

The brighter `--wp-danger: #ef4444` on `#1a1a1a` is ~4.5:1 — passes AA for normal text but borderline. The "Revoke" button uses this as the border + text color; on hover it inverts to white-on-red which is much better. Acceptable.

##### S5. `<a href="/ui/">` for in-app nav causes full-page reloads
`app/layout.js:14-21`. Next.js `<Link>` would do client-side nav and preserve the WS connection if you implement S1's shared client. Right now navigating between pages disconnects/reconnects WS every time.

##### S6. `PairingPromptCard` re-renders `disabled={busy}` on **all** prompts when busy applies to only one approval
`app/pairings/page.js:13` — single `busy` boolean, but multiple pending pairings can exist. Approving pairing A disables Deny/Approve on pairing B too. Either track `busy` per `pairingId` (a `Set<string>`) or accept the global-busy UX and note it explicitly.

##### S7. No `key` for `details` field in `AgentRow` makes `title={agent.key}` exposed in tooltip
`components/AgentRow.js:69` — `title={agent.key}` exposes the full API key on hover. Not a leak per se (the user already has it on their machine), but for shoulder-surfing it's a needless reveal. Maybe limit the title to the same short prefix?

##### S8. `<span className="wp-status-dot">` has no `aria-label`
`components/StatusCard.js:16`. Color-only status indicator → invisible to screen readers and to colour-blind users. Add `aria-label` describing the state ("status: ok"), or render an off-screen text equivalent ("Running — healthy").

##### S9. Empty-state copy could be more consistent
"No pairings waiting." vs "No agents paired yet." vs "No profiles found." — all fine in isolation; consider standardising on "No X yet" / "No X to show."

##### S10. `next.config.js` has `output: 'export'` with `trailingSlash: true` — confirm asset paths work mounted under `/ui`
The static export emits to `out/`, which the WebPilot server presumably mounts at `/ui`. The `basePath: '/ui'` + `assetPrefix: '/ui/'` should handle this, but verify the server serves `out/index.html` for `/ui/` and `out/pairings/index.html` for `/ui/pairings/` (not `/ui/pairings.html`). The trailing-slash quirk is a frequent source of 404s.

##### S11. `globals.css` uses two ellipsis styles: `Loading...` vs `Loading…` vs `Launching...` vs `Restarting…`
`app/page.js:61` has `Loading...`, `app/settings/page.js:71` has `Loading…`, `Launching...` (profiles) vs `Restarting…` (settings). Pick one.

### Cross-cutting observations

- **Wave 2 wiring is mostly clean**: API surface (`lib/api.js`) is consistent — every endpoint goes through one wrapper, no rogue `fetch()` calls. Good.
- **No tests anywhere** in the package — `package.json` has no `test` script, no test files. For a UI that gates destructive actions (revoke key, restart server, create profile) this is a gap.
- **No TypeScript / JSDoc** — `apiFetch` returns "JSON or text" depending on response, callers blindly index into the result (`data.pendingPairings`, `data.chrome.running`, etc.). One backend rename and the UI silently breaks. Even minimal JSDoc types on the API wrappers would help.
- **WebSocket auth in dev**: the WS handshake from a browser can't carry headers, so the server falls back to `?apiKey=` query string (`server.js:275`). The UI client never appends `apiKey`. In localhost mode this works because of the `isLocal` shortcut, but it's another piece blocking non-localhost UIs.
- **Build / hydration**: Pages use `'use client'` correctly and never read `window` at top level (only inside `useEffect`), so SSR/SSG should be clean. The `_defaultUrl` in `ws.js:20-25` short-circuits with `if (typeof window === 'undefined') return null;` — good.
- **`.gitignore` is correct** — `node_modules/`, `out/`, `.next/`. But note that `.next/` and `out/` are present in the working tree on disk; they shouldn't be committed, and the ignore handles that. No `package-lock.json` present — depending on the monorepo's lockfile strategy, this may or may not be intentional.
- **All four event subscriptions across pages use `'pairing_*'`, `'agents_changed'`, `'extension_*'` strings as literals.** These should be exported constants from `lib/ws.js` (or a shared `events.js`) so a typo doesn't silently break a subscription.

### Things that are well done

- `lib/api.js` is a clean, minimal wrapper. JSON / text dispatch is correct, error object carries `status` and `payload`. The pattern of named wrapper exports (`getStatus`, `approvePairing`, etc.) is exactly right.
- `UiEventsClient` correctly handles SSR (returns `null` URL when `window` is undefined), correctly handles WebSocket construction errors, and correctly reconnects with a backoff timer.
- The `disconnect()` method sets `_closed = true` **before** closing the socket and clearing listeners — the ordering prevents the close handler from re-scheduling a reconnect.
- `cancelled` flag pattern in `useEffect` (e.g. `app/page.js:27`) is the right pattern for guarding against stale `setState` after unmount.
- CSS uses semantic CSS variables (`--wp-bg`, `--wp-accent`, etc.) with sensible defaults — easy to retheme.
- The Settings page surface area is tiny and well-scoped — one toggle, clear copy.
- `PairingPromptCard` and `AgentRow` are properly extracted, single-responsibility components.
- Server-side `/api/ui/*` endpoints all use the same `auth` middleware, and the UI hits them through one client — no auth bypass on any route.
- Error states render *somewhere* on every page (even if I7 critiques the overloading) — no page silently fails.

---

## Extension review (from `packages/chrome-extension-unpacked/REVIEW_EXTENSION.md`)

Branch: `QOL-Features`. Commits in scope: `bdae1ac`, `11b5074`, `dbe6f2f`, `b288ef7`.
Files reviewed: `manifest.json`, `background.js`, `popup/popup.html`, `popup/popup.js`, `popup/popup.css`.

### Severity legend
- Critical: bug, security issue, or broken behavior
- Important: smell, missing error handling, unclear contract, potential bug
- Suggestion: clean-code improvement, naming, structure

### Findings

#### Critical

**C1. `pairingRequiredCache` is sent to the server on every connect but the popup has no way to set it (orphaned/zombie state).**
- `background.js:376` — on every `wsConnection.onopen` the extension sends `{ type: 'set_pairing_required', enabled: pairingRequiredCache }`.
- `background.js:54-58, 234-249, 744-746` — the value is cached in module scope, mirrored to `chrome.storage.local`, with `SET_PAIRING_REQUIRED` / `GET_PAIRING_REQUIRED` message handlers and a `storage.onChanged` mirror.
- However, the Pairing tab was removed (`dbe6f2f`) and `popup.js` no longer contains *any* reference to `pairingRequired` / `SET_PAIRING_REQUIRED` / `GET_PAIRING_REQUIRED` (grep confirms zero matches in `popup/`).
- Effect: the cache value defaults to `true` on a fresh install and can never be changed from the extension UI. The server is told "pairing required" forever from this side. Per the QOL plan §5, pairing config moves to the web UI, but the extension is still actively *pushing* its (now-frozen) cached value to the server on every reconnect. That means even if the web UI flips the toggle off, this extension will flip it back on at its next reconnect, silently fighting the web UI.
- Either remove the `set_pairing_required` send at `background.js:376` and the related handlers/cache (lines 53-59, 234-249, 744-746), or wire the server's authoritative value back into the cache. As written this is broken state with no UI.

**C2. Stored credentials get out of sync with the actually-connected profile.**
- The `auto-connect` and config path at `background.js:127-148` writes `apiKey` / `serverUrl` / `sseUrl` / `networkMode` etc. to `chrome.storage.local` regardless of which Chrome profile the user is in. With multi-extension support, *every* profile that loads the extension will pull credentials from the same shared `/connect` endpoint and store them under the same per-profile storage keys (fine, since storage is per-profile), but the apiKey stored is a *server* key, not a per-profile key.
- Worse: when `auth_failed` (code 1008) is hit at `background.js:455-464`, the extension clears `apiKey` / `serverUrl` / `enabled` but does **not** clear `webpilot.profileId` or `webpilot.knownProfiles`. After a forced re-pair, the profileId may now reference a profile that no longer exists in `Local State`, and the handshake will keep failing without ever surfacing an `identify_required` (the server resolves the stored profileId and accepts it even if the profile was deleted, depending on how `readProfiles` is implemented — needs verification). At minimum, `FORGET_CONFIG` (line 215) and the auth-failed path should also clear `webpilot.profileId`/`webpilot.knownProfiles` so the user is forced through fresh identification.

**C3. `chrome.identity.getProfileUserInfo()` "user denied" path is not handled — the helper resolves `null` and `gaiaEmail` becomes `null` permanently.**
- `background.js:514-526` — the callback path resolves `null` when `info.email` is empty (which is exactly what Chrome returns when the user has not opted in to "Allow sign-in" / sync, or when running in a Guest/Incognito-ish profile, or when account info is simply unavailable).
- That is fine *the first time* — the server will reply with `identify_required` and the user gets a picker. But there is no UX path that *re-prompts* for identity later. If the user clicks "I am this profile" once and gets it wrong, `webpilot.profileId` is now set and the extension will keep sending the wrong id on every reconnect with no recovery affordance.
- There is no setting/button anywhere in the popup that lets a user clear or change `webpilot.profileId`. The only way out is `FORGET_CONFIG`, which does *not* clear the profileId (see C2). Consider adding a "Change profile" link in the connected view, or at minimum clear `webpilot.profileId` on `FORGET_CONFIG`.

**C4. Race window: `wsConnection.onmessage` is *replaced* during the formatter-update flow, dropping all in-flight server messages.**
- `background.js:293-310` — the `CHECK_FORMATTER_UPDATES` handler does `wsConnection.onmessage = tempHandler` and only restores the original on receipt of `formatter_update_result` (or never, on timeout — see C6).
- During the temp-handler window, any `store_refs`, `identify_required`, `hello_ack`, `paired_agents_list`, command envelopes, or `pong` messages are silently swallowed because `tempHandler` only matches one type.
- This bug *predates* the QOL branch but is now much worse because (a) `hello_ack` and `identify_required` flow through the same `onmessage` and (b) multi-extension means commands routed to this profile during the 10s window are dropped without rejection. The cleaner fix is a small message-router with a `Map<type, handler>` or one-shot promises keyed on a correlation id, not monkey-patching `onmessage`. Worth flagging for cleanup even though it's pre-existing.

#### Important

**I1. Service worker module-scope state still has gaps that aren't backed by storage.**
The `bdae1ac` fix correctly persisted `manuallyDisconnected`. Audit shows other in-memory state that *also* resets on worker termination and is not in storage:
- `connectionStatus`, `connectionError`, `connectionErrorType` (`background.js:24-26`) — when the popup opens and calls `GET_STATUS` after a worker termination, these will be `'disconnected'/null/null` even if the *real* WS is mid-reconnect, because the worker just spun back up. Not catastrophic (the next `onopen`/`onclose` will fix it), but `loadStateAndShow()` may briefly show the wrong view.
- `pendingCommands` (formatter-update tempHandler) — see C4.
- `wsConnection` itself — fine, it gets reconstructed.
The `autoConnectInterval` and `keepaliveInterval` will also be lost on worker termination; the worker should set these up again on startup, which `loadConfig()` does via `attemptAutoConnect()`. OK.

**I2. Hello handshake doesn't gate command processing — race on first connect.**
- `background.js:371-381` — on `onopen` the extension sends `set_pairing_required` immediately and *then* schedules the hello handshake asynchronously (the storage read in `sendHelloHandshake` takes a tick).
- The server *does* gate commands behind hello (server.js:347-405, only after `setConnection` is called does the bridge route commands to this WS), so this is currently safe in practice. But the extension treats *any* message arriving before `hello_ack` as a regular command and would dispatch it through `handleServerCommand` (`background.js:432`). If the server's contract ever changes — or if a future feature sends a side-channel push before `hello_ack` — this will silently misroute.
- Defensive fix: track a `helloAcked` flag and reject (or queue) `handleServerCommand` calls until it flips. Document the assumption in either case.

**I3. `wsConnection.send` inside `set_pairing_required` on `onopen` is sent *before* `hello`.**
- `background.js:376` sends `set_pairing_required` synchronously in `onopen`, then `sendHelloHandshake()` is called.
- The server's hello loop (server.js:347) ignores everything except `hello` until registered. So `set_pairing_required` arriving pre-hello is *dropped*. This makes the message effectively useless — the very first thing the server does is wait for hello, so the cache value never reaches the server before the connection is registered. Reorder: send hello first, then any post-handshake state after `hello_ack`.

**I4. `hello_ack` is received but `handleServerCommand` is reached for *unknown* message types in the default branch.**
- `background.js:383-436` — the `onmessage` switch has explicit cases for `pong`, `paired_agents_list`, `identify_required`, `hello_ack`, `store_refs`, then falls through to `handleServerCommand`. Any unknown server message type (e.g., a future `extension_disconnected` echo, or the `pairing_request` that the docs at `docs/CHROME_EXTENSION.md:59` still mention) will hit `handleServerCommand`, which immediately fails inside its `switch` at `background.js:649` with `Unknown command type:` — and that error gets `sendResult()` back to the server with the message's `id` (if any) as a *command response*. This pollutes the server's pending-commands map for messages that aren't commands. Add an early-return for unrecognized non-command types or check `message.id` presence before dispatching.

**I5. `paired_agents_list` is cached in storage but the comment says "future tooling".**
- `background.js:389-394` — "Pairing is now web-UI-only; the popup no longer renders this list, but we still stash it in storage in case future tooling consumes it."
- The `pairedAgents` storage key is read *nowhere* in the extension (grep confirms). Storing it has zero current value and consumes a slot in chrome storage on every server change. Either remove the `chrome.storage.local.set` call, or commit to a contract by documenting which tool will consume it. "In case" is not a contract — delete it. The branch that handles the message can simply `return`.

**I6. `IDENTIFY_REQUIRED` storage-write race vs. popup render.**
- `background.js:399-407` writes `webpilot.knownProfiles` to storage and *concurrently* dispatches `chrome.runtime.sendMessage({ type: 'IDENTIFY_REQUIRED', knownProfiles })`. The popup's listener at `popup.js:100-102` calls `renderProfilePicker(msg.knownProfiles)` directly from the message payload (good — doesn't depend on storage), so this is fine in the common path.
- However, on popup *open* (cold path) at `popup.js:415-419`, the popup calls `GET_PROFILE_IDENTITY` which reads from storage. If `webpilot.profileId` is `null` and `webpilot.knownProfiles` is non-empty, it renders the picker — correct. But the storage write at line 399-403 sets `'webpilot.profileId': null` every time `identify_required` arrives, even if the user *had previously confirmed a profile* and the server then re-asked (e.g., the profile was deleted from `Local State`). That stomps the previously-stored value. Is that desired? Probably, but it's worth a comment — and the popup will then ask for re-pick, which the user might reasonably do.

**I7. No retry / no error UI when `SET_PROFILE_ID` succeeds in storage but the handshake fails.**
- `background.js:266-277`: `chrome.storage.local.set(...)` writes the chosen profileId; if `sendHelloHandshake()` rejects, the popup gets `{ success: false, error }`. But the `popup.js:405-412` handler only acts on `response.success === true` and otherwise does nothing — the button just re-enables. The user has no feedback and `webpilot.profileId` is already stored (so next connect will try it). If the server rejects the chosen id, the user is stuck in a silent loop.
- Either surface the error in `profileIdentifyView`, or roll back the storage write on failure.

**I8. `profileIdSelect.value` empty-string when `knownProfiles` is empty.**
- `popup.js:386-397` — if the picker is rendered with an empty `knownProfiles` array, the `<select>` has no options, `chosen` at line 401 will be `''`, the click handler returns early, and the user is permanently stuck on the picker view with a non-functional button and no explanation.
- This can happen if the server's `readProfiles()` returns nothing (e.g., `Local State` missing on a fresh install, or non-Chrome browser). Add an "empty state" UI ("No Chrome profiles found, please retry") or fall back to the connecting view.

**I9. `renderProfilePicker` is called twice on race between message + storage read.**
- When `identify_required` arrives while popup is open: popup receives `IDENTIFY_REQUIRED` message (line 100) → renders. Concurrently, the initial `GET_PROFILE_IDENTITY` (line 415) may also resolve with the same data → renders again. Calling `renderProfilePicker` twice rebuilds the `<select>` and resets the user's pending selection. Harmless but messy. The `GET_PROFILE_IDENTITY` initial fetch should probably bail if the message-driven render already happened, or be gated behind "we haven't received status yet".

**I10. Manifest scopes — `identity.email` is overkill if email is only used opportunistically.**
- `manifest.json:15-16` requests `identity` + `identity.email`. The QOL plan §2 talks about `chrome.identity.getProfileUserInfo()` to surface an email *as a fallback* — and the code already handles `email === null`. Adding `identity.email` triggers a permission-warning at install time ("Read your email address") which is a noticeable UX cost for an optional fast path.
- Either drop `identity.email` and rely entirely on the user-picker fallback, or document why the trade-off is worth it. `getProfileUserInfo({ accountStatus: 'ANY' })` will return `email: ''` (not throw) when the permission is absent, so the code at `background.js:514-526` will still work, just always falling back to the picker.

**I11. WebSocket failure during hello handshake silently logged, never user-surfaced.**
- `background.js:378-380` — `sendHelloHandshake().catch((err) => console.log('[hello] handshake failed:', err && err.message));` — purely log-only.
- `sendHelloHandshake` itself can also fail synchronously inside the try/catch at line 536-540 and only logs. If the connection drops *during* hello, the user sees "Connected" status (because `onopen` fired and `updateConnectionStatus('connected', ...)` ran on line 373), but no commands work because the server never registered the profile. The popup will show green-Connected forever. This is misleading.
- Consider: only show "Connected" *after* `hello_ack`, or add a sub-state ("Connected, identifying...") that the popup can render distinctly.

**I12. `refreshConnectionMetadata` happens before hello and re-writes `networkMode` from `/connect`.**
- `background.js:374-375`: `refreshConnectionMetadata()` runs on every `onopen` and fetches `/connect` which returns `networkMode`. With B5 removing the network-mode *toggle* in the extension, the extension still cares about the value only to *display* it (popup.js:120). That's fine, but note that the field has effectively become a server-driven readout — the extension can't change it. The naming `networkMode` in storage suggests writeability; consider renaming the read path or adding a comment.

#### Suggestion

**S1. Dead CSS section header comment.**
- `popup.css:531` — `/* Pairing & Agents Sections */` is the only remaining marker; the actual rules `.section`, `.section + .section`, `.section-header`, `.empty-message` are still in the file (lines 532-555) but no surviving HTML uses them (grep `class="section"`, `section-header`, `empty-message` in `popup/popup.html` → zero matches). Delete the section.

**S2. Orphan CSS class `action-btn`.**
- `popup.html:81` — `<button id="checkFormatterUpdates" class="action-btn" ...>` references `.action-btn`, which isn't defined in `popup.css` (grep confirms). The button gets only inline `style="width:100%;"`. Either define `.action-btn` or drop the class.

**S3. Orphan CSS class `has-badge`.**
- `popup.css:78-85` — `.tab-btn.has-badge` and `.tab-btn.has-badge.active` were used to flag pending pairing requests. With Pairing tab removed there's no code that adds `has-badge` anymore. Delete.

**S4. Inline styles in `popup.html` for the new profile picker.**
- `popup.html:42-43` — `style="width:100%; margin-top:12px;"` etc. Inline style works but breaks the project pattern (every other button uses class-only styling). Extract to `.profile-id-select` / `.profile-id-confirm` for consistency.

**S5. `console.log` strings use `+` concatenation instead of template literals — inconsistent with rest of file.**
- `background.js:268, 407, 412, 525, 539` use `'foo ' + bar + ' baz'` pattern.
- Other recent logs in the same file use template literals (`background.js:362, 443, 469`). Pick one — template literals are easier to read.

**S6. `// Restart auto-connect to pick up server again` orphan.**
- `background.js:222` — comment inside `FORGET_CONFIG` is fine; just noting we should also clear `webpilot.profileId` here (see C2).

**S7. `connectionError` returned by `GET_STATUS` but popup only displays it in the "connecting" view.**
- `popup.js:148-150` shows the error only when status is `'connecting'`/`'error'`. If the worker is restarted while in error state, the popup may show "Connecting..." with the prior error. Minor UX inconsistency.

**S8. `updateConnectionStatus` sends `chrome.runtime.sendMessage` unconditionally with `.catch(() => {})`.**
- `background.js:593-599` — fine in practice (popup may not be open), but the empty catch hides genuine errors (e.g. extension context invalidated). Consider logging at debug level.

**S9. `getCurrentTabDomain` swallows errors silently.**
- `popup.js:271-276` — `catch (e)` returns `null` with no log. For a debug tool, even a `console.debug` would help diagnose "Whitelist this site" never appearing.

**S10. `sendHelloHandshake` always logs `helloMsg` including `gaiaEmail`.**
- `background.js:535` — logging email addresses to the console is a small privacy concern. Either redact (`gaiaEmail: gaiaEmail ? '<set>' : null`) or downgrade to debug level.

**S11. Comment quality — `// ---- Profile self-identification picker ----` in `popup.js:384` is fine; but elsewhere the new code lacks JSDoc.**
- `sendHelloHandshake` in `background.js:495-501` has a good docstring. Consider one for `renderProfilePicker` and `handleConnectionStatusChange` too — popup.js has very few comments.

**S12. `pairingRequiredCache` initial read uses two separate storage reads.**
- `background.js:44-51` (whitelist) and `background.js:57-59` (pairing) read storage in two callbacks. Combine into one `chrome.storage.local.get(['restrictedModeEnabled', 'whitelistedDomains', 'pairingRequired'], ...)` for one fewer round-trip on worker startup.

### Cross-cutting observations

1. **Documentation drift.** `docs/CHROME_EXTENSION.md` is unchanged by this branch but is *substantially* out of date:
   - Lines 59-78 list `pairing_request`, `PAIRING_RESPONSE`, `REVOKE_KEY`, `RENAME_AGENT`, `GET_PAIRED_AGENTS`, `GET_PENDING_PAIRING`, `SET_NETWORK_MODE` message handlers as if they exist — they have all been removed from `background.js`.
   - Lines 193-256 describe a "Pairing tab" and "Network mode toggle" that no longer exist.
   - Lines 332-346 (permissions table) doesn't list `identity` / `identity.email`.
   - No mention of `hello` / `hello_ack` / `identify_required` / `paired_agents_list` caching contract.
   - This is presumably planned for the C2 docs phase per QOL plan §6, but should be called out — anyone reading the docs today will be very confused.

2. **The `pairingRequiredCache` problem (C1) is the kind of subtle inconsistency multi-extension makes worse.** With N extension instances connecting in arbitrary order, each one telling the server its own copy of `pairingRequiredCache`, the server's effective state depends on who connected last. Defining authority (server-side or web-UI-side) is essential.

3. **Profile self-identification is a one-way street.** Once a profileId is stored, there is no UI to change it. This will bite users who run the same Chrome profile on multiple devices, or who clone profiles, or who delete a profile and recreate it. A "Change profile" affordance in the connected view (or in the Settings tab) would be a low-effort high-value addition.

4. **No telemetry / no metrics on handshake success rate.** The `[hello]` log lines are useful for debugging but there's no way for the popup to tell the user "we tried to identify your profile, it failed N times". Consider showing the last handshake outcome in the connected view subtitle.

5. **Whitelist functionality is unchanged but should be tested against the new picker flow.** Specifically: while `profileIdentifyView` is showing, the Dashboard tab is still selected but the restricted-mode controls aren't visible (they live in `connectedView`). That seems correct — but it means `loadRestrictedModeSettings()` only runs on status=connected (popup.js:218), not on first popup-open. If the user opens the popup in `identify` state then transitions to `connected` via the message listener, `loadRestrictedModeSettings` is called from `handleConnectionStatusChange`. OK in practice, but worth a smoke test.

### Things that are well done

1. **`bdae1ac` is a tidy fix.** Persisting `manuallyDisconnected` in `chrome.storage.local` and reading it in `loadConfig()` is the right shape for MV3 service workers. The popup's read path at `popup.js:138-142` correctly drives the disconnected view. All transitions (`DISCONNECT`, `RECONNECT`, `FORGET_CONFIG`, `RETRY_AUTO_CONNECT`) are consistent.

2. **Server-side hello protocol is cleanly gated.** The server's `setConnection` is only called after a successful `hello`, so the bridge never routes commands to an unregistered WS — this means the extension doesn't *strictly* need to gate command processing client-side (though I2 suggests it should defensively).

3. **`identify_required` UI is clean.** The picker is consistent with the rest of the popup's visual language, the "I am this profile" affordance is clear, and the storage contract (`webpilot.profileId` / `webpilot.knownProfiles` keys with explicit namespace) is good.

4. **`clearConnection` accepts both `profileId` and `ws`.** The server-side bridge's polymorphic clear is a nice ergonomic touch for `ws.on('close')`.

5. **Backwards-compat alias `isConnected()` preserved.** Means callers that don't care about which profile is connected still work without churn.

6. **Pairing removal was thorough.** All `PAIRING_RESPONSE`, `REVOKE_KEY`, `RENAME_AGENT`, `GET_PAIRED_AGENTS`, `GET_PENDING_PAIRING`, `SET_NETWORK_MODE` handlers are gone from `background.js`. CSS for pairing-request-card / paired-agent-item / rename-btn / approve-btn / deny-btn etc. is also removed (~170 lines of dead CSS). Good cleanup discipline.

7. **`fail-closed` whitelist semantics survived the rewrite.** `checkWhitelist` at `background.js:686-715` still throws explanatory errors that mention "the human must manually add this site." This is unchanged and good.
