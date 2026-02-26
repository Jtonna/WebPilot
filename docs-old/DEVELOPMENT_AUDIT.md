# DEVELOPMENT.md Audit

## Inaccuracies

### 1. File paths use wrong package names

The doc references paths like `mcp-server/src/mcp-handler.js` and `unpacked-extension/background.js`. The actual paths are:

| Doc says | Actual path |
|----------|-------------|
| `mcp-server/src/mcp-handler.js` | `packages/server-for-chrome-extension/src/mcp-handler.js` |
| `mcp-server/src/extension-bridge.js` | `packages/server-for-chrome-extension/src/extension-bridge.js` |
| `unpacked-extension/background.js` | `packages/chrome-extension-unpacked/background.js` |
| `unpacked-extension/manifest.json` | `packages/chrome-extension-unpacked/manifest.json` |
| `unpacked-extension/accessibility-tree.js` | `packages/chrome-extension-unpacked/accessibility-tree.js` |
| `unpacked-extension/formatters/threads.js` | `packages/chrome-extension-unpacked/formatters/threads.js` |

### 2. Architecture diagram says "Default YAML formatter" for accessibility-tree.js

The doc states `accessibility-tree.js` is a "Default YAML formatter." The actual output format is an indented plaintext tree using `- role "name" [ref=eN]` syntax, not YAML. There is no YAML serialization anywhere in the file.

### 3. Doc says background.js has a `handleServerCommand` switch with inline handler functions

The doc's Step 3 shows handlers as functions defined directly in `background.js`:

```javascript
case 'your_command_type':
  result = await yourHandlerFunction(params);
  break;
```

In reality, `background.js` is a thin orchestrator that imports handler functions from separate modules under `handlers/`:

```javascript
import { createTab, closeTab, getTabs, organizeTab } from './handlers/tabs.js';
import { getAccessibilityTree } from './handlers/accessibility.js';
import { click } from './handlers/click.js';
// etc.
```

New handlers should be created as separate files in `packages/chrome-extension-unpacked/handlers/`, not added inline to `background.js`.

### 4. Doc's "6-step" process is actually 8 steps in its own checklist

The narrative describes a 4-step process (Steps 1-4), but the checklist section at line 159 lists 8 items (tool array, handleToolCall, permissions, handleServerCommand case, handler function, README, MCP_INTEGRATION, test). The introduction calls it a "6-step process" but neither count matches.

### 5. `handleToolCall` uses if/else-if, not a switch statement

The doc says to "Add case to `handleToolCall` switch" (line 61). Looking at the actual code, `handleToolCall` does use a `switch` statement on `name` (line 363). This is correct. However, `processMessage` uses `if`/`else if` chains (lines 305-350), not a switch. The doc does not mention `processMessage` directly so this is minor, but worth noting for completeness.

### 6. Formatter function naming convention is wrong

The doc says to create a function called `formatSiteTree(nodes)`. The actual convention in the codebase is:

- `formatThreadsTree(nodes)` in `formatters/threads.js`
- `formatZillowTree(nodes)` in `formatters/zillow.js`

The naming pattern is `format<Platform>Tree`, not `formatSiteTree`.

### 7. Doc's site-specific formatter example does not match actual architecture

The doc (line 457-495) shows a standalone handler function `getSiteFeed` that fetches the accessibility tree, detects the URL, calls `getSession()`, and calls the formatter directly. This is not how it works.

In reality, platform detection and formatter routing happen inside `handlers/accessibility.js` via the `detectPlatform()` function, which is called from `getAccessibilityTree()`. There are no separate `get_<site>_feed` command types or MCP tools per site. Instead, the existing `browser_get_accessibility_tree` tool has a `usePlatformOptimizer` parameter that auto-detects the platform from the tab URL and routes to the appropriate formatter.

The doc's claim that "Each formatter gets its own dedicated MCP tool rather than auto-routing by URL" (line 373) is the **opposite** of what the code does. The code auto-routes by URL within a single tool.

### 8. Formatter return format is incomplete

