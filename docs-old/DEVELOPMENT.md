# WebPilot Development Guide

Guide for adding new features to the WebPilot browser control extension.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Request Flow                                   │
│                                                                         │
│   Claude Code          MCP Server              Extension        Chrome  │
│       │                    │                       │               │    │
│       │ ─── SSE ─────────► │                       │               │    │
│       │   tools/call       │                       │               │    │
│       │                    │ ─── WebSocket ──────► │               │    │
│       │                    │   {id, type, params}  │               │    │
│       │                    │                       │ ─── API ────► │    │
│       │                    │                       │               │    │
│       │                    │ ◄── WebSocket ─────── │ ◄─────────────│    │
│       │                    │   {id, success, result}               │    │
│       │ ◄── SSE ────────── │                       │               │    │
│       │   result           │                       │               │    │
└─────────────────────────────────────────────────────────────────────────┘
```

The MCP server uses JSON-RPC 2.0 over SSE (protocol version `2024-11-05`). The `processMessage` function handles `initialize`, `notifications/initialized`, `tools/list`, and `tools/call` methods. Error responses use the JSON-RPC error format with `code` and `message` fields. The `handleToolCall` function wraps results in `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }` before returning, which is the MCP protocol's required response format.

**Key Components:**

| Component | File | Role |
|-----------|------|------|
| MCP Handler | `packages/server-for-chrome-extension/src/mcp-handler.js` | Tool definitions, request routing |
| Extension Bridge | `packages/server-for-chrome-extension/src/extension-bridge.js` | WebSocket communication (generic) |
| Background Script | `packages/chrome-extension-unpacked/background.js` | Command routing, imports handler modules |
| Manifest | `packages/chrome-extension-unpacked/manifest.json` | Extension permissions (ES module service worker) |

**Existing Tools:**

| Tool | Description |
|------|-------------|
| `browser_create_tab` | Create a new browser tab |
| `browser_close_tab` | Close a browser tab |
| `browser_get_tabs` | Get list of open tabs |
| `browser_get_accessibility_tree` | Get page accessibility tree (with auto platform formatting) |
| `browser_inject_script` | Inject a script from a URL into a tab |
| `browser_execute_js` | Execute JavaScript in page context |
| `browser_click` | Click at coordinates, selector, or accessibility ref |
| `browser_scroll` | Scroll to element or by pixel amount |
| `browser_type` | Type text into focused or specified element |

### Handler Module Architecture

The extension uses a modular architecture. `background.js` is a thin orchestrator that imports handler functions from separate modules under `handlers/`:

```javascript
import { createTab, closeTab, getTabs, organizeTab } from './handlers/tabs.js';
import { getAccessibilityTree } from './handlers/accessibility.js';
import { click } from './handlers/click.js';
import { scroll } from './handlers/scroll.js';
import { type } from './handlers/keyboard.js';
import { injectScript, executeJs, handleNavigationComplete, handleTabClosed } from './handlers/scripts.js';
```

Handler files:
- `handlers/tabs.js` - createTab, closeTab, getTabs, organizeTab
- `handlers/accessibility.js` - getAccessibilityTree (includes platform detection and formatter routing)
- `handlers/click.js` - click
- `handlers/scroll.js` - scroll
- `handlers/keyboard.js` - type
- `handlers/scripts.js` - injectScript, executeJs, handleNavigationComplete, handleTabClosed

### Utility Modules

- `utils/debugger.js` - Persistent debugger session management (`getSession`, `cleanup`, `isProtectedPage`)
- `utils/mouse-state.js` - Mouse position tracking per tab
- `utils/cursor.js` - Visual cursor rendering
- `utils/timing.js` - Timing utilities
- `utils/windmouse.js` - Natural mouse movement simulation
- `utils/scroll.js` - Scroll utilities

### Storage Modules

- `accessibility-storage.js` - Stores ref-to-backendDOMNodeId mappings and ancestry context for click/scroll-by-ref functionality. Provides `findRefByAncestry()` for re-identifying elements after scroll.

### Tab Cleanup Lifecycle

When a tab is closed, `background.js` runs cleanup for all per-tab state:

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupDebugger(tabId);
  handleTabClosed(tabId);
  clearRefs(tabId);
  clearPosition(tabId);
});
```

New features that store per-tab state must add cleanup here.

### The `organizeTab()` Pattern

After most commands, `background.js` calls `organizeTab(params.tab_id)`. This is a consistent pattern: 6 of 9 commands call it (`get_accessibility_tree`, `inject_script`, `execute_js`, `click`, `scroll`, `type`). The three commands that skip it are `create_tab`, `close_tab`, and `get_tabs`. New tool authors should follow this pattern unless the tool manages tabs itself.

