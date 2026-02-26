# Electron App (Phase 2)

Next.js Electron application for installer onboarding and MCP server service management.

## Purpose

The Electron app provides a graphical interface for setting up and managing WebPilot. It does NOT run the MCP server -- the server runs independently as a background service registered via the CLI (`--install` flag). The Electron app is a separate control panel.

## Planned Features

### Onboarding Wizard

- Guide users through Chrome extension sideloading (enable Developer Mode, Load unpacked, select extension folder)
- Display the connection string for pasting into the extension popup
- Show the MCP config snippet for adding to Claude Code or other MCP clients
- Verify setup: check that the server is running, extension is connected, and end-to-end communication works

### Status Dashboard

- Show whether the MCP server background service is running
- Show whether the Chrome extension is connected
- Display active MCP sessions
- Provide start/stop/restart controls for the background service

### Configuration Management

- View and update the server port and API key
- Regenerate the API key
- Toggle network mode (localhost vs. LAN access)

## Architecture

The app will be built with Next.js inside Electron, producing platform-specific installers:

| Platform | Installer Format |
|----------|-----------------|
| Windows  | NSIS `.exe` |
| macOS    | `.dmg` |
| Linux    | AppImage |

The installer will bundle both the compiled MCP server binary and the unpacked extension files. During installation, it deploys these to the platform app data directory and registers the server as a background service.

## Current Status

Phase 2 placeholder. The `packages/electron/` directory contains only a `package.json` stub:

```
packages/electron/
  package.json    # Name: @webpilot/electron, version 0.0.1
```

No implementation exists yet. The MCP server and Chrome extension (Phase 1) are functional independently.
