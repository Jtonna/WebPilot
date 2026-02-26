# CHROME_EXTENSION.md — Audit

## Inaccuracies

### 1. Tab Organization Function Misnamed
- **Doc says**: `addTabToGroup(tabId)` is "called automatically when any command interacts with a tab"
- **Reality**: The function called is `organizeTab(params.tab_id)` (from handlers/tabs.js), which is an orchestrator that routes to either window or group mode based on the `tabMode` setting. `addTabToGroup` exists but is only one path within `organizeTab`.

### 2. Scroll Duration Partially Wrong
- **Doc says**: "Duration auto-calculated: 50ms per 50px of scroll distance" (implying all scrolls)
- **Reality**: Window scrolls use 50ms per 50px, but container scrolls (dropdowns, modals) use 75ms per 50px. The doc only covers one timing mode.

## Missing from Documentation

### 3. Window Mode Tab Organization
- The extension supports two tab organization modes: 'group' (default, uses tab groups) and 'window' (moves tabs to a dedicated WebPilot window). This is configurable in the popup settings but completely undocumented.

### 4. Popup Settings UI
- When connected/disconnected, the popup shows a settings section with:
  - Toggle: "Focus new tabs" (defaults to false)
  - Select: "Tab organization" with options "Existing window" (group) or "New window"
- Not documented.

### 5. Element Re-identification After Scroll
- Click handler has sophisticated ancestry-based element re-identification for handling virtualized DOM after scrolling. Not documented.

### 6. Scrollable Container Support
- Scroll handler detects and handles scrollable containers (dropdowns, modals) separately from window scrolling, with different timing. Not documented as a distinct feature.

## Verified Correct

- All 6 handlers exist and work as described (tabs, click, scroll, keyboard, scripts, accessibility)
- All Threads formatters present (router, home, activity, search)
- All Zillow formatters present (router, home, search, detail overlay, detail page)
- All 6 utilities exist (windmouse, mouse-state, cursor, scroll, timing, debugger)
- Popup UI has 4 views (Setup, Connecting, Connected, Disconnected)
- Communication protocol accurate (command/response JSON, keepalive ping/pong)
- All permissions in manifest.json verified correct
- Connection string format verified (`vf://` + base64url JSON)
