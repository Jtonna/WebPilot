# Adding New Features to WebPilot

Practical guide for adding new MCP tools, handlers, and site-specific formatters.

For architecture details, see [CHROME_EXTENSION.md](../docs/CHROME_EXTENSION.md), [MCP_SERVER.md](../docs/MCP_SERVER.md), and [BUILD_ARCHITECTURE.md](../docs/BUILD_ARCHITECTURE.md).

## Request Flow

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

1. Claude Code sends a `tools/call` JSON-RPC request over SSE to the MCP server.
2. The MCP server translates it into a `{id, type, params}` WebSocket message to the extension.
3. The extension's `background.js` routes the command to the appropriate handler, which calls Chrome APIs.
4. The handler returns a result. The extension sends `{id, success, result}` back over WebSocket.
5. The MCP server wraps the result in `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }` and returns it to Claude Code over SSE.

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

Edit `packages/chrome-extension-unpacked/manifest.json`. The manifest already includes these base permissions: `storage`, `activeTab`, `tabs`, `tabGroups`, `debugger`, `scripting`, `webNavigation`, and `"host_permissions": ["<all_urls>"]`.

If your tool needs additional permissions (e.g., `downloads`, `history`, `bookmarks`), add them to the `permissions` array. See: https://developer.chrome.com/docs/extensions/reference/permissions-list

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
    result_field: data
  };
}
```

The background script is an ES module (`"type": "module"` in manifest.json), so use `export`/`import` syntax.

**For handlers using the Chrome Debugger:**

The extension uses persistent debugger sessions that stay attached until the tab closes. Use `getSession()` from `utils/debugger.js`:

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

**The `organizeTab()` pattern:** 6 of 9 existing commands call `organizeTab(params.tab_id)` after execution (fire-and-forget, no `await`). The three that skip it are `create_tab`, `close_tab`, and `get_tabs`. Follow this pattern unless your tool manages tabs itself.

**Per-tab state cleanup:** If your handler stores per-tab state, add cleanup in the `chrome.tabs.onRemoved` listener in `background.js`:

```javascript
chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupDebugger(tabId);
  handleTabClosed(tabId);
  clearRefs(tabId);
  clearPosition(tabId);
  // Add your cleanup here
});
```

### Step 5: Update Documentation

- **README.md** - Add to tools table
- **MCP_INTEGRATION.md** - Add full documentation with parameters, return format, errors, and usage notes

## Adding a Site-Specific Formatter

Site-specific formatters extract structured data (posts, feeds, listings) from accessibility trees. They auto-route by URL via `detectPlatform()` inside the existing `browser_get_accessibility_tree` tool -- no new MCP tools or command types are needed.

### How Platform Detection Works

When `browser_get_accessibility_tree` is called with `usePlatformOptimizer: true` (the default), `handlers/accessibility.js` calls `detectPlatform()` which checks the tab URL and returns a `{ formatter, platform }` object that routes to the appropriate formatter automatically.

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

**Return format requirements:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `tree` | string | Yes | Formatted text output |
| `elementCount` | number | Yes | Count of elements with refs |
| `refs` | object | Yes | Map of ref string to backendDOMNodeId (used internally for click/scroll-by-ref; not sent to MCP client) |

Omitting `refs` will break click/scroll-by-ref functionality.

### Step 2: Add Platform Detection

Edit `packages/chrome-extension-unpacked/handlers/accessibility.js`:

**Add import for your formatter**, then add your platform to `detectPlatform()`:

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

### Step 3: Update Documentation

Update README.md and MCP_INTEGRATION.md to list the new platform under `browser_get_accessibility_tree`.

### Formatter Tips

- **Router pattern:** If your site has multiple distinct page layouts (e.g., home, search, detail), create a top-level router file (`<site>.js`) that delegates to page-specific sub-formatters (`<site>_home.js`, `<site>_search.js`). See `formatters/threads.js` and `formatters/zillow.js` for examples.
- Use `findChildrenByRole(nodeId, role)` to search for elements recursively
- Profile pictures, buttons, links often mark content boundaries
- Parse button names for counts (e.g., "Like 5" -> 5 likes)
- Extract timestamps from `time` elements for enriched data
- Handle nested generic containers -- content may not be direct children

## Example: Adding a "Focus Tab" Tool

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

No new permissions needed -- uses existing `tabs` permission.

## Testing New Tools

1. **Reload the extension:** Go to `chrome://extensions`, click the refresh icon on WebPilot, and re-connect in the popup.
2. **Restart the MCP server:** If using `npm run dev`, it auto-reloads. Otherwise run `npm run dev`.
3. **Restart Claude Code** to pick up new tool definitions.
4. **Test via Claude Code:** Ask Claude to use your new tool.
5. **Debug issues:**
   - Extension logs: `chrome://extensions` -> click "Service worker" link on WebPilot -> Console tab
   - Server logs: Check terminal running `npm run dev`
   - "Unknown command type" -> case not added to `handleServerCommand`
   - "Unknown tool" -> case not added to `handleToolCall`
   - Permission denied -> missing permission in `manifest.json`

## Checklist

Use this when adding a new tool:

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

Use this when adding a site-specific formatter:

```
[ ] 1. formatters/<site>.js - Create formatter (return tree, elementCount, refs)
[ ] 2. handlers/accessibility.js - Import formatter and add to detectPlatform()
[ ] 3. README.md and MCP_INTEGRATION.md - Document the new platform
[ ] 4. Test with browser_get_accessibility_tree on the target site
```
