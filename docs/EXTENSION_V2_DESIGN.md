# Extension V2 — Thin Scaffolding + Server-Side Handler Logic

**Status:** Design — not yet implemented. Tracked as P1 in `OPEN_ITEMS.md`.
**Branch target:** TBD (likely a new worktree off `QOL-Features` so the
agent swarm executes in isolation; cut a PR back when green).
**Authors:** Jacob Tonna + AI agents (designed 2026-05-16).

---

## Problem (the user-facing pain)

The WebPilot Chrome extension is loaded unpacked. Each Chrome **profile**
that wants to use WebPilot needs its own "Load unpacked" step (one-time)
AND its own manual reload from `chrome://extensions/` every time we
improve any behavior inside the extension service worker.

Today the service worker holds the *behavioral* code — `handlers/click.js`
runs WindMouse mouse paths, `handlers/keyboard.js` types char-by-char,
`handlers/accessibility.js` filters the CDP accessibility tree. Every
nudge to any of those forces the user to click "Reload" in every paired
profile. We just shipped a stall watchdog (`60839ee`) — the user reloaded
in one profile and forgot the other, the bug appeared fixed in one
session and not in the other, and we spent a chunk of time debugging
that environmental mismatch before realizing it was a deploy gap.

The `webpilot_dev_reload_extension` tool helps a little — agents can ask
the extension to call `chrome.runtime.reload()` programmatically — but
(a) it's per-profile-scoped (the user just hit this), and (b) it still
needs a manual unpacked-reload if files on disk changed in a way Chrome
doesn't auto-detect (it doesn't auto-detect anything; it just reads the
files on next worker start).

The deeper friction will compound forever as we tune handler behavior
across new sites + new SPA edge cases.

---

## Solution (architectural pivot)

Move all *behavioral* logic to the server, where formatters and workflows
already hot-reload. The Chrome extension becomes a **thin CDP relay** —
just enough code to:

1. Hold the WebSocket to the server.
2. Maintain `chrome.debugger` attachments per tab.
3. Receive batched CDP command sequences from the server and dispatch them.
4. Send results back.

Everything else — mouse path, cursor visualization, type sequences,
accessibility tree filtering, scroll-into-view, ref resolution, retry
policy, stall watchdog — moves to the server.

**Why this works**: the server is local and already hot-reloadable. We
already have the pattern: formatters/workflows live as JS files the server
reads from disk and reloads on demand. We extend the same pattern to the
*handler* layer. After the one-time "Load unpacked" per profile, the user
never has to touch chrome://extensions/ again — every improvement we ship
to click/type/scroll lands by restarting the server (or by
`webpilot_dev_reload_handlers` if we add a hot-reload for those too,
mirroring `webpilot_reload_formatters`).

---

## Why "true" hot-reload of extension code isn't an option

Manifest V3 service workers forbid:
- `eval()` and `new Function()` (CSP)
- `importScripts()` from cross-origin URLs
- Remote-hosted code in any form

So we **cannot** literally "have the extension fetch engine.js from
localhost on boot and execute it". MV3 was explicitly designed to prevent
that. The compliant answer is to move the *logic* out of the service
worker rather than try to ship logic over the wire — i.e., the server
holds the smart code, and the extension stays minimal and stable.

That's exactly what this design does.

---

## Protocol — what the V2 extension exposes

The extension's `handleServerCommand` switch shrinks from today's
~10 commands (click, type, scroll, get_accessibility_tree, inject_script,
execute_js, create_tab, close_tab, get_tabs, reload_extension) to roughly
**four**:

| Command | Purpose |
|---|---|
| `cdp_send` | Forward a single `chrome.debugger.sendCommand` and return its result. |
| `cdp_send_batch` | Execute a sequence of CDP commands + inter-step ops (sleeps, conditionals on detach/stall) inside the extension and return all intermediate results. **This is the workhorse** — clicks, types, scrolls all become single batches. |
| `tab_lifecycle` | Wraps `chrome.tabs.create / remove / query` (these aren't CDP — they're Chrome runtime API). |
| `attach_tab` | Wraps `chrome.debugger.attach` + persistent session bookkeeping; returns `{ attached: true }` or surfaces protected-page errors. The extension also continues to install per-tab `chrome.debugger.onDetach` listeners and broadcasts detach events back to the server as unsolicited WS messages so server-side handlers can react. |

