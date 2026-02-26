# Chrome BrowserMCP Extension

Documentation for the BrowserMCP extension used with Claude Code for browser automation.

## Overview

BrowserMCP is a Chrome extension that enables Claude Code to interact with web pages through the Model Context Protocol (MCP). It provides navigation, clicking, typing, and observation capabilities without requiring screenshots or computer vision.

## Setup

1. Install the BrowserMCP extension in Chrome
2. Open the browser tab you want to control
3. Click the BrowserMCP extension icon in the toolbar
4. Click "Connect" to establish the connection with Claude Code

## How It Works

### Accessibility Tree (Not Screenshots)

BrowserMCP uses the browser's **accessibility tree** rather than screenshots or the full DOM:

- The accessibility tree is a simplified, browser-generated structure for assistive technologies
- Contains semantically meaningful elements: buttons, links, inputs, headings, text
- Excludes decorative elements, hidden content, and wrapper divs
- Much smaller and cleaner than the full DOM

### Element References

Each element in the snapshot has a unique `ref` identifier:

```yaml
- link "Search" [ref=s1e38]:
    - /url: /search
    - img "Search" [ref=s1e42]
- button "Create" [ref=s1e45]:
    - img "Create" [ref=s1e49]
```

**Important**: Refs are ephemeral and change with every snapshot:
- First snapshot: `s1e38`, `s1e42`...
- Second snapshot: `s2e105`, `s2e107`...
- Refs are only valid until the next page change or snapshot

## Available Tools

### Navigation

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL |
| `browser_go_back` | Go back to previous page |
| `browser_go_forward` | Go forward to next page |

### Observation

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Capture accessibility tree with element refs |
| `browser_screenshot` | Take a screenshot of the current page |
| `browser_get_console_logs` | Get console logs from the browser |
| `browser_wait` | Wait for a specified time in seconds |

### Interaction

| Tool | Description |
|------|-------------|
| `browser_click` | Click on an element by ref |
| `browser_type` | Type text into an input field |
| `browser_hover` | Hover over an element |
| `browser_select_option` | Select option in a dropdown |
| `browser_press_key` | Press a keyboard key (e.g., `Enter`, `PageDown`, `ArrowDown`) |

## Tool Parameters

### browser_navigate
```json
{
  "url": "https://example.com"
}
```

### browser_click
```json
{
  "element": "Human-readable description",
  "ref": "s1e38"
}
```

### browser_type
```json
{
  "element": "Human-readable description",
  "ref": "s1e105",
  "text": "Text to type",
  "submit": false
}
```
- Set `submit: true` to press Enter after typing

### browser_press_key
```json
{
  "key": "PageDown"
}
```
Common keys: `Enter`, `Escape`, `Tab`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `PageUp`, `PageDown`

### browser_wait
```json
{
  "time": 2
}
```
- Time is in seconds

## Example Workflow

### 1. Navigate and Get Snapshot
```
browser_navigate → url: "https://threads.com"
```
Returns page snapshot with element refs.

### 2. Find Element in Snapshot
Look for the element you want to interact with:
```yaml
- link "Search" [ref=s1e38]:
    - /url: /search
```

### 3. Click the Element
```
browser_click → element: "Search link", ref: "s1e38"
```

### 4. Type in Input Field
After clicking, find the input ref in the new snapshot:
```yaml
- searchbox "Search" [ref=s2e105]
```

```
browser_type → element: "Search box", ref: "s2e105", text: "search query", submit: true
```

### 5. Scroll Down
```
browser_press_key → key: "PageDown"
browser_wait → time: 1.5
```

## Limitations

1. **No JavaScript Execution** - Cannot inject or run JavaScript in the page context
2. **No Direct DOM Manipulation** - Cannot modify DOM elements directly
3. **No Network Interception** - Cannot intercept or modify network requests
4. **Ephemeral Refs** - Must take a new snapshot after any action to get fresh refs

## Alternative Browser MCP Extensions

We evaluated several alternatives to address BrowserMCP's limitations (particularly JS execution):