## Adding a New MCP Tool

### Step 1: Define the Tool (MCP Server)

Edit `packages/server-for-chrome-extension/src/mcp-handler.js`:

**Add to the `tools` array:**

```javascript
{
  name: 'browser_your_tool_name',
  description: 'What this tool does',
  inputSchema: {
    type: 'object',
    properties: {
      param_name: {
        type: 'string',  // or 'number', 'boolean', 'object', 'array'
        description: 'What this parameter does'
      }
    },
    required: ['param_name']  // list required params
  }
}
```

**Add case to `handleToolCall` switch:**

```javascript
case 'browser_your_tool_name':
  commandType = 'your_command_type';  // sent to extension
  commandParams = { param_name: args.param_name };
  break;
```

Note: `handleToolCall` wraps the extension's response in the MCP protocol format automatically. You do not need to handle that wrapping yourself.

### Step 2: Add Permissions (If Needed)

Edit `packages/chrome-extension-unpacked/manifest.json`:

The manifest already includes these base permissions: `storage`, `activeTab`, `tabs`, `tabGroups`, `debugger`, `scripting`, `webNavigation`. It also includes `"host_permissions": ["<all_urls>"]`.

If your tool needs additional permissions, add them:

```json
{
  "permissions": [
    "storage",
    "activeTab",
    "tabs",
    "tabGroups",
    "debugger",
    "scripting",
    "webNavigation",
    "your_new_permission"
  ]
}
```

Common additional permissions:
- `downloads` - Download files
- `history` - Browser history access
- `bookmarks` - Bookmark access

See: https://developer.chrome.com/docs/extensions/reference/permissions-list

### Step 3: Create the Handler (Extension)

Create a new handler file at `packages/chrome-extension-unpacked/handlers/your_handler.js` (or add to an existing handler file if it fits):

```javascript
export async function yourHandlerFunction(params) {
  const { param_name } = params;

  if (!param_name) {
    throw new Error('param_name is required');
  }

  // Call Chrome APIs here
  const data = await chrome.someApi.someMethod(param_name);

  return {
    // Return data to agent
    result_field: data
  };
}
```

The background script is an ES module (`"type": "module"` in manifest.json), so use `export`/`import` syntax.

### Step 4: Wire Up the Command (Extension)

Edit `packages/chrome-extension-unpacked/background.js`:

**Add import:**
```javascript
import { yourHandlerFunction } from './handlers/your_handler.js';
```

**Add case to `handleServerCommand` switch:**

```javascript
case 'your_command_type':
  result = await yourHandlerFunction(params);
  // Call organizeTab unless your tool manages tabs itself
  organizeTab(params.tab_id);
  break;
```

### Step 5: Update Documentation

**README.md** - Add to tools table:

```markdown
| `browser_your_tool_name` | Brief description | `param_name: type` |
```

**MCP_INTEGRATION.md** - Add full documentation:

```markdown
### browser_your_tool_name

Detailed description of what the tool does.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `param_name` | type | Yes | What it does |

**Returns:**
\`\`\`json
{
  "result_field": "example value"
}
\`\`\`

**Errors:**
- `Error message` - When this happens

**Notes:**
- Important usage notes
```

## Checklist

Use this checklist when adding a new tool:

```
[ ] 1. mcp-handler.js - Add tool to `tools` array
[ ] 2. mcp-handler.js - Add case to `handleToolCall`
[ ] 3. manifest.json - Add permissions (if needed)
[ ] 4. handlers/<file>.js - Create or update handler module
[ ] 5. background.js - Import handler and add case to `handleServerCommand`
[ ] 6. background.js - Add organizeTab() call if tool takes a tab_id
[ ] 7. background.js - Add tab cleanup in onRemoved listener if storing per-tab state
[ ] 8. README.md - Update tools table
[ ] 9. MCP_INTEGRATION.md - Add full documentation
[ ] 10. Test the tool end-to-end
```

## Testing New Tools

### 1. Reload the Extension

After changing extension files:
1. Go to `chrome://extensions`
2. Click refresh icon on WebPilot
3. Re-connect in the extension popup

### 2. Restart the MCP Server

After changing server files:
```bash
# If using npm run dev, it auto-reloads
# Otherwise:
npm run dev
```

### 3. Restart Claude Code

After adding/changing MCP tools, restart Claude Code to pick up the new tool definitions.

### 4. Test via Claude Code