Plus a small handful of housekeeping commands that don't fit the above
(`reload_extension`, `hello`, `paired_agents_list`).

### `cdp_send_batch` shape

```js
{
  type: 'cdp_send_batch',
  params: {
    tab_id: number,
    steps: [
      // CDP send. Optional `label` for logging; optional `timeoutMs`
      // (default 4000 — the stall budget we just shipped).
      { cmd: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 123, y: 45 }, label: 'mouseMoved#0', timeoutMs: 4000 },

      // Wait (server-composed timing, e.g. between path points).
      { sleep: 17 },

      // Conditional: if the per-tab detach flag flipped during prior steps,
      // either break out of the batch or continue.
      { ifDetached: 'break' },

      // CDP call whose return value we want surfaced to the server.
      { cmd: 'DOM.getBoxModel', params: { backendNodeId: 9876 }, label: 'boxModel', capture: true },

      // ... etc
    ],
    // Top-level options for the batch:
    showCursor: true,     // if true, cursor SVG management is included as inline steps
    captureAll: false     // if true, ALL step results returned; default returns only marked captures
  }
}
```

The extension iterates `steps` locally, awaits each CDP call with the
per-call stall watchdog from `60839ee`, accumulates marked captures, and
returns one consolidated response:

```js
{
  success: true,
  tab_id,
  steps_executed: 42,
  detached: false,
  detachReason: null,
  captures: { boxModel: {...}, ... },
  durationMs: 287
}
```

If a step stalls or the tab detaches mid-batch, the extension short-circuits
and returns success with `detached: true, detachReason: 'cdp_stall:<label>'`
just like today's click handler does.

### Why batch instead of streaming individual `cdp_send`?

A typical click animates ~30-100 path points. Each point is one
`Input.dispatchMouseEvent`. If we sent each one as a separate WS roundtrip,
the latency cost would be ~5-10 ms × 100 = **0.5-1 s extra per click** —
unacceptable. With batching, the extension executes the whole sequence
locally and we eat one WS roundtrip per *click*, not per *frame*. Server
composes the script, extension runs it, performance matches today.

---

## What lives on the server in V2

Each handler becomes a server-side JS file that exports a function
producing a `cdp_send_batch` payload (and optionally interpreting the
captures into the existing response shape).

```
packages/server-for-chrome-extension/src/handlers/
  click.js              <- composes click batch
  type.js               <- composes type batch
  scroll.js             <- composes scroll batch
  accessibility-tree.js <- raw CDP fetch + server-side filtering
  inject-script.js      <- composes injection batch
  execute-js.js         <- composes Runtime.evaluate batch
  cursor.js             <- server-composed cursor SVG strings (today in extension's utils/cursor.js)
  windmouse.js          <- WindMouse path generator (today in extension's utils/windmouse.js)
  timing.js             <- random delay helpers (today in extension's utils/timing.js)
```

`mcp-handler.js` `_browserClick`, `_browserType`, etc. switch from sending
`{type: 'click', params: ...}` over the bridge to sending
`{type: 'cdp_send_batch', params: <composed by handlers/click.js>}` and
unwrapping the captured results into the legacy response shape.

---

## Migration plan (dual-mode, then cutover)

To avoid a flag day where everything breaks if the new code has any bugs,
the migration ships in three phases:

### Phase A — Foundation (extension protocol)
Extension v1.2.0 ships:
- `cdp_send` and `cdp_send_batch` ADDED to the switch (does NOT remove
  existing click/type/etc.).
- Per-tab onDetach listener registration moved up to a tab-lifecycle
  module so both old and new paths share it.
- Stall watchdog factored out of `click.js`/`keyboard.js` into a shared
  helper consumable by the batch executor.

User installs this once (one chrome://extensions/ reload per profile, the
last one they should need for a long time).

### Phase B — Per-handler migration
Server-side handler files added, **gated by a config flag**:

```json
// %LOCALAPPDATA%\WebPilot\config\config.json
{ "useV2Handlers": ["type", "click"] }   // empty = all old path; "*" = all new path
```

Per tool, server checks `useV2Handlers.includes(name)` and routes to the
new dispatcher OR the old `extensionBridge.sendCommand(profile, 'click', ...)`
path. We turn handlers on one at a time, verify live (DM workflow, server-
channel workflow, navigation clicks), and roll back individually if any
single handler regresses.

