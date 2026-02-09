# WebPilot

AI-powered browser automation through Chrome extension and MCP server.

WebPilot lets AI agents control a real Chrome browser through the Model Context Protocol (MCP). A Chrome extension handles browser actions (clicking, scrolling, typing, reading page content) while a Node.js server bridges the extension to any MCP-compatible AI agent. The server compiles to standalone binaries and runs as a background service.

## Project Structure

```
packages/
  extension/                  Chrome extension (Manifest V3) — browser automation
  mcp-server/                 Node.js MCP server — bridges AI agents to the extension
  electron/                   Electron app (Phase 2) — installer and status dashboard
```

## Documentation

- [docs/BUILD_ARCHITECTURE.md](docs/BUILD_ARCHITECTURE.md) — Build system and release pipeline
- [docs/CHROME_EXTENSION.md](docs/CHROME_EXTENSION.md) — Chrome extension architecture
- [docs/MCP_SERVER.md](docs/MCP_SERVER.md) — MCP server architecture
- [docs/ELECTRON_APP.md](docs/ELECTRON_APP.md) — Electron app architecture (Phase 2)

## Issue Tracking

WebPilot uses [beads](https://github.com/steveyegge/beads) for git-backed issue tracking. Issues live in `.beads/issues.jsonl` and sync to the GitHub Projects kanban board when merged to `main`. See [docs/BEADS_SYNC.md](docs/BEADS_SYNC.md) for details.

## Quick Start

Start the MCP server:

```bash
cd packages/mcp-server
npm install
npm start
```

Load the Chrome extension:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode**
3. Click **Load unpacked** and select `packages/extension/`
4. Click the WebPilot extension icon and paste the connection string from the server output

Add to your MCP client (e.g., Claude Code):

```bash
claude mcp add -s project --transport sse webpilot "http://localhost:3456/sse"
```
