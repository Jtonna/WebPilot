# WebPilot MCP Integration Guide

Reference documentation for AI agents integrating with the WebPilot browser control MCP server.

## Overview

The WebPilot MCP server provides browser automation capabilities to AI agents via the Model Context Protocol (MCP). Agents can manage tabs, read page content via accessibility trees, click elements, scroll, type text, inject scripts, and execute JavaScript in the user's Chrome browser.

## Authentication

By default, all MCP tool calls (except `request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, and `webpilot_dev_get_formatter_logs`) require a valid API key obtained by pairing.

`agent_name` is only required when calling `request_pairing` — it is shown in the approval UI. All other tools authenticate via the API key alone; the server resolves the bound Chrome profile from the key via `resolveTargetProfile` in `mcp-handler.js`.

### Providing the API Key

Include the key with every request using any of these methods:

- **HTTP header:** `X-API-Key: <your-key>` on the `/sse` and `/message` endpoints (recommended for MCP client configuration)
- **Query parameter:** `?apiKey=<your-key>` on the `/sse` and `/message` endpoints
- **Tool parameter:** `api_key: "<your-key>"` as a parameter in each `tools/call` request (useful for immediate use after pairing, before the client is reconfigured)

The server checks `session.mcpApiKey` (set from header or query parameter) first, then falls back to `params.arguments.api_key` from the tool call. All tools except the four auth-exempt tools (`request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, `webpilot_dev_get_formatter_logs`) include an optional `api_key` parameter in their schema for this purpose.

### First-Time Setup (async flow)

The pairing flow is asynchronous and is mediated by the server-hosted web UI at `http://localhost:3456/ui/`, not by the Chrome extension popup.

