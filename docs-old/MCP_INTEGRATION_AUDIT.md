# MCP_INTEGRATION.md Audit Results

Audited against codebase at `packages/server-for-chrome-extension/` and `packages/chrome-extension-unpacked/`.

## Inaccuracies

### 1. Search Results example JSON is missing `_filterSchema` and `filters` fields

**Doc claim (line 157-163):** The example JSON for Threads Search Results shows only `nav`, `filter`, `_postSchema`, and `posts`.

**Code evidence:** `formatSearchResults()` in `packages/chrome-extension-unpacked/formatters/threads_search.js` lines 467-475 returns `filter`, `_filterSchema`, `filters`, `_postSchema`, `posts`, and `postCount`. The table on line 194 correctly mentions "filters array (with refs)" but the example JSON omits the `_filterSchema` and `filters` keys entirely.

**File:** `packages/chrome-extension-unpacked/formatters/threads_search.js`, lines 467-475

---

### 2. MCP tool description for `browser_scroll` says "75ms per 50px" but window scrolls default to 50ms per 50px

**Doc claim (line 506):** The doc itself correctly states "50ms per 50px for window scrolls, 75ms per 50px for container scrolls" -- this is accurate.

However, the MCP tool definition in `mcp-handler.js` line 182 describes the tool as "Uses smooth easing (75ms per 50px)" without differentiating window vs container scrolls. This is a minor inconsistency between the tool description string and the doc/code behavior.

**Code evidence:** `calculateScrollDuration()` in `packages/chrome-extension-unpacked/utils/scroll.js` line 12 defaults to `msPerStep = 50`. The scroll handler at `packages/chrome-extension-unpacked/handlers/scroll.js` line 164 calls it without overriding the default, so window scrolls use 50ms per 50px. Container scrolls use 75ms per 50px (hardcoded in `scrollElementIntoView()` at `packages/chrome-extension-unpacked/utils/scroll.js` line 210).

**Impact:** The doc body text is correct; only the tool description string registered in the MCP server is inaccurate.

**File:** `packages/server-for-chrome-extension/src/mcp-handler.js`, line 182

---

## Verified Correct

### Tool Definitions (mcp-handler.js)

- **browser_get_tabs**: No parameters, returns tab list. Matches `tools` array (lines 68-74).
- **browser_create_tab**: Requires `url` string. Matches (lines 40-52).
- **browser_close_tab**: Requires `tab_id` number. Matches (lines 53-66).
- **browser_get_accessibility_tree**: Requires `tab_id`, optional `usePlatformOptimizer` (default true). Matches (lines 76-92).
- **browser_inject_script**: Requires `tab_id` and `script_url`, optional `keep_injected`. Matches (lines 94-113).
- **browser_execute_js**: Requires `tab_id` and `code`. Matches (lines 116-132).
- **browser_click**: Requires `tab_id`, optional `ref`, `selector`, `x`, `y`, `button`, `clickCount`, `delay`, `showCursor`. All match (lines 134-178).
- **browser_scroll**: Requires `tab_id`, optional `ref`, `selector`, `pixels`. Matches (lines 180-205).
- **browser_type**: Requires `tab_id` and `text`, optional `ref`, `selector`, `delay` (default 50), `pressEnter` (default false). Matches (lines 207-239).

### browser_get_tabs Response

- Returns `id`, `url`, `title`, `active`, `windowId`, `groupId` (null if not grouped). Confirmed in `packages/chrome-extension-unpacked/handlers/tabs.js` lines 220-227.
- `groupId` uses `TAB_GROUP_ID_NONE` check, returning null when not in a group. Correct.

### browser_create_tab Response and Behavior

- Returns `{ tab_id, url, title }`. Confirmed in `handlers/tabs.js` lines 163-167, 176-180, 186-190.
- `focusNewTabs` defaults to `false`. Confirmed in `getSettings()` line 48: `focusNewTabs: result.focusNewTabs === true`.
- Settings stored in `chrome.storage.local`. Confirmed line 45.

### Tab Organization (tabMode)

- `"group"` mode (default): Tabs grouped into cyan "WebPilot" tab group. Confirmed in `addTabToGroup()` lines 120-121.
- `"window"` mode: Tabs opened in a dedicated separate window. Confirmed in `organizeTab()` lines 98-104 and `createTab()` lines 154-181.

### browser_close_tab Response

- Returns `{ success: true }`. Confirmed in `handlers/tabs.js` line 209.

### browser_get_accessibility_tree

- `usePlatformOptimizer` defaults to `true`. Confirmed in `mcp-handler.js` line 383 and `handlers/accessibility.js` line 69.
- Platform detection: `threads.com` -> threads, `zillow.com` -> zillow. Confirmed in `handlers/accessibility.js` lines 17-33.
- Response includes `tree`, `elementCount`, `postCount`, `listingCount`, `platform`. Confirmed in lines 95-101.
- Handler does NOT pass through `ghostCount`, `activityCount`, `trendCount`, etc. Confirmed -- only `tree`, `elementCount`, `postCount`, `listingCount`, `platform` are in the return at lines 95-101.
- Name truncation to 80 chars in generic tree. Confirmed in `accessibility-tree.js` (grep found: `name.length > 80 ? name.substring(0, 77) + '...'`).

### browser_inject_script