The doc says formatters return `{ tree, elementCount }`. The actual formatters return additional fields:

- `refs` (required): A map of `ref -> backendDOMNodeId` used by `accessibility-storage.js` for click/scroll targeting
- `postCount`, `listingCount`, `activityCount`, `ghostCount` (platform-specific counts)

The `refs` field is critical and omitting it would break click/scroll functionality.

### 9. Doc's formatter template uses `getRef(nodeId)` but actual code uses `getRef(node)`

The doc shows `getRef(nodeId)` taking a node ID. The actual implementations pass the full node object: `getRef(node)` which accesses `node.nodeId` and `node.backendDOMNodeId` internally.

### 10. Manifest permissions list is incomplete

The doc lists `storage`, `activeTab`, `tabs` as the base permissions (line 75). The actual `manifest.json` also includes `tabGroups`, `debugger`, `scripting`, and `webNavigation` in the base set. The doc mentions `debugger` and `scripting` only as "common permissions to add" rather than acknowledging they are already present.

### 11. Focus tab example would not work as-is

The example adds handler code directly in `background.js`. Given the modular architecture (handlers in separate files under `handlers/`), the handler should be in `handlers/tabs.js` or a new handler file, then imported in `background.js`. Also, `background.js` calls `organizeTab(params.tab_id)` after most commands -- the example omits this pattern.

### 12. Doc says `handleToolCall` is a "switch" -- this is technically correct

The doc's description of adding a case to the `handleToolCall` switch matches the actual code structure (it is a switch on `name`). However, the doc omits the fact that `handleToolCall` wraps results in `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }` before returning, which is the MCP protocol's required response format.

---

## Missing from Documentation

### 1. Handler module architecture

The doc does not mention the `handlers/` directory or the modular pattern. Actual handler files:
- `handlers/tabs.js` - createTab, closeTab, getTabs, organizeTab
- `handlers/accessibility.js` - getAccessibilityTree (includes platform detection)
- `handlers/click.js` - click
- `handlers/scroll.js` - scroll
- `handlers/keyboard.js` - type
- `handlers/scripts.js` - injectScript, executeJs, handleNavigationComplete, handleTabClosed

### 2. Utility modules

The doc does not mention these utility modules:
- `utils/debugger.js` - Persistent debugger session management (mentioned but path is wrong)
- `utils/mouse-state.js` - Mouse position tracking
- `utils/cursor.js` - Visual cursor rendering
- `utils/timing.js` - Timing utilities
- `utils/windmouse.js` - Natural mouse movement simulation
- `utils/scroll.js` - Scroll utilities

### 3. `accessibility-storage.js` module

Not mentioned. This module stores ref-to-backendDOMNodeId mappings and ancestry context, critical for click/scroll-by-ref functionality.

### 4. `organizeTab()` pattern

After most commands, `background.js` calls `organizeTab(params.tab_id)`. This is not documented but is a consistent pattern a new tool author should follow.

### 5. Tab cleanup lifecycle

The doc does not mention the cleanup listeners:
```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupDebugger(tabId);
  handleTabClosed(tabId);
  clearRefs(tabId);
  clearPosition(tabId);
});
```
New features that store per-tab state must add cleanup here.

### 6. Existing tools not mentioned

The doc does not list the 9 actual tools: `browser_create_tab`, `browser_close_tab`, `browser_get_tabs`, `browser_get_accessibility_tree`, `browser_inject_script`, `browser_execute_js`, `browser_click`, `browser_scroll`, `browser_type`. Having the full list would provide context for new contributors.

### 7. `browser_inject_script` server-side fetch pattern

The MCP server fetches script content from URLs before sending to the extension (via `fetchScriptFromUrl`). This is a non-obvious architectural choice where the server acts as a fetch proxy. Not documented.

### 8. MCP protocol details

