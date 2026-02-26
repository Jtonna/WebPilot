# Chrome Extension Documentation Audit

Audit of `docs/CHROME_EXTENSION.md` against the codebase at `packages/chrome-extension-unpacked/`.

## Inaccuracies

### 1. Scroll handler duration claim is partially wrong

**Doc claim (line 97):**
> Duration auto-calculated: 50ms per 50px for window scrolls, 75ms per 50px for container scrolls

**Actual code:** The first part is correct for the scroll handler (`handlers/scroll.js` calls `calculateScrollDuration(scrollDelta)` which defaults to 50ms per 50px). However, the click handler (`handlers/click.js` line 188) also calls `animateScroll(target, scrollDelta)` without a duration argument, which also defaults to 50ms per 50px via `calculateScrollDuration`. The doc is technically accurate here.

However, the **scroll handler file header comment** at `handlers/scroll.js` line 3 says "75ms per 50px of distance" which contradicts its own code (it calls `calculateScrollDuration` which defaults to 50ms). This is a code comment bug, not a doc bug. **No doc change needed.**

### 2. Cursor description says "particle burst on click" but the visual is a ripple/burst, not tied to the SVG glow

**Doc claim (line 85):**
> Shows a visual SVG cursor with RGB glow animation and particle burst on click

**Actual code:** The cursor (`utils/cursor.js`) has two separate visual features: (1) the RGB color-shifting glow on the SVG cursor and text label, and (2) a particle burst on click via `generateRippleCode()`. The doc is accurate here -- the "particle burst on click" is a separate effect from the "RGB glow animation." **No inaccuracy.**

### 3. `addTabToWindow` description says it creates the window on first use

**Doc claim (line 76):**
> `addTabToWindow(tabId)` -- Moves a tab to a dedicated WebPilot Chrome window, creating the window on first use and adding subsequent tabs to it.

**Actual code (`handlers/tabs.js` lines 75-88):** `addTabToWindow` does NOT create the window. If no WebPilot window exists, it returns `{ success: false, error: 'No WebPilot window exists' }`. The window is only created in `createTab` (line 159: `chrome.windows.create({ url, focused: true })`). The `addTabToWindow` function only moves tabs to an existing window.

**Evidence:**
```javascript
// addTabToWindow (lines 75-88)
export async function addTabToWindow(tabId) {
  try {
    let windowId = await ensureWebPilotWindow();
    if (windowId !== null) {
      await chrome.tabs.move(tabId, { windowId, index: -1 });
      return { success: true, windowId };
    }
    // No WebPilot window yet - don't create one just for organizing
    return { success: false, error: 'No WebPilot window exists' };
  } catch (error) { ... }
}
```

This is a real inaccuracy. The doc should say that `addTabToWindow` moves a tab to the WebPilot window if it exists, but does not create the window. Window creation happens only in `createTab` when in window mode.

### 4. `injectScript` parameter name described as script from URL

**Doc claim (line 114):**
> `injectScript(params)` -- Injects script content (fetched by the MCP server from a URL) into the page via `Runtime.evaluate`.

**Actual code (`handlers/scripts.js` line 23):** The parameter is `script_content`, and the function directly injects it. The parenthetical "(fetched by the MCP server from a URL)" describes server-side behavior that is not verifiable from the extension code alone. The MCP tool definition (`browser_inject_script`) has a `script_url` parameter, suggesting the server does fetch from a URL before passing content to the extension. **This is accurate but the phrasing could be misleading -- the extension receives content, not a URL. Minor clarity issue, not a factual error.**

## Verified Correct

### Architecture & File Structure
- The file tree listing (lines 14-51) exactly matches the actual directory structure. All listed files exist: `background.js`, `handlers/` (tabs.js, click.js, scroll.js, keyboard.js, scripts.js, accessibility.js), `formatters/` (threads.js, threads_home.js, threads_activity.js, threads_search.js, zillow.js, zillow_home.js, zillow_search.js, zillow_detail.js, zillow_detail_page.js), `utils/` (debugger.js, windmouse.js, mouse-state.js, cursor.js, scroll.js, timing.js), `accessibility-tree.js`, `accessibility-storage.js`, `popup/`.

### background.js -- Service Worker (lines 53-63)
- Confirmed: manages WebSocket, routes commands via switch on `type`, sends results with `{id, success, result/error}`, listens for tab closed and navigation complete events.
- Keepalive interval is 15 seconds (`KEEPALIVE_INTERVAL_MS = 15000`), sends `{"type":"ping"}`.
- Auto-reconnect on code 1006 with 5-second delay (`setTimeout(..., 5000)`).
- Auth failure on code 1008 clears stored config and stops retrying (`shouldRetry = false`).
- Config stored in `chrome.storage.local` and loaded on startup via `loadConfig()`.

### handlers/tabs.js (lines 67-77)
- `createTab`: confirmed uses `focusNewTabs` setting with `chrome.tabs.create({ url, active: focusNewTabs })`.
- `closeTab`: confirmed closes by tab ID.
- `getTabs`: confirmed returns id, url, title, active, windowId, groupId.
- `organizeTab`: confirmed reads `tabMode` setting, routes to `addTabToGroup` (default) or `addTabToWindow`.
- `addTabToGroup`: confirmed creates cyan "WebPilot" group (`color: 'cyan'`, `title: 'WebPilot'`).
- `organizeTab` is called automatically after commands that interact with tabs (confirmed in background.js command router).

