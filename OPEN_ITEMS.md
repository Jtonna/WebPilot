# Open Items

Pending work on `QOL-Features` before v1 ships — triaged 2026-05-16.

---

## P0 — required before pushing / opening PR

- **Misattributed commit `87dd359`.** Has A3's "scaffold web UI" message but contains A2's pairing code. Cosmetic only. Decision: leave + note in PR description, or rewrite via filter-branch.

## P1 — should-fix before launch

- **Formatter errors should surface as Dashboard action items.** Today, errors land in `formatter-logs.js` and only show on `/ui/formatters/logs/?name=X`. The Dashboard "Action items" section only renders pending pairings. Wire unhealthy formatters into `getStatus()`'s action-items aggregate, add a WS broadcast on log update, and render formatter-error rows on the dashboard. Same treatment should cover workflow errors (already logged with `phase: 'workflow'` for filtering).
- ~~**`browser_click` returns `MCP error -32000: Command timeout` while the click actually succeeded.**~~ ✅ Fixed in `bb42e6e`. Root cause: when a click triggers SPA navigation, the CDP target is torn down mid-flight; subsequent `chrome.debugger.sendCommand` calls neither resolve nor reject and the `await` hangs forever, so the handler never returns and the server times out at 30 s. Fix: install `chrome.debugger.onDetach` listener at the start of `click()`, race the post-cursor-path CDP calls against the detach flag, and short-circuit returning `{ success: true, navigated: true, detachReason }` if detach wins. (Live-tested on Discord 2026-05-16; fix shipped same day. Verify on next live click that triggers SPA nav.)
- ~~**Discord formatter abstracts composer accessible name**~~ ✅ Fixed in `e09fa46` (formatter) + `e4d114f` (workflow matcher update). Composer now renders as `[eN] Message @<recipient> textbox` / `[eN] Message #<channel> textbox`. Workflow matcher updated to `name_starts_with: 'Message ' + role: 'textbox'` which handles both shapes. Live-verified end-to-end 2026-05-16: `webpilot_run_workflow(discord, send_message, ...)` lands the message in one tool call.
- **`send_message` workflow flattens multiline text.** Two-line input `"line 1\nline 2"` landed as a single line with the two phrases concatenated. Discord interprets `\n` in the composer as the send trigger (or `browser.type` with `pressEnter: true` is eating the embedded newline). For in-message line breaks Discord requires Shift+Enter. Workflow should either pre-process embedded `\n` into Shift+Enter key events or document the limitation. (Found during live retest 2026-05-16.)
- **`webpilot_run_workflow` returns `Command timeout` while the workflow's `browser.type` step also hits the same timeout class as the click handler.** Live server-channel retest on 2026-05-16 (StreamCheats Community / `#💬・public`): clicks recovered (they navigate but return the timeout error — same shape as the bb42e6e click bug), but the workflow itself timed out and the message never landed. Suggests the click-handler `onDetach` short-circuit (bb42e6e) isn't catching every CDP stall; workflows compound the problem because a single stalled inner step kills the entire workflow. Either (a) plumb the same `raceWithDetach` guard around every inner `chrome.debugger.sendCommand` call in click/type handlers, or (b) extend the workflow runner's timeout for multi-step workflows and return partial success state. Also worth investigating whether Discord's SPA stays on the same CDP target (in which case `onDetach` never fires and we need a different signal — e.g. `Page.frameNavigated`).
- **macOS detector / launcher / closer / notifications.** Scaffolded honestly per spec, never tested on real macOS hardware. Will surface real issues on first non-Windows user.
- **Linux detector / launcher / closer / notifications.** Same as above for Linux.
- **`pending-pairings.json` history pruning.** 24 h expiry exists for pending entries; denied/approved/expired entries accumulate forever. `cleanupOldPairings(maxAgeDays)` is in the spec but not yet implemented (`paired-keys.js`). (Server review I6.)
- **Web UI `/pairings` history is mount-scoped.** Built from event-stream messages, lost on refresh *and* on navigation away. `listAllPairings()` exists server-side; needs a `GET /api/ui/pairings/history` route + UI fetch. (Web UI review I8.)
- **`webpilot_reload_formatters` MCP tool is exempt from auth.** A network-mode-enabled non-paired client can hit `/sse` and reload arbitrary formatter files. Require auth or restrict to localhost. (Server review I16.)
- **Auth comparison uses `===`, not `crypto.timingSafeEqual`.** `server.js` UI middleware + WS handshake + extension WS auth all use short-circuit string equality on the shared `apiKey`. Localhost today; LAN-exposed once network mode is on. (Server review C4.)
- **Single shared `apiKey` reused for extension transport + UI admin.** Compromise of one = compromise of both. At minimum restrict mutating UI endpoints (`/api/ui/agents/*`, `/api/ui/settings/network-mode`, `/api/ui/profiles`) to localhost regardless of header. (Server review C3.)

