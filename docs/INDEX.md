# Documentation Index

WebPilot documentation covering system architecture, development guides, and API reference.

## Architecture

- [BUILD_ARCHITECTURE.md](BUILD_ARCHITECTURE.md) -- Build pipeline, pkg compilation, Electron packaging, deployment paths, and CLI flags. For anyone working on the build system or understanding how the pieces ship together.
- [MCP_SERVER.md](MCP_SERVER.md) -- MCP server internals: entry points, SSE/WebSocket communication, configuration, background daemon, and service registration. For developers working on the server layer.
- [CHROME_EXTENSION.md](CHROME_EXTENSION.md) -- Chrome extension architecture: service worker, command handlers, formatters, utilities, popup UI, and communication protocol. For developers working on browser automation.
- [CHROME_WINDOWS.md](CHROME_WINDOWS.md) -- Chrome behaviors observed on Windows that WebPilot empirically depends on: `--profile-directory` tab auto-restore, session-file mtime activity detection, and Registry Run key auto-start.
- [CHROME_MAC.md](CHROME_MAC.md) -- macOS-side Chrome integration notes (first-boot smoke checks for the detector/launcher/closer/notifications path).
- [CHROME_LINUX.md](CHROME_LINUX.md) -- Linux-side Chrome integration notes (same scope as the macOS doc).
- [ELECTRON_APP.md](ELECTRON_APP.md) -- Electron app structure: status dashboard, onboarding placeholder text, preload IPC bridge, and build scripts. For developers working on the installer and management UI.

## Guides

- [ADDING_NEW_FEATURES.md](ADDING_NEW_FEATURES.md) -- Step-by-step guide for adding MCP tools, extension handlers, and site-specific formatters. Includes checklists and a worked example. For developers extending WebPilot's capabilities.
- [WHY_DEPLOY_VIA_SIDELOADING.md](WHY_DEPLOY_VIA_SIDELOADING.md) -- Why the Chrome extension must be sideloaded via Developer Mode instead of distributed through the Chrome Web Store. For anyone wondering about the distribution model.

## Reference

- [MCP_INTEGRATION.md](MCP_INTEGRATION.md) -- Full API reference for all fourteen MCP tools (nine `browser_*` tools plus async pairing, formatter inspection/reload, and request-chain orchestration): parameters, return formats, error codes, usage examples, and best practices. For AI agents and developers integrating with WebPilot.

## Design

- `design/UX.md`, `design/ELEGANCE.md`, `design/PALETTE.md` -- Web UI design system, palette, and visual craft. These describe the look-and-feel of the server-hosted web UI at `/ui`.

## Project Meta

- [README.md](../README.md) -- Project overview, install path, and the canonical entry point for anyone landing on the repo.
- [CONTRIBUTING.md](../CONTRIBUTING.md) -- How to file issues, propose changes, and the contributor expectations (development setup, commit hygiene, supply-chain rules).
- [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) -- Community standards and enforcement contact for participation in the project.
- [SECURITY.md](../SECURITY.md) -- Vulnerability reporting channel, supported versions, scope, trust model, and `.mcp.json` safety guidance.
- [CHANGELOG.md](../CHANGELOG.md) -- Versioned release notes for the server, extension, and Electron installer.

## Formatters

- [accessibility-tree-formatters/DEV_GUIDE.md](../accessibility-tree-formatters/DEV_GUIDE.md) -- How to author a platform-specific accessibility-tree formatter: directory layout, workflow conventions, local-testing loop, and the `webpilot_dev_*` tools.
- [accessibility-tree-formatters/MANIFEST_SCHEMA.md](../accessibility-tree-formatters/MANIFEST_SCHEMA.md) -- Per-formatter `manifest.json` schema reference: required fields, workflow descriptors, `errorHandling` flags, and version semantics.

