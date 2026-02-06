# Vantage Feed MCP Integration Guide

Reference documentation for AI agents integrating with the Vantage Feed browser control MCP server.

## Overview

The Vantage Feed MCP server provides browser tab control capabilities to AI agents via the Model Context Protocol (MCP). Agents can list, open, and close browser tabs in the user's Chrome browser.

## Available Tools

### browser_get_tabs

Lists all open browser tabs.

**Parameters:** None

**Returns:**
```json
[
  {
    "id": 1062346368,
    "url": "https://example.com/page",
    "title": "Page Title",
    "active": true,
    "windowId": 1062346367,
    "groupId": 2072108014
  }
]
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique tab identifier. Use this for close_tab. |
| `url` | string | Current URL of the tab |
| `title` | string | Page title |
| `active` | boolean | True if this is the currently focused tab |
| `windowId` | number | Browser window containing this tab |
| `groupId` | number \| null | Tab group ID, or null if not in a group |

**Notes:**
- Tab IDs are stable for the lifetime of the tab
- Navigating to a new URL within the same tab keeps the same ID
- Tab IDs only change when the tab is closed and a new one is opened
- Tabs interacted with via VantageFeed are automatically grouped into a cyan "VantageFeed" tab group

---

### browser_create_tab

Opens a new browser tab with the specified URL.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | The URL to open |

**Returns:**
```json
{
  "tab_id": 1062346731,
  "url": "https://example.com",
  "title": ""
}
```

**Notes:**
- Title may be empty if the page hasn't finished loading
- The new tab becomes the active tab
- Returns the new tab's ID for future reference

---

### browser_close_tab

Closes a browser tab by its ID.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tab_id` | number | Yes | The tab ID to close |

**Returns:**
```json
{
  "success": true
}
```

**Errors:**
- `No tab with id: {id}` - Tab doesn't exist or was already closed

**Notes:**
- Tab IDs remain stable even through navigation and redirects
- Only need to re-fetch if unsure whether tab was manually closed by user

---

### browser_get_accessibility_tree

Gets the accessibility tree (a11y DOM) of a browser tab. Returns a structured representation of the page content that's useful for understanding page structure and content.

**Parameters:**
| Parameter | Type   | Required | Description                    |
|-----------|--------|----------|--------------------------------|
| `tab_id`  | number | Yes      | The tab ID to get the tree from |
| `usePlatformOptimizer` | boolean | No | Use platform-specific formatting if available (default: false) |

**Returns (default):**
```json
{
  "tree": "- RootWebArea \"Page Title\" [ref=e1] [focusable, url=https://example.com]\n  - navigation [ref=e2]\n    - link \"Home\" [ref=e3] [focusable, url=/]\n    - link \"About\" [ref=e4] [focusable, url=/about]\n  - main [ref=e5]\n    - heading \"Welcome\" [ref=e6] [level=1]\n    - button \"Sign Up\" [ref=e7] [focusable]\n    - textbox \"Email\" [ref=e8] [focusable]",
  "elementCount": 8
}
```

**Returns (with usePlatformOptimizer=true on Threads Home):**
```json
{
  "tree": "{\"source\":{\"title\":\"Home • Threads\",\"url\":\"https://www.threads.com/\"},\"nav\":[[\"Home\",\"e1\",\"https://www.threads.com/\"],...],\"_postSchema\":[\"url\",\"content\",\"time\",\"likes\",\"replies\",\"likeRef\",\"replyRef\"],\"posts\":[[\"https://www.threads.com/@user/post/xyz\",\"Post content...\",1768800840000,16,10,\"e6\",\"e7\"],...],\"_ghostSchema\":[\"authorUrl\",\"content\",\"expires\",\"likeRef\"],\"ghosts\":[[\"https://www.threads.com/@user\",\"Ghost content...\",1768846806591,\"e22\"]]}",
  "elementCount": 69,
  "postCount": 32,
  "ghostCount": 1,
  "platform": "threads"
}
```