Order of migration:
1. `type` — simplest (no path animation, no scroll-into-view).
2. `scroll` — small.
3. `click` — most complex; do this once Type is proven.
4. `get_accessibility_tree` — largest payload but mechanically simplest
   (extension just hands raw nodes back; all the filtering moves server-side).
5. `inject_script`, `execute_js` — wrappers around Runtime.evaluate; trivial.

### Phase C — Cutover
Once all V2 handlers are stable and `useV2Handlers: "*"` has shipped for a
few days:
- Extension v1.3.0 drops the legacy command cases (click/type/scroll/
  get_accessibility_tree/inject_script/execute_js) from the switch — final
  unpacked-reload required, with a release note.
- Server stops carrying the legacy dispatcher branches.
- The handler utility files (`utils/windmouse.js`, `utils/cursor.js`,
  `utils/timing.js`, `utils/scroll.js`) move out of the extension package
  entirely into `packages/server-for-chrome-extension/src/handlers/`.

---

## Hot-reload story going forward

| Layer | Hot-reload mechanism today | After V2 |
|---|---|---|
| Formatters | `webpilot_reload_formatters` (instant) | Same. |
| Workflows | `webpilot_reload_formatters` (instant) | Same. |
| Click / type / scroll / a11y handlers | None — requires manual chrome://extensions/ reload per profile | **`webpilot_dev_reload_handlers`** — clears require cache for `packages/server-for-chrome-extension/src/handlers/*.js`, re-imports, instant. (Or just server restart.) |
| Extension protocol (rare) | `webpilot_dev_reload_extension` (per-profile) | Same — but needed orders of magnitude less often (only when the protocol itself changes, ~monthly at most). |
| MCP tool definitions | Server restart | Same. |

We could add `webpilot_dev_reload_handlers` as a Phase B deliverable so the
dev loop is fully self-serve for handler iteration just like it is for
formatters today.

---

## Risks + open questions

### Risk: latency regression
Mitigated by `cdp_send_batch` (one WS roundtrip per logical action, same
as today). Worth measuring before/after on a representative click — if
overhead is >50 ms above today's baseline, investigate.

### Risk: stall-watchdog semantics drift
Today's watchdog (`raceDetachOrStall` in `click.js` + `keyboard.js`) is
*per-CDP-call*. The batch executor must preserve that — if any single
step's CDP call takes >4 s, the batch short-circuits and surfaces
`detachReason: 'cdp_stall:<label>'`. Easy enough but needs careful porting.

### Risk: concurrent batches in one tab
Today, two simultaneous `click` calls against the same tab could race
each other via the persistent debugger session. With explicit `cdp_send_batch`
the same risk exists. We should either (a) serialize batches per tab in
the extension's runtime, or (b) document the behavior and let the server
serialize. Probably (a) — fewer surprises for the server.

### Open question: cursor visualization
Today's cursor SVG (`utils/cursor.js`) renders WebPilot's signature
mouse pointer as the agent works. Two viable spots in V2:
- **Server-composed in-page JS, dispatched via `cdp_send_batch`**: cursor
  inject/move/remove become `Runtime.evaluate` steps in the batch.
  Server-side control, no extension involvement.
- **Drop it for V2**: was a nice-to-have, never load-bearing.

Default in this design: keep the cursor, server-composed. Cleaner UX, no
real cost since we're already sending the batch.

### Open question: does the user lose the `webpilot_dev_reload_extension` tool?
No — the tool still works post-V2. It just becomes much rarer to need.
Document the change in expectation in `DEV_GUIDE.md` after Phase C ships.

### Open question: how does `_requireExtensionConnected` change?
Doesn't — the extension still pairs per-profile, still has a WS, still
identifies as a specific profile. The new commands route the same way.

---

## Verification plan

For each migrated handler:
1. **Unit-ish:** Server composes the same CDP sequence the extension used
   to emit. Capturing today's actual sequence (via console.log timestamps
   inside `click.js` etc.) gives us a baseline to assert against.
