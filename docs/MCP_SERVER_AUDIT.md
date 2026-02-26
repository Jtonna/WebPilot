# MCP_SERVER.md — Audit

## Inaccuracies

### 1. Service Management Claimed as "Stubs" — Actually Fully Implemented
- **Doc says**: `--install`, `--uninstall`, and `--status` are "currently stubs that detect the platform and print a 'not yet implemented' message."
- **Reality**: Fully implemented across all 3 platforms:
  - Windows: Registry Run key (`src/service/windows.js`)
  - macOS: launchd plist (`src/service/macos.js`)
  - Linux: systemd user service (`src/service/linux.js`)
- Each has complete `install()`, `uninstall()`, `status()` with PID/port file management, PID-alive validation, and detailed status output.
- The doc also claims Windows uses "Task Scheduler" — this is wrong. The actual implementation uses the Registry Run key at `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, which requires no admin elevation.

### 2. CLI Flags Incomplete
- **Doc lists**: `--install`, `--uninstall`, `--status`, `--help`, `--version`, `--network`
- **Missing**: `--stop` (kills running server by PID, cleans up PID/port files) and `--foreground` (runs server in foreground; used by the daemon self-spawn via `WEBPILOT_FOREGROUND` env var)

### 3. Configuration Loading Chain Incomplete
- **Doc says**: Config comes from environment variables and `process.argv`
- **Reality**: `index.js` calls `getPort()` and `getApiKey()` from `src/service/paths.js`. The actual loading order is:
  1. Config file at `getDataDir()/config/server.json` (if exists)
  2. Environment variables (`PORT`, `API_KEY`) as fallback
  3. Hardcoded defaults (`3456`, `dev-123-test`) as final fallback
- The config file mechanism is not documented at all.

### 4. Default Behavior Misdescribed
- **Doc says**: "No flags -- Requires `index.js` to start the server"
- **Reality**: Running with no flags starts the server as a **background daemon** — it spawns a detached child process with `WEBPILOT_FOREGROUND=1` and exits. It does NOT directly require `index.js`. The `--foreground` flag (or the env var) is needed to run the server in the current process.

### 5. Build Command Incorrect
- **Doc says**: `npm run build` compiles to standalone binaries.
- **Reality**: `npm run build` prints an error ("Use build:win, build:mac, or build:linux") and exits with code 1. The correct commands are `npm run build:win`, `npm run build:mac`, or `npm run build:linux`.

### 6. Hardcoded Version Mismatch in MCP Handler
- `src/mcp-handler.js` line 312 reports `serverInfo.version` as `0.2.0`, but `package.json` declares version `0.3.0`. These are out of sync.

## Missing from Documentation

### 7. Background Daemon Implementation
- CLI spawns a detached child process with `WEBPILOT_FOREGROUND=1` env var (avoids pkg binary argument-parsing issue where `--foreground` is treated as a module path)
- Health endpoint polling to verify startup (6 attempts, 500ms apart)
- Stale PID file detection and cleanup
- Auto-registration of service on first run (calls `service.install()` if not already registered)
- Already-running detection via PID file before spawning
- None of this is documented.

### 8. Daemon Logging System
- Size-managed log writer (1 GB max) in `src/service/logger.js`
- Automatic log rotation: drops oldest 25% of the log when size limit is reached
- ANSI escape code stripping for clean log files
- Dual stdout/stderr capture (intercepts `process.stdout.write` and `process.stderr.write`)
- Log file truncated fresh on each startup
- Not documented.

### 9. PID and Port File Management
- `src/server.js` writes `server.pid` and `server.port` to the data directory on listen
- Cleanup on process exit via SIGTERM, SIGINT, and `exit` event handlers
- `cli.js` validates and cleans up stale PID/port files when checking if server is already running
- `--stop` flag reads PID file, sends SIGTERM, and manually cleans up files (needed on Windows where SIGTERM kills immediately without running exit handlers)
- Not documented.

### 10. Data Directory Structure
- In **pkg binary mode**: resolves to `../../data/` relative to the executable path (designed for the Electron deployment layout)
- In **dev mode**: platform-specific user-local config directory:
  - Windows: `%LOCALAPPDATA%\WebPilot`
  - macOS: `~/Library/Application Support/WebPilot`
  - Linux: `$XDG_CONFIG_HOME/WebPilot` (defaults to `~/.config/WebPilot`)
- Contents: `daemon.log`, `server.pid`, `server.port`, `logs/` subdirectory, `config/server.json`
- Not documented.

### 11. SSE Handler Implementation Details
- Maintains per-session message queue, flushed every 100ms via `setInterval`
- Separate keepalive comment messages every 30 seconds
- Session cleanup on client disconnect (clears both intervals, removes session from Map)
- These operational details are not documented (though SSE sessions are mentioned at a high level).

### 12. WebSocket Ping/Pong Handling
- `src/server.js` handles incoming `{ type: 'ping' }` messages from the extension and responds with `{ type: 'pong' }` (lines 72-75). This keep-alive mechanism is not documented.

## Dead Code

### 13. Unused `portListening` Variable in All Platform Status Functions
- All three platform service modules (`windows.js`, `macos.js`, `linux.js`) compute a `portListening` variable (checking whether the port is actually listening via netstat/lsof) but never use it in the status output or return value. This is dead code.

## Verified Correct

- Entry point chain: cli.js -> index.js -> src/server.js
- cli.js uses Node 18's `util.parseArgs`
- index.js bootstrap behavior (host/publicHost resolution, network mode detection)
- src/server.js Express + WebSocket setup (CORS, JSON body parsing, noServer mode, manual upgrade)
- MCP protocol implementation (SSE, message handling, tool routing, script fetching with 10s timeout)
- extension-bridge.js methods (setConnection, clearConnection, isConnected, sendCommand with 30s timeout, handleResponse)
- All 9 MCP tools listed correctly with accurate parameter names
- HTTP endpoints (/sse, /message, /health, /connect, WebSocket /)
- WebSocket authentication via `?apiKey=` query parameter
- Communication flow diagram
- Dependencies list (express, cors, ws, uuid, @yao-pkg/pkg)
- Network mode behavior (0.0.0.0 vs 127.0.0.1, LAN IP advertisement)
- Connection string format (`vf://` + base64url JSON with `{ v, s, k }` schema) and `/connect` endpoint

## Verified By

**Date**: 2025-02-25
**Method**: Line-by-line verification of every audit claim against source files in `packages/server-for-chrome-extension/`.

**Changes from original audit**:
- **Updated #1**: Added explicit callout that the doc incorrectly claims Windows uses "Task Scheduler" when it actually uses Registry Run key. Corrected "health checking" to "PID-alive validation" (status functions check if PID is alive, not HTTP health).
- **Updated #2**: Added detail about what `--stop` does.
- **Added #4**: Default behavior (no flags) starts background daemon, not foreground server.
- **Added #5**: `npm run build` doesn't work; must use platform-specific build scripts.
- **Added #6**: Version mismatch between mcp-handler.js (0.2.0) and package.json (0.3.0).
- **Removed old #8** (Connection String Encoding): The doc DOES document this at line 59 ("Generates a connection string (`vf://` + base64url-encoded JSON)"). The audit incorrectly claimed it was undocumented.
- **Updated old #9 -> #11**: Noted that SSE sessions are mentioned at a high level in the doc; only the queue/flush implementation details are missing.
- **Added #12**: WebSocket ping/pong keep-alive handling not documented.
- **Added #13**: Dead code section for unused `portListening` variable across all platforms.
- **Updated Verified Correct**: Added connection string format (moved from "missing" since it IS documented). Added specifics like timeout values.
