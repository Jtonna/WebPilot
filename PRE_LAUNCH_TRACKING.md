# Pre-Launch Tracking

Slim record of what shipped on `QOL-Features` and what is still pending
before v1 of this branch lands. The branch's git history is the durable
record; this file just answers "what's left."

Last triage: 2026-05-16.

---

## Completed on this branch

This branch shipped ~70 changes across server, web UI, extension, notifications, and tooling. See `git log main..HEAD --no-merges --oneline` for the full set, and `docs/` for the resulting architecture.

---

## Open

### P0 — required before pushing / opening PR

- **Live extension end-to-end smoke test on Windows.** Load the unpacked extension into Default + Profile 2; exercise full pairing flow, `browser_create_tab` flow, and restart-on-flag-missing flow. Only validatable live.
- **Misattributed commit `87dd359`.** Has A3's "scaffold web UI" message but contains A2's pairing code. Cosmetic only. Decision: leave + note in PR description, or rewrite via filter-branch.

### P1 — should-fix before launch

- **macOS detector / launcher / closer / notifications.** Scaffolded honestly per spec, never tested on real macOS hardware. Will surface real issues on first non-Windows user.
- **Linux detector / launcher / closer / notifications.** Same as above for Linux.
- **`pending-pairings.json` history pruning.** 24 h expiry exists for pending entries; denied/approved/expired entries accumulate forever. `cleanupOldPairings(maxAgeDays)` is in the spec but not yet implemented (`paired-keys.js`). (Server review I6.)
- **Web UI `/pairings` history is mount-scoped.** Built from event-stream messages, lost on refresh *and* on navigation away. `listAllPairings()` exists server-side; needs a `GET /api/ui/pairings/history` route + UI fetch. (Web UI review I8.)
- **`webpilot_reload_formatters` MCP tool is exempt from auth.** A network-mode-enabled non-paired client can hit `/sse` and reload arbitrary formatter files. Require auth or restrict to localhost. (Server review I16.)
- **Auth comparison uses `===`, not `crypto.timingSafeEqual`.** `server.js` UI middleware + WS handshake + extension WS auth all use short-circuit string equality on the shared `apiKey`. Localhost today; LAN-exposed once network mode is on. (Server review C4.)
- **Single shared `apiKey` reused for extension transport + UI admin.** Compromise of one = compromise of both. At minimum restrict mutating UI endpoints (`/api/ui/agents/*`, `/api/ui/settings/network-mode`, `/api/ui/profiles`) to localhost regardless of header. (Server review C3.)

### P2 — nice to have