**Returns (with usePlatformOptimizer=true on Threads Activity):**
```json
{
  "tree": "{\"source\":{\"title\":\"Activity • Threads\",\"url\":\"https://www.threads.com/activity\"},\"nav\":[...],\"activity\":{\"_followSchema\":[\"user\",\"others\",\"time\",\"ref\"],\"follows\":[],\"_likeSchema\":[\"user\",\"others\",\"time\",\"postUrl\",\"postPreview\",\"ref\"],\"likes\":[[\"zryork\",2,1768772938224,\"https://...\",\"post preview\",\"e10\"]],...}}",
  "elementCount": 37,
  "activityCount": 17,
  "platform": "threads"
}
```

**Returns (with usePlatformOptimizer=true on Threads Search Landing):**
```json
{
  "tree": "{\"source\":{\"title\":\"Search • Threads\",\"url\":\"https://www.threads.com/search\"},\"nav\":[...],\"searchRef\":\"e6\",\"filterRef\":\"e7\",\"_trendSchema\":[\"description\",\"posts\",\"ref\"],\"trends\":[[\"Green Day to open Super Bowl with bold statement.\",\"1M\",\"e10\"],...],\"_suggestionSchema\":[\"profileUrl\",\"bio\",\"followers\",\"followRef\",\"profileRef\"],\"suggestions\":[[\"https://www.threads.com/@thestevenmellor\",\"Steve Mellor | Growth Marketing\",null,\"e23\",\"e24\"],...]}",
  "elementCount": 72,
  "platform": "threads"
}
```

**Returns (with usePlatformOptimizer=true on Threads Search Autocomplete):**
```json
{
  "tree": "{\"source\":{\"title\":\"Search • Threads\",\"url\":\"https://www.threads.com/search\"},\"nav\":[...],\"searchRef\":\"e6\",\"_threadsSchema\":[\"name\",\"members\",\"recentPosts\",\"url\",\"ref\"],\"threads\":[],\"_searchTermsSchema\":[\"query\",\"url\",\"ref\"],\"searchTerms\":[[\"buildinpublic\",\"https://www.threads.com/search?q=buildinpublic&serp_type=default\",\"e7\"]],\"_profileSchema\":[\"username\",\"displayName\",\"verified\",\"following\",\"url\",\"ref\",\"followRef\"],\"profiles\":[[\"buildforpublic\",\"#buildinpublic\",false,false,\"https://www.threads.com/@buildforpublic\",\"e9\",\"e8\"],...]}",
  "elementCount": 27,
  "threadCount": 0,
  "termCount": 1,
  "profileCount": 10,
  "platform": "threads"
}
```

**Returns (with usePlatformOptimizer=true on Threads Search Results):**
```json
{
  "tree": "{\"source\":{\"title\":\"Search • Threads\",\"url\":\"https://www.threads.com/search?q=AI&serp_type=default\"},\"nav\":[...],\"filter\":\"Top\",\"_postSchema\":[\"url\",\"content\",\"time\",\"likes\",\"replies\",\"reposts\",\"shares\",\"likeRef\",\"replyRef\",\"tags\"],\"posts\":[[\"https://www.threads.com/@user/post/xyz\",\"Post content about AI...\",1737295920000,47,34,0,0,\"e20\",\"e21\",[\"AI Threads\"]],...]}",
  "elementCount": 120,
  "postCount": 15,
  "filter": "Top",
  "platform": "threads"
}
```

**Response Fields:**
| Field | Description |
|-------|-------------|
| `tree` | JSON string representation of page content (format depends on platform/page type) |
| `elementCount` | Total number of interactive elements with refs |
| `postCount` | (Threads home/profile/search results) Number of posts extracted |
| `ghostCount` | (Threads home/profile) Number of ghost posts extracted |
| `activityCount` | (Threads activity) Total activity items extracted |
| `trendCount` | (Threads search landing) Number of trending topics extracted |
| `suggestionCount` | (Threads search landing) Number of follow suggestions extracted |
| `threadCount` | (Threads search autocomplete) Number of thread/community suggestions |
| `termCount` | (Threads search autocomplete) Number of search term suggestions |
| `profileCount` | (Threads search autocomplete) Number of profile suggestions |
| `filter` | (Threads search results) Active filter: "Top", "Recent", or "Profiles" |
| `platform` | (When optimizer used) Detected platform name |

