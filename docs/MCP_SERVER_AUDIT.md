# MCP_SERVER.md Audit

Audit performed against the codebase at `packages/server-for-chrome-extension/`.

## Inaccuracies

### 1. "All three platform service modules compute a `portListening` variable" (line 181)

The doc states:

> All three platform service modules compute a `portListening` variable (checking whether the port is actually listening via netstat/lsof) but never use it in the status output or return value.

Only **two** of the three modules compute `portListening`:

- `src/service/windows.js` lines 95-104: computes `portListening` via `netstat`, never uses it.
- `src/service/macos.js` lines 137-143: computes `portListening` via `lsof`, never uses it.
- `src/service/linux.js`: does **not** compute `portListening` at all. The variable does not appear anywhere in the file.

**Fix**: Change "All three" to "Two of the three (Windows and macOS)". Linux's `status()` has no port-listening check.

### 2. "--network -- Forwarded to index.js via `process.argv`" (line 33)

The doc states:

> `--network` -- Forwarded to `index.js` via `process.argv`

This is incomplete and misleading. In `cli.js` lines 185-188, the `--network` flag is forwarded via the **environment variable** `process.env.NETWORK = '1'`. While `process.argv` still contains `--network` in foreground mode (since `require('./index.js')` runs in the same process), in the **background daemon** case the child is spawned with an empty args array (`spawn(process.execPath, [])` at line 228), so `process.argv` does NOT contain `--network` in the child process. The env var `NETWORK=1` (inherited via `env: { ...process.env, WEBPILOT_FOREGROUND: '1' }`) is the actual forwarding mechanism for the daemon case.

`index.js` line 7 reads both: `process.argv.includes('--network') || process.env.NETWORK === '1'`.

**Fix**: Change to something like: "Forwarded to `index.js` via `process.env.NETWORK` (and also readable from `process.argv` in foreground mode)."

## Verified Correct

The following claims were checked against the code and confirmed accurate:

