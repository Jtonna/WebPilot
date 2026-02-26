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

- [MCP_INTEGRATION.md](MCP_INTEGRATION.md) -- Full API reference for all nine MCP tools: parameters, return formats, error codes, usage examples, and best practices. For AI agents and developers integrating with WebPilot.

