# Web UI code review — QOL Features

## Severity legend
- 🔴 Critical: bug, security issue, accessibility failure, or broken behavior
- 🟡 Important: smell, missing error/loading state, unclear contract, potential bug
- 🟢 Suggestion: clean-code improvement, naming, structure, UX polish

## Findings

### 🔴 Critical

#### C1. `useEffect` cleanup runs `client.disconnect()` which clears the listener map — but in React 19 Strict Mode the effect mounts twice
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

#### C2. `confirm()` for revoke and network-mode toggle blocks the renderer and is not accessible
`app/agents/page.js:52` — `if (!confirm(...)) return;`
`app/settings/page.js:33` — `if (!confirm(msg)) return;`

`window.confirm()` is a synchronous modal that blocks the JS event loop, is not styleable, does not match the dark theme, cannot be made keyboard-trap-correct for assistive tech beyond what the browser provides, and on some Electron / packaged contexts the dialog may not render at all (especially if the UI is hosted inside a webview without the BrowserWindow's dialog permissions). Worst case in Electron: `confirm()` returns `undefined`/throws, the revoke silently never fires. The review brief explicitly asked us to call out which mechanism is used — it is `window.confirm()` in both places, and that is the wrong choice for a destructive action like **agent key revocation** and **server restart**.

Recommendation: a small dark-themed `<dialog>` modal component, or at minimum a two-step inline confirm (button morphs to "Click again to confirm").

#### C3. Pairing approval flow drops `selectedProfile === '__new__'` into a `null` profileId without ever creating a profile
`app/pairings/page.js:64-65` — `const profile = selectedProfile === '__new__' ? null : selectedProfile;`
`lib/api.js:55-60` — sends `{ profileId: profile || null }`
`packages/server-for-chrome-extension/src/server.js:143-154` — server's `approvePairing` ignores `profileId` entirely.

When the user selects "+ New sandbox profile" the UI sends `profileId: null`. The server-side `approvePairing` doesn't accept or use `profileId` at all (it just calls `pairedKeys.approvePairing(id)` and returns). So:

1. "+ New sandbox profile" is silently equivalent to picking any other option — no sandbox is created.
2. The UI presents an option that has no implementation behind it. This is a stub leaked into shipped code.

Either remove the "+ New sandbox profile" option from `profileOptions` until the server supports it, or implement the create-on-approve flow on the server. Right now the dropdown is misleading.

#### C4. `createProfile` accepts any string and forwards it directly to Chrome's `--profile-directory` flag — no validation
`app/profiles/page.js:39-57`, `lib/api.js:69-74`, server at `packages/server-for-chrome-extension/src/server.js:169-193`.

The only client-side check is `name.trim()` being non-empty. Chrome's `--profile-directory` value becomes a **directory name on disk** under `User Data\`. Characters that are illegal on Windows (`< > : " / \ | ? *`) and the trailing-dot / trailing-space rules will cause Chrome to either silently fall back to "Default" or fail to launch. There is no length cap either (Windows MAX_PATH still bites at ~255 chars combined with the user-data-dir prefix). On Linux/macOS, embedded slashes will create nested directories.

At minimum the UI should:
- Reject characters not in `[A-Za-z0-9 _-]` (matching what Chrome's profile picker allows).
- Cap the length (~64 chars is plenty).
- Reject names that already exist in `data.profiles` (otherwise you launch Chrome onto an existing profile and call it a "sandbox").

Server-side it should mirror the same validation as defence in depth — currently `String(req.body.name).trim()` is the entire validation surface.

#### C5. WebSocket URL ignores `setApiBaseUrl()` for dev mode → events stream broken in `next dev`
`lib/ws.js:20-25` builds the WS URL from `window.location` only. The REST client (`lib/api.js`) has an `API_BASE_URL` overridable via `setApiBaseUrl()` precisely so that `next dev` (port 3100) can point REST at the WebPilot server (some other port). The WS client has no equivalent — running `next dev` will try to open a WebSocket to `ws://localhost:3100/api/ui/events`, which is the Next dev server, not WebPilot. Result: dev mode shows "events unavailable" forever; only the periodic refresh (which there isn't — see I3) keeps the UI alive.

`createUiEventsClient` accepts a `url` option, but no page passes one. Either:
- have `ws.js` read from the same `API_BASE_URL` (and translate `http://` → `ws://`), or
- accept a base URL prop and have a single shared `EventsProvider` at the app root.

### 🟡 Important

#### I1. Five independent WebSocket connections — one per page mount
See C1 reclassified. Each page in `app/*/page.js` instantiates its own `UiEventsClient`. Navigating between pages tears down and rebuilds. A module-level singleton or a React context would:
- Reduce server load (uiWsClients churn).
- Avoid the "client connected / disconnected" spam in server logs on every nav.
- Allow the History list on `/pairings` to accumulate **across navigation** rather than being reset every time the user clicks away and back (see I8).

#### I2. Stub `console.log` paths still in production components
`components/AgentRow.js:28, 37` and `components/PairingPromptCard.js:25, 34` log `(stub)` messages if `onRename`/`onRevoke`/`onApprove`/`onDeny` are not provided. Since the pages always provide these handlers now (Wave 2 wired them up), the stub branches are dead code — but they ship to the bundle, and any future caller forgetting to wire up will fail silently with a console log rather than a loud error. Recommendation: remove the stub branches; treat missing handler as a programmer error.

#### I3. No polling fallback — if WebSocket never connects, UI is stale forever
Every page does **one** `refresh()` at mount and then relies on WS events for further updates. If `/api/ui/events` never connects (auth failure, dev-mode wrong port per C5, server restart per Settings page), the UI silently stays stale. There is no "live updates disconnected" indicator anywhere, and no polling fallback. The Home page even claims a "live" status card with no signal to the user that the live channel is down.

Recommendation: add a small "Live"/"Reconnecting…" badge sourced from the WS client's connection state, and/or a 30 s polling fallback when the WS is not in `OPEN` state.

#### I4. `useEffect` deps array is `[]` but uses `refresh` defined in the component body — stale closure waiting to happen
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

#### I5. Race condition between REST `refresh()` and WS event-driven `refresh()`
`app/page.js:13-24` (and identical patterns on every page): `refresh()` is `async`. If a WS event fires while a previous `refresh()` is in flight, you get two parallel `getStatus()` requests with no ordering guarantee. The later-fired request may resolve **first** and be overwritten by the older response. This is the classic stale-response bug.

Fix: use an incrementing request id (a `useRef`) and discard responses whose id is not the latest, or use `AbortController` to cancel the in-flight request when a new one starts.

#### I6. `setTimeout(refresh, 1000)` on profile-create — magic delay, no cleanup
`app/profiles/page.js:51` — `setTimeout(refresh, 1000);` after `createProfile()` succeeds. The 1 s is presumably to wait for Chrome to actually launch and the extension to connect, but:
- It is not cleared on unmount → if the user navigates away within 1 s, `refresh` runs against an unmounted component (no React warning in 19 but still wasted work and a `setState`-on-unmounted no-op).
- A WS `extension_connected` event will trigger a refresh anyway, making this redundant.

Fix: drop the timer; rely on the WS event, or capture the timer id and clear it in the effect cleanup.

#### I7. `error` state is overloaded: it carries both real errors and "everything is fine, just restarting" messages
`app/settings/page.js:40` — `setError(new Error('Server is restarting — refresh this page in a few seconds.'));`

Putting a benign info message into the `error` slot means it renders inside the error card with no visual distinction, and a downstream developer reading the state model will be confused. Add a separate `info` / `notice` state, or model this as `{kind: 'error'|'info', message}` (the Profiles page already does this correctly with `createMsg`).

#### I8. History list on `/pairings` is reset on every navigation away/back
`app/pairings/page.js:10` — `const [history, setHistory] = useState([]);` State is component-local, so navigating to another page and back clears the history. The Wave 2 doc apparently claims "session-scoped"; the actual scope is **mount-scoped**, which is much narrower (every page click resets it). The user will be surprised.

Options:
- Hoist `history` to a module-level array or React context provider that survives navigation but not full refresh.
- Persist in `sessionStorage` (still session-scoped, survives nav).
- Document the behaviour clearly in the empty state ("History is cleared when you leave this page").

#### I9. Network-mode toggle marks the server as restarting via a fake error, but UI optimistically sets `networkMode = next` first
`app/settings/page.js:38-40`:
```js
await apiSetNetworkMode(next);
setNetworkMode(next);
setError(new Error('Server is restarting — refresh this page in a few seconds.'));
```

The server response is `{ ok: true, restarting: true }` and `setImmediate(() => setNetworkMode({ enabled }))` is fired **after** the response is sent. There is a window where the UI shows "ON" but the server hasn't actually restarted yet, and any `getStatus()` polled during that window would still report the old value. Combined with no polling/WS reconnect indicator (I3), the user has no robust signal that the toggle "took". Consider disabling the toggle entirely until `getStatus()` confirms the new value, with a spinner + a hard timeout (e.g. 10 s).

#### I10. `apiFetch` doesn't pass the dev-mode X-API-Key header
`lib/api.js:18-47` only sets `Accept` and `Content-Type`. The server's `uiAuth` (`server.js:104-114`) accepts `localhost OR X-API-Key`. In `next dev` (port 3100) the request originates from the same machine but with a different port — `req.socket.remoteAddress === '127.0.0.1'`, so localhost auth will pass. Good. But there is no `X-API-Key` plumbing at all, meaning the UI can never be served from a non-localhost device with auth, which is the explicit motivation for `setApiBaseUrl()`. Add an `setApiKey()` and include it in headers when set.

#### I11. The dropdown in `PairingPromptCard` does not refresh `selectedProfile` when `profileOptions` changes
`components/PairingPromptCard.js:18` — `useState(profileOptions[0]?.value || 'Default')`. If `profileOptions` updates (e.g. a new profile was created on the Profiles tab and the WS triggers a refresh), the card keeps its old `selectedProfile`, which may now be stale or refer to a profile that no longer exists. With the current single-page approval flow it's unlikely to hit, but it's classic "derived state stored in state".

Fix: validate `selectedProfile` against current `profileOptions` on each render, falling back to options[0] if not found.

#### I12. The "Default" fallback in `app/pairings/page.js:56-59` masks the empty-profiles case
```js
if (profileOptions.length === 1) {
  profileOptions.unshift({ value: 'Default', label: 'Default' });
}
```

If `/api/ui/status` returns `profiles: []` (e.g. Chrome never ran, or fetching profiles failed) the UI silently adds a magic "Default" option. The user might approve a pairing for the literal directory name "Default" while the server has no idea what profile that maps to. Worse: this fallback only triggers when `profiles.length === 0` because `__new__` always counts as 1. It would be clearer to render a warning "No Chrome profiles detected — approving will use the default profile" and disable the dropdown.

#### I13. `formatDate('never')`-style values get silently passed through
`components/AgentRow.js:10-15` returns `'never'` only when value is falsy; if the server sends a non-date string like `'unknown'` or `0`, it falls through to `String(value)`. Minor robustness issue.

#### I14. Inline `<span onClick>` for "click to rename" is not keyboard-accessible
`components/AgentRow.js:60-67`. The agent name is editable on click, but the span has no `tabIndex`, no `role="button"`, no `onKeyDown` for Enter/Space. Keyboard-only users cannot rename. The `cursor: 'text'` is also a poor affordance — `cursor: 'pointer'` would at least hint at interactivity. Better: an actual `<button>` styled as text, or a small pencil icon button next to the name.

#### I15. Profile-create input has no `onKeyDown="Enter"` submit binding
`app/profiles/page.js:106-112`. Users instinctively press Enter; here that does nothing (no surrounding `<form>`, no `onKeyDown`). Easy win: wrap in `<form onSubmit={handleCreate}>` with `e.preventDefault()`.

#### I16. WebSocket `error` events log only `err.message`, but DOM `Event` objects don't have a `message`
`lib/ws.js:64-67`. `WebSocket` error events are plain `Event` instances (not `ErrorEvent` in all browsers), so `err.message` is typically `undefined` and the log prints `[ui-ws] error undefined`. Not user-visible but unhelpful when debugging.

#### I17. Cleanup pattern `u1 && u1()` is needlessly defensive
`app/profiles/page.js:33-34`, `app/agents/page.js:36-37`. `subscribe()` always returns a function (`lib/ws.js:84`). The `&&` guard implies otherwise. Just call them. The home and pairings pages use `unsubs.forEach((u) => u && u())` — same comment.

### 🟢 Suggestion

#### S1. Consolidate the four nearly identical `useEffect` blocks into a `useUiEvents(eventTypes, onChange)` hook
All five pages copy/paste the same pattern: create client, subscribe, refresh on event, cleanup. This is the textbook case for extraction. A hook also lets you share a single `UiEventsClient` across the app (see I1) and centralise the "live" / "reconnecting" state (see I3).

#### S2. Move `refresh` functions out of components — they're just `getStatus()` wrappers with `setState`
Each page defines `refresh`. A `useStatus()` hook returning `{ status, error, loading, refresh }` would DRY this up nicely.

#### S3. `apiFetch` swallows the JSON parse error
`lib/api.js:35` — `await res.json().catch(() => null)`. If the server sends `Content-Type: application/json` but a malformed body, `payload` is silently `null` and the caller doesn't know the response was bad. Log it at minimum.

#### S4. Color contrast: `--wp-fg-muted: #9a9a9a` on `--wp-bg-card: #1a1a1a`
Contrast ratio ≈ 6.0:1 — passes WCAG AA for normal text but the `.wp-muted` class is used at 0.85rem ≈ 13.6px (smallish). Still passes AA, doesn't hit AAA (7:1). Fine, but lift the muted to `#a8a8a8` for AAA without changing the design feel.

The brighter `--wp-danger: #ef4444` on `#1a1a1a` is ~4.5:1 — passes AA for normal text but borderline. The "Revoke" button uses this as the border + text color; on hover it inverts to white-on-red which is much better. Acceptable.

#### S5. `<a href="/ui/">` for in-app nav causes full-page reloads
`app/layout.js:14-21`. Next.js `<Link>` would do client-side nav and preserve the WS connection if you implement S1's shared client. Right now navigating between pages disconnects/reconnects WS every time.

#### S6. `PairingPromptCard` re-renders `disabled={busy}` on **all** prompts when busy applies to only one approval
`app/pairings/page.js:13` — single `busy` boolean, but multiple pending pairings can exist. Approving pairing A disables Deny/Approve on pairing B too. Either track `busy` per `pairingId` (a `Set<string>`) or accept the global-busy UX and note it explicitly.

#### S7. No `key` for `details` field in `AgentRow` makes `title={agent.key}` exposed in tooltip
`components/AgentRow.js:69` — `title={agent.key}` exposes the full API key on hover. Not a leak per se (the user already has it on their machine), but for shoulder-surfing it's a needless reveal. Maybe limit the title to the same short prefix?

#### S8. `<span className="wp-status-dot">` has no `aria-label`
`components/StatusCard.js:16`. Color-only status indicator → invisible to screen readers and to colour-blind users. Add `aria-label` describing the state ("status: ok"), or render an off-screen text equivalent ("Running — healthy").

#### S9. Empty-state copy could be more consistent
"No pairings waiting." vs "No agents paired yet." vs "No profiles found." — all fine in isolation; consider standardising on "No X yet" / "No X to show."

#### S10. `next.config.js` has `output: 'export'` with `trailingSlash: true` — confirm asset paths work mounted under `/ui`
The static export emits to `out/`, which the WebPilot server presumably mounts at `/ui`. The `basePath: '/ui'` + `assetPrefix: '/ui/'` should handle this, but verify the server serves `out/index.html` for `/ui/` and `out/pairings/index.html` for `/ui/pairings/` (not `/ui/pairings.html`). The trailing-slash quirk is a frequent source of 404s.

#### S11. `globals.css` uses two ellipsis styles: `Loading...` vs `Loading…` vs `Launching...` vs `Restarting…`
`app/page.js:61` has `Loading...`, `app/settings/page.js:71` has `Loading…`, `Launching...` (profiles) vs `Restarting…` (settings). Pick one.

## Cross-cutting observations

- **Wave 2 wiring is mostly clean**: API surface (`lib/api.js`) is consistent — every endpoint goes through one wrapper, no rogue `fetch()` calls. Good.
- **No tests anywhere** in the package — `package.json` has no `test` script, no test files. For a UI that gates destructive actions (revoke key, restart server, create profile) this is a gap.
- **No TypeScript / JSDoc** — `apiFetch` returns "JSON or text" depending on response, callers blindly index into the result (`data.pendingPairings`, `data.chrome.running`, etc.). One backend rename and the UI silently breaks. Even minimal JSDoc types on the API wrappers would help.
- **WebSocket auth in dev**: the WS handshake from a browser can't carry headers, so the server falls back to `?apiKey=` query string (`server.js:275`). The UI client never appends `apiKey`. In localhost mode this works because of the `isLocal` shortcut, but it's another piece blocking non-localhost UIs.
- **Build / hydration**: Pages use `'use client'` correctly and never read `window` at top level (only inside `useEffect`), so SSR/SSG should be clean. The `_defaultUrl` in `ws.js:20-25` short-circuits with `if (typeof window === 'undefined') return null;` — good.
- **`.gitignore` is correct** — `node_modules/`, `out/`, `.next/`. But note that `.next/` and `out/` are present in the working tree on disk; they shouldn't be committed, and the ignore handles that. No `package-lock.json` present — depending on the monorepo's lockfile strategy, this may or may not be intentional.
- **All four event subscriptions across pages use `'pairing_*'`, `'agents_changed'`, `'extension_*'` strings as literals.** These should be exported constants from `lib/ws.js` (or a shared `events.js`) so a typo doesn't silently break a subscription.

## Things that are well done

- `lib/api.js` is a clean, minimal wrapper. JSON / text dispatch is correct, error object carries `status` and `payload`. The pattern of named wrapper exports (`getStatus`, `approvePairing`, etc.) is exactly right.
- `UiEventsClient` correctly handles SSR (returns `null` URL when `window` is undefined), correctly handles WebSocket construction errors, and correctly reconnects with a backoff timer.
- The `disconnect()` method sets `_closed = true` **before** closing the socket and clearing listeners — the ordering prevents the close handler from re-scheduling a reconnect.
- `cancelled` flag pattern in `useEffect` (e.g. `app/page.js:27`) is the right pattern for guarding against stale `setState` after unmount.
- CSS uses semantic CSS variables (`--wp-bg`, `--wp-accent`, etc.) with sensible defaults — easy to retheme.
- The Settings page surface area is tiny and well-scoped — one toggle, clear copy.
- `PairingPromptCard` and `AgentRow` are properly extracted, single-responsibility components.
- Server-side `/api/ui/*` endpoints all use the same `auth` middleware, and the UI hits them through one client — no auth bypass on any route.
- Error states render *somewhere* on every page (even if I7 critiques the overloading) — no page silently fails.
