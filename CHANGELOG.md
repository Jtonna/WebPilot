# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.8]

### Added
- Electron shell — tray + splash window, single platform-appropriate `userData` path, multi-resolution RGBA icons.
- UI — connecting splash held until the daemon responds; readable dark dropdowns.
- Server — ships the `better-sqlite3` native binding alongside the app; legacy `userData` migration on first launch.
- CI — manual release workflows replace the previous label-gated flow.
- Open-source repository scaffolding: `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and this `CHANGELOG.md`.

### Fixed
- Installer — kill running processes on install/uninstall to make upgrades safe; `installer.nsh` now tracked in the repo.

### Removed
- Internal task tracking and design docs that lived in the repo during pre-1.0 development (`OPEN_ITEMS.md`, the P2 redesign design doc, the auth audit doc). The decisions they captured are now reflected in the live architecture docs and the code.

## [1.1.1]

Internal pre-1.0 development. Notable architectural milestones from this period:

- Auth model overhaul — retired the shared transport key in favour of per-profile installId identity + per-agent paired API keys.
- SQLite migration — moved per-profile state, paired agents, pending pairings, site policy, and formatter incident logs out of JSON files into a single SQLite database with WAL mode.
- Minimal popup redesign — Block/Allow toggle and pairing prompts surfaced in the extension popup.
- Dashboard pivot — replaced the four-up KPI grid with an Action Items section that surfaces pending pairings + formatter errors inline.
- Baseline blocklist — bundled financial-institution blocklist with hourly auto-update from GitHub, local-cache fallback chain for offline resilience.

[Unreleased]: https://github.com/Jtonna/WebPilot/compare/v1.1.8...HEAD
[1.1.8]: https://github.com/Jtonna/WebPilot/compare/v1.1.1...v1.1.8
[1.1.1]: https://github.com/Jtonna/WebPilot/releases/tag/v1.1.1