### Comparison Table

| Extension | Chrome Web Store | Real Browser Profile | JS Execution | Buildable |
|-----------|------------------|---------------------|--------------|-----------|
| BrowserMCP (current) | ✅ 4.9 stars | ✅ | ❌ | ❌ (monorepo deps) |
| hangwin/mcp-chrome | ❌ GitHub only | ✅ | ✅ | ✅ |
| ChromeDevTools MCP | N/A (npm package) | ❌ (Puppeteer) | ✅ | ✅ |
| chrome-extension-bridge-mcp | ❌ GitHub only | ✅ | ✅ | ✅ |

### hangwin/mcp-chrome
- **GitHub**: https://github.com/hangwin/mcp-chrome
- **Stars**: 9.9k
- Uses real browser profile with login states
- Has `chrome_inject_script` and `chrome_send_command_to_inject_script` tools
- 20+ tools including semantic search with vector database
- All-in-one monorepo (extension + server), buildable from source
- **Concern**: Not on Chrome Web Store, some Chinese content in repo

### ChromeDevTools MCP (Official Google)
- **GitHub**: https://github.com/ChromeDevTools/chrome-devtools-mcp
- **Stars**: 21k
- Official Chrome DevTools team project
- Has `evaluate_script` for JS execution
- 26 tools across debugging, input, navigation, network, performance
- **Drawback**: Uses Puppeteer (fresh browser instance, not your profile)
- Easier to detect as automation

### chrome-extension-bridge-mcp (Minimal JS Bridge)
- **GitHub**: https://github.com/Oanakiaja/chrome-extension-bridge-mcp
- Minimal extension focused only on JS execution via WebSocket
- Can potentially run alongside BrowserMCP
- Small codebase (~50% JS, ~47% TS) - easy to audit
- Load as unpacked extension from source

## Potential Combined Workflow

Use BrowserMCP + chrome-extension-bridge-mcp together:

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code                             │
└─────────────────────┬───────────────────────┬───────────────┘
                      │                       │
                      ▼                       ▼
┌─────────────────────────────┐  ┌────────────────────────────┐
│       BrowserMCP            │  │  chrome-extension-bridge   │
│  - Navigate to pages        │  │  - Execute JavaScript      │
│  - Click, type, hover       │  │  - Access DOM/window       │
│  - Take snapshots           │  │  - Get function responses  │
│  - Read accessibility tree  │  │                            │
└─────────────────────────────┘  └────────────────────────────┘
                      │                       │
                      └───────────┬───────────┘
                                  ▼
                         ┌───────────────┐
                         │  Chrome Tab   │
                         │  (Real Profile)│
                         └───────────────┘
```

**Example workflow**:
1. BrowserMCP: Navigate to threads.com
2. BrowserMCP: Click on a post, type a comment
3. extension-bridge-mcp: Execute JS to extract data or modify page
4. BrowserMCP: Continue with navigation/interactions

**Status**: Not yet tested. The bridge may need modifications for tab targeting.

## Setup for chrome-extension-bridge-mcp

```bash
git clone https://github.com/Oanakiaja/chrome-extension-bridge-mcp
cd chrome-extension-bridge-mcp
npm install
npm run debug
```

Then in Chrome:
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` folder

## Future Considerations

1. **Audit bridge code** - Review chrome-extension-bridge-mcp for security before using
2. **Tab targeting** - May need to add ability to target specific tabs
3. **Fork BrowserMCP** - The extension source is in a separate monorepo, not easily modifiable
4. **Build custom bridge** - Could create minimal extension just for JS execution if needed

## Demonstrated Session

During testing, we successfully:

1. Navigated to threads.com
2. Clicked on Search
3. Typed "build in public" and searched
4. Switched to Recent tab
5. Clicked on a user profile (@bwluzw_dev)
6. Followed the user
7. Scrolled through their posts
8. Opened a reply dialog
9. Typed and posted a comment

All interactions used the accessibility tree refs without screenshots or computer vision.
