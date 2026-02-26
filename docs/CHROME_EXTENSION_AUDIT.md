# CHROME_EXTENSION.md — Audit

## Inaccuracies

### 1. Tab Organization Function Misnamed
- **Doc says**: `addTabToGroup(tabId)` is "called automatically when any command interacts with a tab"
- **Reality**: The function called in `background.js` is `organizeTab(params.tab_id)` (line 282 etc.), which reads the `tabMode` setting and routes to either `addTabToWindow(tabId)` or `addTabToGroup(tabId)`. The doc omits the `organizeTab` orchestrator and the window mode path entirely.

### 2. Scroll Duration Partially Wrong
- **Doc says**: "Duration auto-calculated: 50ms per 50px of scroll distance" (in handlers/scroll.js section)
- **Reality**: Window scrolls use 50ms per 50px (`calculateScrollDuration` default), but container scrolls (via `scrollElementIntoView` in `utils/scroll.js`) hardcode 75ms per 50px (line 210). The doc only describes window scroll timing. Note: the `handlers/scroll.js` file header comment itself incorrectly states "75ms per 50px" when its window scroll path actually uses the 50ms default.

### 3. Manifest Path Wrong
- **Doc says** (Permissions section): "From `packages/extension/manifest.json`"
- **Reality**: The actual path is `packages/chrome-extension-unpacked/manifest.json`. The directory name in the doc is wrong.

### 4. `scrollElementIntoView` Missing from Utils Documentation
- **Doc says** (utils/scroll.js section): Lists `animateScroll`, `calculateScrollDelta`, `generateViewportCheckCode`, `calculateScrollDuration`
- **Reality**: The file also exports `scrollElementIntoView(target, elementExpression)` and `generateScrollIntoViewCode(selector)`, which are used by both click.js and the scroll handler for container scrolling. These are undocumented.

## Missing from Documentation

### 5. Window Mode Tab Organization
- The extension supports two tab organization modes: `'group'` (default, uses tab groups) and `'window'` (moves tabs to a dedicated WebPilot window). The `organizeTab` function in `handlers/tabs.js` reads the `tabMode` setting from `chrome.storage.local` and routes accordingly. In window mode, `createTab` creates a new Chrome window on first use and adds subsequent tabs to it. This is configurable in the popup settings but completely undocumented.

### 6. Popup Settings UI
- When connected or disconnected, the popup shows a settings section (`popup/popup.html` lines 101-126) with:
  - Toggle: "Focus new tabs" (defaults to false) -- controls whether new tabs get focus via `chrome.tabs.create({ active: focusNewTabs })`
  - Select: "Tab organization" with options "Existing window" (group mode) or "New window" (window mode)
- These settings are stored in `chrome.storage.local` as `focusNewTabs` and `tabMode`.
- Not documented.

### 7. Scrollable Container Support
- Both the click handler and scroll handler detect scrollable parent containers (dropdowns, modals) before falling back to window scrolling. The `scrollElementIntoView` function in `utils/scroll.js` walks up the DOM looking for ancestors with `overflow-y: auto|scroll` and `scrollHeight > clientHeight`. Container scrolls use the same easeInOutCubic animation but at 75ms per 50px (slower than window scrolls). Not documented as a distinct feature.

### 8. Click Handler Scrollable Container Handling
- The click handler (`handlers/click.js` lines 121-194) checks for scrollable containers before window-scrolling, using a temporary `data-webpilot-scroll-target` attribute to bridge between CDP node resolution and in-page JavaScript. This two-phase approach (container scroll attempt, then window scroll fallback) is not described in the doc.

### 9. `createTab` Respects `focusNewTabs` Setting
- The doc says `createTab` "opens a new tab with the given URL" and "adds the tab to a cyan WebPilot tab group." It does not mention that the tab's `active` state is controlled by the `focusNewTabs` setting (defaults to false, meaning tabs open in the background).

### 10. Version Display in Popup
- The popup displays the extension version from `chrome.runtime.getManifest()` in the header. Not documented.

## Removed from Previous Audit (Incorrect Claims)

### Former Item #5: "Element Re-identification After Scroll - Not documented"
- **Deleted because**: The doc DOES document this at line 85 of click.js section: "Re-identifies elements after scroll using ancestry context (handles virtualized DOM recycling)". The doc also mentions ancestry context in the accessibility.js section: "Builds ancestry context for each ref (role, name, parent info, ancestor content) to support re-identification after scrolling." The claim that this was undocumented was wrong.

## Verified Correct

- All 6 handlers exist and work as described (tabs, click, scroll, keyboard, scripts, accessibility)
- All Threads formatters present (router, home, activity, search)
- All Zillow formatters present (router, home, search, detail overlay, detail page)
- All 6 utilities exist (windmouse, mouse-state, cursor, scroll, timing, debugger)
- Popup UI has 4 views (Setup, Connecting, Connected, Disconnected)
- Communication protocol accurate (command/response JSON, keepalive ping/pong at 15s interval)
- All 7 permissions in manifest.json verified correct (storage, activeTab, tabs, tabGroups, debugger, scripting, webNavigation)
- Host permission `<all_urls>` present
- Connection string format verified (`vf://` + base64url-encoded JSON with `v`, `s`, `k` fields)
- WindMouse algorithm description accurate (gravity/wind forces, distance-based Hz caps, acceleration curve, path stats)
- Mouse state tracking: viewport center default on first interaction, per-tab position persistence -- all verified
- Visual cursor: SVG arrow pointer with "WebPilot" text label, RGB color-shifting outer glow (`rgbShift` keyframes), particle burst on click (12 particles), configurable linger delay before fade-out -- all verified
- Keyboard handler: character-by-character typing with keyDown+keyUp, +/-30% jitter on delay, special key map (Enter, Tab, Backspace, Escape, arrows) -- all verified
- Scripts handler: `keep_injected` mode re-injects on `webNavigation.onCompleted`, protected page blocking for `chrome://`, `chrome-extension://`, `about:` URLs -- all verified
- Debugger sessions: persistent until tab close, CDP 1.3, focus emulation enabled on attach -- all verified
- Accessibility handler: `Accessibility.getFullAXTree` for tree fetch, platform detection by hostname, ref assignment as `e1`, `e2`, etc. mapped to `backendDOMNodeId` -- all verified
- Auth failure (code 1008) clears stored config and stops retrying -- verified in `background.js` lines 187-194
- Reconnect on transient failures (code 1006) with 5-second delay -- verified in `background.js` lines 183-186 and 211-217

## Verified By

**Date**: 2026-02-25
**Method**: Line-by-line code verification of all source files in `packages/chrome-extension-unpacked/`
**Changes from previous audit**:
- Removed item #5 (element re-identification) from "Missing" section -- the doc already covers this
- Added item #3 (wrong manifest path in doc)
- Added item #4 (missing `scrollElementIntoView` from utils docs)
- Added item #8 (click handler container scroll details)
- Added item #9 (`focusNewTabs` setting undocumented for `createTab`)
- Added item #10 (version display in popup)
- Refined item #2 with note about misleading code comment in scroll handler header
- Expanded "Verified Correct" section with specific code-level evidence for each claim
