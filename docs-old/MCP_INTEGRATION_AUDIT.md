# MCP_INTEGRATION.md Audit Report

## Inaccuracies

### 1. browser_create_tab: "The new tab becomes the active tab" is wrong
- **Doc (line 69):** "The new tab becomes the active tab"
- **Actual behavior:** `createTab()` in `handlers/tabs.js` uses `active: focusNewTabs`, where `focusNewTabs` defaults to `false` (line 48). The new tab is **not** active by default. This is a user-configurable setting stored in `chrome.storage.local`.
- **File:** `packages/chrome-extension-unpacked/handlers/tabs.js` lines 48, 152, 171, 184

### 2. browser_scroll: Duration formula is inconsistent
- **Doc (line 504):** "Uses smooth easing (50ms per 50px)."
- **MCP handler description (line 182):** Says "75ms per 50px"
- **Actual behavior:** `calculateScrollDuration()` in `utils/scroll.js` defaults to `msPerStep = 50` (50ms per 50px) for window scrolls. Container scrolls use 75ms per 50px. The doc body text (50ms) is correct for the main scroll case, but the MCP tool description registered with the protocol says 75ms, which is misleading.
- **File:** `packages/chrome-extension-unpacked/utils/scroll.js` lines 12-15; `packages/server-for-chrome-extension/src/mcp-handler.js` line 182

### 3. browser_scroll: Error message for no target is wrong
- **Doc (line 566):** `Either ref or selector is required`
- **Actual error:** `Either ref/selector OR pixels is required` (scroll.js line 29)
- **File:** `packages/chrome-extension-unpacked/handlers/scroll.js` line 29

### 4. browser_get_accessibility_tree: Most platform-specific count fields are not returned
- **Doc (lines 175-184):** Claims the response includes `ghostCount`, `activityCount`, `trendCount`, `suggestionCount`, `threadCount`, `termCount`, `profileCount`, and `filter` fields.
- **Actual behavior:** The `getAccessibilityTree()` handler in `handlers/accessibility.js` only returns `tree`, `elementCount`, `postCount`, `listingCount`, and `platform` (lines 95-101). All other counts from the formatters (`ghostCount`, `activityCount`, `trendCount`, `suggestionCount`, `threadCount`, `termCount`, `profileCount`, `filter`) are **silently dropped** by the handler. These counts ARE computed by the formatter in `formatters/threads.js` but never make it to the MCP response.
- **This is likely a bug in the handler**, not just a doc issue. The formatter computes these values (threads.js lines 178, 224-225, 244, 265) but the handler doesn't pass them through.
- **File:** `packages/chrome-extension-unpacked/handlers/accessibility.js` lines 95-101

### 5. browser_inject_script: Error message for empty script is wrong
- **Doc (line 260):** `script_content is required`
- **Actual behavior from agent perspective:** The MCP handler fetches the URL first via `fetchScriptFromUrl()`. If the fetch returns empty content, the error is `Fetched script is empty` (mcp-handler.js line 22). The `script_content is required` error from `injectScript()` in scripts.js can only be triggered if the fetch somehow returns a falsy but non-empty-string value.
- **File:** `packages/server-for-chrome-extension/src/mcp-handler.js` line 22; `packages/chrome-extension-unpacked/handlers/scripts.js` line 26

### 6. Configuration: Prerequisites mention wrong directory
- **Doc (line 786):** "MCP server running (`npm run dev` in `mcp-server/`)"
- **Actual:** The server package is `packages/server-for-chrome-extension/`, not `mcp-server/`.
- **File:** `packages/server-for-chrome-extension/`

### 7. browser_click: WindMouse Hz cap ranges omit the 800-1200px interpolation zone
- **Doc (lines 440-442):** Lists three distance brackets (< 300px, < 800px, >= 1200px)
- **Actual:** There is a fourth bracket: 800-1200px interpolates linearly between 500Hz and 1000Hz (windmouse.js lines 24-27). The doc omits this interpolation zone.
- **File:** `packages/chrome-extension-unpacked/utils/windmouse.js` lines 18-28

### 8. browser_click: path stats response includes `distance` field not documented
- **Doc (lines 397-401):** Lists `path.points`, `path.duration`, `path.avgHz`, `path.minHz`, `path.maxHz`
- **Actual:** `getPathStats()` also returns a `distance` field (windmouse.js line 219), so the response includes `path.distance` (total pixel distance from start to end).
- **File:** `packages/chrome-extension-unpacked/utils/windmouse.js` lines 221-228

