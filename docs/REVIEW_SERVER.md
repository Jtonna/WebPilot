# Server-side code review — QOL Features

Scope: `packages/server-for-chrome-extension/src/chrome/`, `src/notifications/`, `src/paired-keys.js`, `src/mcp-handler.js`, `src/server.js`, `src/extension-bridge.js`, `package.json`. Reference: `docs/TEMP_QOL_FEATURES_PLAN.md`.

## Severity legend
- Critical: bug, security issue, or broken behavior
- Important: smell, missing error handling, unclear contract, potential bug
- Suggestion: clean-code improvement, naming, structure, comment

---

## Findings

### Critical

#### C1. `POST /api/ui/profiles` does not validate / sanitize the profile name — passes user input straight into a Chrome CLI arg

`server.js:169-193` accepts `req.body.name`, trims it, and passes it directly to `launchChromeProfile({ profileDirectory: name })`. The launcher (`chrome/launcher.js:57`) builds the arg as `'--profile-directory=' + profileDirectory`. Because spawn is invoked without a shell, classic shell injection isn't possible, but:

- A name like `"x --remote-debugging-port=9222"` is parsed by Chrome's command-line parser as additional flags (Node's `spawn` passes argv tokens but `child_process.spawn` on Windows joins to a string for non-shell exes via `cmd /c` semantics depending on which underlying API is used — `windowsVerbatimArguments` is not set here, so Node will quote/escape, but Chrome's own parser still splits the value if it contains `"` and an additional `--flag`).
- Path-traversal characters (`..`, `\`, `/`, `:`) let the user create directories anywhere under `userDataDir` — `<UDD>\..\..\anywhere`.
- Reserved Windows names (`CON`, `PRN`, `NUL`, `AUX`, `COM1`-`COM9`, `LPT1`-`LPT9`) and names with `<>:"|?*` will create filesystem mayhem.
- Empty/whitespace name passes the `if (!name)` check via the trim, but names like `.` or `..` get through.

Fix: enforce a strict allowlist regex (e.g. `^[A-Za-z0-9 _-]{1,40}$`), reject reserved Windows names, and 400 on violation.

Spec section 4.4 calls out this endpoint and section 4.4's auth note says "configurable: localhost-only by default if you want stricter security" — input validation is independent of auth and is missing.

---

#### C2. `approvePairing` ignores `profileId` posted by the web UI — silently lost

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

#### C3. WS upgrade for `/api/ui/events` accepts the **extension API key** as the UI key (key reuse)

`server.js:264-300` shares the same `apiKey` variable for both the extension WebSocket auth (`url.searchParams.get('apiKey') !== apiKey`, line 290-291) and the UI WebSocket auth (`clientApiKey === apiKey`, line 276). The `makeUiAuth` HTTP middleware also uses the same key (line 109).

The task brief asks: "is that compared to the right key store?" The answer is: there is no separate UI key store; the server's single `apiKey` (the WS-handshake key for extensions, persisted in `<dataDir>/config/server.json`) is reused as the UI master key. Compromise of one credential equals compromise of both. The spec doesn't explicitly require separation, but mixing the long-lived extension transport key with the user-facing UI admin key is a meaningful security smell — anyone with the apiKey (e.g. anyone who read the extension popup's `Connect` flow output, or scanned `server.json`) can drive `/api/ui/agents/:key/rename`, revoke, force a network-mode restart, or launch arbitrary Chrome profiles.

Fix: mint a separate per-UI session/admin key, or — at minimum — restrict the mutating UI endpoints (`/api/ui/agents/*`, `/api/ui/settings/network-mode`, `/api/ui/profiles`) to localhost only, regardless of header.

---

#### C4. `uiAuth` middleware comparison is timing-attack-shaped and uses `===` on a possibly-undefined header

`server.js:104-114`: `headerKey === apiKey`. If a request omits `X-API-Key`, `headerKey` is `undefined`, which compares cleanly. But if an attacker spams guesses, the string `===` is short-circuit and timing-leaky. The same pattern repeats at `server.js:276` for the WS handshake.

Important rather than critical because all current deployments are localhost. Promoted toward critical because the spec ships a network-mode toggle that exposes this to LAN. Fix: `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` with length pre-check.

---

#### C5. `setNetworkMode` restart path writes `network.enabled` twice and races with old `set_network_mode` WS handler

The legacy extension popup handler still lives at `server.js:438-460` (`set_network_mode` over the extension WS) and does an *in-process* `server.close()`/`server.listen()` rebind. The new UI handler at `server.js:549-572` writes the same `network.enabled` file and then **spawns a detached copy of the daemon and exits**.

Problems:

1. Both code paths write `network.enabled`. The web UI handler also persists in `mountWebUiRoutes` (`server.js:552`), but `server.js:443-448` does its own write. If the extension still sends `set_network_mode` (B5 only removed the UI toggle — see `b288ef7`; the message handler is still alive) the file gets stomped without the spawn.
2. `args = process.argv.slice(1)` (line 560) drops `argv[0]` (the node interpreter / pkg binary path), but then re-spawns `process.execPath` with those args. In dev mode where `process.execPath` is `node` and `argv[0]` is `node` and `argv[1]` is `index.js`, this works. In pkg mode `argv[0]` is the pkg .exe and `argv[1]` may be undefined or a real arg; passing `[]` or just `['--foreground']` to the same exe is fine, but if the user launched with a custom flag like `--network`, that flag is preserved correctly. However: `WEBPILOT_FOREGROUND=1` is forced into the env — overriding whatever lifecycle mode the spawned daemon is in. The MEMORY note on the pkg self-spawn bug says env-var is the workaround for `--foreground`. This collision is by design but should be commented; right now it looks accidental.
3. The 500 ms `setTimeout` before `process.exit(0)` is fragile — if the spawn fails (caught silently at line 564-566), the daemon exits anyway, leaving the user with no server. The fix would be to verify the child is alive before exiting (or at least not exit on spawn failure).
4. Spec section 4.6 specifies "the parent daemon supervisor (or absent that, the user-facing exit + auto-relaunch via the Run-key auto-start) brings it back". The Run-key relies on user login — if the daemon exits at runtime without spawn succeeding, the user has to log out/in.

Fix: tear out the extension's `set_network_mode` handler entirely (the popup UI for it was removed in B5) so the two paths can't diverge; check spawn success before `process.exit`.

---

### Important

#### I1. `ChromeManager.refresh()` arbitrarily picks `ours[0]` when multiple browser-parents match

`chrome/manager.js:101` takes `ours[0]` after filtering. If two Chrome browser-parents share a user-data-dir (unusual but possible — e.g. one started fresh after a crash before the old one fully exited), the cache only records the first PID's hasFlag. If `ours[0]` has the flag but `ours[1]` does not (or vice-versa), `ensureReady` may take the wrong action. Log all matches and pick by `hasFlag === true` first (or warn if the set is mixed).

#### I2. `ensureReady`'s "running + hasFlag" case skips the spec's per-profile WS check

`chrome/manager.js:202-211`: spec section 4.1 explicitly says step 2 should also check "all requiredProfiles already have an active extension WebSocket". The code returns `noop` if the flag is present, even if the required profile's WS isn't connected. This is partially compensated by `mcp-handler.js:841-845` doing a separate `extensionBridge.isConnected(targetProfile)` check, but that throws rather than triggering a relaunch — which is the spec's intended UX. The comment at `manager.js:202` explicitly notes "Wave 2 will add per-profile WS check" — but Wave 2 is in. Either complete the integration or update the spec to acknowledge the gap.

#### I3. `ensureReady` reuses `activeBefore` of the now-killed Chrome — relies on filesystem mtime that was already going stale

`chrome/manager.js:215-217` calls `getActiveProfiles()` *after* `getStatus()` and *before* `closeAll()`. `getActiveProfiles` checks mtime within `activityWindowSeconds` (default 30s). Between detection of "running without flag" and the close-all, there's no race. But if the user has Chrome paused, suspended, or with no recent writes (e.g. only a single read-only tab idle for 30s+), no profiles will be detected as active and only the `requiredProfiles` get relaunched — losing the user's other open profiles. Consider falling back to `knownProfiles` ∩ `current --profile-directory` from the live browser-parent command line, or widening the activity window when zero profiles look active.

#### I4. `getActiveProfiles` uses `fs.statSync` synchronously per-file inside an async-named method

`chrome/manager.js:132-138` is `async getActiveProfiles()` but the underlying `chrome/profile-activity.js:53-74` uses `fs.statSync` and `fs.existsSync` synchronously in a loop. With ~20 profiles × 10 hot files this is fine; flagging only because the async signature suggests otherwise. Either convert to `fs.promises.stat` or drop the `async`.

#### I5. `chrome/launcher.js:67-71` — spawn errors caught two ways, child PID may be `undefined`

If `spawn` synchronously throws (rare; e.g. ENOENT on certain platforms), the try/catch at lines 66-75 re-throws. But spawn's async ENOENT fires on the `error` event handler (line 80-82), which just logs and is too late — the function has already returned `{ pid: child.pid, ... }` with `child.pid` set to `undefined` (or 0). Callers like `ChromeManager._launchProfiles` then push `{ profileDirectory: p, pid: undefined }` and proceed as if launch succeeded.

Fix: wrap launch as a Promise that resolves on `spawn` success or rejects on the `error` event, with a short timeout. Or at minimum check `child.pid` and throw if falsy.

#### I6. Pending-pairings file has no cleanup — grows unboundedly

`paired-keys.js:198-202` `savePendingPairings()` writes the full array; `denyPairing` and `approvePairing` keep entries forever (status changes but the entry stays). Spec section 4.2 explicitly lists `cleanupOldPairings(maxAgeDays)` as part of the contract. It's not implemented. Over months a malicious actor (or a buggy MCP client) repeatedly calling `request_pairing` with random agent names grows the file linearly. Also: a denied entry blocks future `request_pairing` calls for that agent_name (see I7) — without cleanup, denial is permanent.

#### I7. `requestPairing` is idempotent on `pending|approved` but NOT on `denied` — and there's no way to un-deny

`paired-keys.js:215-217` finds existing entries with `status === 'pending' || status === 'approved'`. A `denied` entry slips through and a fresh pending entry is created with a new `pairingId`. This is correct UX for the agent (denial isn't permanent), BUT: the array now has both a `denied` and a new `pending` entry for the same agentName. `listPendingPairings` (line 337-339) shows only the new pending one, so the UI is fine, but `listAllPairings` returns both, and history pages will see duplicate agent rows. Document or dedupe.

#### I8. `approvePairing` returns the entry on the `denied` branch (line 292) but caller treats it as success

`paired-keys.js:288-293`: if status is `denied`, we log and `return entry` — the entry has status `denied`, so the caller (`server.js:148`) treats it as if approval succeeded and responds 200. Should return `null` (or a separate error sentinel) so the route can 409.

#### I9. `mcp-handler.js`'s `resolveTargetProfile` is called per tool call and reads + parses `server.json` from disk every time

`mcp-handler.js:56-66`. Cheap but unnecessary I/O on a hot path. Cache the result inside the closure with an invalidation hook (or read once at factory time). Spec section 4.3 talks about routing — this routing is the single profile name from config, so caching is safe until the user edits `server.json`.

#### I10. `mcp-handler.js`'s `waitForExtensionConnection` polls every 250 ms with no jitter or backoff

`mcp-handler.js:76-93`. Adequate for 10 s, but pure polling. The bridge already knows when a connection lands (it emits via `setConnection`). Wiring an event emitter on `ExtensionBridge` would make this deterministic. Not a bug — but as the spec says "wait for the extension WebSocket(s) to connect (with timeout)", an event-driven wait is the better implementation.

#### I11. `handleToolCall` for `browser_create_tab` falls through to the `switch` block but case is a no-op (`commandType = 'create_tab'`)

`mcp-handler.js:814-851` handles `browser_create_tab` and `return`s. `mcp-handler.js:862-867` has `case 'browser_create_tab': /* handled above */ commandType = 'create_tab'; commandParams = ...`. The case is dead code (kept for the comment, presumably) and is misleading — anyone reading the switch could think `browser_create_tab` reaches the bottom-of-function `sendCommand`. Delete it.

#### I12. `extension-bridge.clearConnection(ws)` rejects pending commands when no profile was identified, but the message reads "Extension disconnected" for ALL pending commands

`extension-bridge.js:72-79`: the loop is `for (const [id, pending] of pendingCommands)` and rejects when `!removedProfileId || pending.profileId === removedProfileId`. The `!removedProfileId` branch rejects *every* pending command across *every* connection just because one anonymous connection closed. That's a bug if multiple profiles are connected and one of them never finished its hello before disconnecting. Fix: skip rejection when `removedProfileId` is null.

#### I13. WS upgrade routes `/api/ui/events` to `uiWss` but the UI client probably needs the query param `apiKey` even when on localhost

`server.js:272-287`: the WS upgrade allows local OR `apiKey` query. The Next.js client (`packages/server-web-ui/lib/ws.js` per the scaffold commit) connects with `?apiKey=...`. Need to verify the UI knows the API key without first calling an authenticated endpoint — there's a chicken-and-egg risk where the UI bootstraps over localhost (no header) but the WS code path then expects an apiKey query string. Mark this as a question for the UI reviewer; the server-side `isLocal` short-circuit at line 277 means localhost UI works without the key, which is correct.

#### I14. `mountWebUiStatic` 'fallback' route is registered AFTER `express.static` and conflicts

`server.js:90-98`: `app.use('/ui', express.static(dir, { extensions: ['html'] }))` registers a catch-all on `/ui` first; then `app.get('/ui', ...)` registers an explicit `GET /ui` handler. Order matters in Express — the explicit handler at line 92 will never fire because `express.static` already served `index.html` for the bare `/ui` path. Either the comment is misleading or the fallback is dead code. The Next.js static-export `out/` layout uses trailing-slash subdirs and a top-level `index.html`, so `express.static({ extensions: ['html'] })` should handle the bare `/ui` correctly. Drop the dead fallback.

#### I15. `resolveWebUiDir` only tries two candidates; pkg snapshot path is path.join('..','..','server-web-ui','out') from `__dirname`, but `__dirname` in the snapshot is `/snapshot/packages/server-for-chrome-extension/src` — verify the resolved candidate path

`server.js:53-78`. The comment claims candidate `[0]` is correct in pkg mode. From `__dirname = /snapshot/packages/server-for-chrome-extension/src`, going `..,..` lands at `/snapshot/packages/`, then `server-web-ui/out`. The pkg asset glob `"../server-web-ui/out/**/*"` is relative to the package directory (`packages/server-for-chrome-extension/`), so pkg writes the assets to `/snapshot/packages/server-web-ui/out/`. The candidate path is correct only if pkg's snapshot uses `/snapshot/packages/...` as its layout. **Question for verification**: pkg actually places assets relative to where the source-file claims them, which means `path.join(__dirname, '..', '..', 'server-web-ui', 'out')` will work. This needs a smoke test against the built `.exe` — please confirm via the manual checklist before claiming v1 done.

#### I16. `mcp-handler.js`'s `webpilot_reload_formatters` is exempt from auth (line 538)

This wasn't added in QOL but it's worth flagging: a network-mode-enabled, non-paired client can hit `/sse` and call `webpilot_reload_formatters` to reload arbitrary formatter files on disk. The custom-formatters dir is local, but if combined with another flaw allowing file write, this turns into RCE. Lower the surface by requiring auth, or at least localhost-only for this tool.

#### I17. The `request_pairing` `created && status === 'pending'` notification fires only on FIRST request — but the notification is the user's only signal

`mcp-handler.js:632`: the toast only fires on `result.created === true`. If the agent calls `request_pairing` twice and the user dismissed the first toast, they're stuck with no signal. Consider firing on every "pending" return (with a short de-dupe window), or also firing on `check_pairing_status` if the user has waited too long.

#### I18. `mcp-handler.js:629-650` — `notify()` rejection swallowed silently, never propagates

The `.catch` at 642-644 logs but doesn't reach the agent. The `try/catch` at 633/645 catches the `require()` failure but not async errors. Both behaviors are intentional ("Never throws — failures are logged and swallowed" per notifications/index.js:13), but the agent receives a "pending — system notification sent" message even when the notification silently failed. Either change wording to "a system notification has been attempted" or add a stdout-visible warning back to the response when known-failed.

#### I19. `pairings/page.js` shows `__new__` option but server has no `/api/ui/profiles/new-and-approve` endpoint; user picks it, server silently approves to nothing

See C2 — combined with the silent-drop, the `__new__` UX is doubly broken. Either remove the option until the server supports it, or have the server 400 on `profileId === null`.

#### I20. `cleanupPidAndPortFiles` ran on `process.exit` event but the network-mode setImmediate-spawn-then-exit (server.js:567-570) has a 500ms sleep — pid/port may briefly mismatch the new daemon

Race: spawned child writes its own pid file (it will, via `writePidAndPortFiles` at startup); the parent's `process.on('exit', cleanupPidAndPortFiles)` then unlinks them. Order of operations: parent spawns child → setTimeout 500ms → cleanup → exit. If the child started fast (<500ms), the child wrote its pid, then the parent unlinks it. Net result: server.pid/server.port are deleted right after a successful restart, breaking any later `service status` check. Fix: do not run `cleanupPidAndPortFiles` on the restart path — only on graceful shutdown.

#### I21. `extension-bridge.js`'s "Backwards-compatible" comment says `isConnected()` is an alias for `isAnyConnected()` — but the no-arg call in callers is unclear

Lines 86-92: the function silently bifurcates based on argument presence. This is the kind of "magic" interface that bites later. Prefer two named methods (`isAnyConnected()` and `isConnectedForProfile(profileId)`) and have legacy callers explicitly pick one.

---

### Suggestion

#### S1. Hardcoded version string `'0.5.4'` in `mcp-handler.js:502` will drift on every release

The version-bump script likely updates this (per memory notes), but it's a single source of truth violation. Read from package.json once at startup.

#### S2. `chrome/logger.js` and `notifications/logger.js` are identical except for prefix string

Both modules implement an identical `formatExtra` + `log/error` pair. Promote to a shared `make-logger.js` factory; saves 40 LOC and prevents drift.

#### S3. Magic number `30000` for command timeout in `extension-bridge.js:19`

Name it `EXTENSION_COMMAND_TIMEOUT_MS = 30000` for grep-ability.

#### S4. Magic number `30` for activity window in `chrome/manager.js:26` and `chrome/profile-activity.js:32`

Define as `DEFAULT_ACTIVITY_WINDOW_SECONDS` once; spec section 2.5 documents the empirical basis (13 file-writes per 60s for active profile) — comment that constant accordingly.

#### S5. Magic number `5000` for hello deadline in `server.js:339`, `10000` for extension reconnect in `mcp-handler.js:831`, `20000` for close timeout in `chrome/closer.js:24`

Many tuned-by-magic timeouts. Constants at top of file.

#### S6. `chrome/profile-activity.js` `HOT_FILES` list is correct but undocumented why each is there

Add a one-line comment per entry pointing to spec section 2.5 / what is written to it.

#### S7. `windows-detector.js`'s embedded PS script is built as a JS array joined by `' '` (line 47-57)

Hard to debug. Prefer a heredoc-style multiline template string — at least the script is greppable. Same applies to `closer.js`'s WM_CLOSE script, but that one already uses backticks.

#### S8. `paired-keys.js` mixes `[pairing]` log prefix with file-scoped `console.log` — vs. the rest of the QOL code that uses `[component:area]`

The QOL spec calls for `[component:area]` prefixes (e.g. `[chrome:manager]`, `[notify:windows]`). `paired-keys.js` uses bare `[pairing]` and `[auth]`. Consider `[pairing:requestPairing]` etc., or accept this as the legacy module's existing convention.

#### S9. `server.js` line 117 destructures `pairedKeys` from `deps` shadowing the module-level import

```js
function mountWebUiRoutes(app, deps) {
  const { apiKey, chromeManager, extensionBridge, pairedKeys, setNetworkMode } = deps;
```

The parameter `pairedKeys` shadows `require('./paired-keys')`. Functionally OK because they're the same value, but linters will warn and a reader has to verify. Rename to `pairedKeysDep` or drop from destructure.

#### S10. `server.js:170-193` — error handling 500s on every failure including expected ones (e.g. Chrome not installed)

`launchChromeProfile` throws if `chromePath` doesn't resolve. The 500 response then says `e.message`. Differentiate "user error" (400) from "server error" (500).

#### S11. `chrome/manager.js:230` non-ASCII unicode `∪` in a log message

`'chrome was running without flag; restarted with active ∪ required profiles'` — fine on UTF-8 stdout but won't survive on `cp850` Windows consoles. Use `union of`.

#### S12. `chrome/closer.js`'s WM_CLOSE PowerShell script doesn't escape PID list

Line 64 builds `$pids = @(${pidList})` from `pids.map(Number).filter(...)`. The filter ensures only finite numbers reach the array, so injection is impossible. Mark with a comment so future modifications don't drop the filter accidentally.

#### S13. `notifications/windows.js` includes the URL inline in the toast body via `body + '\n' + url`

`\n` in a toast `<text>` element doesn't render as a newline; it renders as a space (or is collapsed). Either insert a second `<text>` element or use spec-compliant attribution. Cosmetic.

#### S14. `linux-detector.js` matches `comm` with `comm.startsWith('chrome')`

Will match `chrome_crashpad_h` and other Chrome helpers that are NOT browser-parents. The `isBrowserParent(args)` filter saves the day, but the over-matching wastes work. Tighten the comm filter.

#### S15. `server.js:235` constructor uses object destructuring with explicit defaults inline — long signature

Cosmetic: extract a `DEFAULT_HOST = '127.0.0.1'` constant.

#### S16. `notifications/index.js` re-`require`s the platform impl on every call

Could be top-level. Lazy-require is justified only if there's a CI/test scenario where the impl isn't bundled — pkg's asset glob covers `src/**/*.js` so all three notif impls are in the bundle. Switch to eager require for clarity.

#### S17. `chrome/index.js` re-exports both `ChromeManager` (class) and `createChromeManager` (factory) — pick one

The factory pattern is used everywhere else in the QOL code (`createExtensionBridge`, `createMcpHandler`). Drop the class export from the public API; keep it internal.

#### S18. `paired-keys.js:188` log starts with `[pairing]` but the listener-throw log uses backticks and a different format

```js
console.log(`[pairing] listener for "${event}" threw: ${e.message}`);
```
vs.
```js
console.log(`[pairing] Failed to load pending-pairings.json: ${e.message}`);
```
Inconsistent capitalization within the same file.

---

## Cross-cutting observations

1. **Auth surface fragmentation.** Four different auth checks exist: extension-WS handshake (`server.js:290-294`), UI HTTP middleware (`server.js:104-114`), UI WebSocket (`server.js:272-282`), and MCP tool gate (`mcp-handler.js:539-551`). All four share the same `apiKey`. The MCP gate is the only one that can be bypassed via `isPairingRequired() === false`. Centralize the policy: a single `authPolicy({ source, target, key, remote })` function would prevent the next reviewer from missing a check site.

2. **Silent error swallow vs. user-facing error.** `notifications/*` document "never throws — failures are logged and swallowed" and live up to that. `chrome/launcher.js` partially swallows (the async `'error'` event handler just logs). `chrome/manager.js` `ensureReady` returns `{ action: 'abort' }` on close failure rather than throwing. `mcp-handler.js`'s `browser_create_tab` translates `ensureReady` throw into a useful error message but does NOT check for the `action: 'abort'` return, so an abort silently becomes "no extension connected" downstream. Wire the abort case to throw an explanatory error before the WS-connect wait.

3. **`[component:area]` logging convention is followed in the new modules** (`chrome/*`, `notifications/*`) but the older `paired-keys.js` and `server.js` mix `[pairing]`, `[auth]`, `[ui-api]`, `[ui-ws]`, `[network]`, `[config]`, `[extension-bridge]`, `[mcp-handler]`. Most have the `[area]` form rather than `[component:area]`. The spec doesn't strictly require `:area` everywhere but the consistency drift is jarring.

4. **No use of `async/await` inside `setImmediate(() => setNetworkMode(...))`** — the route handler returns 200 before the spawn happens. If spawn fails the user gets no signal. Either await + then respond, or push an event over `broadcastUiEvent` when restart succeeds.

5. **Pkg-mode path resolution is fragile.** Both `resolveWebUiDir` (`server.js:53`) and `getDataDir` (`service/paths.js:33`) hard-code relative path traversals based on assumed install layout. A test that runs the built binary and exercises `GET /ui` and `GET /api/ui/status` would catch all these.

6. **The Chrome detector for macOS uses `pgrep -x 'Google Chrome'`** — pgrep on macOS does not match the full process name by default; users may have Chrome Beta, Canary, Chromium, etc. Spec scope says default Chrome only, so accept this, but log a TODO already present.

7. **No tests for the `paired-keys.js` async-pairing flow.** The state machine (pending → approved → key minted) is critical infrastructure now; even a unit test for `requestPairing` idempotency would prevent regression.

---

## Things that are well done

- **`chrome/` module separation by responsibility** — detector / closer / launcher / paths / manager — is exemplary. Easy to swap an impl, easy to test each in isolation.
- **Per-OS detector files are honest about scaffold quality.** `macos-detector.js:8` and `linux-detector.js:11` explicitly call themselves out as unverified. The TODO logs at runtime are the right move.
- **`chrome/closer.js`'s Win32 WM_CLOSE approach** correctly implements the spec section 2.6 "raw PostMessage to every visible HWND" — and the PS script logs every HWND it hits, which is exactly the kind of trace the spec asked for.
- **`requestPairing` idempotency** on pending+approved is well-implemented and correctly tested by the `created` flag returned to the caller. The notification-only-on-fresh-creation guard (`mcp-handler.js:632`) prevents toast spam.
- **Pairing events emitter** (`paired-keys.js:27-43`) is a clean way to decouple disk-state changes from WS broadcasts.
- **`chrome/manager.js` getStatus()'s fast-path** with PID liveness check is exactly the spec's requirement and is correctly cache-validated.
- **The `extension-bridge.js` per-profile WebSocket map** is appropriately defensive: it replaces stale connections, cleans up on close, rejects in-flight commands when their target disappears.

---

## Test coverage gaps

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

## Summary

- Critical: 5
- Important: 21
- Suggestion: 18

Top 3 most important:

1. **C1** — `POST /api/ui/profiles` accepts unvalidated profile names that pass straight into a Chrome CLI arg and a filesystem path. Must fix before exposing the UI on the network or making this anything other than localhost-trusted.

2. **C2** — The web UI's profile-selection on pairing approval is silently dropped by the server. The `__new__` sandbox-profile UX is non-functional. Either implement it or 4xx clearly.

3. **C3 + C4** — Single shared `apiKey` reused as the UI admin credential, with non-constant-time string comparison and trivial header-vs-localhost auth on a network-exposed mutating API. With the new network-mode toggle this becomes the largest attack surface in the project.
