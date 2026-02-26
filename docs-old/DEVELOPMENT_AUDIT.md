# DEVELOPMENT.md Audit

Audit of `docs-old/DEVELOPMENT.md` against the actual codebase at `packages/`.

## Inaccuracies

### 1. `detectPlatform()` checks `threads.com`, not `threads.net`

**Doc claims (line 565):**
```javascript
if (hostname.includes('threads.net')) return 'threads';
```

**Actual code** in `packages/chrome-extension-unpacked/handlers/accessibility.js` line 21:
```javascript
if (hostname.includes('threads.com')) {
```

The domain is `threads.com`, not `threads.net`.

---

### 2. `organizeTab()` is called without `await` in `background.js`

**Doc claims (Step 4 example, line 209, and line 465):**
```javascript
await organizeTab(params.tab_id);
```

**Actual code** in `packages/chrome-extension-unpacked/background.js` (e.g., line 282):
```javascript
organizeTab(params.tab_id);
```

All six `organizeTab` calls in `background.js` are fire-and-forget (no `await`). The doc's Step 4 template and the "focus tab" example both incorrectly show `await`.

---

### 3. Formatter directory tree implies subdirectory nesting that does not exist

**Doc claims (lines 485-493):**
```
├── formatters/
│   ├── threads.js                     # Threads router (delegates by page type)
│   │   ├── threads_home.js
│   │   ├── threads_search.js
│   │   └── threads_activity.js
│   └── zillow.js                      # Zillow router (delegates by page type)
│       ├── zillow_home.js
│       ├── zillow_search.js
│       ├── zillow_detail.js
│       └── zillow_detail_page.js
```

**Actual structure:** All formatter files are flat in the `formatters/` directory. There are no subdirectories. The tree notation (files indented under `threads.js` and `zillow.js`) implies they are children in a subdirectory, but `threads_home.js`, `threads_search.js`, etc. are sibling files alongside `threads.js`.

Correct tree:
```
├── formatters/
│   ├── threads.js
│   ├── threads_activity.js
│   ├── threads_home.js
│   ├── threads_search.js
│   ├── zillow.js
│   ├── zillow_detail.js
│   ├── zillow_detail_page.js
│   ├── zillow_home.js
│   └── zillow_search.js
```

---

### 4. `utils/debugger.js` exports `cleanup`, not `cleanupDebugger`

**Doc claims (line 74):**
> `utils/debugger.js` - Persistent debugger session management (`getSession`, `cleanupDebugger`, `isProtectedPage`)

**Actual exports** in `packages/chrome-extension-unpacked/utils/debugger.js`:
- `getSession` (correct)
- `cleanup` (not `cleanupDebugger`)
- `isProtectedPage` (correct)

The function is named `cleanup` at source. It is aliased to `cleanupDebugger` only at the import site in `background.js` (`import { cleanup as cleanupDebugger }`). The doc should list the actual export name `cleanup`, or note the alias.

---

### 5. `detectPlatform()` returns an object, not a string

**Doc claims (lines 563-569):**
```javascript
function detectPlatform(url) {
  const hostname = new URL(url).hostname;
  if (hostname.includes('threads.net')) return 'threads';
  if (hostname.includes('zillow.com')) return 'zillow';
  if (hostname.includes('yoursite.com')) return 'yoursite';
  return null;
}
```

**Actual code** in `packages/chrome-extension-unpacked/handlers/accessibility.js` lines 17-33:
```javascript
function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes('threads.com')) {
      return { formatter: formatThreadsTree, platform: 'threads' };
    }
    if (hostname.includes('zillow.com')) {
      return { formatter: formatZillowTree, platform: 'zillow' };
    }
    return null;
  } catch {
    return null;
  }
}
```

The function returns `{ formatter, platform }` objects, not plain strings. Someone following the doc's pattern for adding a new platform would produce incompatible code.

---

## Verified Correct

- **Architecture overview (SSE + WebSocket flow):** The MCP server uses SSE for Claude Code communication and WebSocket for extension communication. Confirmed in `mcp-handler.js` (SSE endpoint, message handler) and `extension-bridge.js` (WebSocket sendCommand).
- **Protocol version `2024-11-05`:** Confirmed in `mcp-handler.js` line 310.
- **JSON-RPC 2.0 methods handled:** `initialize`, `notifications/initialized`, `tools/list`, `tools/call` all confirmed in `processMessage()`.
- **Error response format with `code` and `message`:** Confirmed at lines 341 and 349 of `mcp-handler.js`.
- **`handleToolCall` wraps results in MCP format:** Confirmed at lines 444-452, wrapping in `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`.
- **Component file table:** All four files exist at the stated paths and serve the described roles.
- **Tool list (9 tools):** All 9 tools confirmed in `mcp-handler.js` `tools` array with matching names and descriptions.
- **Handler module imports in `background.js`:** The actual imports (lines 6-14) match the doc's listing on lines 56-61, including the `type as typeText` alias for keyboard.
- **Handler files list:** All six handler files exist: `tabs.js`, `accessibility.js`, `click.js`, `scroll.js`, `keyboard.js`, `scripts.js`.
- **Utility modules list:** All six utility files exist: `debugger.js`, `mouse-state.js`, `cursor.js`, `timing.js`, `windmouse.js`, `scroll.js`.
- **`accessibility-storage.js` description:** Confirmed it stores ref-to-backendDOMNodeId mappings, provides `findRefByAncestry()`, and stores ancestry context.
- **Tab cleanup lifecycle (`onRemoved` listener):** Confirmed at `background.js` lines 330-335, calling `cleanupDebugger(tabId)`, `handleTabClosed(tabId)`, `clearRefs(tabId)`, `clearPosition(tabId)`.
- **`organizeTab` pattern - which commands call it:** Correctly identifies 6 of 9 commands. The three that skip it (`create_tab`, `close_tab`, `get_tabs`) are correct.
- **Manifest permissions:** All 7 permissions listed match `manifest.json` exactly: `storage`, `activeTab`, `tabs`, `tabGroups`, `debugger`, `scripting`, `webNavigation`. `host_permissions` with `<all_urls>` also confirmed.
- **ES module service worker:** `manifest.json` confirms `"type": "module"` in background config.
- **`fetchScriptFromUrl` in `mcp-handler.js`:** Confirmed. The server fetches script content and sends it to the extension as `script_content`, not the URL.
- **Message format (Server to Extension and Extension to Server):** Confirmed by `extension-bridge.js` `sendCommand()` (sends `{ id, type, params }`) and `handleResponse()` (expects `{ id, success, result }` or `{ id, success: false, error }`).
- **Debugger pattern (persistent sessions, `getSession`, `isProtectedPage`):** All confirmed in `utils/debugger.js`.
- **Formatter return format (tree, elementCount, refs):** Confirmed in `handlers/accessibility.js` which consumes `formatted.refs`, `formatted.tree`, `formatted.elementCount`.
- **Formatter router pattern:** Both `threads.js` and `zillow.js` export a single top-level function that delegates to page-specific sub-formatters. Confirmed.