The doc does not mention:
- The server uses JSON-RPC 2.0 over SSE (not just "SSE")
- Protocol version: `2024-11-05`
- The `processMessage` function handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` methods
- Error responses use JSON-RPC error format with `code` and `message` fields

### 9. Zillow formatter exists

The doc only references the Threads formatter. A Zillow formatter also exists with multiple sub-formatters (`zillow_home.js`, `zillow_search.js`, `zillow_detail.js`, `zillow_detail_page.js`).

### 10. `host_permissions` in manifest

The manifest includes `"host_permissions": ["<all_urls>"]` which is not mentioned in the doc. This is relevant when discussing permissions.

### 11. Background script is an ES module

The manifest specifies `"type": "module"` for the background service worker. The doc's example code uses CommonJS-style patterns but the extension code uses ES module imports/exports.

---

## Verified Correct

### 1. Request flow diagram (partially)

The overall flow of Claude Code -> MCP Server (SSE) -> Extension (WebSocket) -> Chrome APIs is correct. The message directions and protocol choices (SSE for MCP, WebSocket for extension bridge) match the code.

### 2. Server -> Extension message format

The doc's `{ id, type, params }` format matches `extension-bridge.js` line 45:
```javascript
const message = { id, type, params };
```

### 3. Extension -> Server response format

The doc's success format `{ id, success: true, result }` and error format `{ id, success: false, error }` match `background.js` `sendResult()` function (lines 315-325) and `extension-bridge.js` `handleResponse()` (lines 58-77).

### 4. `handleToolCall` switch pattern

The doc correctly describes adding a case to a switch statement in `handleToolCall`. The actual code uses `switch (name)` at line 363 of `mcp-handler.js`.

### 5. `handleServerCommand` switch pattern

The doc correctly describes adding a case to a switch statement. The actual code uses `switch (type)` at line 270 of `background.js`.

### 6. Error handling pattern

The doc's pattern of throwing errors in handlers and having them caught by the command router matches the actual `handleServerCommand` try/catch at lines 267-312 of `background.js`.

### 7. Debugger session management

The doc correctly states: "The extension uses persistent debugger sessions - the debugger stays attached to a tab until the tab is closed. Use `getSession()` from `utils/debugger.js`." This matches the actual code in `utils/debugger.js`.

### 8. Chrome API reference table

The listed APIs (`chrome.tabs`, `chrome.debugger`, `chrome.scripting`, `chrome.downloads`, `chrome.storage`) and their permissions are accurate Chrome extension API references.

### 9. Extension reload instructions

The testing instructions for reloading the extension at `chrome://extensions` and checking service worker logs are standard and correct for Manifest V3 extensions.

### 10. `findChildrenByRole` utility recommendation

The doc recommends using `findChildrenByRole(nodeId, role)` in formatters. This function exists in `formatters/threads.js` (line 98) with that exact signature.

---

## Verified By

- **Date:** 2026-02-25
- **Method:** Manual line-by-line comparison of DEVELOPMENT.md claims against source files in `packages/server-for-chrome-extension/` and `packages/chrome-extension-unpacked/`. Each file path, function signature, message format, switch statement, and architectural claim was checked against the actual code.
- **Files examined:**
  - `packages/server-for-chrome-extension/src/mcp-handler.js`
  - `packages/server-for-chrome-extension/src/extension-bridge.js`
  - `packages/chrome-extension-unpacked/background.js`
  - `packages/chrome-extension-unpacked/manifest.json`
  - `packages/chrome-extension-unpacked/accessibility-tree.js`
  - `packages/chrome-extension-unpacked/accessibility-storage.js`
  - `packages/chrome-extension-unpacked/handlers/accessibility.js`
  - `packages/chrome-extension-unpacked/handlers/tabs.js`
  - `packages/chrome-extension-unpacked/formatters/threads.js`
  - `packages/chrome-extension-unpacked/formatters/zillow.js`
  - `packages/chrome-extension-unpacked/utils/debugger.js`
- **Summary:** The doc has significant structural inaccuracies. The most critical issue is the site-specific formatter section, which describes an architecture (dedicated MCP tools per site) that is the opposite of what exists (auto-routing within a single tool). File paths all use outdated/incorrect package names. The modular handler architecture is not documented at all. The core request flow and message formats are accurate.