Ask Claude to use your new tool:
```
"Use browser_your_tool_name with param_name set to 'test'"
```

### 5. Debug Issues

**Extension logs:**
1. Go to `chrome://extensions`
2. Click "Service worker" link on WebPilot
3. Check Console tab for errors

**Server logs:**
- Check terminal running `npm run dev`

**Common issues:**
- "Unknown command type" - Case not added to `handleServerCommand`
- "Unknown tool" - Case not added to `handleToolCall`
- Permission denied - Missing permission in manifest.json

## Message Format

### Server → Extension

```json
{
  "id": "uuid-string",
  "type": "command_type",
  "params": {
    "param_name": "value"
  }
}
```

### Extension → Server

**Success:**
```json
{
  "id": "uuid-string",
  "success": true,
  "result": {
    "data": "value"
  }
}
```

**Error:**
```json
{
  "id": "uuid-string",
  "success": false,
  "error": "Error message"
}
```

## Error Handling Patterns

### In Handler Functions

```javascript
async function yourHandler(params) {
  const { required_param } = params;

  // Validate required params
  if (!required_param) {
    throw new Error('required_param is required');
  }

  try {
    // Chrome API call
    const result = await chrome.api.method();
    return { data: result };
  } catch (e) {
    // Re-throw with descriptive message
    throw new Error(`Failed to do thing: ${e.message}`);
  }
}
```

### For Handlers Using Chrome Debugger

The extension uses persistent debugger sessions - the debugger stays attached to a tab until the tab is closed. Use `getSession()` from `utils/debugger.js`:

```javascript
import { getSession, isProtectedPage } from '../utils/debugger.js';

async function handlerWithDebugger(params) {
  const { tab_id } = params;

  // Check for protected pages before attaching debugger
  const tab = await chrome.tabs.get(tab_id);
  if (isProtectedPage(tab.url)) {
    throw new Error('Cannot attach debugger to protected page (chrome://, chrome-extension://, about:)');
  }

  // Get persistent session (stays attached until tab closes)
  const target = await getSession(tab_id);

  // Main operation - no try/finally cleanup needed
  const result = await chrome.debugger.sendCommand(target, 'Method');
  return { data: result };
}
```

## Chrome API Reference

Common APIs used in browser control:

| API | Purpose | Permission |
|-----|---------|------------|
| `chrome.tabs` | Tab management | `tabs` |
| `chrome.debugger` | DevTools Protocol | `debugger` |
| `chrome.scripting` | Execute scripts | `scripting` |
| `chrome.downloads` | Download files | `downloads` |
| `chrome.storage` | Store data | `storage` |

Docs: https://developer.chrome.com/docs/extensions/reference/api

## Example: Adding a Simple Tool

Here's a complete example of adding a "focus tab" tool:

### 1. mcp-handler.js - Tool Definition

```javascript
{
  name: 'browser_focus_tab',
  description: 'Focus (activate) a browser tab by its ID',
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'number',
        description: 'The ID of the tab to focus'
      }
    },
    required: ['tab_id']
  }
}
```

### 2. mcp-handler.js - handleToolCall

```javascript
case 'browser_focus_tab':
  commandType = 'focus_tab';
  commandParams = { tab_id: args.tab_id };
  break;
```

### 3. handlers/tabs.js - Handler Function

```javascript
export async function focusTab(params) {
  const { tab_id } = params;

  if (!tab_id) {
    throw new Error('tab_id is required');
  }

  await chrome.tabs.update(tab_id, { active: true });
  const tab = await chrome.tabs.get(tab_id);
  await chrome.windows.update(tab.windowId, { focused: true });

  return { success: true, tab_id: tab_id };
}
```

### 4. background.js - Import and Wire Up

```javascript
import { createTab, closeTab, getTabs, organizeTab, focusTab } from './handlers/tabs.js';

// In handleServerCommand switch:
case 'focus_tab':
  result = await focusTab(params);
  organizeTab(params.tab_id);
  break;
```

No new permissions needed - uses existing `tabs` permission.

## Adding Site-Specific Formatters

Site-specific formatters extract structured data (posts, feeds, listings, etc.) from accessibility trees. Formatters auto-route by URL via `detectPlatform()` inside the existing `browser_get_accessibility_tree` tool - there are no separate MCP tools per formatter.

### Architecture

