# Chrome behavior on Windows

This document captures Chrome (and Windows-host) behaviors that WebPilot
empirically depends on. Everything below was verified against Chrome on
Windows 10/11, which is the supported platform. macOS and Linux behavior
may differ — see [`CHROME_MAC.md`](CHROME_MAC.md) and
[`CHROME_LINUX.md`](CHROME_LINUX.md) for the platform-specific siblings.

---

## Restart restores the previous session with `--restore-last-session`

`--profile-directory=<name>` alone does not bring a closed session's
windows back. When `ChromeManager.ensureReady` finds Chrome running
without `--silent-debugger-extension-api`, it closes Chrome and
relaunches it, and every relaunched profile gets
`--restore-last-session` (`RESTORE_SESSION_FLAG`). That flag is what
makes the user's previous windows and tabs reappear, so no
tab-restoration logic is needed on the server side.

The close is graceful. `closer.js` posts `WM_CLOSE` to every visible
Chrome window, so Chrome runs its normal shutdown and saves the session
before it exits. A hard kill would skip that save.

The relaunch covers the active profiles plus the required profiles
(active ∪ required). Only the required profiles get the target URL.

Flag order on the Chrome command line:

1. `--user-data-dir` (only when non-default)
2. `--profile-directory`
3. `--silent-debugger-extension-api`
4. `extraArgs`: `--restore-last-session`, then the URL

This is what makes the "we may need to relaunch Chrome to attach the
debugger flag" UX tolerable: the user notices a brief Chrome flicker,
but their open tabs come back on their own.

See: `packages/server-for-chrome-extension/src/chrome/launcher.js`
(`extraArgs`, appended last),
`packages/server-for-chrome-extension/src/chrome/manager.js`
(`ensureReady`, `RESTORE_SESSION_FLAG`), and
`packages/server-for-chrome-extension/src/chrome/closer.js`
(`WM_CLOSE`).

## What `ensureReady` does in each case

- **Running with the flag, extension not connected.** Wait 3 s
  (`EXTENSION_GRACE_MS`) for a sleeping extension service worker to
  reconnect on its own. If it hasn't, spawn the missing profiles with
  the URL. There is one coordinated wait, with a 10 s budget.
- **Running without the flag.** Close and relaunch as described above.
  15 s budget.
- **Not running.** Launch the required profiles with the URL. 15 s
  budget.
- **Process scan failed (state unknown).** Abort with
  `reason: 'chrome_state_unknown'`. It never closes Chrome or spawns
  anything, because "could not check" is not "not running". Windows and
  Linux raise `ChromeDetectionError` on a failed scan. macOS still
  reports an empty list when `pgrep` fails, so it cannot report this
  state.

See: `packages/server-for-chrome-extension/src/chrome/manager.js`
(`ensureReady`).

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
re-launch, alongside the required ones, after an `ensureReady`
close-and-relaunch.
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