2. **Live:** The session that's already proven the new path works for
   live test —
   - DM workflow (Discord, @Jtonna), no SPA nav stall
   - Server-channel workflow (Discord #public), SPA-nav case
   - Channel switch + immediate workflow (no tree refetch), in-server SPA nav
   Run each before and after migrating the relevant handler.
3. **Latency:** Time a click before and after migration. Should be within
   ~50 ms (mostly the extra serialization/parse of the batch envelope).
4. **Regressions:** Run the existing test suite under
   `packages/server-for-chrome-extension/test/` and confirm no new
   breakages.

---

## Files this design touches (rough inventory)

**Extension (Phase A additions, Phase C deletions):**
- `packages/chrome-extension-unpacked/handlers/cdp.js` (new — batch executor)
- `packages/chrome-extension-unpacked/background.js` (add cases; later drop cases)
- `packages/chrome-extension-unpacked/utils/detach.js` (new — shared per-tab onDetach + stall watchdog factored out of click.js/keyboard.js)
- Phase C deletes: `handlers/click.js`, `handlers/keyboard.js`,
  `handlers/scroll.js`, `handlers/accessibility.js`, `handlers/scripts.js`,
  `utils/windmouse.js`, `utils/cursor.js`, `utils/timing.js`, `utils/scroll.js`,
  `utils/mouse-state.js`

**Server (Phase B additions):**
- `packages/server-for-chrome-extension/src/handlers/{click,type,scroll,accessibility-tree,inject-script,execute-js}.js`
- `packages/server-for-chrome-extension/src/handlers/{windmouse,cursor,timing}.js` (moved from extension)
- `packages/server-for-chrome-extension/src/lib/cdp-batch.js` (helpers for composing batch payloads)
- `packages/server-for-chrome-extension/src/mcp-handler.js` (re-route `_browserClick` etc.)
- `packages/server-for-chrome-extension/src/service/paths.js` (add `useV2Handlers` config helper)

**Docs (continuously updated, finalized in Phase C):**
- `accessibility-tree-formatters/DEV_GUIDE.md` — extension reload becomes
  "rare event"
- `docs/CHROME_EXTENSION.md` — protocol section rewritten
- `docs/MCP_INTEGRATION.md` — note the V2 handler path
- This document — mark phases complete as they ship

**Tests:**
- `packages/server-for-chrome-extension/test/handlers/*.test.js` (new)
- Existing extension-bridge tests carry forward unchanged

---

## What "1-shot" agent swarm execution looks like

The user has asked whether an agent swarm can produce this in one go.
A reasonable wedge layout for parallel agents:

1. **Foundation agent** (sequential first) — Phase A: ports detach +
   stall watchdog into a shared util, adds `cdp_send` + `cdp_send_batch`
   to extension, lands the inter-step ops (`sleep`, `ifDetached`,
   `capture`). Bumps extension manifest to 1.2.0. Other agents block on
   this returning.
2. **Type-handler agent** (parallel) — Phase B for `type`: composes the
   keyDown/keyUp batch on the server, wires `_browserType` through the
   dispatcher behind `useV2Handlers`. Smallest scope, lowest risk.
3. **Click-handler agent** (parallel) — Phase B for `click`: ports
   WindMouse + cursor + scroll-into-view + ref resolution to a server
   batch composer. Largest scope, highest risk — gets the most context
   in its prompt.
4. **Accessibility + scripts agent** (parallel) — Phase B for
   `get_accessibility_tree`, `inject_script`, `execute_js`. Mechanically
   simple but touches the largest response payload (the tree itself).
5. **Verification agent** (sequential last) — runs syntax checks, builds
   the server, runs existing tests, drafts the commit message + PR body.

What the swarm CANNOT do in a single shot:
- Live-test on Discord, Threads, Zillow — only the interactive session
  can run `browser_*` tools against real Chrome.
- Confirm latency targets — needs a real click on a real page.
- Catch CSS-selector or ref-resolution regressions that only show up
  against real DOM.

Recommended human/interactive follow-up after the swarm returns:
- Pull the work into the active session.
- Run the DM + server-channel + channel-switch live tests (the same three
  scenarios that proved out the stall watchdog).
- Iterate on any handler that fails.
- Flip `useV2Handlers: "*"` and run the suite again.
- Cut a `feat(extension): V2 protocol + server-side handlers` commit and
  open a PR.

The agent swarm gives us 80 % of the code, the interactive session
proves it green on live Chrome.
