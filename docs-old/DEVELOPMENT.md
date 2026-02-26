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

**Key Components:**

| Component | File | Role |
|-----------|------|------|
| MCP Handler | `mcp-server/src/mcp-handler.js` | Tool definitions, request routing |
| Extension Bridge | `mcp-server/src/extension-bridge.js` | WebSocket communication (generic) |
| Background Script | `unpacked-extension/background.js` | Command handlers, Chrome API calls |
| Manifest | `unpacked-extension/manifest.json` | Extension permissions |

## Adding a New MCP Tool

### Step 1: Define the Tool (MCP Server)

Edit `mcp-server/src/mcp-handler.js`:

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

### Step 2: Add Permissions (If Needed)

Edit `unpacked-extension/manifest.json`:

```json
{
  "permissions": [
    "storage",
    "activeTab",
    "tabs",
    "your_new_permission"  // add here
  ]
}
```

Common permissions:
- `debugger` - Chrome DevTools Protocol access
- `scripting` - Execute scripts in pages
- `downloads` - Download files
- `history` - Browser history access
- `bookmarks` - Bookmark access

See: https://developer.chrome.com/docs/extensions/reference/permissions-list

### Step 3: Handle the Command (Extension)

Edit `unpacked-extension/background.js`:

**Add case to `handleServerCommand` switch:**

```javascript
case 'your_command_type':
  result = await yourHandlerFunction(params);
  break;
```

**Implement the handler function:**

```javascript
async function yourHandlerFunction(params) {
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

### Step 4: Update Documentation

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
[ ] 4. background.js - Add case to `handleServerCommand`
[ ] 5. background.js - Implement handler function
[ ] 6. README.md - Update tools table
[ ] 7. MCP_INTEGRATION.md - Add full documentation
[ ] 8. Test the tool end-to-end
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
import { getSession } from '../utils/debugger.js';

async function handlerWithDebugger(params) {
  const { tab_id } = params;

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

### 3. background.js - handleServerCommand

```javascript
case 'focus_tab':
  result = await focusTab(params);
  break;
```

### 4. background.js - Handler Function

```javascript
async function focusTab(params) {
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

No new permissions needed - uses existing `tabs` permission.

## Adding Site-Specific MCP Tools

Site-specific formatters extract structured data (posts, feeds, etc.) from accessibility trees. Each formatter gets its own dedicated MCP tool rather than auto-routing by URL.

### Architecture

```
webpilot/
├── mcp-server/src/mcp-handler.js  # Tool definitions
├── unpacked-extension/
│   ├── background.js              # Command handlers
│   ├── accessibility-tree.js      # Default YAML formatter
│   └── formatters/
│       └── threads.js             # Threads-specific formatter
```

### Step 1: Create the Formatter

Create `unpacked-extension/formatters/<site>.js`:

```javascript
export function formatSiteTree(nodes) {
  const nodeMap = new Map();
  const refMap = new Map();
  let refCounter = 1;

  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  function getRef(nodeId) {
    if (!refMap.has(nodeId)) {
      refMap.set(nodeId, `e${refCounter++}`);
    }
    return refMap.get(nodeId);
  }

  function getNodeRole(node) {
    return node.role?.value || '';
  }

  function getNodeName(node) {
    return node.name?.value || '';
  }

  // Your custom parsing logic here

  return {
    tree: 'Your formatted output string',
    elementCount: refCounter - 1,
    // Add any custom fields
  };
}
```

### Step 2: Add MCP Tool Definition

Edit `mcp-server/src/mcp-handler.js`:

**Add to tools array:**
```javascript
{
  name: 'browser_get_<site>_feed',
  description: 'Get <site> content in enriched format',
  inputSchema: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'number',
        description: 'The ID of the tab to get content from'
      }
    },
    required: ['tab_id']
  }
}
```

**Add to handleToolCall switch:**
```javascript
case 'browser_get_<site>_feed':
  commandType = 'get_<site>_feed';
  commandParams = { tab_id: args.tab_id };
  break;
```

### Step 3: Add Command Handler

Edit `unpacked-extension/background.js`:

**Add import:**
```javascript
import { formatSiteTree } from './formatters/<site>.js';
```

**Add to handleServerCommand switch:**
```javascript
case 'get_<site>_feed':
  result = await getSiteFeed(params);
  break;
```

**Add handler function:**
```javascript
import { getSession } from './utils/debugger.js';

async function getSiteFeed(params) {
  const { tab_id } = params;

  if (!tab_id) {
    throw new Error('tab_id is required');
  }

  const tab = await chrome.tabs.get(tab_id);
  const hostname = new URL(tab.url || '').hostname;
  if (!hostname.includes('<site>.com')) {
    throw new Error('Tab is not a <site> page');
  }

  // Get persistent debugger session (stays attached until tab closes)
  const target = await getSession(tab_id);

  await chrome.debugger.sendCommand(target, 'Accessibility.enable');
  const result = await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree');
  return formatSiteTree(result.nodes);
}
```

### Step 4: Update Documentation

Update README.md tools table and MCP_INTEGRATION.md with new tool details.

### Formatter Guidelines

**Return Format:**
```javascript
{
  tree: string,         // Required: formatted text output
  elementCount: number, // Required: count of elements with refs
  // Optional: additional fields for your use case
}
```

**Tips:**
- Use `findChildrenByRole(nodeId, role)` to search for elements recursively
- Profile pictures, buttons, links often mark content boundaries
- Parse button names for counts (e.g., "Like 5" → 5 likes)
- Extract timestamps from `time` elements for enriched data
- Handle nested generic containers - content may not be direct children

**See `formatters/threads.js` for a complete example.**
