# Documentation Index

WebPilot documentation covering system architecture, development guides, and API reference.

## Architecture

- [BUILD_ARCHITECTURE.md](BUILD_ARCHITECTURE.md) -- Build pipeline, pkg compilation, Electron packaging, deployment paths, and CLI flags. For anyone working on the build system or understanding how the pieces ship together.
- [MCP_SERVER.md](MCP_SERVER.md) -- MCP server internals: entry points, SSE/WebSocket communication, configuration, background daemon, and service registration. For developers working on the server layer.
- [CHROME_EXTENSION.md](CHROME_EXTENSION.md) -- Chrome extension architecture: service worker, command handlers, formatters, utilities, popup UI, and communication protocol. For developers working on browser automation.
- [ELECTRON_APP.md](ELECTRON_APP.md) -- Electron app structure: status dashboard, onboarding wizard (placeholder), preload IPC bridge, and build scripts. For developers working on the installer and management UI.

## Guides

- [ADDING_NEW_FEATURES.md](ADDING_NEW_FEATURES.md) -- Step-by-step guide for adding MCP tools, extension handlers, and site-specific formatters. Includes checklists and a worked example. For developers extending WebPilot's capabilities.
- [WHY_DEPLOY_VIA_SIDELOADING.md](WHY_DEPLOY_VIA_SIDELOADING.md) -- Why the Chrome extension must be sideloaded via Developer Mode instead of distributed through the Chrome Web Store. For anyone wondering about the distribution model.

## Reference

- [MCP_INTEGRATION.md](MCP_INTEGRATION.md) -- Full API reference for all fourteen MCP tools (including the async `request_pairing` / `check_pairing_status` pair, `webpilot_get_formatter_info`, and `webpilot_reload_formatters`): parameters, return formats, error codes, usage examples, and best practices. For AI agents and developers integrating with WebPilot.

## Design

- `design/UX.md`, `design/ELEGANCE.md`, `design/PALETTE.md`, and `design/research/{APPLE,LUXURY,SIMPLE}.md` -- Web UI design system, palette, and design-research briefs. These describe the look-and-feel of the server-hosted web UI at `/ui`.

## Project planning (temporary)

- `QOL_FOLLOWUPS.md` -- Living list of outstanding QOL-Features follow-ups (will be pruned / deleted as items land).
- `TEMP_QOL_FEATURES_PLAN.md` -- Spec / planning doc for the QOL-Features wave. Marked for deletion or fold-in after v1 ships.
- `REVIEW_SERVER.md`, `packages/server-web-ui/REVIEW_WEB_UI.md`, `packages/chrome-extension-unpacked/REVIEW_EXTENSION.md` -- Wave 3 code reviews from the QOL-Features audit pass. Kept for historical context; safe to delete once their findings are resolved.