Wait -- the click handler actually destructures only specific fields from stats. Let me re-check... Looking at click.js lines 384-389, the click handler returns `{ points: stats.points, duration: stats.duration, avgHz: stats.avgHz, minHz: stats.minHz, maxHz: stats.maxHz }`. The `distance` field from `getPathStats()` is **not included** in the click response because the handler explicitly picks only those five fields. So the doc is actually correct here on the returned fields. This item is retracted.

### 8. (Revised) browser_click: `selector` and `ref` can be null in response
- **Doc (lines 388-389):** Shows `ref` and `selector` as response fields but doesn't note they can be null/undefined.
- **Actual:** The click handler returns whatever was passed in. If only `x,y` was used, `ref` and `selector` will be `undefined`. The example response (line 361) shows `"selector": null` but this only happens if `selector` was explicitly passed as null, otherwise it's `undefined`.
- **Minor inaccuracy** -- the response shape varies by input.

---

## Missing from Documentation

### 1. Zillow platform formatter exists but is completely undocumented
- The `detectPlatform()` function in `handlers/accessibility.js` detects `zillow.com` and routes to `formatZillowTree` (line 25-26). This is a full formatter with multiple page types (home, search, detail, detail overlay) across five files.
- **Files:** `packages/chrome-extension-unpacked/formatters/zillow.js`, `zillow_home.js`, `zillow_search.js`, `zillow_detail.js`, `zillow_detail_page.js`
- The doc's Platform Optimizers table (lines 197-203) only covers Threads.

### 2. browser_execute_js supports async/await (awaitPromise: true)
- The `executeJs()` function uses `awaitPromise: true` (scripts.js line 96), meaning the code expression can return a Promise and it will be awaited. This is a useful capability not mentioned in the doc.
- **File:** `packages/chrome-extension-unpacked/handlers/scripts.js` lines 93-97

### 3. browser_get_accessibility_tree returns `listingCount` for Zillow
- The handler returns `listingCount: formatted.listingCount` (accessibility.js line 99), which is populated by the Zillow formatter. The doc doesn't mention this field.
- **File:** `packages/chrome-extension-unpacked/handlers/accessibility.js` line 99

### 4. Tab organization modes: "group" (default) and "window" mode
- The `createTab()` function supports two modes configured via `chrome.storage.local`: `tabMode: 'group'` (default, creates cyan WebPilot tab group) and `tabMode: 'window'` (creates a separate WebPilot window). The doc only mentions the group behavior (line 45).
- **File:** `packages/chrome-extension-unpacked/handlers/tabs.js` lines 43-52, 98-104, 145-191

### 5. `focusNewTabs` is a configurable setting
- Whether new tabs become active is controlled by `focusNewTabs` in `chrome.storage.local`, not hardcoded. Default is `false`. The doc should mention this as a user-configurable behavior.
- **File:** `packages/chrome-extension-unpacked/handlers/tabs.js` lines 43-52

### 6. Persistent debugger sessions with focus emulation
- The debugger session manager (`utils/debugger.js`) keeps sessions alive until tab close and enables `Emulation.setFocusEmulationEnabled` so CDP commands work on background tabs. This is relevant context for agents (explains why commands work even on non-active tabs).
- **File:** `packages/chrome-extension-unpacked/utils/debugger.js` lines 6-38

### 7. browser_scroll: Container scroll handling
- When an element is inside a scrollable container (dropdown, modal), the scroll handler detects and scrolls the container instead of the window. The response includes a `containerScrolled: true` field in this case. The doc doesn't mention this behavior or response field.
- **File:** `packages/chrome-extension-unpacked/handlers/scroll.js` lines 42-106

### 8. browser_scroll: "pixels" field in response
- When `pixels` is used as input, the response includes `pixels: pixels` (scroll.js line 175). This is not documented.
- **File:** `packages/chrome-extension-unpacked/handlers/scroll.js` line 175

### 9. browser_click: Click handler focuses the element using `showCursor: true` when clicking to focus for typing
- In `keyboard.js`, when `ref` or `selector` is provided, `click()` is called with `showCursor: true` (line 30). This means typing with a ref/selector always shows the cursor animation. This is implicit behavior worth documenting.
- **File:** `packages/chrome-extension-unpacked/handlers/keyboard.js` line 30