**Tree Format (default):**
Each line represents an element with:
- **Indentation** - Shows parent/child hierarchy
- **Role** - The element type (link, button, heading, etc.)
- **Name** - The accessible name in quotes (truncated to 80 chars)
- **Ref** - Element reference `[ref=eN]` for future interaction
- **Properties** - Relevant attributes like `[focusable]`, `[level=1]`, `[url=...]`

**Platform Optimizers:**
When `usePlatformOptimizer=true`, the tool auto-detects the platform and applies specialized formatting:

| Platform | Page | Detection | Output Format |
|----------|------|-----------|---------------|
| Threads | Home/Profile | `threads.com` (default) | JSON with nav, posts array (url, content, timestamp, likes, replies, refs), ghosts array (ephemeral posts without /post/ URLs) |
| Threads | Activity | `threads.com/activity` | JSON with nav, activity object (follows, likes, milestones, replies, polls) |
| Threads | Search Landing | `threads.com/search` (no query) | JSON with nav, searchRef, filterRef, trends array (description, posts, ref), suggestions array (profileUrl, bio, followers, followRef, profileRef) |
| Threads | Search Autocomplete | `threads.com/search` (typing) | JSON with nav, searchRef, threads array (community suggestions), searchTerms array (query suggestions), profiles array (profile suggestions with follow refs) |
| Threads | Search Results | `threads.com/search?q=...` | JSON with nav, filter (Top/Recent/Profiles), filters array (with refs), posts array (url, content, time, likes, replies, reposts, shares, refs, tags) |

**Ghost Posts:**
Ghost posts are ephemeral content on Threads that appear inline but don't have permanent `/post/` URLs. They have an expiration time (e.g., "9h left") and are captured separately from regular posts:
- `authorUrl`: Profile URL of the ghost post author
- `content`: Post text content
- `expires`: Unix timestamp when the ghost post expires
- `likeRef`: Element ref for the Like button