```
packages/chrome-extension-unpacked/
├── background.js                      # Command routing (imports handlers)
├── accessibility-tree.js              # Default plaintext tree formatter
├── accessibility-storage.js           # Ref-to-backendDOMNodeId storage
├── handlers/
│   └── accessibility.js               # getAccessibilityTree + detectPlatform()
├── formatters/
│   ├── threads.js                     # Threads router (delegates by page type)
│   ├── threads_home.js
│   ├── threads_search.js
│   ├── threads_activity.js
│   ├── zillow.js                      # Zillow router (delegates by page type)
│   ├── zillow_home.js
│   ├── zillow_search.js
│   ├── zillow_detail.js
│   └── zillow_detail_page.js
└── utils/
    ├── debugger.js                    # Persistent debugger sessions
    ├── mouse-state.js                 # Mouse position tracking
    ├── cursor.js                      # Visual cursor rendering
    ├── timing.js                      # Timing utilities
    ├── windmouse.js                   # Natural mouse movement simulation
    └── scroll.js                      # Scroll utilities
```

### How Platform Detection Works

When `browser_get_accessibility_tree` is called with `usePlatformOptimizer: true` (the default), `handlers/accessibility.js` calls `detectPlatform()` which checks the tab URL and routes to the appropriate formatter automatically. No new MCP tools or command types are needed.

### Step 1: Create the Formatter

Create `packages/chrome-extension-unpacked/formatters/<site>.js`:

```javascript
export function formatPlatformTree(nodes) {
  const nodeMap = new Map();
  const refMap = new Map();
  let refCounter = 1;

  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  function getRef(node) {
    if (!refMap.has(node.nodeId)) {
      refMap.set(node.nodeId, {
        ref: `e${refCounter++}`,
        backendDOMNodeId: node.backendDOMNodeId
      });
    }
    return refMap.get(node.nodeId).ref;
  }

  function getNodeRole(node) {
    return node.role?.value || '';
  }

  function getNodeName(node) {
    return node.name?.value || '';
  }

  // Your custom parsing logic here

  // Build refs map: ref string -> backendDOMNodeId
  const refs = {};
  for (const [nodeId, entry] of refMap) {
    refs[entry.ref] = entry.backendDOMNodeId;
  }

  return {
    tree: 'Your formatted output string',
    elementCount: refCounter - 1,
    refs: refs,  // REQUIRED: consumed by handlers/accessibility.js for click/scroll targeting
    // Optional platform-specific counts: postCount, listingCount, etc.
  };
}
```

### Step 2: Add Platform Detection

Edit `packages/chrome-extension-unpacked/handlers/accessibility.js`:

Add your platform to the `detectPlatform()` function:

```javascript
function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes('threads.com')) return { formatter: formatThreadsTree, platform: 'threads' };
    if (hostname.includes('zillow.com')) return { formatter: formatZillowTree, platform: 'zillow' };
    if (hostname.includes('yoursite.com')) return { formatter: formatYourSiteTree, platform: 'yoursite' };  // Add here
    return null;
  } catch {
    return null;
  }
}
```

Add the import and routing for your formatter in the same file.

### Step 3: Update Documentation

Update README.md tools table and MCP_INTEGRATION.md with the new platform support for `browser_get_accessibility_tree`.

### Formatter Guidelines

**Return Format:**
```javascript
{
  tree: string,         // Required: formatted text output
  elementCount: number, // Required: count of elements with refs
  refs: object,         // Required: map of ref string -> backendDOMNodeId
                        //   (consumed internally by handlers/accessibility.js,
                        //    stored via accessibility-storage.js, NOT sent to MCP client)
  // Optional platform-specific counts (e.g., postCount, listingCount)
}
```

Omitting `refs` from a new formatter will break click/scroll-by-ref functionality.

**Router Pattern:**

Both existing top-level formatters (`threads.js`, `zillow.js`) follow a router pattern: they detect the page type from the URL and delegate to page-specific sub-formatters (e.g., `threads_home.js`, `zillow_search.js`). Follow this pattern if your site has multiple distinct page layouts.

**Tips:**
- Use `findChildrenByRole(nodeId, role)` to search for elements recursively
- Profile pictures, buttons, links often mark content boundaries
- Parse button names for counts (e.g., "Like 5" → 5 likes)
- Extract timestamps from `time` elements for enriched data
- Handle nested generic containers - content may not be direct children

**See `formatters/threads.js` and `formatters/zillow.js` for complete examples.**

## `browser_inject_script` Server-Side Fetch

The MCP server fetches script content from URLs before sending it to the extension (via `fetchScriptFromUrl` in `mcp-handler.js`). The server acts as a fetch proxy - the extension receives the script content, not the URL. This is a non-obvious architectural choice to be aware of when working with script injection.