### 10. browser_scroll: Both ref and pixels simultaneously is explicitly rejected
- The error `Cannot specify both element target and pixels - use one or the other` is produced when both are provided (scroll.js lines 31-33). The doc mentions mutual exclusivity but doesn't document the specific error.
- **File:** `packages/chrome-extension-unpacked/handlers/scroll.js` lines 31-33

### 11. browser_click: Additional error for scroll re-identification failure
- `Element no longer exists after scroll. Re-fetch accessibility tree and try again.` (click.js line 249) is an error not listed in the doc.
- **File:** `packages/chrome-extension-unpacked/handlers/click.js` line 249

---

## Verified Correct

### browser_get_tabs
- Tool exists with correct name, no parameters.
- Response fields (`id`, `url`, `title`, `active`, `windowId`, `groupId`) match `getTabs()` exactly.
- `groupId` correctly maps to `null` when not in a group (tabs.js line 226: `chrome.tabGroups.TAB_GROUP_ID_NONE ? ... : null`).
- Tab grouping into cyan "WebPilot" group confirmed (tabs.js lines 120-121).
- Tab IDs are Chrome-assigned and stable for tab lifetime -- correct.

### browser_create_tab
- Tool exists with `url` as required string parameter -- correct.
- Returns `{ tab_id, url, title }` -- matches code (tabs.js lines 163-167, 176-180, 186-190).
- Title may be empty if page hasn't loaded -- confirmed (`tab.title || ''`).

### browser_close_tab
- Tool exists with `tab_id` as required number parameter -- correct.
- Returns `{ success: true }` -- matches code (tabs.js line 209).
- Error for nonexistent tab: Chrome will throw; the `No tab with id:` message pattern is from Chrome's native error.

### browser_get_accessibility_tree
- Tool exists with `tab_id` (required) and `usePlatformOptimizer` (optional, default true) -- correct.
- Default tree format with indentation, role, name (truncated to 80 chars), ref, properties -- all confirmed in `accessibility-tree.js`.
- Properties extracted: `level`, `url`, `focusable`, `checked`, `selected`, `expanded`, `disabled` -- confirmed.
- Refs format `[ref=eN]` -- confirmed.
- Uses CDP `Accessibility.getFullAXTree` -- confirmed.
- Error messages: `tab_id is required`, debugger attachment errors -- confirmed.
- Cannot access protected pages -- confirmed via `isProtectedPage()`.
- Platform detection for threads.com -- confirmed.
- Threads formatter outputs for Home, Activity, Search Landing, Search Autocomplete, Search Results -- all confirmed in formatters.

### browser_inject_script
- Tool exists with `tab_id` (required), `script_url` (required), `keep_injected` (optional, default false) -- correct.
- Returns `{ success, tab_id, injected, persistent }` -- matches code (scripts.js lines 41-46).
- Server fetches script content -- confirmed in mcp-handler.js lines 2-33.
- Fetch timeout of 10 seconds -- confirmed (mcp-handler.js line 10).
- Persistent re-injection on navigation -- confirmed via `handleNavigationComplete()` in scripts.js.
- Uses Runtime.evaluate to bypass CSP -- confirmed (scripts.js line 58).
- Unsupported protocol error -- confirmed (mcp-handler.js line 6).
- HTTP error format (`HTTP 404 Not Found`) -- confirmed (mcp-handler.js line 17).
- Script fetch timeout error -- confirmed (mcp-handler.js line 29).
- Protected page check -- confirmed (scripts.js lines 28-30).

### browser_execute_js
- Tool exists with `tab_id` (required) and `code` (required) -- correct.
- Returns `{ success, tab_id, result }` -- matches code (scripts.js line 107).
- Code evaluated as expression (Runtime.evaluate) -- confirmed.
- Return value from `result.result?.value` -- confirmed.
- Error messages: `tab_id is required`, `code is required`, protected page check -- all confirmed.
- Uses Runtime.evaluate with returnByValue -- confirmed.

