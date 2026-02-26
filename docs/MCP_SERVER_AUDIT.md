# MCP_SERVER.md — Audit

## Inaccuracies

### 1. Service Management Claimed as "Stubs" — Actually Fully Implemented
- **Doc says**: `--install`, `--uninstall`, and `--status` are "currently stubs that detect the platform and print a 'not yet implemented' message."
- **Reality**: Fully implemented across all 3 platforms:
  - Windows: Registry Run key (windows.js)
  - macOS: launchd plist (macos.js)
  - Linux: systemd user service (linux.js)
- Each has complete `install()`, `uninstall()`, `status()` with PID/port file management, health checking, and detailed status output.

### 2. CLI Flags Incomplete
- **Doc lists**: `--install`, `--uninstall`, `--status`, `--help`, `--version`, `--network`
- **Missing**: `--stop` (kills running server by PID) and `--foreground` (runs in foreground for daemon self-spawn via env var)

### 3. Configuration Loading Chain Incomplete
- **Doc says**: Config comes from environment variables and `process.argv`
- **Reality**: Actual loading order is:
  1. Config file at `getDataDir()/config/server.json` (if exists)
  2. Environment variables (fallback)
  3. Hardcoded defaults (final fallback)
- The config file mechanism is not documented at all.

## Missing from Documentation

### 4. Background Daemon Implementation
- CLI spawns a detached child process with `WEBPILOT_FOREGROUND=1` env var
- Health endpoint polling to verify startup (6 attempts, 500ms apart)
- Stale PID file detection and cleanup
- Auto-registration of service on first run
- None of this is documented.

### 5. Daemon Logging System
- Size-managed log writer (1GB max) in `logger.js`
- Automatic log rotation with 25% discard strategy
- ANSI code stripping for clean logs
- Dual stdout/stderr capture
- Not documented.

### 6. PID and Port File Management
- Automatic PID/port file creation in data directory
- Cleanup on process exit (SIGTERM, SIGINT, exit)
- Validation and cleanup of stale files
- Not documented.

### 7. Data Directory Structure
- Platform-specific: LOCALAPPDATA on Windows, ~/Library/Application Support on macOS, ~/.config on Linux
- Subfolder organization: logs/, config/, server.pid, server.port
- Intelligent path resolution for pkg binaries vs development mode
- Not documented.

### 8. Connection String Encoding
- Format: `vf://` + base64url-encoded JSON with schema `{ v: 1, s: serverUrl, k: apiKey }`
- Exposed via `/connect` endpoint
- Not documented in this file.

### 9. Message Queuing in SSE Handler
- Maintains per-session message queue, flushed every 100ms
- Keepalive messages every 30 seconds
- Not documented.

## Verified Correct

- Entry point chain: cli.js → index.js → src/server.js
- cli.js uses Node 18's `util.parseArgs`
- index.js bootstrap behavior
- src/server.js Express + WebSocket setup
- MCP protocol implementation (SSE, message handling, tool routing, script fetching)
- extension-bridge.js methods (setConnection, clearConnection, isConnected, sendCommand, handleResponse)
- All 9 MCP tools listed and implemented
- All HTTP endpoints (/sse, /message, /health, /connect, WebSocket /)
- WebSocket authentication via `?apiKey=` query parameter
- Communication flow diagram
- Dependencies list (express, cors, ws, uuid, @yao-pkg/pkg)
- Network mode behavior
- Build targets (node18-win-x64, node18-macos-x64, node18-linux-x64)