- **Entry point chain**: `cli.js` -> `index.js` -> `src/server.js` (cli.js line 206 requires index.js; index.js line 2 requires src/server.js).
- **`util.parseArgs`**: cli.js line 4 uses `require('node:util')` and line 25 calls `parseArgs()`.
- **CLI flags**: `--install`, `--uninstall`, `--status`, `--stop`, `--foreground`, `--help`, `--version`, `--network` all present in cli.js options (lines 12-21) and handled in the corresponding if-blocks.
- **`--stop` behavior**: Reads PID file, sends SIGTERM, manually cleans up PID/port files. Confirmed at cli.js lines 93-121.
- **`--foreground` and `WEBPILOT_FOREGROUND` env var**: cli.js line 190 checks both `flags.foreground` and `process.env.WEBPILOT_FOREGROUND === '1'`.
- **Background daemon spawn**: Uses `WEBPILOT_FOREGROUND=1` env var, not `--foreground` flag. Confirmed at cli.js lines 228-234.
- **Three-tier config**: `getPort()` and `getApiKey()` in `src/service/paths.js` lines 92-100 check config file first, then env var, then hardcoded default.
- **Default port `3456`**: paths.js line 10.
- **Default API key `dev-123-test`**: paths.js line 11.
- **Config file path**: `<dataDir>/config/server.json` per paths.js line 64.
- **NETWORK env var and `--network` flag**: index.js line 7 reads both.
- **Network mode listens on `0.0.0.0`**: index.js line 21.
- **Express with CORS and JSON body parsing**: server.js lines 37-39.
- **WebSocketServer in noServer mode**: server.js line 47 `{ noServer: true }`.
- **WebSocket auth via `?apiKey=` query parameter**: server.js line 51.
- **Ping/pong keep-alive**: server.js lines 72-75 handle `{ type: 'ping' }` with `{ type: 'pong' }` response.
- **PID and port file writing on listen**: server.js line 115 calls `writePidAndPortFiles(port)`.
- **Cleanup on SIGTERM, SIGINT, and exit**: server.js lines 140-150.
- **MCP routes `GET /sse` and `POST /message`**: server.js lines 95-96.
- **`GET /health` returns `extensionConnected` and `sessions` count**: server.js lines 98-104.
- **`GET /connect` returns connection string and server URL**: server.js lines 106-111.
- **Connection string format `vf://` + base64url JSON**: server.js lines 30-33.
- **SSE session UUID**: mcp-handler.js line 243 uses `uuidv4()`.
- **Queue flushed every 100ms**: mcp-handler.js line 266 `setInterval(..., 100)`.
- **Keepalive comment every 30 seconds**: mcp-handler.js line 271 `setInterval(..., 30000)`.
- **Both intervals cleared on disconnect**: mcp-handler.js lines 274-275.
- **Protocol methods**: `initialize`, `notifications/initialized`, `tools/list`, `tools/call` all handled in mcp-handler.js lines 305-350.
- **`serverInfo.version` hardcoded as `0.2.0`**: mcp-handler.js line 312.
- **`package.json` version is `0.3.0`**: package.json line 3. These are indeed out of sync.
- **Script fetching for `browser_inject_script`**: mcp-handler.js lines 387-394 call `fetchScriptFromUrl()`.
- **Extension bridge maintains single WebSocket connection**: extension-bridge.js uses a single `wsConnection` variable (line 4).
- **`sendCommand` returns Promise with UUID**: extension-bridge.js lines 29-56.
- **30-second command timeout**: extension-bridge.js line 6 `COMMAND_TIMEOUT = 30000`.
- **`handleResponse` routes by ID**: extension-bridge.js lines 58-77.
- **`setConnection`, `clearConnection`, `isConnected` lifecycle methods**: extension-bridge.js lines 8, 13, 25.
- **Nine MCP tools**: Confirmed by counting tools array in mcp-handler.js (lines 38-240).
- **Tool names and parameters**: All nine tool definitions in mcp-handler.js match the doc's table exactly.
- **Windows service uses Registry Run key `HKCU\...\Run`**: windows.js line 14.
- **macOS service uses launchd LaunchAgent plist**: macos.js lines 15-16 and install() function.
- **Linux service uses systemd user service unit**: linux.js lines 15-16 and install() function.
- **Each platform module provides `install()`, `uninstall()`, `status()`**: Confirmed in all three files.
- **PID-alive validation in status**: All three platform modules check `process.kill(pid, 0)`.
- **Health check polling**: cli.js lines 241-276 -- 6 attempts (`maxAttempts = 6`), 500ms apart.
- **Auto-registers service on first run**: cli.js lines 167-183 (`autoRegister()`) called at lines 200 and 224.
- **Logger intercepts stdout and stderr**: logger.js lines 74-85.
- **Strips ANSI escape codes**: logger.js line 20.
- **Log truncated fresh on startup**: logger.js line 12 `fs.writeFileSync(logPath, '', 'utf8')`.
- **Max log size 1 GB**: logger.js line 6 `MAX_SIZE = 1073741824`.
- **Drops oldest 25% on rotation**: logger.js line 37 `content.length / 4`.
- **Daemon log at `<dataDir>/daemon.log`**: paths.js line 60.
- **Data directory for pkg binary**: paths.js line 33 resolves two levels up from exe directory + `/data`.
- **Dev mode data directories**: Windows `%LOCALAPPDATA%\WebPilot`, macOS `~/Library/Application Support/WebPilot`, Linux `$XDG_CONFIG_HOME/WebPilot` (default `~/.config/WebPilot`). All confirmed at paths.js lines 37-44.
- **`npm run build` prints error and exits**: package.json line 12.
- **Build targets**: `node18-win-x64`, `node18-macos-x64`, `node18-linux-x64`. Confirmed in package.json lines 13-15.
- **Output directory `dist/`**: package.json line 18.
- **`cli.js` is the `bin` entry point**: package.json line 6.
- **Dependencies**: express, cors, ws, uuid all in package.json. `@yao-pkg/pkg` in devDependencies. All confirmed.
- **npm scripts `dev:network` and `start:network`**: package.json lines 10-11.