### browser_click
- Tool exists with all documented parameters: `tab_id`, `ref`, `selector`, `x`, `y`, `button`, `clickCount`, `delay`, `showCursor` -- all confirmed in mcp-handler.js lines 138-175.
- Default values: `button='left'`, `clickCount=1`, `showCursor=true` -- confirmed in click.js line 36 and mcp-handler.js lines 410-413.
- Delay behavior: weighted random 10-90ms favoring longer delays -- confirmed (timing.js lines 14-17).
- Return fields: `success`, `tab_id`, `selector`, `ref`, `x`, `y`, `button`, `clickCount`, `delay`, `lingerDelay`, `scrolled`, `path.*`, `startPosition` -- all confirmed (click.js lines 372-392).
- Linger delay 800-1500ms -- confirmed (click.js line 40).
- WindMouse algorithm with gravity/wind forces -- confirmed (windmouse.js).
- Acceleration curve: slow start, peak at 50-80%, slow end -- confirmed (windmouse.js lines 41-58, 92-94).
- Error messages: `tab_id is required`, `Either selector, ref, or x,y coordinates are required`, ref not found, element no longer exists, element not found, element has no dimensions, `button must be left, right, or middle` -- all confirmed.
- Uses Input.dispatchMouseEvent (mousePressed + mouseReleased) -- confirmed.
- Auto-scroll with 150ms settle time -- confirmed (click.js lines 134, 192).
- Ancestry-based re-identification after scroll -- confirmed (click.js lines 198-261).
- Start position from last click position or viewport center -- confirmed via `getStartPosition()`.
- Cursor persists across page refreshes (tracked per tab ID) -- confirmed via `setLastPosition()`.

### browser_scroll
- Tool exists with `tab_id` (required), `ref`, `selector`, `pixels` -- correct.
- Mutual exclusivity of ref/selector vs pixels -- confirmed (scroll.js lines 28-33).
- Return fields: `success`, `scrolled`, `tab_id`, `ref`, `selector`, `scrollDelta`, `duration` -- confirmed.
- "Already in view" response with `scrolled: false` -- confirmed (scroll.js lines 160-162).
- Centers element in viewport -- confirmed (scroll.js lines 149-156).
- Uses requestAnimationFrame with cubic ease-in-out -- confirmed (scroll.js lines 32-36, 48-49).
- Error for element position: `Could not determine element position` -- confirmed (scroll.js line 147).

### browser_type
- Tool exists with `tab_id` (required), `text` (required), `ref`, `selector`, `delay` (default 50), `pressEnter` (default false) -- correct.
- Return fields: `success`, `tab_id`, `text`, `charCount`, `ref`, `selector`, `pressEnter` -- confirmed (keyboard.js lines 58-66).
- Click to focus if ref/selector provided -- confirmed (keyboard.js lines 29-33).
- Uses Input.dispatchKeyEvent with keyDown+keyUp -- confirmed (keyboard.js lines 76-86).
- Special keys supported: Enter, Tab, Backspace, Escape, Arrow keys -- confirmed (keyboard.js lines 95-103).
- Delay has ~30% random variance -- confirmed (keyboard.js lines 46-48).

### Error Handling
- "Browser extension not connected" error -- confirmed (mcp-handler.js line 357).
- Tab not found error pattern -- correct.

### Best Practices
- Tab IDs reliable through navigation -- correct.
- Coordinates relative to viewport -- correct (CDP Input.dispatchMouseEvent uses viewport coordinates).

### Limitations
- All listed limitations are accurate and confirmed.

---

## Verified By

- **Date:** 2026-02-25
- **Method:** Manual line-by-line audit of MCP_INTEGRATION.md against source code in `packages/server-for-chrome-extension/src/mcp-handler.js`, `packages/chrome-extension-unpacked/handlers/` (tabs.js, accessibility.js, click.js, scroll.js, keyboard.js, scripts.js), `packages/chrome-extension-unpacked/formatters/` (threads.js, zillow.js), `packages/chrome-extension-unpacked/utils/` (scroll.js, timing.js, windmouse.js, debugger.js, cursor.js), and `packages/chrome-extension-unpacked/accessibility-tree.js`.
- **Summary:** 8 inaccuracies found (most impactful: platform-specific response fields silently dropped by handler, createTab active behavior wrong, scroll error message wrong). 11 items missing from documentation (most impactful: Zillow formatter undocumented, async/await support in execute_js, container scroll handling). All 9 tools exist with correct names and core parameter schemas verified against MCP tool definitions.