## P2 — nice to have

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
- **Profile-create input lacks Enter-to-submit.** Wrap in `<form onSubmit>`. (Web UI review I15.)
- **WebSocket `error` event log prints `undefined`** — `Event` objects don't carry `.message`. (Web UI review I16.)
- **Stub `console.log` paths still in shipped components** (`AgentRow`, `PairingPromptCard`). Treat missing handler as programmer error, drop stubs. (Web UI review I2.)
- **Extension `manuallyDisconnected` is persisted, but `connectionStatus`/`connectionError`/`pendingCommands` are not.** Worker termination loses them. (Extension review I1.)
- **Extension `auth_failed` and `FORGET_CONFIG` paths still don't clear `webpilot.profileId` / `webpilot.knownProfiles`.** (Extension review C2.)
- **Extension `chrome.identity.getProfileUserInfo` "user denied" path** has no re-prompt UX. Need a "Change profile" affordance in connected view. (Extension review C3 — partially shipped via `57d7f1a`; verify the auth-failed reset path is also covered.) (verify)
- **Extension formatter-update temp-handler replaces `wsConnection.onmessage`** — drops in-flight `store_refs` / `identify_required` / `hello_ack` / `paired_agents_list` / commands during the window. Pre-existing but now worse with multi-extension. (Extension review C4.)
- **Hello-ack not enforced as a gate on command processing client-side.** Server gates correctly; extension should defensively reject `handleServerCommand` until `hello_ack` arrives. (Extension review I2.)
- **Confirm no remaining pre-hello sends in extension `onopen`** after `595df13`. (verify)
- **`handleServerCommand` default branch responds with `Unknown command type` for every unknown server message** — pollutes server's pending-commands map for messages without `id`. (Extension review I4.)
- **`paired_agents_list` cached in storage with no reader.** Dead write. Either commit to a contract or delete. (Extension review I5.)
- **Connected status shown before `hello_ack`** — popup says green when server hasn't yet registered the profile. (Extension review I11.)
- **`identity.email` permission triggers install-time warning** for an opportunistic-only path. Consider dropping. (Extension review I10.)
- **Empty `knownProfiles` deadlocks the profile picker.** No "empty state" fallback. (Extension review I8.)

## P3 — backlog (would not block v1 push)

- **No test coverage for the formatter-logs ring buffer.** `formatter-logs.js` has a `_resetForTests` seam and a deterministic public API (recordSuccess/recordError/getStatus/getLogs/listAll/flush) but no unit test asserting the health rule, ring eviction, 7-day TTL on hydrate, or stack truncation. Add a vitest/mocha spec under `packages/server-for-chrome-extension/test/`. (Overnight audit, this branch.)
- **No test coverage for the workflow execution engine.** `_validateWorkflowParams` + `handleToolCall`'s `webpilot_run_workflow` branch + `formatter-manager.loadWorkflowsForFormatter`'s declared/implemented cross-check have no tests. Easy wins because all the validation is pure-function. (Overnight audit, this branch.)
- **`intent` parameter not wired through `browser_get_accessibility_tree` or `browser_get_tabs`.** The audit added `intent` to navigational tools (create/close/click/scroll/type + run_workflow), but reading tools were skipped intentionally. Worth reconsidering — a tree-fetch with `intent: "looking for the Send button after typing"` is the highest-signal moment to capture context. (Overnight audit, this branch.)
- **`AUTH_ERROR_MESSAGE` constant lives mid-file in `mcp-handler.js`.** Defined just before `processMessage` so it's lexically close to its use, but it's a static string — could move to the top of the file alongside other module-level constants for symmetry with `formatter-logs.js`. (Overnight audit, this branch.)
- **Web UI auth model for LAN deployments.** Currently localhost-only. If LAN access is needed, design a proper session/cookie auth flow.
- **Click-to-open from macOS / Linux notifications.** Windows shipped `activationType=protocol`; the other two need helper apps.
- **Bundle the server into the Electron app.** Currently a separate pkg binary the Electron app spawns.
- **Auto-installing the extension into new profiles.** Chrome forbids it for unsigned extensions; improve the manual-load instructions in the sandbox-profile flow.
- **Cross user-data-dir Chrome management.** Current model assumes the default user-data-dir.
- **No tests for `paired-keys` async-pairing flow.** Integration test for `requestPairing` idempotency would prevent state-machine regressions.
- **No tests on the web UI package** — `package.json` has no `test` script.
- **`apiFetch` swallows JSON parse error** — `.catch(() => null)`. Log at minimum. (Web UI review S3.)
- **`<a href="/ui/...">` in nav causes full page reload.** Next.js `<Link>` would preserve WS if singleton client is adopted. (Web UI review S5.)
- **Agent-row `title={agent.key}` exposes full key on hover.** Shoulder-surfing risk. Use a prefix instead. (Web UI review S7.)
- **`StatusCard` dot has no `aria-label`** — color-only indicator. (Web UI review S8.)
- **Dead CSS (`Pairing & Agents Sections`, `.tab-btn.has-badge`, `.action-btn`) in extension popup.** (Extension review S1–S3.)
- **Inline styles in `popup.html` for the profile picker** — extract to classes. (Extension review S4.)
- **`gaiaEmail` is logged in cleartext** in `sendHelloHandshake`. Redact or downgrade to debug. (Extension review S10.)
- **Re-read `docs/CHROME_EXTENSION.md` after the recent doc-audit pass** to confirm drift is fully closed. (verify)

---

## Deferred / out of scope (intentional non-goals for v1)

- Per-agent profile binding at MCP-tool-routing level beyond v1's "one agent → one profile" model — *partially shipped* via `64e7290`; full multi-binding is post-v1.
- Bundling Electron app to host the web UI — see P3.
- Cross-user-data-dir Chrome management for non-standard installations.
- Auto-installing the extension into new profiles (Chrome forbids it).
- Click-to-open from macOS / Linux notifications (Windows only in v1).
