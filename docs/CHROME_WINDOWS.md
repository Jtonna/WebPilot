# Chrome behavior on Windows

This document captures Chrome (and Windows-host) behaviors that WebPilot
empirically depends on. Everything below was verified against Chrome on
Windows 10/11. macOS and Linux behavior may differ — when those platforms
ship to v1, either verify each section's claims still hold or add
platform-specific siblings (`CHROME_MACOS.md`, `CHROME_LINUX.md`).

---

## `--profile-directory=<name>` auto-restores tabs

When Chrome is launched with `--profile-directory=<name>`, it automatically
restores the previous session's tabs for that profile, regardless of the
profile's `restore_on_startup` Preferences value. WebPilot relies on this
in `ChromeManager.ensureReady`: when a kill+relaunch is necessary (e.g.
to add the `--silent-debugger-extension-api` flag), no explicit
tab-restoration logic is needed on the server side — Chrome's own
session-restore handles it.

This is what makes the "we may need to relaunch Chrome to attach the
debugger flag" UX tolerable: the user notices a brief Chrome flicker,
but their open tabs come back on their own.

See: `packages/server-for-chrome-extension/src/chrome/launcher.js`
(builds the `--profile-directory=` arg) and
`packages/server-for-chrome-extension/src/chrome/manager.js`
(`ensureReady` decides when a relaunch is necessary).

## Per-profile activity detection via session-file mtimes

WebPilot infers per-profile activity by stat'ing a fixed set of session-
and storage-related files inside each profile directory and treating a
profile as active when the most recent of those was written within a
recent window (default 30 seconds). The file list — see `HOT_FILES` in
`profile-activity.js` — is: `SharedStorage-wal`, `SharedStorage`,
`Cookies`, `Cookies-journal`, `History`, `History-journal`,
`Preferences`, `Sessions`, `Current Session`, `Current Tabs`. The
profile directory's own mtime is also consulted as a cheap fallback.

This drives `getActiveProfiles()`, which decides which profiles to
re-launch after a `ChromeManager.ensureReady` kill+relaunch cycle.
The 30-second window is a tradeoff: long enough to survive idle
pauses between user interactions, short enough that a long-abandoned
tab isn't treated as live work. Active Chrome profiles write to
`SharedStorage-wal` and similar files on the order of ~9–13 times per
minute, so 30 s comfortably covers normal activity without false
positives.

Only top-level entries inside each profile dir are checked — the code
deliberately does not descend into `Cache/`, `Sessions/Session_*`, or
other large subtrees, to keep the stat sweep cheap.

See: `packages/server-for-chrome-extension/src/chrome/profile-activity.js`.

## Windows auto-start via Registry Run key

WebPilot's auto-start on Windows writes to the per-user Registry Run key
(`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`) rather than
registering a scheduled task. The value is a plain `REG_SZ` pointing at
`"<binary-path>" --foreground` — no `RunOnce`, no delayed-launch shim,
no conditional logic.

The reason: Task Scheduler's logon trigger (`schtasks /SC ONLOGON`)
requires Administrator elevation on Windows 10/11. The HKCU Run key
works for ordinary, non-elevated users — which is the only deployment
WebPilot currently supports. The trade-off is no advanced scheduling
controls (no "delay 30 s after logon", no "only on AC power", etc.) —
but for the simple "launch on user login" case, the Run key is the
right tool.

`uninstall()` deletes the same registry value and cleans up the PID /
port files in the WebPilot data dir. `status()` checks both registry
registration and PID-file liveness independently, so a registered-but-
not-running state is reported correctly.

See: `packages/server-for-chrome-extension/src/service/windows.js`.

---

## Cross-references

- Server-side launch + flag-management lives in
  `packages/server-for-chrome-extension/src/chrome/` — see
  [`docs/MCP_SERVER.md`](MCP_SERVER.md) for the broader architecture.
- The Chrome extension side of the integration is documented in
  [`docs/CHROME_EXTENSION.md`](CHROME_EXTENSION.md).
- Service registration internals: [`docs/MCP_SERVER.md`](MCP_SERVER.md)
  Service Management section.
