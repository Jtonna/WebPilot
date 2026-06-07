# WebPilot

[![Build & Release](https://github.com/Jtonna/WebPilot/actions/workflows/release.yml/badge.svg)](https://github.com/Jtonna/WebPilot/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**WebPilot lets AI agents drive your real Chrome browser** — your tabs, your logged-in sessions, your bookmarks — instead of an isolated headless instance. It runs as a local background service, ships with a Chrome extension as the on-page bridge, and gates every agent through an explicit human pairing handshake.

If you've ever wanted Claude (or any MCP-capable agent) to read what's in your Gmail tab, fill out a form on a site you're already signed into, or do research while preserving the page state you can see — that's the thing.

---

## Install

Download the latest installer from the [Releases page](https://github.com/Jtonna/WebPilot/releases/latest):

| Platform | File |
|----------|------|
| Windows  | `WebPilot-<version>-windows.exe` |

WebPilot ships for Windows. macOS and Linux code paths exist in the source tree but are not released.

The installer is currently **unsigned**. SmartScreen will warn on first run — click "More info" → "Run anyway".

The WebPilot service starts automatically on login. The Chrome extension is auto-deployed to your user data directory, and you **sideload it once per Chrome profile** — open `chrome://extensions`, enable Developer Mode, "Load unpacked", and point at the deployed extension path. See [`docs/WHY_DEPLOY_VIA_SIDELOADING.md`](docs/WHY_DEPLOY_VIA_SIDELOADING.md) for why this isn't on the Chrome Web Store.

## Quick start: pair your first agent

1. Open the dashboard at <http://localhost:3456/ui/>.
2. Add WebPilot to your MCP client (e.g. Claude Code `.mcp.json`):
   ```json
   {
     "mcpServers": {
       "webpilot": { "url": "http://localhost:3456/sse" }
     }
   }
   ```
3. From the agent, call the `request_pairing` tool with a memorable `agent_name`. The tool returns a `pairing_id` and `status: 'pending'`.
4. A desktop notification fires and the dashboard's **Action items** section shows the pending request.
5. Pick the Chrome profile the agent should drive, hit **Approve**, and the agent's next call to `check_pairing_status` returns its API key.
6. Persist the key as the `X-API-Key` header in your MCP client config (or pass it as `api_key` on each tool call).

If your agent already has an API key (e.g. a subagent inheriting its parent's `.mcp.json`), `request_pairing` short-circuits and returns the existing identity — no re-pairing needed.

For the full tool reference, see [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md).

## Architecture

```
packages/
  chrome-extension-unpacked/   Chrome MV3 extension — browser automation bridge
  server-for-chrome-extension/ Node.js MCP server — agents-to-extension bridge,
                               hosts the web UI, manages Chrome (detect/restart),
                               routes per-agent tool calls to bound profiles
  server-web-ui/               Next.js dashboard served at /ui
  electron/                    Installer + tray app (deploys server + extension)
```

**Security model:** extension = identity (via per-profile `installId`), server = security boundary, agents = power (gated by paired API keys + explicit human approval). The extension does not hold any shared secret — every Chrome profile has a distinct identity and every agent has a distinct key. See [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md) §Authentication & authorization.

**Per-agent profile routing:** each paired agent is bound to one Chrome profile. Tool calls route to that profile via the agent's API key. The Agents page can re-bind an agent in-place — no socket teardown.

**Site-specific formatters** live in [`accessibility-tree-formatters/`](accessibility-tree-formatters/). Each is a small JS module with a `manifest.json` that transforms a site's a11y tree into something agent-friendly. Bundled: `discord`, `threads`, `zillow`. The server pulls fresh copies from GitHub on startup. Bundled formatters are cryptographically signed (Ed25519); the daemon refuses to apply any update whose signature doesn't verify against the bundled `PUBKEY.pem`. Some formatters expose composite operations as **workflows** — server-side multi-step actions invoked via `webpilot_run_workflow` (e.g. Discord's `send_message` does fetch-tree + locate + click + type + Enter in one call).

### Custom formatters (sideloading)

You can ship your own formatter for any site without going through the repo. Drop your files into `<userData>/custom-formatters/`:

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\@webpilot\onboarding\custom-formatters\` |
| macOS    | `~/Library/Application Support/@webpilot/onboarding/custom-formatters/` |
| Linux    | `~/.config/@webpilot/onboarding/custom-formatters/` (or `$XDG_CONFIG_HOME/@webpilot/onboarding/custom-formatters/`) |

Add an entry to `custom-formatters/manifest.json` under `platforms`:

```json
{
  "version": "1",
  "platforms": {
    "mysite": {
      "match": "mysite.com",
      "entry": "mysite/formatter.js"
    }
  }
}
```

Then call `webpilot_get_formatter_info` (or restart the daemon) to pick up the change. **Custom formatters do not require a signature** — signing only gates the remote auto-update channel, not files you place locally. They also persist across upgrades and are never overwritten by the auto-updater. See [`accessibility-tree-formatters/DEV_GUIDE.md`](accessibility-tree-formatters/DEV_GUIDE.md) for the formatter API + workflow shape.

Full architecture index: [`docs/INDEX.md`](docs/INDEX.md).

## Development

Requires Node 22+ and a local Chrome install.

```bash
git clone https://github.com/Jtonna/WebPilot.git
cd WebPilot
npm install
npm run dev
```

This runs the server (hot-reload via `node --watch`) and the Next.js web UI concurrently. The server detects `WEBPILOT_DEV=1` and proxies `/ui/*` to `http://localhost:3100`. The dashboard is at <http://localhost:3456/ui/>.

`npm run start` builds the Next.js static export and runs the server in production mode (serving `/ui/*` from `packages/server-web-ui/out/`). Build details in [`docs/BUILD_ARCHITECTURE.md`](docs/BUILD_ARCHITECTURE.md).

Local installer build:

```bash
npm run dist:win    # or :mac / :linux
```

## Contributing

Issues and PRs welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — releases are cut manually from the Actions tab (patch / minor / major dispatchers), so merging a PR does not auto-release.

Found a security issue? Please follow [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

By participating in this project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Jacob Tonna
