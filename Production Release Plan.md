# WebPilot — Production Release Plan

## Phase 1: MCP Server as a Background Service

Compile the MCP server into a standalone executable using `pkg` and have it register itself with the OS task scheduler to run as a hidden background service on boot.

- Compile to standalone binary (Windows `.exe`, macOS, Linux)
- On install, register with platform task scheduler (Windows Task Scheduler, macOS launchd, Linux systemd)
- Auto-start on login, run hidden in background
- Support `--install`, `--uninstall`, `--status` CLI flags
- Generate secure API key and persist config to platform-appropriate app data directory

## Phase 2: Installer with Onboarding UI

Build an Electron installer with a Next.js UI that packages the Phase 1 binary, deploys the Chrome extension, and walks users through setup.

- Installer packages the compiled MCP server and the unpacked extension
- Next.js onboarding wizard guides user through:
  - Installing the MCP server and registering the background service
  - Deploying extension files to a permanent location
  - Walking through Chrome extension sideloading (Developer Mode, Load unpacked)
  - Displaying connection string and MCP config snippet
- Produces platform installers (NSIS `.exe`, `.dmg`, AppImage)

## Phase 3: Cross-Platform Verification

Verify with partners that macOS and Linux support works properly, including task scheduler equivalents on each platform.

- Partner testing on macOS (launchd) and Linux (systemd)
- Confirm install, reboot persistence, extension loading, and end-to-end MCP tool execution
- Bug fix cycle based on partner feedback
- Final sign-off across all platforms before release
