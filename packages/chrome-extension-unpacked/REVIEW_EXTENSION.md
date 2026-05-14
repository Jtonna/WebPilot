# Chrome extension code review — QOL Features

Branch: `QOL-Features`. Commits in scope: `bdae1ac`, `11b5074`, `dbe6f2f`, `b288ef7`.
Files reviewed: `manifest.json`, `background.js`, `popup/popup.html`, `popup/popup.js`, `popup/popup.css`.

## Severity legend
- 🔴 Critical: bug, security issue, or broken behavior
- 🟡 Important: smell, missing error handling, unclear contract, potential bug
- 🟢 Suggestion: clean-code improvement, naming, structure

## Findings

### 🔴 Critical

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

### 🟡 Important

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

### 🟢 Suggestion

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

## Cross-cutting observations

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

## Things that are well done

1. **`bdae1ac` is a tidy fix.** Persisting `manuallyDisconnected` in `chrome.storage.local` and reading it in `loadConfig()` is the right shape for MV3 service workers. The popup's read path at `popup.js:138-142` correctly drives the disconnected view. All transitions (`DISCONNECT`, `RECONNECT`, `FORGET_CONFIG`, `RETRY_AUTO_CONNECT`) are consistent.

2. **Server-side hello protocol is cleanly gated.** The server's `setConnection` is only called after a successful `hello`, so the bridge never routes commands to an unregistered WS — this means the extension doesn't *strictly* need to gate command processing client-side (though I2 suggests it should defensively).

3. **`identify_required` UI is clean.** The picker is consistent with the rest of the popup's visual language, the "I am this profile" affordance is clear, and the storage contract (`webpilot.profileId` / `webpilot.knownProfiles` keys with explicit namespace) is good.

4. **`clearConnection` accepts both `profileId` and `ws`.** The server-side bridge's polymorphic clear is a nice ergonomic touch for `ws.on('close')`.

5. **Backwards-compat alias `isConnected()` preserved.** Means callers that don't care about which profile is connected still work without churn.

6. **Pairing removal was thorough.** All `PAIRING_RESPONSE`, `REVOKE_KEY`, `RENAME_AGENT`, `GET_PAIRED_AGENTS`, `GET_PENDING_PAIRING`, `SET_NETWORK_MODE` handlers are gone from `background.js`. CSS for pairing-request-card / paired-agent-item / rename-btn / approve-btn / deny-btn etc. is also removed (~170 lines of dead CSS). Good cleanup discipline.

7. **`fail-closed` whitelist semantics survived the rewrite.** `checkWhitelist` at `background.js:686-715` still throws explanatory errors that mention "the human must manually add this site." This is unchanged and good.
