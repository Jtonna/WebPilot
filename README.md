# WebPilot

AI-powered browser automation through Chrome extension and MCP server.

WebPilot lets AI agents control a real Chrome browser through the Model Context Protocol (MCP). A Chrome extension handles browser actions (clicking, scrolling, typing, reading page content) while a Node.js server bridges the extension to any MCP-compatible AI agent. The server compiles to standalone binaries and runs as a background service.

## Project Structure

```
packages/
  chrome-extension-unpacked/   Chrome extension (Manifest V3) — browser automation
  server-for-chrome-extension/ Node.js MCP server — bridges AI agents to the extension,
                               hosts the web UI at /ui, manages Chrome (detect/restart),
                               routes per-agent tool calls to bound Chrome profiles
  server-web-ui/               Next.js static-export web UI bundled into the server pkg
                               binary and served at http://localhost:3456/ui
  electron/                    Electron installer wrapper — spawns the server binary,
                               shows a minimal status window
```

## Documentation

See [Documentation Index](docs/INDEX.md) for system architecture, development guides, and API reference.

## Quick Start

Start the MCP server:

```bash
cd packages/server-for-chrome-extension
npm install
npm start
```

Load the Chrome extension:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked** and select `packages/chrome-extension-unpacked/`
4. The extension automatically connects to the MCP server on startup — no connection string needed

Open the WebPilot web UI at http://localhost:3456/ui to manage pairings, profiles, and agents. The dashboard surfaces per-Chrome-profile status (`active` / `ready` / `needs_setup`) and offers a **Restart Chrome** action when Chrome is missing the `--silent-debugger-extension-api` launch flag (which suppresses the yellow "started debugging" banner on every CDP call).

Add to your MCP client (e.g., Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "webpilot": {
      "url": "http://localhost:3456/sse"
    }
  }
}
```

The MCP server identifies itself as `WebPilot` in the MCP `initialize` handshake (`serverInfo.name`).

**Pairing on first use (async flow):** MCP access is authenticated via per-agent API keys. The first time an agent connects, it calls `request_pairing` with a human-readable `agent_name`. The tool returns immediately with a `pairing_id` and `status` of `'pending'` (not the API key). A native notification fires on the host, pointing the human at the web UI to **Approve** or **Deny** and pick the Chrome profile to bind to. The agent then calls `check_pairing_status` with the `pairing_id` on a later turn to retrieve its API key. Use the key as the `X-API-Key` header in MCP client config, or as the `api_key` parameter on individual tool calls.

If the agent already presents a valid API key (e.g. a subagent inheriting its parent's `.mcp.json`), `request_pairing` short-circuits and returns the existing identity instead of creating a new pending entry — there is no need to re-pair.

**Pre-provisioned key flow (web UI):** The web UI's pair-agent modal can mint a key directly via `POST /api/ui/agents` and embed it in the `.mcp.json` snippet the operator copies. The agent never calls `request_pairing` at all in this flow.

**Per-agent profile routing:** Each paired agent is bound to one Chrome profile. Tool calls route to that profile via the agent's API key (see `mcp-handler.resolveTargetProfile`). The web UI's Agents page can re-bind an agent to a different profile in-place via `PATCH /api/ui/agents/:key` — no socket teardown, the next tool call picks up the new binding.