- Server fetches script via `fetchScriptFromUrl()`. Confirmed in `mcp-handler.js` lines 2-33, 388.
- 10-second timeout. Confirmed line 10.
- Errors: "Fetched script is empty", "Unsupported protocol", "Script fetch timeout". All confirmed lines 21, 6, 29.
- Protected page check (`chrome://`, `chrome-extension://`, `about:`). Confirmed in `utils/debugger.js` lines 60-67.
- Response: `{ success, tab_id, injected, persistent }`. Confirmed in `handlers/scripts.js` lines 41-46.
- `keep_injected=true` persists scripts across navigation via `webNavigation.onCompleted` listener. Confirmed in `handlers/scripts.js` lines 35-39 and 115-130, `background.js` line 328.

### browser_execute_js

- Uses `Runtime.evaluate` with `awaitPromise: true`. Confirmed in `handlers/scripts.js` lines 93-97.
- Response: `{ success, tab_id, result }`. Confirmed line 107.
- Protected page check. Confirmed lines 86-89.

### browser_click

- WindMouse algorithm for human-like paths. Confirmed in `utils/windmouse.js`.
- Distance-based Hz caps: <300px -> 250Hz, <800px -> 500Hz, 800-1200px interpolates, >=1200px -> 1000Hz. Confirmed in `utils/windmouse.js` lines 15-33.
- Acceleration curve: slow start -> peak at 50-80% -> slow end. Confirmed in `getSpeedCurve()` lines 44-58.
- Weighted random delay 10-90ms, ~75% in upper half. Confirmed in `utils/timing.js` lines 14-17.
- Linger delay 800-1500ms. Confirmed in `handlers/click.js` line 40: `Math.floor(800 + Math.random() * 700)`.
- SVG cursor: black fill, white stroke, RGB color-shifting outer glow. Confirmed in `utils/cursor.js` lines 36-115.
- "WebPilot" text label with same RGB glow treatment. Confirmed in `utils/cursor.js` lines 54-98.
- Particle burst on click. Confirmed in `generateRippleCode()` in `utils/cursor.js` lines 159-208.
- Start position: last click position or viewport center. Confirmed in `utils/mouse-state.js` lines 51-61.
- Position persists across page refreshes (tracked per tab). Confirmed -- `clearPosition` only called on `tabs.onRemoved` (background.js line 334), not on navigation.
- Response fields: `success`, `tab_id`, `ref`, `selector`, `x`, `y`, `button`, `clickCount`, `delay`, `lingerDelay`, `scrolled`, `path` (with `points`, `duration`, `avgHz`, `minHz`, `maxHz`), `startPosition`. All confirmed in `handlers/click.js` lines 372-392.
- Auto-scroll and re-identification via ancestry context. Confirmed in click handler lines 111-280 and `accessibility-storage.js` lines 60-103.
- Error messages match documented strings. Confirmed.

### browser_scroll

- Window scroll uses `window.scrollTo()` with `requestAnimationFrame`. Confirmed in `utils/scroll.js` lines 72-90.
- Container scroll uses `element.scrollTo()` (actually `container.scrollTop = scrollPos`). Confirmed in `utils/scroll.js` lines 211.
- Cubic ease-in-out. Confirmed in `generateScrollAnimationCode()` lines 32-35.
- Centers element in viewport. Confirmed in `utils/scroll.js` lines 106-108 and `handlers/scroll.js` lines 155-156.
- Container detection by walking up DOM to find scrollable ancestor. Confirmed in `utils/scroll.js` lines 175-186.
- `containerScrolled` field in response. Confirmed in `handlers/scroll.js` lines 51-60, 91-101.
- Error messages match documented strings. Confirmed.

### browser_type

- Uses `Input.dispatchKeyEvent` with `keyDown`/`keyUp`. Confirmed in `handlers/keyboard.js` lines 74-87.
- Delay has +/-30% random variance. Confirmed lines 46-48.
- When `ref`/`selector` provided, click with `showCursor: true` is performed first. Confirmed lines 29-30.
- `typeKey()` function supports Enter, Tab, Backspace, Escape, Arrow keys internally but only Enter exposed via `pressEnter`. Confirmed lines 94-123 (internal) and line 53 (only Enter used externally).

### Persistent Debugger Sessions

- Sessions kept alive until tab is closed. Confirmed in `utils/debugger.js` -- `getSession()` caches sessions, `cleanup()` called only on `tabs.onRemoved`.
- Focus emulation enabled. Confirmed in `utils/debugger.js` lines 31-35.

### Protected Pages

- Cannot access `chrome://`, `chrome-extension://`, `about:`. Confirmed in `utils/debugger.js` lines 60-67.

### Extension Not Connected Error

- Returns `"Browser extension not connected"`. Confirmed in `mcp-handler.js` lines 356-358.

### Platform Optimizers Table

- Threads Home/Profile, Activity, Search Landing, Search Autocomplete, Search Results all confirmed with correct detection and output format descriptions.
- Zillow Home, Search, Detail, Detail Overlay formatters exist. Confirmed by file presence: `formatters/zillow.js`, `zillow_home.js`, `zillow_search.js`, `zillow_detail.js`, `zillow_detail_page.js`.

### Ghost Posts

- Captured separately from regular posts based on absence of `/post/` URL. Confirmed in `formatters/threads_home.js` lines 73-77.
- Schema: `authorUrl`, `content`, `expires` (Unix timestamp), `likeRef`. Confirmed lines 237-244.
- Expiration parsed from "Xh left" format to future Unix timestamp. Confirmed lines 218-227.

### Configuration

- `claude mcp add -s project --transport sse webpilot "http://localhost:3456/sse"`. SSE endpoint confirmed in `mcp-handler.js` `handleSSE()` function.