1. Call `request_pairing` with a human-readable `agent_name`. The tool returns **immediately** with a `pairing_id` and `status` (one of `'pending'`, `'approved'`, `'denied'`, `'expired'`). It is **idempotent**: a repeat call with the same `agent_name` returns the same `pairing_id` unless the pending entry has aged past its 24-hour TTL. Approved entries are also reused — calling `request_pairing` again with an approved `agent_name` returns the same `pairing_id` and the existing `api_key`. Denied or expired entries cause a fresh `pairing_id` to be minted on next call.
2. If `status` is `'pending'`, a native system notification fires on the host pointing the human at the web UI. Surface the approval URL to the human and stop calling browser tools.
3. The human approves the pairing in the web UI and **selects which Chrome profile** the agent should be bound to. (The web UI can also pre-provision a key directly without an approval round-trip — see [Pre-provisioned keys](#pre-provisioned-keys-web-ui).)
4. On a later turn, call `check_pairing_status` with the `pairing_id`. When `status` becomes `'approved'`, the response contains your `api_key`.
5. Persist the key as the `X-API-Key` header in your MCP client config (e.g. `.mcp.json` for Claude Code), or pass it as the `api_key` parameter on each tool call.

### Short-circuit for already-keyed callers

If the caller already presents a valid API key (header, query, or `api_key` argument) when calling `request_pairing`, the tool **short-circuits** and returns the existing identity instead of minting a new pending entry. This avoids spurious approval prompts when a subagent or inheriting process carries its parent's `.mcp.json` and reflexively calls `request_pairing` again. Subagents do **not** need to re-pair — they share the parent's key and are routed to the same bound profile.

### Pre-provisioned keys (web UI)

The web UI's pair-agent modal supports an "Include API key" toggle. When enabled, the UI calls `POST /api/ui/agents` (body: `{ agentName, profileId }`), the server mints the key directly via `paired-keys.createPairedAgent`, and the UI builds the copyable `.mcp.json` snippet with the key already baked in. Agents using a pre-provisioned key never call `request_pairing` at all.

**Unused keys expire after 48 hours.** If the agent never makes a tool call with this key, the server revokes the entry on its next cleanup pass (`paired-keys.cleanupUnusedKeys`, runs at startup and hourly). Once any tool call lands (which sets `lastAccessed` via `touchKey`), the key is kept indefinitely. The same rule applies to keys minted by the classic `request_pairing → approve` handshake — both paths start with `lastAccessed: null`.

### Re-binding agents to a different profile

The web UI's Agents page exposes a profile dropdown per row. Selecting a different profile issues `PATCH /api/ui/agents/:key` with `{ profileId }`. This is a field-flip on the paired-keys entry — no WebSocket teardown is needed because tool calls re-resolve the target profile per call via `resolveTargetProfile`.

### Auth Error

Unauthenticated or invalid-key requests receive MCP error code `-32001`.

## Security: Site Policy

Site-policy enforcement is **server-side**, implemented by `isAllowed(agentId, url)` in `packages/server-for-chrome-extension/src/site-policy.js`. The extension does not enforce site policy — it executes commands. See `docs/MCP_SERVER.md` for the canonical reference.

**Enforcement point:** every `browser_*` tool call (`browser_create_tab`, `browser_close_tab`, `browser_get_accessibility_tree`, `browser_inject_script`, `browser_execute_js`, `browser_click`, `browser_scroll`, `browser_type`) and `webpilot_run_workflow` is checked by `mcp-handler.js` at MCP dispatch time (checkpoints A and B) before the command reaches the extension. `browser_get_tabs` is exempt (no URL context).

**Precedence (highest first):**

1. **Per-agent overrides** — rows in the `agent_site_overrides` table, scoped to the calling agent.
2. **Global user rules** — rows in `global_site_rules` with `source='user'`, applied to all agents on this host.
3. **Global site blocklist** — rows in `global_site_rules` with `source='global_site_blocklist'`, populated by `global-site-blocklist-updater.js` from the bundled `global-site-blocklists/` and gated by `config.global_site_blocklist_enabled`.
4. **Default: allow.**

**Managing site policy:** the web UI at `http://localhost:3456/ui/sites/` is the canonical surface for adding per-agent overrides, global user rules, and toggling the global site blocklist.

**Note on `api_key` parameter:** All tools except the four auth-exempt tools (`request_pairing`, `check_pairing_status`, `webpilot_get_formatter_info`, `webpilot_dev_get_formatter_logs`) include an optional `api_key` string parameter in their schema. This is an alternative way to authenticate per-request without configuring the `X-API-Key` header. The `api_key` parameter is omitted from the individual tool documentation below for brevity.

**Note on `intent` parameter (debug trace).** The navigational tools (`browser_create_tab`, `browser_close_tab`, `browser_click`, `browser_scroll`, `browser_type`, `webpilot_run_workflow`) accept an optional `intent` string — a one-line human-readable description of *why* the call is being made (e.g. `"opening Discord to find #general"`, `"clicking Send after typing message text"`). The value is logged server-side as `[mcp:intent] <tool>: <text>` and surfaced in the Formatters/MCP observability UI. It is purely additive — not validated, not required — and is omitted from the per-tool docs below for brevity. Use it for any non-trivial multi-step flow: traces become dramatically easier to read.

## Agent Instructions

When an agent connects to the WebPilot MCP server, the `initialize` response includes an `instructions` field with a comprehensive guide on how to use WebPilot effectively. Agents receive this automatically on connection — no extra tool call is needed. The instructions cover authentication, tool usage patterns, platform formatter behavior, and best practices. (The server identifies itself in the initialize response as `serverInfo.name = 'WebPilot'` — see MCP_SERVER.md.)

## Available Tools

### request_pairing

Initiate an asynchronous pairing request. Returns **immediately** with a `pairing_id`; the human approves in the web UI on the host. This tool is unauthenticated and idempotent (same `agent_name` → same `pairing_id` until the 24h TTL expires).

If the caller already presents a valid API key, the tool **short-circuits** and returns the existing identity instead of creating a new pending entry. Subagents inheriting their parent's `.mcp.json` should not call this tool at all.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent_name` | string | Yes | Human-readable name for this agent, shown in the approval UI |

**Returns (pending):**
```
Pairing requested for agent "<agent_name>".

pairing_id: <uuid>
status: pending

ACTION REQUIRED FROM THE HUMAN: open http://localhost:3456/ui in a browser and approve this pairing. A system notification has been sent.

NEXT STEPS FOR THE AGENT:
1. Surface the approval URL to the human and stop making other tool calls.
2. After the human confirms approval, call check_pairing_status with pairing_id="<uuid>" to retrieve your api_key.
3. Calling request_pairing again with the same agent_name is safe — it is idempotent and will return this same pairing_id.
```

**Returns (already-approved on this call):**
If the agent_name was already approved previously, the call returns `status: approved` immediately with the full `api_key` and an example `.mcp.json` snippet.

**Returns (short-circuit when caller is already keyed):**
```
You already have a valid API key — no need to pair again.

Paired as: "<agentName>"
Bound to profile: <profileId>
status: approved

Just call browser tools directly with your existing key. The server resolves your bound profile from the api_key automatically; agent_name is not needed on tool calls and only matters during initial pairing.

If you intended to register as a *separate* agent identity (e.g. so the human can see this subagent distinctly in the UI), ask the human to revoke or rename the current key first, then retry.
```

**Returns (denied):**
A text response with `status: denied` and instructions not to retry automatically.

**Notes:**
- The async flow is server-side. The pairing entry is persisted to `<dataDir>/config/pending-pairings.json` and aged out after 24h of inactivity. Terminal-state entries (`approved`/`denied`/`expired`) are hard-dropped after 7 days by an hourly cleanup pass.
- The human picks **which Chrome profile** the agent binds to during approval. That profile is persisted on the paired-keys entry and used for tool-call routing.
- `agent_name` is required here only. Other tools authenticate via the API key alone.
- This tool and `check_pairing_status` do not require an API key.

---

### check_pairing_status

Poll the status of a pending pairing request. Returns the current `status` and, when approved, the `api_key`. This tool is unauthenticated.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pairing_id` | string | Yes | The `pairing_id` returned from a prior call to `request_pairing` |

**Status values:**
- `pending` — user has not yet approved; wait and call again on a later turn.
- `approved` — the response includes your `api_key`. Store it and use it for all future tool calls via the `X-API-Key` header or `api_key` argument.
- `denied` — the user rejected this pairing. Do not retry automatically; ask the human whether to try again with a different `agent_name`.
- `expired` — the pending entry aged out (24h of inactivity). Call `request_pairing` again with the same `agent_name` to mint a fresh `pairing_id`.

**Notes:**
- The server expires `pending` entries after 24 hours and hard-drops terminal-state entries (`approved`/`denied`/`expired`) older than 7 days during periodic cleanup.
- This is the only safe way to retrieve the API key after an async approval.

---

### webpilot_get_formatter_info

Get information about available platform-specific formatters and instructions for writing custom platform optimizers. This tool does not require authentication.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | string | No | Filter to a specific platform (e.g., `"threads"`, `"zillow"`). Omit to return all platforms. |
| `tab_id` | number | No | Browser tab ID. When provided with a valid API key and the URL matches a formatter, records an unlock for (agentId, formatter, tab_id) so subsequent gated calls on that tab pass the platform-guide gate. Omit for pure discovery. |

**Side effects:** When `tab_id` is provided with a valid API key and the tab's URL matches a formatter, the call records an unlock entry for the (agentId, platform, tab_id) tuple. This allows the agent to call gated tools (`browser_get_accessibility_tree`, `browser_click`, `browser_type`, `browser_scroll`, `browser_execute_js`, `browser_inject_script`, `browser_request_chain`, `webpilot_run_workflow`) on that tab without hitting `platform_guide_required`. Without `tab_id`, the tool is pure discovery.

**Returns:**
```json
{
  "version": "1",
  "platforms": {
    "threads": {
      "name": "threads",
      "match": "threads.com",
      "description": "Platform-specific formatter for sites matching hostname \"threads.com\"",
      "source": "auto-updated",
      "workflows": [
        {
          "name": "open_thread",
          "description": "Open a thread by URL and return its formatted tree.",
          "parameters": { "url": "string" },
          "implemented": true
        }
      ]
    },
    "zillow": {
      "name": "zillow",
      "match": "zillow.com",
      "description": "Platform-specific formatter for sites matching hostname \"zillow.com\"",
      "source": "auto-updated",
      "workflows": []
    }
  },
  "default": { "entry": "default.js" },
  "customFormatterDir": "C:\\Users\\...\\WebPilot\\custom-formatters",
  "formatterApiContract": {
    "input": "{ url: string, title: string, tree: object }",
    "output": "{ tree: string, ...extraFields }"
  },
  "howToCreateCustomFormatter": "Step-by-step guide for authoring a custom platform formatter..."
}
```

> The `description` field shown above is the fallback that `formatter-manager.js` generates when a manifest entry has no `description` of its own — the current shipped `accessibility-tree-formatters/manifest.json` does not declare per-platform descriptions, so this fallback is what callers see today. The `version` value is the literal string in the manifest (currently `"1"`).

**Returns (when `platform` filter does not match):**
```json
{
  "version": "1",
  "platforms": null,
  "message": "Platform \"foo\" not found. Available platforms: threads, zillow",
  "default": { "entry": "default.js" },
  "customFormatterDir": "C:\\Users\\...\\WebPilot\\custom-formatters",
  "formatterApiContract": { },
  "howToCreateCustomFormatter": "..."
}
```

**Response Fields:**
| Field | Description |
|-------|-------------|
| `version` | Formatter API version |
| `platforms` | Object of available formatters, each with `name`, `match` pattern, `description`, and `source` |
| `platforms[].source` | `"auto-updated"` for GitHub-hosted formatters, `"custom"` for user-provided ones |
| `platforms[].workflows` | Array of `{ name, description, parameters, implemented }` rows declared in the platform's `manifest.json` and cross-checked against its `workflows.js`. Only call `webpilot_run_workflow` on entries with `implemented: true`. |
| `default` | Description of fallback behavior when no formatter matches |
| `customFormatterDir` | Absolute path to the `custom-formatters/` directory on this machine |
| `formatterApiContract` | Input/output specification for the formatter API |
| `howToCreateCustomFormatter` | Authoring guide for writing a custom platform formatter |

**Example Usage:**
```
// Get all available formatters
webpilot_get_formatter_info()
→ { "version": "...", "platforms": {...}, "customFormatterDir": "...", "formatterApiContract": {...}, ... }

// Filter to a specific platform
webpilot_get_formatter_info(platform="threads")
→ { "version": "...", "platforms": { "threads": { ..., "source": "auto-updated" } }, ... }
```

**Notes:**
- This tool does not require an API key (unauthenticated, like `request_pairing`, `check_pairing_status`, and `webpilot_dev_get_formatter_logs`).
- Use this tool to understand what platform formatters are available before calling `browser_get_accessibility_tree`
- The `howToCreateCustomFormatter` field provides a full guide for agents or users who want to author a custom formatter for a new platform
- Calling this tool also triggers a live reload of both manifests, so changes to `custom-formatters/manifest.json` are picked up immediately

---

### webpilot_reload_formatters

Reload all formatters (both auto-updated and custom) without restarting the server. Use this after adding or modifying custom formatter files in the `custom-formatters` directory. Returns the updated formatter state.

This tool does not require authentication.

**Parameters:** None

**Returns:**
```json
{
  "reloaded": true,
  "version": "1",
  "platforms": {
    "threads": {
      "name": "threads",
      "match": "threads.com",
      "description": "Platform-specific formatter for sites matching hostname \"threads.com\"",
      "source": "auto-updated"
    }
  },
  "customFormatterDir": "C:\\Users\\...\\WebPilot\\custom-formatters",
  ...
}
```

**Notes:**
- This tool is unauthenticated — no API key required.
- Triggers a full reload of both the auto-updated formatter manifest (`formatters/`) and the custom formatter manifest (`custom-formatters/`). Custom platform entries override auto-updated ones with the same key.
- Use this after dropping new formatter files into `custom-formatters/` and updating `custom-formatters/manifest.json`, rather than restarting the server
- The returned object merges `reloaded: true` with the full `getFormatterInfo()` response, so callers see the current state of all loaded formatters immediately
- If the auto-updated manifest has not yet been downloaded, reload returns only custom platforms and the default formatter is unavailable until the first auto-update completes

---

### webpilot_run_workflow

Execute a named, platform-specific workflow exposed by an accessibility-tree formatter. Workflows bundle multiple primitive actions (click, type, scroll, fetch the a11y tree, etc.) into a single server-side operation — much cheaper than firing the equivalent sequence of individual MCP tool calls.

Each formatter declares its workflows in `manifest.json` under `workflows[]` and implements them in a sibling `workflows.js` (CommonJS). Use `webpilot_get_formatter_info` to discover what's available per platform; each entry in the returned `workflows[]` array is annotated with `implemented: boolean` — only call `webpilot_run_workflow` on `implemented: true` rows.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `platform` | string | Yes | Formatter name (e.g. `"discord"`). See `webpilot_get_formatter_info`. |
| `workflow` | string | Yes | Workflow name (e.g. `"send_message"`). |
| `tab_id` | number | Yes | The browser tab to run the workflow against. |
| `params` | object | No | Workflow-specific parameters as declared in the workflow definition. |
| `intent` | string | No | Optional debug trace. |

**Returns:**
On success, an object of shape `{ ok: true, ...result }` where `result` is whatever the workflow's `run()` function returned. On failure, `{ ok: false, error: "<message>", diagnostics: {...} }` with `isError: true` set on the MCP response. The `diagnostics` object includes `phase`, `workflow`, `platform`, `tabId`, and error context.

**Example (Discord — `send_message`):**
```
webpilot_run_workflow(
  platform="discord",
  workflow="send_message",
  tab_id=1234567890,
  params={ "text": "Heads up team — deploy is queued." }
)
→ { "ok": true, "sent": true, "composerRef": "e42" }
```

Internally this workflow fetches the formatted accessibility tree, locates the composer textbox via `findInTree(tree, { name: 'Message textbox' })`, clicks it, types the supplied text, and presses Enter — one MCP round-trip instead of four.

**Errors:**
- `platform_guide_required` — Tool blocked on formatter-covered URLs until the agent calls `webpilot_get_formatter_info({platform, tab_id})` to unlock the tab. The error envelope includes `platform`, `tab_id`, and an `unlock_call` object naming the required call. Pass `usePlatformOptimizer: false` to bypass when intentional.
- `Workflow not found: <workflow>` — Workflow does not exist or is not implemented (`implemented: false` in manifest).
- `Invalid workflow parameters: ...` — Parameter types do not match the workflow declaration.

**Notes:**
- Workflow runtime errors include inline `diagnostics` in the error response (phase, workflow, platform, tabId), so you can see what failed without calling `webpilot_dev_get_formatter_logs`.
- Errors are also recorded to per-formatter logs so the Web UI Formatters tab can surface recent errors for pattern analysis.
- Workflow parameters are type-checked against the manifest declaration (string/number/boolean/object/array). All parameters are treated as optional unless explicitly required by the workflow's `run()` implementation.
- Workflows execute server-side using the same internal browser primitives as the MCP tool dispatch — so per-agent profile routing, visual cursor, auth, and refs all keep working transparently.

---

### Custom Formatters

Agents and users can add site-specific formatters that are never overwritten by auto-updates:

1. **Drop formatter files** into the `custom-formatters/` directory (absolute path returned in `customFormatterDir`)
2. **Register the platform** by editing `custom-formatters/manifest.json`:
   ```json
   {
     "version": "1",
     "platforms": {
       "mysite": { "match": "mysite.com", "entry": "my-formatter.js" }
     },
     "files": ["my-formatter.js"]
   }
   ```
3. **Reload** by calling `webpilot_reload_formatters`, calling `webpilot_get_formatter_info`, or restarting the server
4. Custom formatters take **priority** over auto-updated ones for the same domain
5. The `howToCreateCustomFormatter.customFormatters` field in the response has step-by-step instructions

---

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
- Tabs interacted with via WebPilot are organized based on the `tabMode` setting (stored in `chrome.storage.local`):
  - `"group"` (default): Tabs are grouped into a cyan "WebPilot" tab group in the current window
  - `"window"`: Tabs are opened in a dedicated separate WebPilot window

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
  "title": "",
  "warning": "Platform 'threads' detected on the URL you opened. Call webpilot_get_formatter_info({platform:'threads', tab_id:1062346731}) before interacting."
}
```

**Response Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `tab_id` | number | The new tab's ID for future reference |
| `url` | string | The URL the tab was opened with |
| `title` | string | Page title (may be empty if page hasn't finished loading) |
| `warning` | string | Optional. Present when the requested URL matches a platform with a formatter. Names the formatter and the unlock call needed before interacting with the tab. |

**Notes:**
- Title may be empty if the page hasn't finished loading
- The new tab is **not** active by default (`focusNewTabs` defaults to `false`). This is a user-configurable setting stored in `chrome.storage.local`.
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

Gets the accessibility tree (a11y DOM) of a browser tab. Returns a pre-filtered, LLM-optimized representation of the page — ignored nodes and empty elements are stripped. When a platform formatter is available (e.g., Threads, Zillow), it is applied automatically to produce compact structured JSON instead of raw tree text. Use `webpilot_get_formatter_info` to see which platforms have formatters and what their output looks like.

**Parameters:**
| Parameter | Type   | Required | Description                    |
|-----------|--------|----------|--------------------------------|
| `tab_id`  | number | Yes      | The tab ID to get the tree from |
| `usePlatformOptimizer` | boolean | No | Use platform-specific formatting if available (default: true) |

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
  "platform": "threads"
}
```

**Returns (with usePlatformOptimizer=true on Threads Activity):**
```json
{
  "tree": "{\"source\":{\"title\":\"Activity • Threads\",\"url\":\"https://www.threads.com/activity\"},\"nav\":[...],\"activity\":{\"_followSchema\":[\"user\",\"others\",\"time\",\"ref\"],\"follows\":[],\"_likeSchema\":[\"user\",\"others\",\"time\",\"postUrl\",\"postPreview\",\"ref\"],\"likes\":[[\"zryork\",2,1768772938224,\"https://...\",\"post preview\",\"e10\"]],...}}",
  "elementCount": 37,
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
  "platform": "threads"
}
```

**Returns (with usePlatformOptimizer=true on Threads Search Results):**
```json
{
  "tree": "{\"source\":{\"title\":\"Search • Threads\",\"url\":\"https://www.threads.com/search?q=AI&serp_type=default\"},\"nav\":[...],\"filter\":\"Top\",\"_filterSchema\":[\"name\",\"ref\"],\"filters\":[[\"Top\",\"e10\"],[\"Recent\",\"e11\"],[\"Profiles\",\"e12\"]],\"_postSchema\":[\"url\",\"content\",\"time\",\"likes\",\"replies\",\"reposts\",\"shares\",\"likeRef\",\"replyRef\",\"tags\"],\"posts\":[[\"https://www.threads.com/@user/post/xyz\",\"Post content about AI...\",1737295920000,47,34,0,0,\"e20\",\"e21\",[\"AI Threads\"]],...]}",
  "elementCount": 120,
  "postCount": 15,
  "platform": "threads"
}
```

**Response Fields:**
| Field | Description |
|-------|-------------|
| `tree` | JSON string representation of page content (format depends on platform/page type) |
| `elementCount` | Total number of interactive elements with refs |
| `postCount` | (Threads home/profile/search results) Number of posts extracted |
| `listingCount` | (Zillow search/detail) Number of property listings extracted |
| `platform` | (When optimizer used) Detected platform name |

> **Note:** The handler passes through every field the formatter returns via a `...extras` spread (see `mcp-handler.js` `browser_get_accessibility_tree` response builder). The exact set of count/metadata fields depends on which formatter matched (`postCount`, `ghostCount`, `listingCount`, `activityCount`, etc.).

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
| Zillow | Home | `zillow.com` (homepage) | JSON with structured home page content |
| Zillow | Search | `zillow.com` (search results) | JSON with listings array (property details, prices, refs) |
| Zillow | Detail | `zillow.com` (property page) | JSON with structured property detail information |
| Zillow | Detail Overlay | `zillow.com` (overlay on search) | JSON with property detail overlay information |

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
- `platform_guide_required` — Tool blocked on formatter-covered URLs until the agent calls `webpilot_get_formatter_info({platform, tab_id})` to unlock the tab. The error envelope includes `platform`, `tab_id`, and an `unlock_call` object naming the required call. Pass `usePlatformOptimizer: false` to bypass when intentional.
- `Another debugger is already attached to this tab` - DevTools or another extension is debugging the tab
- `Failed to attach debugger: ...` - Tab may not exist or be a protected page (chrome://, etc.)
- Formatter errors return `{ ok: false, error: "<message>", diagnostics: {...} }` (rather than throwing). The `diagnostics` object includes `phase`, `platform`, `tabId`, and error context.

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
- `platform_guide_required` — Tool blocked on formatter-covered URLs until the agent calls `webpilot_get_formatter_info({platform, tab_id})` to unlock the tab. The error envelope includes `platform`, `tab_id`, and an `unlock_call` object naming the required call. Pass `usePlatformOptimizer: false` to bypass when intentional.
- `Fetched script is empty` - Script fetch returned empty content
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

Executes JavaScript code in the page context and returns the result. Use ONLY for reading values or computing derived data that the accessibility tree does not already expose. **Do NOT use for navigation, clicking, typing, scrolling, or any DOM manipulation** — those have dedicated tools (`browser_create_tab`, `browser_click`, `browser_type`, `browser_scroll`, `browser_close_tab`) that integrate with WebPilot's visual cursor, scroll easing, focus management, and refs system. Using `browser_execute_js` to click/type/navigate bypasses all of those and produces brittle, hard-to-debug interactions. For page data extraction, prefer `browser_get_accessibility_tree` which already provides pre-filtered, structured content.

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

// Async/await (Promises are automatically awaited)
browser_execute_js(tab_id, 'fetch("/api/data").then(r => r.json())')
→ { "success": true, "result": { "items": [...] } }
```

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `platform_guide_required` — Tool blocked on formatter-covered URLs until the agent calls `webpilot_get_formatter_info({platform, tab_id})` to unlock the tab. The error envelope includes `platform`, `tab_id`, and an `unlock_call` object naming the required call. Pass `usePlatformOptimizer: false` to bypass when intentional.
- `code is required` - Missing code parameter
- `Cannot execute scripts on protected pages` - Tab is chrome://, chrome-extension://, or about: URL
- `Another debugger is already attached to this tab` - Close DevTools or other debuggers first
- JavaScript errors from the code (e.g., `ReferenceError: x is not defined`)

**Notes:**
- Uses Chrome Debugger Protocol (Runtime.evaluate) - works like DevTools console
- Code is evaluated as an expression, not a function body (no `return` needed)
- **Supports async/await:** The evaluation uses `awaitPromise: true`, so the code can return a Promise and it will be automatically awaited before returning the result
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
  - 800-1200px: linearly interpolates between 500Hz and 1000Hz
  - ≥ 1200px: max 1000Hz
- **Acceleration curve**: slow start → peak speed at 50-80% → slow end
- Both visual cursor and CDP `mouseMoved` events are dispatched for each path point
- SVG arrow pointer with "WebPilot" text label:
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
- `platform_guide_required` — Tool blocked on formatter-covered URLs until the agent calls `webpilot_get_formatter_info({platform, tab_id})` to unlock the tab. The error envelope includes `platform`, `tab_id`, and an `unlock_call` object naming the required call. Pass `usePlatformOptimizer: false` to bypass when intentional.
- `Either selector, ref, or x,y coordinates are required` - No click target provided
- `Ref "eX" not found. Fetch accessibility tree first.` - Ref doesn't exist in stored refs
- `Element for ref "eX" no longer exists in DOM` - Page changed since tree fetch
- `Element not found: <selector>` - CSS selector matched nothing
- `Element has no dimensions` - Matched element is hidden or zero-size
- `button must be left, right, or middle` - Invalid button value
- `Element no longer exists after scroll. Re-fetch accessibility tree and try again.` - Element could not be re-identified after auto-scroll
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

Scroll to element OR by pixel amount. Uses smooth easing (50ms per 50px for window scrolls, 75ms per 50px for container scrolls).

> **Note:** The registered MCP tool description in `mcp-handler.js` says "Uses smooth easing (75ms per 50px)" without differentiating window vs container scrolls. In practice, `calculateScrollDuration()` in `utils/scroll.js` defaults to 50ms per 50px for window scrolls, while container scrolls use 75ms per 50px (hardcoded in `scrollElementIntoView()`). The tool description string is slightly inaccurate; the behavior documented below is correct.

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
| `pixels` | number | Echoed back when `pixels` was used as input |
| `duration` | number | Animation duration used (ms) |
| `containerScrolled` | boolean | Whether a scrollable container was scrolled instead of the window |

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
- Duration auto-calculated: 50ms per 50px of scroll distance for window scrolls, 75ms per 50px for container scrolls
- Cubic ease-in-out for natural feel (slow start → fast middle → slow end)
- Centers element in viewport when using ref/selector

**Container Scroll Handling:**
- When a target element is inside a scrollable container (dropdown, modal, sidebar, etc.), the scroll handler automatically detects and scrolls the container instead of the window
- The response includes `containerScrolled: true` when a container was scrolled
- Container scrolls use a slightly slower timing (75ms per 50px) compared to window scrolls (50ms per 50px)

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `platform_guide_required` — Tool blocked on formatter-covered URLs until the agent calls `webpilot_get_formatter_info({platform, tab_id})` to unlock the tab. The error envelope includes `platform`, `tab_id`, and an `unlock_call` object naming the required call. Pass `usePlatformOptimizer: false` to bypass when intentional.
- `Either ref/selector OR pixels is required` - No scroll target provided
- `Cannot specify both element target and pixels - use one or the other` - Both ref/selector and pixels provided
- `Ref "eX" not found. Fetch accessibility tree first.` - Ref doesn't exist
- `Element for ref "eX" no longer exists` - Page changed since tree fetch
- `Could not determine element position` - Element couldn't be located

**Notes:**
- Uses incremental `window.scrollTo()` for smooth window animation, or `element.scrollTo()` for container scrolls
- Element is centered in viewport after scroll
- Automatically detects scrollable containers and scrolls the appropriate element
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
- Only Enter is exposed as a special key via the `pressEnter` parameter. Other special keys (Tab, Backspace, Escape, Arrow keys) exist in the internal `typeKey()` function but are not accessible to MCP clients.
- Works with React, Vue, and other SPA frameworks (unlike setting `input.value` directly)
- Human-like timing with slight random variance on delay
- When `ref` or `selector` is provided, a click with cursor animation (`showCursor: true`) is performed first to focus the element

**Errors:**
- `tab_id is required` - Missing tab_id parameter
- `platform_guide_required` — Tool blocked on formatter-covered URLs until the agent calls `webpilot_get_formatter_info({platform, tab_id})` to unlock the tab. The error envelope includes `platform`, `tab_id`, and an `unlock_call` object naming the required call. Pass `usePlatformOptimizer: false` to bypass when intentional.
- `text is required` - Missing text parameter
- `Ref "eX" not found. Fetch accessibility tree first.` - Ref doesn't exist
- `Another debugger is already attached to this tab` - Close DevTools first

**Notes:**
- If `ref` or `selector` is provided, the element is clicked first to focus it
- Delay has ±30% random variance for human-like typing
- Chrome shows a yellow "started debugging" banner during typing
- For filling forms, prefer this over `browser_execute_js` with DOM manipulation

---

### browser_request_chain

Execute multiple tool calls sequentially and return combined results, without intermediate LLM reasoning between steps. Use this for fixed sequences where each step's inputs can be derived directly from prior step outputs using `$N.path.to.value` references. If you need to inspect a result and decide what to do next, call the tools individually instead. Validates all tool names before execution begins.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `steps` | array | Yes | Array of tool calls to execute in order |
| `steps[].tool` | string | Yes | The name of the tool to call. Cannot be `browser_request_chain`. |
| `steps[].arguments` | object | Yes | Arguments to pass to the tool. String values matching `$N.path.to.value` pattern will be resolved from prior step results. |
| `return_mode` | string | No | `"all"` returns results from every step (default), `"last"` returns only the final step result. |

**Returns (return_mode="all"):**
```json
{
  "results": [
    { "tab_id": 1062346731, "url": "https://example.com", "title": "" },
    { "tree": "...", "elementCount": 42 }
  ]
}
```

**Returns (return_mode="last"):**
Returns the raw result of the final step only, in the same format as calling that tool directly.

**Returns (on step failure):**
```json
{
  "results": [
    { "tab_id": 1062346731, "url": "https://example.com", "title": "" }
  ],
  "error": {
    "step": 1,
    "tool": "browser_get_accessibility_tree",
    "message": "Another debugger is already attached to this tab"
  }
}
```

**Result Referencing:**
String argument values matching the pattern `$N.path.to.value` are resolved from prior step results before execution:
- `$0.tab_id` -- resolves `tab_id` from step 0's result
- `$1.results.0.id` -- resolves the first element's `id` from step 1's result
- References work in nested objects and arrays
- Non-string values (numbers, booleans) pass through unchanged

**Pre-validation:**
Before executing any steps, the chain validates:
1. All tool names exist and are not `browser_request_chain` (no recursion)
2. All `$N` reference indices point to earlier steps (no forward or self references)

If pre-validation fails, no steps execute and an error is thrown.

**Example Usage:**
```
// Open a tab and immediately get its accessibility tree
browser_request_chain(
  steps=[
    { "tool": "browser_create_tab", "arguments": { "url": "https://example.com" } },
    { "tool": "browser_get_accessibility_tree", "arguments": { "tab_id": "$0.tab_id" } }
  ]
)
```

**Per-step locking behavior:** If a step targets a tab that's locked behind a formatter guide, that step's result is the inline `platform_guide_required` block envelope (with `platform`, `tab_id`, `unlock_call`). Other steps continue executing. An earlier step that calls `webpilot_get_formatter_info({platform, tab_id})` unlocks the tab for subsequent steps in the same chain.

**Errors:**
- `platform_guide_required` — Tool blocked on formatter-covered URLs until the agent calls `webpilot_get_formatter_info({platform, tab_id})` to unlock the tab. The error envelope includes `platform`, `tab_id`, and an `unlock_call` object naming the required call. Pass `usePlatformOptimizer: false` to bypass when intentional.
- `Unknown tool(s) in chain: step 0: "nonexistent_tool"` -- invalid tool name
- `Step 2 references $2 which has not executed yet` -- forward or self reference
- `Cannot use return_mode "last" with an empty steps array` -- empty steps with last mode
- `Reference $0.foo.bar: could not resolve 'bar' in step 0 result` -- unresolvable path

**Notes:**
- Steps execute sequentially; there is no parallel step execution
- On step failure, execution stops and returns all prior successful results plus the error
- Domain restriction rules still apply to each individual step
- `browser_request_chain` cannot be used as a step tool (no recursive chaining)

---

### Developer tools

The `webpilot_dev_*` namespace exists for formatter authors iterating against a live server. These tools are **not intended for production agents** — they expose internals (log ring buffers, extension reload) that production callers should never touch. Schemas live in `packages/server-for-chrome-extension/src/mcp-handler.js`.

| Tool | What it does |
|------|--------------|
| `webpilot_dev_get_formatter_logs` | Get error history for a platform formatter. Workflow and accessibility-tree errors already include the most recent diagnostic inline, so this is typically only needed when investigating multiple failures or developing a new formatter. Auth-exempt (read-only). |
| `webpilot_dev_reload_extension` | Triggers a `chrome.runtime.reload()` on the *calling agent's* paired Chrome profile. Requires auth. Multi-profile installs need one call per profile. Used when iterating on extension code; safe to skip in normal agent flows. |

See `accessibility-tree-formatters/DEV_GUIDE.md` for the formatter dev loop these tools support.

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

### Open a Page and Read It (Chained)

```
browser_request_chain(
  steps=[
    { "tool": "browser_create_tab", "arguments": { "url": "https://example.com" } },
    { "tool": "browser_get_accessibility_tree", "arguments": { "tab_id": "$0.tab_id" } }
  ]
)
// Returns both results in one call
```

---

## Window Management

All tabs have a `windowId` that identifies which browser window they belong to.

- Tabs in the same window share the same `windowId`
- Multiple windows will have different `windowId` values
- Use `windowId` to group tabs by window when needed

---

## Error Handling

### Not Authenticated

If a tool call is made without a valid API key (or with no key at all):
```json
{
  "code": -32001,
  "message": "Authentication required. Include your API key as the X-API-Key header or as the api_key argument on the tool call. If you don't have a key — or your previous one was revoked — call request_pairing with a memorable agent_name to start a new pairing flow."
}
```

**Cause:** Missing or invalid API key. The server checks `session.mcpApiKey` (from the `X-API-Key` header or `apiKey` query parameter on the SSE/message endpoints) and falls back to `params.arguments.api_key` (the per-tool-call parameter).

**Solution:** Call `request_pairing` to obtain an API key, then include it with all subsequent requests via the `X-API-Key` header or as the `api_key` parameter in tool call arguments.

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

If no Chrome extension is connected for the agent's bound profile, browser tools error helpfully. The exact error string is:

```
No browser instance connected for profile "<profileId>". Call browser_create_tab to launch Chrome.
```

The web UI at `http://localhost:3456/ui/` shows per-profile state (`active` / `ready` / `needs_setup`). The dashboard also surfaces a **Restart Chrome** action when the Chrome process is detected but missing the required `--silent-debugger-extension-api` flag (endpoint: `POST /api/ui/chrome/restart`).

**Solution:** Open the WebPilot web UI to inspect Chrome status, restart Chrome with the flag if needed, or re-load the unpacked extension in the target profile.

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

Add the server to your `.mcp.json` file with the API key as a header:

```json
{
  "mcpServers": {
    "webpilot": {
      "type": "sse",
      "url": "http://localhost:3456/sse",
      "headers": {
        "X-API-Key": "<your-key>"
      }
    }
  }
}
```

Replace `<your-key>` with the API key obtained from `request_pairing`.

### Prerequisites

1. MCP server running (`npm run dev` in `packages/server-for-chrome-extension/`)
2. Chrome extension loaded and connected
3. Extension shows "Connected" status

---

## Limitations

- **Accessibility tree only** - Content access via accessibility tree, not raw HTML/DOM
- **Persistent debugger sessions** - Debugger sessions are kept alive until the tab is closed, with focus emulation enabled so CDP commands work on background (non-active) tabs
- **No navigation control** - Cannot go back/forward or refresh tabs
- **Chrome only** - Extension only works in Chrome/Chromium browsers
- **Single browser** - Controls the browser where extension is installed
- **Protected pages** - Cannot access chrome://, chrome-extension://, about:, or other protected URLs
- **JS return values** - Return values from `browser_execute_js` must be JSON-serializable
