# BUILD_ARCHITECTURE.md — Audit

## Inaccuracies

### 1. Service Registration Claimed as "Stubs" — Actually Fully Implemented
- **Doc says**: "Service registration is currently stubbed in cli.js. It is not yet implemented."
- **Reality**: Fully implemented across all 3 platforms:
  - Windows: Registry Run key (HKCU) in `service/windows.js`
  - macOS: launchd plist in `service/macos.js`
  - Linux: systemd user service in `service/linux.js`
- All have working `install()`, `uninstall()`, and `status()` methods.

### 2. Windows Service Mechanism Wrong
- **Doc says**: "Windows: Task Scheduler | Planned"
- **Reality**: Uses Registry Run key (HKCU\Software\Microsoft\Windows\CurrentVersion\Run), not Task Scheduler. Already implemented.

### 3. pkg Targets Config Misrepresented
- **Doc says**: pkg config in package.json contains a `targets` array with `node18-win-x64`, etc.
- **Reality**: The `pkg` section in `packages/server-for-chrome-extension/package.json` only has `outputPath` and `assets`. Targets are specified as CLI flags in the npm scripts (`build:win`, `build:mac`, `build:linux`).

### 4. CLI Flags Incomplete
- **Doc lists**: `--install`, `--uninstall`, `--status`, `--help`, `--version`, `--network`
- **Missing**: `--stop` (kills running server by PID) and `--foreground` (runs in foreground, used for daemon self-spawn)

### 5. Deployment Paths Inaccurate
- **Doc says**: Server binary is copied from bundled resources to `%LOCALAPPDATA%\WebPilot\`
- **Reality**: No copying occurs. Server runs directly from its bundled location in `process.resourcesPath/server/`. The data directory path is computed relative to the binary location, not a fixed AppData path.

### 6. Extension Directory Name Wrong
- **Doc says**: `chrome extension/unpacked-extension/`
- **Reality**: electron-builder.yml shows `from: ../chrome-extension-unpacked` → `to: chrome-extension`. The directory is `chrome-extension/`, not `chrome extension/unpacked-extension/`.

### 7. Root npm Scripts Names Outdated
- **Doc says**: `build`, `build:electron`, `build:all` (some marked as "to be added")
- **Reality**: Actual scripts are `dist:win`, `dist:mac`, `dist:linux` which combine server and electron builds.

## Missing from Documentation

### 8. Auto-Registration on First Run
- Server automatically registers itself as a service on first startup (cli.js). Not documented.

### 9. Health Check Polling
- After spawning the daemon, CLI polls the health endpoint (6 attempts, 500ms apart) to verify startup. Not documented.

### 10. Config File Structure
- Config stored at `<dataDir>/config/server.json` with `apiKey` and `port` fields. Not documented.

### 11. Daemon Logging System
- Size-managed log writer (1GB max), automatic rotation with 25% discard, ANSI stripping. Not documented.

### 12. PID/Port File Management
- Automatic PID/port file creation, cleanup on exit, stale file detection. Not documented.
