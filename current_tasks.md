# Phase 1 — Current Tasks

## Completed

### #1 — Restructure repo into monorepo layout
Moved `mcp-server/` and `unpacked-extension/` into `packages/` directory. Created root `package.json` with npm workspaces config. Added empty `packages/electron/` placeholder for Phase 2.

**Result:**
```
packages/
  server-for-chrome-extension/  <- moved from root
  chrome-extension-unpacked/    <- moved from root (renamed from unpacked-extension)
  electron/                     <- empty placeholder
package.json        <- root workspaces config
```

---

### #2 — Configure pkg build pipeline for MCP server
Added `@yao-pkg/pkg` (actively maintained fork of vercel/pkg) as a devDependency. Configured targets for win-x64, macos-x64, linux-x64 on Node 18. `npm run build` in mcp-server outputs standalone binaries to `dist/`.

**Changes:** `packages/server-for-chrome-extension/package.json`
- Added `"build": "pkg . --out-path dist"` script
- Added `pkg` config with targets and assets
- Added `@yao-pkg/pkg` devDependency

---

### #3 — Create CLI entry point with --install, --uninstall, --status flags
Created `packages/server-for-chrome-extension/cli.js` as the new binary entry point. Uses Node.js built-in `util.parseArgs` (zero external dependencies). Supports `--install`, `--uninstall`, `--status`, `--help`, `--version`. Running with no flags boots the MCP server via `index.js`. Stubs log detected platform and "not yet implemented" messages.

**New file:** `packages/server-for-chrome-extension/cli.js`
**Changes:** `packages/server-for-chrome-extension/package.json` — `bin` field now points to `cli.js`

---

### #6 — Update .gitignore and add build/dist output structure
Added patterns for `*.exe`, `.pkg-cache/`, `config.local.json`, `*.code-workspace` to existing `.gitignore`. Existing entries already covered `dist/`, `build/`, `.env`, OS files, and editor files.

---

## Remaining

### #4 — Implement platform service registration
**Status:** Pending (was blocked by #3, now unblocked)
**Blocked by:** Nothing

Wire up the `--install`, `--uninstall`, and `--status` CLI stubs to actually register/manage the MCP server as a background service. Windows first since that's our dev/test environment.

**Windows implementation:**
- `--install`: Create a Windows Task Scheduler task that runs the binary on user login, hidden (no console window)
- `--uninstall`: Remove the Task Scheduler task
- `--status`: Query Task Scheduler to check if the task exists and if the process is running

**Acceptance criteria:**
- `--install` creates a scheduled task that starts the MCP server on login
- Task runs hidden (no console window)
- `--uninstall` cleanly removes the task
- `--status` reports whether the service is registered and running
- All operations fail gracefully with clear error messages

**Cross-platform:** macOS (launchd) and Linux (systemd) tracked in `CROSS_PLATFORM_CHECKLIST.md`

---

### #5 — Add platform config directory and secure API key generation
**Status:** Pending (was blocked by #3, now unblocked)
**Blocked by:** Nothing

Detect the platform-appropriate app data directory and persist configuration there. Generate a secure API key on first run.

**Windows implementation:**
- Config directory: `%APPDATA%/WebPilot/`
- Generate a cryptographically secure API key using `crypto.randomBytes`
- Persist config as JSON (key, port, settings)
- Server reads config from this location on startup

**Acceptance criteria:**
- Config directory created automatically on first run
- Secure API key generated (256-bit, hex or base64 encoded)
- Config written as JSON with key, port, and settings
- Server loads config from platform directory instead of hardcoded values
- Existing config is preserved (not overwritten on subsequent runs)

**Cross-platform:** macOS (`~/Library/Application Support/WebPilot/`) and Linux (`~/.config/WebPilot/`) tracked in `CROSS_PLATFORM_CHECKLIST.md`