### handlers/click.js (lines 79-88)
- Resolves targets from refs, CSS selectors, or raw coordinates.
- Uses WindMouse algorithm for curved path generation.
- Dispatches `Input.dispatchMouseEvent` (mouseMoved, mousePressed, mouseReleased).
- Shows visual SVG cursor with RGB glow and particle burst.
- Auto-scrolls off-screen elements, checks for scrollable containers first using `data-webpilot-scroll-target` attribute.
- Re-identifies elements after scroll using ancestry context (`findRefByAncestry`).
- Tracks last cursor position per tab via `setLastPosition`.

### handlers/scroll.js (lines 93-99)
- Scrolls to element (by ref or CSS selector) or by pixel amount.
- Detects scrollable parent containers before falling back to window scrolling.
- Uses `requestAnimationFrame` with cubic ease-in-out (`easeInOutCubic` function in `utils/scroll.js`).
- Duration: 50ms per 50px for window scrolls (default in `calculateScrollDuration`), 75ms per 50px for container scrolls (hardcoded in `scrollElementIntoView`).
- Centers target element in viewport when scrolling to ref/selector.
- Returns `scrolled: false` if delta < 10px (effectively "already visible").

### handlers/keyboard.js (lines 101-108)
- Types character by character using `Input.dispatchKeyEvent` (keyDown + keyUp).
- Optionally clicks ref/selector first to focus.
- Supports special keys: Enter, Tab, Backspace, Escape, arrow keys (confirmed in `keyMap` object).
- Delay default is 50ms with +/-30% jitter (line 46: `variance = Math.floor(delay * 0.3)`).

### handlers/scripts.js (lines 110-117)
- `injectScript`: injects via `Runtime.evaluate`, supports `keep_injected` with re-injection on `webNavigation.onCompleted`.
- `executeJs`: executes JavaScript, returns result, uses `awaitPromise: true`.
- Both reject protected pages (`chrome://`, `chrome-extension://`, `about:`).
- Uses CDP `Runtime.evaluate`.

### handlers/accessibility.js (lines 119-127)
- Fetches via `Accessibility.getFullAXTree` (CDP).
- Detects platform (Threads from `threads.com`, Zillow from `zillow.com`).
- Falls back to generic formatter (`accessibility-tree.js`).
- Assigns refs (`e1`, `e2`, ...) mapped to `backendDOMNodeId`.
- Builds ancestry context for re-identification after scroll.

### Formatters (lines 129-161)
- Router pattern confirmed: both `threads.js` and `zillow.js` build node maps, set up ref tracking, detect page type, delegate to sub-formatters.
- All formatter files exist as listed.
- Zillow router checks for property detail overlay on search pages (confirmed in `zillow.js`).

### Utils (lines 163-204)
- `windmouse.js`: Confirmed gravity/wind forces, distance-based Hz caps (250Hz for <300px, up to 1000Hz for >=1200px), acceleration curve with peak at 50-80%, returns path stats.
- `mouse-state.js`: Confirmed per-tab position tracking, viewport center as default.
- `cursor.js`: Confirmed SVG arrow cursor with "WebPilot" text label, RGB color-shifting glow, particle burst on click, configurable linger delay and fade-out.
- `scroll.js`: Confirmed `animateScroll`, `calculateScrollDelta`, `generateViewportCheckCode`, `calculateScrollDuration`, `scrollElementIntoView`, `generateScrollIntoViewCode`. Hard timeout (`maxTime = duration + 2000`) prevents hangs.
- `timing.js`: Confirmed `getWeightedRandomDelay` with inverted quadratic curve (doc says "inverted quadratic" which is mathematically correct for `1 - (1-x)^2`). Also exports `generateCursorTimings`.
- `debugger.js`: Confirmed `getSession` (persistent sessions, focus emulation), `cleanup`, `isProtectedPage`.

### Popup UI (lines 206-230)
- Four views confirmed: Setup, Connecting, Connected, Disconnected.
- Setup: paste connection string, click Connect.
- Connecting: shows server URL, displays errors.
- Connected: shows server URL, Disconnect button, Settings.
- Disconnected: Reconnect button, Forget button, Settings.
- Version display from `chrome.runtime.getManifest()` confirmed.
- Settings: `focusNewTabs` toggle (defaults false), `tabMode` select ("Existing window" = group, "New window" = window).
- Stored as `focusNewTabs` and `tabMode` in `chrome.storage.local`.
- Connection string format `vf://<base64url>` encoding `{"v":1,"s":"<ws_url>","k":"<api_key>"}` confirmed.
- Auth failures clear config and return to Setup view confirmed.

### Communication Protocol (lines 232-264)
- Server-to-extension format `{id, type, params}` confirmed.
- Extension-to-server success `{id, success: true, result}` and error `{id, success: false, error}` confirmed.
- Keepalive `{"type":"ping"}` every 15 seconds confirmed, pong handled silently.

### Permissions (lines 266-280)
- All 7 permissions match manifest.json exactly: `storage`, `activeTab`, `tabs`, `tabGroups`, `debugger`, `scripting`, `webNavigation`.
- Host permission `<all_urls>` confirmed.
- Permission purposes are accurately described.

## Summary

**One real inaccuracy found:** The description of `addTabToWindow` (line 76) claims it creates the WebPilot window on first use. In reality, `addTabToWindow` only moves tabs to an existing window and returns a failure if no window exists. Window creation happens exclusively in `createTab` when in window mode.

All other claims in the documentation are verified correct against the codebase.