**Element Refs:**
Refs (e1, e2, e3...) are stable identifiers for each element. These can be used for future interaction tools like `browser_click(ref="e7")`.

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `Another debugger is already attached to this tab` - DevTools or another extension is debugging the tab
- `Failed to attach debugger: ...` - Tab may not exist or be a protected page (chrome://, etc.)

**Notes:**
- Uses Chrome DevTools Protocol via the debugger API
- A debugger banner will briefly appear on the tab while fetching
- Cannot access protected pages (chrome://, chrome-extension://, etc.)
- Response is optimized for LLM consumption (~97% smaller than raw CDP output)
- Ignored nodes and empty generic elements are filtered out

---

### browser_inject_script

Injects a script from a URL into a browser tab. The MCP server fetches the script content and injects it into the page context.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tab_id` | number | Yes | The tab ID to inject into |
| `script_url` | string | Yes | URL to fetch script from (localhost or external) |
| `keep_injected` | boolean | No | If true, auto re-inject when page navigates (default: false) |

**Returns:**
```json
{
  "success": true,
  "tab_id": 1234567890,
  "injected": true,
  "persistent": false
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether injection succeeded |
| `tab_id` | number | The tab ID that was injected into |
| `injected` | boolean | Whether script was injected |
| `persistent` | boolean | Whether script will be re-injected on navigation |

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `script_content is required` - Script fetch returned empty content
- `Cannot inject scripts into protected pages` - Tab is chrome://, chrome-extension://, or about: URL
- `Unsupported protocol: ...` - Script URL uses non-HTTP(S) protocol
- `HTTP 404 Not Found` - Script URL returned error
- `Script fetch timeout` - Fetch took longer than 10 seconds

**Notes:**
- Uses Chrome Debugger Protocol (Runtime.evaluate) to bypass CSP/Trusted Types restrictions
- Works on all sites including those with strict security policies (e.g., Threads, Facebook)
- With `keep_injected=true`, script persists across navigation until tab is closed
- Server fetches the script, so localhost URLs work even if page can't access them
- Chrome shows a yellow "started debugging" banner; suppress with `--silent-debugger-extension-api` flag

---

### browser_execute_js

Executes JavaScript code in the page context and returns the result.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tab_id` | number | Yes | The tab ID to execute in |
| `code` | string | Yes | JavaScript code to execute |

**Returns:**
```json
{
  "success": true,
  "tab_id": 1234567890,
  "result": "value returned by code"
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether execution succeeded |
| `tab_id` | number | The tab ID executed in |
| `result` | any | Return value of the code (must be JSON-serializable) |

**Example Usage:**
```
// Get page title
browser_execute_js(tab_id, 'document.title')
→ { "success": true, "result": "Example Page" }

// Arithmetic
browser_execute_js(tab_id, '1 + 1')
→ { "success": true, "result": 2 }

// Check a variable
browser_execute_js(tab_id, 'window.MY_VAR')
→ { "success": true, "result": "some value" }

// Return object
browser_execute_js(tab_id, '({ foo: "bar", count: 42 })')
→ { "success": true, "result": { "foo": "bar", "count": 42 } }
```

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `code is required` - Missing code parameter
- `Cannot execute scripts on protected pages` - Tab is chrome://, chrome-extension://, or about: URL
- `Another debugger is already attached to this tab` - Close DevTools or other debuggers first
- JavaScript errors from the code (e.g., `ReferenceError: x is not defined`)

**Notes:**
- Uses Chrome Debugger Protocol (Runtime.evaluate) - works like DevTools console
- Code is evaluated as an expression, not a function body (no `return` needed)
- Works on all sites including those with strict CSP/Trusted Types
- Return value must be JSON-serializable (no functions, DOM elements, etc.)
- Chrome shows a yellow "started debugging" banner; suppress with `--silent-debugger-extension-api` flag

---

### browser_click

Clicks at specific coordinates in a browser tab using CDP mouse simulation. Simulates real mouse press and release events with an optional visual cursor indicator.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tab_id` | number | Yes | The tab ID to click in |
| `ref` | string | No* | Accessibility tree ref (e.g., "e1", "e2"). Requires prior tree fetch. |
| `selector` | string | No* | CSS selector to find and click (element center). |
| `x` | number | No* | X coordinate to click |
| `y` | number | No* | Y coordinate to click |
| `button` | string | No | Mouse button: `left`, `right`, or `middle` (default: `left`) |
| `clickCount` | number | No | Number of clicks, use 2 for double-click (default: 1) |
| `delay` | number | No | Override delay in ms between press and release. If not provided, uses weighted random 10-90ms |
| `showCursor` | boolean | No | Show visual cursor indicator on screen (default: true) |

*Either `ref`, `selector`, or both `x` and `y` must be provided.

**Returns:**
```json
{
  "success": true,
  "tab_id": 1234567890,
  "ref": "e7",
  "selector": null,
  "x": 150,
  "y": 300,
  "button": "left",
  "clickCount": 1,
  "delay": 67,
  "lingerDelay": 521,
  "scrolled": false,
  "path": {
    "points": 31,
    "duration": 218,
    "avgHz": 142,
    "minHz": 53,
    "maxHz": 333
  },
  "startPosition": {
    "x": 379,
    "y": 365
  }
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether click succeeded |
| `tab_id` | number | The tab ID clicked in |
| `ref` | string | The ref that was clicked (if provided) |
| `selector` | string | The selector that was clicked (if provided) |
| `x` | number | X coordinate clicked (resolved from ref/selector if used) |
| `y` | number | Y coordinate clicked (resolved from ref/selector if used) |
| `button` | string | Mouse button used |
| `clickCount` | number | Number of clicks performed |
| `delay` | number | Actual delay used between press and release (ms) |
| `lingerDelay` | number | Cursor linger time after click before fade (ms) |
| `scrolled` | boolean | Whether auto-scroll was performed to bring element into view |
| `path.points` | number | Number of points in the WindMouse path |
| `path.duration` | number | Total path duration in ms |
| `path.avgHz` | number | Average polling rate during movement |
| `path.minHz` | number | Minimum Hz (at start/end of movement) |
| `path.maxHz` | number | Maximum Hz reached (at peak speed) |
| `startPosition` | object | Where the cursor started from `{x, y}` |

**Example Usage:**
```
// Click by accessibility tree ref (recommended for interactive elements)
browser_click(tab_id, ref="e7")
→ { "success": true, "ref": "e7", "x": 150, "y": 300, ... }

// Click by CSS selector
browser_click(tab_id, selector="#submit-btn")
→ { "success": true, "selector": "#submit-btn", "x": 200, "y": 400, ... }

// Click by selector with double-click
browser_click(tab_id, selector="a.nav-link", clickCount=2)
→ { "success": true, "clickCount": 2, ... }

// Basic click by coordinates
browser_click(tab_id, x=150, y=300)
→ { "success": true, "x": 150, "y": 300, "button": "left", "delay": 72 }

// Right-click (context menu)
browser_click(tab_id, ref="e5", button="right")
→ { "success": true, "button": "right", ... }

// Click without visual cursor (faster, no animation)
browser_click(tab_id, ref="e3", showCursor=false)
→ { "success": true, ... }

// Fixed delay (deterministic timing)
browser_click(tab_id, x=150, y=300, delay=100)
→ { "success": true, "delay": 100, ... }
```

**Visual Cursor & WindMouse Algorithm:**
By default, a visual cursor follows a human-like path using the WindMouse algorithm:
- Cursor starts from **last click position** (or viewport center on first interaction)
- Uses **WindMouse algorithm** for natural, slightly curved paths with wind/gravity forces
- **Distance-based Hz caps** for realistic speed:
  - < 300px: max 250Hz
  - < 800px: max 500Hz
  - ≥ 1200px: max 1000Hz
- **Acceleration curve**: slow start → peak speed at 50-80% → slow end
- Both visual cursor and CDP `mouseMoved` events are dispatched for each path point
- SVG arrow pointer with "VantageFeed" text label:
  - Arrow: black fill, white stroke, RGB color-shifting outer glow
  - Text: black fill, white stroke, RGB color-shifting outer glow (synced with arrow)
  - Text positioned to the right of cursor, vertically centered
- Twitter-like particle burst animation on click (colored circles explode outward)
- Lingers briefly (800-1500ms), then fades out
- Position persists across page refreshes (tracked per tab ID)
- Set `showCursor: false` to disable visual cursor (CDP events still dispatched)

**Delay Behavior:**
- If `delay` is not provided, uses a weighted random delay between 10-90ms
- Distribution favors longer delays (~75% fall in 50-90ms range)
- This simulates natural human click timing
- Provide explicit `delay` for deterministic behavior

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `Either selector, ref, or x,y coordinates are required` - No click target provided
- `Ref "eX" not found. Fetch accessibility tree first.` - Ref doesn't exist in stored refs
- `Element for ref "eX" no longer exists in DOM` - Page changed since tree fetch
- `Element not found: <selector>` - CSS selector matched nothing
- `Element has no dimensions` - Matched element is hidden or zero-size
- `button must be left, right, or middle` - Invalid button value
- `Another debugger is already attached to this tab` - Close DevTools first
- `Failed to attach debugger: ...` - Tab may not exist or be protected

**Notes:**
- Uses Chrome DevTools Protocol Input.dispatchMouseEvent
- Sends mousePressed followed by mouseReleased events
- Works on all sites including those with strict CSP
- Coordinates are relative to the viewport (not the page)
- Chrome shows a yellow "started debugging" banner; suppress with `--silent-debugger-extension-api` flag

**Auto-scroll & Element Re-identification:**

If the target element is off-screen, the click handler automatically:
1. Scrolls the page smoothly to bring the element into view
2. Waits 150ms for the page to settle (React re-renders, lazy loading, etc.)
3. Verifies the element is still valid after scroll
4. Re-identifies the element if it was recycled (common in virtualized lists)

**Virtualized List Handling:**

Sites like Threads and Twitter use virtualized rendering - only visible posts exist in the DOM. When scrolling:
- DOM nodes are recycled (removed from DOM and reused for new content)
- The original `backendNodeId` may point to different content or be invalid

The click handler solves this with **ancestry-based re-identification**:
- When the accessibility tree is fetched, each element's structural context is stored (role, name, parent info, ancestor content)
- After scroll, if the element changed, the handler re-fetches the tree
- It finds the element again by matching its ancestry context (e.g., "button inside group inside post containing 'specific post text...'")
- The click then proceeds with the new correct coordinates

This happens automatically - agents just call `browser_click(ref="e16")` and the handler manages scroll + re-identification transparently.

---

### browser_scroll

Scroll to element OR by pixel amount. Uses smooth easing (50ms per 50px).

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tab_id` | number | Yes | The tab ID to scroll in |
| `ref` | string | No* | Accessibility tree ref (mutually exclusive with pixels) |
| `selector` | string | No* | CSS selector (mutually exclusive with pixels) |
| `pixels` | number | No* | Pixels to scroll, positive=down, negative=up (mutually exclusive with ref/selector) |

*Provide EITHER `ref`/`selector` OR `pixels`, not both.

**Returns:**
```json
{
  "success": true,
  "scrolled": true,
  "tab_id": 1234567890,
  "ref": "e50",
  "selector": null,
  "scrollDelta": 1250,
  "duration": 600
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether scroll operation completed |
| `scrolled` | boolean | Whether scrolling was needed (false if already in view) |
| `tab_id` | number | The tab ID scrolled in |
| `ref` | string | The ref that was scrolled to (if provided) |
| `selector` | string | The selector that was scrolled to (if provided) |
| `scrollDelta` | number | Pixels scrolled (positive = down, negative = up) |
| `duration` | number | Animation duration used (ms) |

**Example Usage:**
```
// Scroll to element by ref
browser_scroll(tab_id, ref="e50")
→ { "success": true, "scrolled": true, "scrollDelta": 1250, "duration": 1250 }

// Scroll by pixel amount
browser_scroll(tab_id, pixels=500)   // scroll down 500px
→ { "success": true, "scrolled": true, "scrollDelta": 500, "duration": 500 }

browser_scroll(tab_id, pixels=-300)  // scroll up 300px
→ { "success": true, "scrolled": true, "scrollDelta": -300, "duration": 300 }

// Element already visible
browser_scroll(tab_id, ref="e5")
→ { "success": true, "scrolled": false, "reason": "already in view" }
```

**Scroll Animation:**
- Uses `requestAnimationFrame` for native-smooth 60fps animation
- Duration auto-calculated: 50ms per 50px of scroll distance
- Cubic ease-in-out for natural feel (slow start → fast middle → slow end)
- Centers element in viewport when using ref/selector

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `Either ref or selector is required` - No scroll target provided
- `Ref "eX" not found. Fetch accessibility tree first.` - Ref doesn't exist
- `Element for ref "eX" no longer exists` - Page changed since tree fetch
- `Could not determine element position` - Element couldn't be located

**Notes:**
- Uses incremental `window.scrollTo()` for smooth animation
- Element is centered in viewport after scroll
- Does not show a visual cursor (use browser_click for that)
- Works on all sites including those with strict CSP
- `browser_click` automatically scrolls if target is off-screen; use this tool for scroll-only operations

---

### browser_type

Type text into the focused element or element specified by ref/selector. Uses CDP keyboard simulation for real keystrokes that work with React and other frameworks.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tab_id` | number | Yes | The tab ID to type in |
| `text` | string | Yes | The text to type |
| `ref` | string | No | Accessibility tree ref to click first to focus |
| `selector` | string | No | CSS selector to click first to focus |
| `delay` | number | No | Delay between keystrokes in ms (default: 50) |
| `pressEnter` | boolean | No | Press Enter key after typing (default: false) |

**Returns:**
```json
{
  "success": true,
  "tab_id": 1234567890,
  "text": "AI",
  "charCount": 2,
  "ref": "e6",
  "selector": null,
  "pressEnter": false
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Whether typing succeeded |
| `tab_id` | number | The tab ID typed in |
| `text` | string | The text that was typed |
| `charCount` | number | Number of characters typed |
| `ref` | string | The ref that was clicked to focus (if provided) |
| `selector` | string | The selector that was clicked to focus (if provided) |
| `pressEnter` | boolean | Whether Enter was pressed after typing |

**Example Usage:**
```
// Type into focused element
browser_type(tab_id, text="Hello world")
→ { "success": true, "text": "Hello world", "charCount": 11 }

// Click element first, then type (recommended for search boxes)
browser_type(tab_id, text="AI", ref="e6")
→ { "success": true, "text": "AI", "charCount": 2, "ref": "e6" }

// Type and press Enter (submit search)
browser_type(tab_id, text="machine learning", ref="e6", pressEnter=true)
→ { "success": true, "text": "machine learning", "pressEnter": true }

// Slower typing (more human-like)
browser_type(tab_id, text="test", delay=100)
→ { "success": true, "text": "test", "charCount": 4 }
```

**Keyboard Simulation:**
- Uses Chrome DevTools Protocol `Input.dispatchKeyEvent`
- Dispatches `keyDown` and `keyUp` events for each character
- Supports special keys: Enter, Tab, Backspace, Escape, Arrow keys
- Works with React, Vue, and other SPA frameworks (unlike setting `input.value` directly)
- Human-like timing with slight random variance on delay

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `text is required` - Missing text parameter
- `Ref "eX" not found. Fetch accessibility tree first.` - Ref doesn't exist
- `Another debugger is already attached to this tab` - Close DevTools first

**Notes:**
- If `ref` or `selector` is provided, the element is clicked first to focus it
- Delay has ±30% random variance for human-like typing
- Chrome shows a yellow "started debugging" banner during typing
- For filling forms, prefer this over `browser_execute_js` with DOM manipulation

---

## Common Patterns

### Find and Close a Tab by URL

```
1. Call browser_get_tabs
2. Filter results to find tab with matching URL
3. Call browser_close_tab with the tab's id
```

### Open a Page and Track It

```
1. Call browser_create_tab with URL
2. Store the returned tab_id
3. Later, use tab_id to close or reference the tab
```

### Check if a URL is Already Open

```
1. Call browser_get_tabs
2. Check if any tab.url matches your target URL
3. If found, you may want to focus it instead of opening a duplicate
```

---

## Window Management

All tabs have a `windowId` that identifies which browser window they belong to.

- Tabs in the same window share the same `windowId`
- Multiple windows will have different `windowId` values
- Use `windowId` to group tabs by window when needed

---

## Error Handling

### Tab Not Found

If you try to close a tab that doesn't exist:
```json
{
  "error": "No tab with id: 1234567"
}
```

**Cause:** Tab was already closed by the user.

**Solution:** Re-fetch tabs with `browser_get_tabs` to get current state.

### Extension Not Connected

If the Chrome extension is not connected to the MCP server:
```json
{
  "error": "Browser extension not connected"
}
```

**Solution:** User needs to open the extension popup and click "Reconnect".

---

## Best Practices

1. **Tab IDs are reliable** - Once you have a tab ID, it won't change even through navigation and redirects

2. **Check for duplicates** before opening a new tab - Use `browser_get_tabs` to see if the URL is already open

3. **Don't assume tab order** - Tabs may not be returned in visual order

4. **Use full URLs** - When opening tabs, include protocol (https://)

---

## Example Agent Workflow

### Research Assistant

An agent that opens research pages and manages tabs:

```
User: "Find information about TypeScript generics"

Agent:
1. browser_create_tab("https://www.typescriptlang.org/docs/handbook/2/generics.html")
2. browser_create_tab("https://stackoverflow.com/questions/tagged/typescript-generics")
3. Store tab IDs for later cleanup

User: "Close the research tabs"

Agent:
1. browser_get_tabs() to verify current state
2. browser_close_tab(tab_id_1)
3. browser_close_tab(tab_id_2)
```

### Tab Cleanup Assistant

An agent that helps organize tabs:

```
User: "Close all my social media tabs"

Agent:
1. browser_get_tabs()
2. Filter for tabs with URLs containing twitter.com, facebook.com, etc.
3. browser_close_tab() for each matching tab
4. Report what was closed
```

---

## Configuration

### Adding to Claude Code

```bash
claude mcp add -s project --transport sse vantage-feed "http://localhost:3456/sse"
```

### Prerequisites

1. MCP server running (`npm run dev` in `mcp-server/`)
2. Chrome extension loaded and connected
3. Extension shows "Connected" status

---

## Limitations

- **Accessibility tree only** - Content access via accessibility tree, not raw HTML/DOM
- **No navigation control** - Cannot go back/forward or refresh tabs
- **Chrome only** - Extension only works in Chrome/Chromium browsers
- **Single browser** - Controls the browser where extension is installed
- **Protected pages** - Cannot access chrome://, chrome-extension://, about:, or other protected URLs
- **JS return values** - Return values from `browser_execute_js` must be JSON-serializable
