# BUILD_ARCHITECTURE.md Audit

Audited on: 2026-02-26
Audited against: actual codebase at `packages/`

## Inaccuracies

### 1. Architecture diagram shows `data/` as a child of `resources/` instead of a sibling

**Location in doc**: Lines 250-258, the ASCII architecture diagram.

The diagram renders `data/` at the same indentation level as `server/` and `chrome-extension/`, all under the `resources/` heading:

```
       | resources/ (bundled, no copying)
       ├── server/
       │     webpilot-server-for-chrome-extension.exe
       ├── chrome-extension/
       └── data/ (created at runtime)
```

This implies `data/` is inside `resources/`, i.e., `<installDir>/resources/data/`.

**What the code actually does**:

In `packages/electron/electron/main.js` line 27:
```js
return path.join(path.dirname(process.resourcesPath), 'data');
```

`path.dirname(process.resourcesPath)` strips the `resources` segment, yielding `<installDir>`. So the data directory is `<installDir>/data/`, a **sibling** of `resources/`, not a child.

In `packages/server-for-chrome-extension/src/service/paths.js` line 33:
```js
return path.resolve(path.dirname(process.execPath), '..', '..', 'data');
```

The server binary lives at `<installDir>/resources/server/<binary>`, so going up two levels yields `<installDir>`, and appending `data` gives `<installDir>/data/` -- consistent with main.js.

The prose sections of the doc (lines 84, 99-117, 119) correctly describe `data/` as a sibling of `resources/`. Only the diagram is wrong.

**Fix**: The diagram should show `data/` at the same level as `resources/`, not nested under it:

```
       ├── resources/ (bundled, no copying)
       │     ├── server/
       │     │     webpilot-server-for-chrome-extension.exe
       │     └── chrome-extension/
       └── data/ (created at runtime)
```

---

### 2. Extension directory listing omits actual subdirectories

**Location in doc**: Lines 60-68 and 105-110, the `resources/chrome-extension/` file tree.

The doc lists:
```
chrome-extension/
  manifest.json
  background.js
  popup/
  handlers/
  ...
```

**What actually exists** in `packages/chrome-extension-unpacked/`:
```
manifest.json
background.js
accessibility-storage.js
accessibility-tree.js
formatters/
handlers/
icons/
popup/
utils/
```

The doc omits `accessibility-storage.js`, `accessibility-tree.js`, and the `formatters/`, `icons/`, and `utils/` directories. The `...` ellipsis partially covers this, but the listing includes `popup/` and `handlers/` specifically while omitting three other directories and two root-level JS files. This is a minor issue since the `...` does imply more files exist.

---

## Verified Correct

### pkg configuration
The `pkg` block in `packages/server-for-chrome-extension/package.json` matches the doc exactly: `outputPath: "dist"`, `assets: ["src/**/*.js", "index.js"]`. The `build` script errors with the documented message, and `build:win`, `build:mac`, `build:linux` use the documented `pkg` CLI flags.

### Binary entry point
`"bin": "cli.js"` in `package.json` is correct.

### Build scripts (root package.json)
All root scripts (`dev`, `dev:server`, `dev:onboarding`, `start`, `dist:win`, `dist:mac`, `dist:linux`) match the doc exactly, including the workspace delegation syntax.

### Electron build targets
`electron-builder.yml` confirms: NSIS for Windows (x64), DMG for macOS (x64), AppImage for Linux (x64). `perMachine: false` confirms per-user install to `%LOCALAPPDATA%\Programs\`.

### extraResources bundling
`electron-builder.yml` confirms two `extraResources` entries: `from: ../server-for-chrome-extension/dist` to `server`, and `from: ../chrome-extension-unpacked` to `chrome-extension`. This matches the documented `resources/server/` and `resources/chrome-extension/` layout.

### CLI flags
All flags documented (`--foreground`, `--install`, `--uninstall`, `--status`, `--stop`, `--help`, `--version`, `--network`) are defined in `cli.js` `parseArgs` options block (lines 11-21). Behavior for each matches the doc.

### Default behavior (no flags) starts background daemon
`cli.js` lines 207-278 confirm: when no flags are set, the code spawns a detached child with `WEBPILOT_FOREGROUND=1` env var and exits. The doc accurately describes this.

### WEBPILOT_FOREGROUND env var for pkg binary workaround
`cli.js` line 228-234 spawns with `env: { ...process.env, WEBPILOT_FOREGROUND: '1' }` and empty args array `[]`. Line 190 checks `flags.foreground || process.env.WEBPILOT_FOREGROUND === '1'`. Correctly documented.

### Health check polling
`cli.js` lines 241-276 confirm: 6 attempts (`maxAttempts = 6`), 500ms intervals (`setTimeout(checkHealth, 500)`), polling `http://127.0.0.1:<port>/health`. Matches the doc's "6 attempts at 500ms intervals (up to 3 seconds)".

### Service registration routing
`src/service/index.js` routes by `process.platform`: `win32` -> `windows.js`, `darwin` -> `macos.js`, `linux` -> `linux.js`. Each module exports `install()`, `uninstall()`, `status()`. Matches the doc.

### Windows service: Registry Run key
`service/windows.js` uses `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` with value name `WebPilotServer`. No admin required. Matches the doc.

### macOS service: LaunchAgent plist
`service/macos.js` writes a plist to `~/Library/LaunchAgents/com.webpilot.server.plist`. Matches the doc.

### Linux service: systemd user service
`service/linux.js` writes a unit file to `~/.config/systemd/user/webpilot-server.service`. Matches the doc.

### Auto-registration on first run
`cli.js` lines 167-183 define `autoRegister()`, which checks `service.status().registered` and calls `service.install()` if not registered. Called from both foreground path (line 200) and background path (line 224). Matches the doc.

### Config file resolution
`paths.js` `getPort()` (line 92-95) and `getApiKey()` (line 97-100): config file first, then env var (`PORT`/`API_KEY`), then hardcoded default (`3456`/`'dev-123-test'`). Matches the doc.

### Daemon logging (SizeManagedWriter)
`service/logger.js` confirms: 1 GB max (`MAX_SIZE = 1073741824`), rotation drops oldest 25% (`content.length / 4`), strips ANSI codes (`str.replace(/\x1b\[[0-9;]*m/g, '')`), truncates on startup (`fs.writeFileSync(logPath, '', 'utf8')`), intercepts `process.stdout.write` and `process.stderr.write`. All match the doc.

### PID and port file management
`cli.js` `isAlreadyRunning()` (lines 150-164) and `handleStop()` (lines 93-121) confirm the documented behavior: reads PID file, checks if process is alive via `process.kill(pid, 0)`, cleans up stale files, `--stop` kills by PID and removes both files.

### Data directory path computation
`paths.js` line 33: `path.resolve(path.dirname(process.execPath), '..', '..', 'data')` matches the doc's stated formula. Dev mode fallback to `%LOCALAPPDATA%\WebPilot\` on Windows (line 38) also matches.

### Electron app launch sequence
`electron/main.js` lines 89-96: `ensureDataDir()`, `startServer()`, `createWindow()` -- matches the doc's claim of "ensures data directory exists, spawns server, opens management UI".

### No file copying at runtime
`electron/main.js` `startServer()` spawns the binary directly from `process.resourcesPath/server/`. No `fs.copyFileSync` or similar operations exist. Matches the doc's claim that no deployment/copying occurs.

### Electron app is Next.js inside Electron
`packages/electron/package.json` has `next` as a dependency. The dev script runs `next dev`. The main process loads `out/index.html` in production. Matches the doc.