- **`ChromeManager.ensureReady` running+hasFlag path skips per-profile WS check** that the spec calls for. Currently compensated by an `isConnected` throw in `mcp-handler.js`, but UX intent is a relaunch, not an error. (Server review I2.)
- **`ChromeManager.refresh()` picks `ours[0]` arbitrarily** when multiple browser-parents match the user-data-dir. Should prefer `hasFlag === true` or warn on mixed sets. (Server review I1.)
- **`getActiveProfiles` falls back to nothing when no profile has recent writes.** Idle browsers (single read-only tab > 30 s) lose their other open profiles on relaunch. Consider widening the activity window or falling back to live `--profile-directory` args. (Server review I3.)
- **`chrome/launcher.js` async spawn `'error'` event** fires too late — `child.pid` may be `undefined` while caller assumes success. Wrap launch as a Promise that rejects on the `error` event. (Server review I5.)
- **`requestPairing` not idempotent on `denied`** — creates new pending entry alongside the denied row; `listAllPairings` then shows duplicate agent rows in history. Document or dedupe. (Server review I7.)
- **`resolveTargetProfile` reads `server.json` from disk on every MCP tool call.** Cheap but unnecessary on the hot path. Cache + invalidate. (Server review I9.)
- **`waitForExtensionConnection` polls every 250 ms** with no jitter; bridge already knows when connection lands. Event-driven wait is cleaner. (Server review I10.)
- **`mountWebUiStatic` registers an explicit `GET /ui` after `express.static`** — the explicit handler is dead code. Drop the fallback. (Server review I14.)
- **pkg-mode resolution of `server-web-ui/out`** has not been smoke-tested end-to-end against the built `.exe`. (Server review I15.) (verify)
- **`uiAuth` and WS auth share the apiKey variable; timing-attack-shaped comparison.** Tracked under P1 above for the policy half; the constant-time fix is a self-contained P2 patch.
- **`cleanupPidAndPortFiles` runs on `process.exit`** including the network-mode-restart spawn path; child writes pid then parent unlinks it, breaking later `service status`. Skip cleanup on the restart path. (Server review I20.)
- **`extension-bridge.isConnected()` polymorphic on arg presence.** Split into `isAnyConnected()` and `isConnectedForProfile(profileId)`. (Server review I21.)
- **Hardcoded `'1.0.0'` version in `mcp-handler.js:536` initialize response.** Read from package.json at startup. (Server review S1.)
- **`chrome/logger.js` and `notifications/logger.js` duplicate the same formatter.** Promote to a shared `make-logger.js`. (Server review S2.)
- **Magic numbers in extension-bridge / chrome manager / closer / server timeouts.** Name as constants. (Server review S3–S5.)
- **Per-row keyboard a11y on agent list.** `<span onClick>` for rename is not keyboard-accessible — needs `<button>` semantics. (Web UI review I14.)
- **`formatDate` non-date fallback.** Falls through to `String(value)` for non-falsy non-date inputs. (Web UI review I13.)
- **Five independent WS connections (one per page).** Each `app/*/page.js` mounts its own `UiEventsClient`. Singleton or context. (Web UI review I1.)
- **No "live updates disconnected" indicator + no polling fallback.** If `/api/ui/events` never connects (auth failure, dev-mode port, restart), UI is silently stale. (Web UI review I3.)
- **Race between REST `refresh()` and WS-event `refresh()`.** Stale-response bug — use request-id ref or `AbortController`. (Web UI review I5.)
- **Settings page conflates error + info state.** "Server is restarting" message lives in the `error` slot. Separate `info`/`notice`. (Web UI review I7.)
- **Network-mode toggle is optimistic + no settle-confirm.** UI flips to new value before server confirms restart took. (Web UI review I9.)
- **`apiFetch` doesn't pass `X-API-Key`.** Blocks non-localhost UI usage with auth. Add `setApiKey()`. (Web UI review I10.)
- **`PairingPromptCard.selectedProfile` doesn't refresh when `profileOptions` changes** — classic derived-state-in-state. (Web UI review I11.)
- **"Default" fallback masks empty-profiles case** in `pairings/page.js`. Render a warning + disable dropdown instead. (Web UI review I12.)
- **Inline `<span onClick>` rename is not keyboard-accessible** (also in I14 above). (Web UI review I14.)
- **Profile-create input lacks Enter-to-submit.** Wrap in `<form onSubmit>`. (Web UI review I15.)
- **WebSocket `error` event log prints `undefined`** — `Event` objects don't carry `.message`. (Web UI review I16.)
- **Stub `console.log` paths still in shipped components** (`AgentRow`, `PairingPromptCard`). Treat missing handler as programmer error, drop stubs. (Web UI review I2.)
- **Extension `manuallyDisconnected` is persisted, but `connectionStatus`/`connectionError`/`pendingCommands` are not.** Worker termination loses them. (Extension review I1.)
- **Extension `set_pairing_required` was removed (✅), but related cleanup remains:** the `auth_failed` and `FORGET_CONFIG` paths still don't clear `webpilot.profileId` / `webpilot.knownProfiles`. (Extension review C2.)
- **Extension `chrome.identity.getProfileUserInfo` "user denied" path** has no re-prompt UX. Need a "Change profile" affordance in connected view. (Extension review C3 — partially shipped via `57d7f1a` change-profile UI; verify the auth-failed reset path is also covered.) (verify)
- **Extension formatter-update temp-handler replaces `wsConnection.onmessage`** — drops in-flight `store_refs` / `identify_required` / `hello_ack` / `paired_agents_list` / commands during the window. Pre-existing but now worse with multi-extension. (Extension review C4.)
- **Hello-ack not enforced as a gate on command processing client-side.** Server gates correctly; extension should defensively reject `handleServerCommand` until `hello_ack` arrives. (Extension review I2.)
- **`set_pairing_required` was sent in `onopen` before hello and dropped** — fixed by removal (`595df13`). Confirm no remaining pre-hello sends. (verify)
- **`handleServerCommand` default branch responds with `Unknown command type` for every unknown server message** — pollutes server's pending-commands map for messages without `id`. (Extension review I4.)
- **`paired_agents_list` cached in storage with no reader.** Dead write. Either commit to a contract or delete. (Extension review I5.)
- **Connected status shown before `hello_ack`** — popup says green when server hasn't yet registered the profile. (Extension review I11.)
- **`identity.email` permission triggers install-time warning** for an opportunistic-only path. Consider dropping. (Extension review I10.)
- **Empty `knownProfiles` deadlocks the profile picker.** No "empty state" fallback. (Extension review I8.)

### P3 — backlog (would not block v1 push)

- **Web UI auth model for LAN deployments.** Currently localhost-only. If LAN access is needed, design a proper session/cookie auth flow.
- **Click-to-open from macOS / Linux notifications.** Windows shipped `activationType=protocol`; the other two need helper apps.
- **Bundle the server into the Electron app.** Currently a separate pkg binary the Electron app spawns.
- **Auto-installing the extension into new profiles.** Chrome forbids it for unsigned extensions; improve the manual-load instructions in the sandbox-profile flow.
- **Cross user-data-dir Chrome management.** Current model assumes the default user-data-dir.
- **No tests for `paired-keys` async-pairing flow.** Integration test for `requestPairing` idempotency would prevent state-machine regressions. (Server review I-summary + Test coverage gaps.)
- **No tests on the web UI package** — `package.json` has no `test` script.
- **`apiFetch` swallows JSON parse error** — `.catch(() => null)`. Log at minimum. (Web UI review S3.)
- **`<a href="/ui/...">` in nav causes full page reload.** Next.js `<Link>` would preserve WS if singleton client is adopted. (Web UI review S5.)
- **Agent-row `title={agent.key}` exposes full key on hover.** Shoulder-surfing risk. Use a prefix instead. (Web UI review S7.)
- **`StatusCard` dot has no `aria-label`** — color-only indicator. (Web UI review S8.)
- **Dead CSS (`Pairing & Agents Sections`, `.tab-btn.has-badge`, `.action-btn`) in extension popup.** (Extension review S1–S3.)
- **Inline styles in `popup.html` for the profile picker** — extract to classes. (Extension review S4.)
- **`gaiaEmail` is logged in cleartext** in `sendHelloHandshake`. Redact or downgrade to debug. (Extension review S10.)
- **Documentation audit pass found `docs/CHROME_EXTENSION.md` drifted; the doc commits address it but a re-read after the trim of this file is wise.** (verify)

---

## Deferred / out of scope (intentional non-goals for v1)

- Per-agent profile binding at MCP-tool-routing level beyond v1's "one agent → one profile" model — *partially shipped* via `64e7290`; full multi-binding is post-v1.
- Bundling Electron app to host the web UI — see P3.
- Cross-user-data-dir Chrome management for non-standard installations.
- Auto-installing the extension into new profiles (Chrome forbids it).
- Click-to-open from macOS / Linux notifications (Windows only in v1).
