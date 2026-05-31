# Chrome behavior on macOS

This document is a **first-boot checklist** for the first person to run
WebPilot on real macOS hardware. Unlike `CHROME_WINDOWS.md`, every claim
in this file should be treated as *unverified* until someone has walked
through the steps below on an actual Mac. The macOS code paths were
scaffolded honestly per spec but have **never been executed on real
hardware** — they were written from a Windows dev box.

The macOS build is **not currently shipping** — see the README's Install
table and [issue #48](https://github.com/Jtonna/WebPilot/issues/48) for
the gating work this doc is meant to help unblock.

If you are that first user: please read this end-to-end before launching
the server, then file issues against any section that diverges from
reality.

---

## 1. Where macOS-specific code lives

All platform branching is keyed off `process.platform === 'darwin'`.
The dedicated macOS files are:

- `packages/server-for-chrome-extension/src/chrome/macos-detector.js`
  — enumerates Chrome browser-parent processes via `pgrep -x "Google
  Chrome"` + `ps -ww -o command= -p <pid>`, extracts `--user-data-dir`
  and `--profile-directory` from the command line, and tags each entry
  with `hasFlag` (whether `--silent-debugger-extension-api` is already
  present). Dispatched from `chrome/detector.js`.
- `packages/server-for-chrome-extension/src/chrome/closer.js`
  (`macosQuit` function) — sends `osascript -e 'tell application
  "Google Chrome" to quit'`, with a SIGTERM fallback if AppleScript
  fails.
- `packages/server-for-chrome-extension/src/notifications/macos.js`
  — fires desktop notifications via `osascript -e 'display
  notification "<body>" with title "<title>" [subtitle "<url>"]
  [sound name "default"]'`.
- `packages/server-for-chrome-extension/src/service/macos.js`
  — registers the server as a `launchd` user agent by writing a
  `com.webpilot.server.plist` into `~/Library/LaunchAgents/` and
  `launchctl load`ing it. Status checks parse `launchctl list
  com.webpilot.server` output.
- `packages/server-for-chrome-extension/src/chrome/paths.js`
  (darwin branches) — resolves the Chrome binary to
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` and
  the default user-data-dir to `~/Library/Application Support/Google/
  Chrome`.
- `packages/server-for-chrome-extension/src/service/paths.js`
  (darwin branch in `platformUserDataDir()`) — WebPilot's own data dir
  resolves to `~/Library/Application Support/WebPilot` in both dev and
  pkg-binary modes. The `WEBPILOT_DATA_DIR` env var overrides this when
  set (Electron main passes `app.getPath('userData')` that way). A
  legacy in-install path (`<install>/../../data`) is only consulted by
  `legacyInstallDataDir()` for the one-time pre-1.1.6 migration, not as
  a runtime data dir.
- `packages/server-for-chrome-extension/src/service/open-browser.js`
  (`spawnOpen` darwin branch) — opens the web UI on `--foreground`
  startup via `open <url>`.

There is no separate macOS launcher; `chrome/launcher.js` is
platform-agnostic and only relies on `paths.js` for the binary path.

## 2. What was scaffolded honestly but never tested on real hardware

Every file under `chrome/`, `notifications/`, and `service/` for darwin
contains a `NOTE: scaffold-quality` comment at the top. The author
called these out explicitly rather than dressing them up as
production-ready. Specific functions most likely to surface real issues
first, ranked by my honest guess at risk:

1. **`macos-detector.detect()`** — `pgrep -x "Google Chrome"` matches
   only when the process name is *exactly* `Google Chrome`. On macOS
   the binary lives at `Google Chrome.app/Contents/MacOS/Google
   Chrome`, and depending on how it was launched the process name
   can show as `Google Chrome` (most common), `Google Chrome Helper`
   (renderer/GPU children — filtered by the `--type=` check, fine), or
   occasionally just `chrome` for Chrome Canary/Beta. Test with both
   stable Chrome and any beta channel you have installed. If
   pgrep misses everything, try `pgrep -fl Chrome` to see what the
   process name actually is and adjust the matcher.
2. **`closer.macosQuit()`** — relies on AppleScript automation. On
   modern macOS this triggers a one-time **"WebPilot wants to control
   Google Chrome" permission prompt** (System Settings → Privacy &
   Security → Automation). Until the user clicks Allow, `osascript`
   will fail and we fall through to SIGTERM. Verify whether the user
   sees a permission prompt at all; if the server is running as a
   `launchd` user agent it may need TCC entitlements before the prompt
   can even appear.
3. **`notifications/macos.js`** — `osascript display notification`
   requires the calling application to be registered for notifications.
   When run from a Terminal session it shows up under "Script Editor".
   When run from a pkg-compiled binary, macOS may attribute it to
   the binary's bundle ID — but the pkg binary has no `.app` bundle
   and therefore no `Info.plist` declaring `NSUserNotification` usage.
   Notifications may silently no-op, or appear as "Terminal" /
   "osascript". Acceptable for v1, but worth documenting actual
   behavior.
4. **`service/macos.js install()`** — writes a `launchd` plist with
   `KeepAlive: { SuccessfulExit: false }`. If the server crashes
   repeatedly in the first 10 seconds, `ThrottleInterval=10` should
   prevent a tight crash loop, but verify that a deliberate
   `kill -9 <server-pid>` triggers a successful auto-restart.
5. **`chrome/launcher.js` — detached spawn on darwin** — `spawn(...,
   { detached: true })` on macOS does *not* fully detach a GUI app
   in the same way a daemon would. Whether the launched Chrome is
   tied to the parent's launchd session (and so disappears when the
   parent exits unexpectedly) is worth verifying on a real macOS
   install — this assertion needs first-macOS-tester confirmation.
   Verify the launched Chrome survives a `kill <server-pid>`.

## 3. What to verify on first boot

Tick each of these by hand on first run.

### Chrome user-data-dir path resolution

- [ ] Confirm `~/Library/Application Support/Google/Chrome` exists and
      contains `Local State`, `Default/`, etc. If you use Chrome Beta
      or Canary instead, the path differs (`Google/Chrome Beta` etc.)
      — there is currently no detection for those, and you'll need to
      override the chromePath/userDataDir via config.
- [ ] Confirm `paths.getDefaultUserDataDir()` log line on startup
      points to the right directory. Server log lives at
      `~/Library/Application Support/WebPilot/logs/server.log` in dev
      mode.

### Process detection

- [ ] After launching Chrome normally, hit `/api/ui/chrome/refresh` (or
      let the server's idle refresh fire) and check that
      `detectChromeBrowsers()` returns one entry per running Chrome
      browser-parent.
- [ ] If it returns zero, run `pgrep -x "Google Chrome"` manually and
      compare. The matcher is case-sensitive and whitespace-sensitive.
- [ ] Verify `--user-data-dir=` is extracted correctly when the path
      contains spaces (e.g. `/Users/<you>/Library/Application Support/
      Google/Chrome`). `macos-detector.extractUserDataDir` now captures
      unquoted macOS `ps -ww -o command=` values through the next
      Chrome `--flag`, which covers Chrome paths containing spaces. Note
      that `launcher.js` deliberately omits `--user-data-dir` when it
      equals the default (see `getDefaultUserDataDir()`), so the
      default-path case won't have the flag on the cmdline at all.

### Notification system

- [ ] On first notification, expect macOS to ask permission. Click
      Allow once.
- [ ] Verify the notification body, title, and subtitle (URL) all
      render. AppleScript escape rules cover `"` and `\\` — see
      `asEscape()` — but URLs containing other characters
      (`'`, `&`, `\\`) have not been smoke-tested.
- [ ] Click-to-open from notification is **explicitly deferred** for
      macOS. Clicking the notification will not open the URL; that's a
      known v1 limitation.

### Launch flag wiring

- [ ] After WebPilot kills and relaunches Chrome, run
      `ps -ww -o command= -p <chrome-pid>` and confirm the launched
      Chrome command line contains both `--profile-directory=<name>`
      and `--silent-debugger-extension-api`.
- [ ] Verify Chrome auto-restores the previous session's tabs — same
      behavior as Windows, see `CHROME_WINDOWS.md` "auto-restores tabs"
      section. This is Chrome's built-in behavior and should work
      identically on macOS, but worth confirming.

### File permissions / sandbox interactions specific to macOS

- [ ] `~/Library/LaunchAgents/com.webpilot.server.plist` should be
      owned by your user (not root) with 644 permissions. The plist
      install path is **user-scoped** by design; a system-level
      install would require `/Library/LaunchDaemons/` and admin.
- [ ] If running from a downloaded .app bundle in the future, expect
      Gatekeeper (`xattr -d com.apple.quarantine`) and notarization
      issues. WebPilot's pkg binary is currently unsigned; the first
      run will likely require right-click → Open. (Note: the older
      `sudo spctl --master-disable` global workaround was removed in
      recent macOS releases; per-binary `xattr -d` is the supported
      escape hatch.)
- [ ] Full Disk Access: WebPilot does not need it for current
      functionality, but if you grant it, double-check nothing leaks
      sensitive paths into logs.

## 4. Known untested paths

Every TODO/scaffold marker in the macOS code paths:

- `chrome/macos-detector.js:8` — top-of-file scaffold note.
- `chrome/macos-detector.js:66` — TODO log line printed on every call.
- `chrome/detector.js:19` — `platform=darwin not yet fully implemented
  — running scaffold` log.
- `notifications/macos.js:9` — scaffold note in module header.
- `notifications/macos.js:37` — TODO log on every notification.

macOS detector / launcher / closer / notifications were scaffolded per
spec but have not been smoke-tested on real macOS hardware; expect
issues on first non-Windows use. Click-to-open from notifications is
explicitly deferred (Windows shipped `activationType=protocol`; macOS
and Linux need helper apps).

No FIXME comments found; no `not yet tested` markers beyond the ones
listed.

## 5. How to send feedback

- Open a GitHub issue on the WebPilot repo with the prefix `[macOS]`.
- Include: macOS version, Chrome channel + version, the relevant
  section heading from this doc, the actual log output from
  `~/Library/Application Support/WebPilot/logs/server.log`, and what
  you expected vs. what happened.
- For detector/process-list issues, please attach the verbatim output
  of `pgrep -x "Google Chrome"` and `ps -ww -o command= -p <pid>` for
  one of the missed processes — that lets us fix the matcher without
  another round-trip.

---

## Cross-references

- Windows equivalents and source-of-truth structure: `CHROME_WINDOWS.md`.
- Linux equivalents: `CHROME_LINUX.md`.
- Broader server architecture: `MCP_SERVER.md`.
- Extension side: `CHROME_EXTENSION.md`.
