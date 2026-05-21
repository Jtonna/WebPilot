# Chrome behavior on Linux

This document is a **first-boot checklist** for the first person to run
WebPilot on real Linux hardware. Like `CHROME_MAC.md`, every claim here
should be treated as *unverified* until walked through on an actual
Linux desktop. The Linux code paths were scaffolded per spec but have
**never been executed on a real Linux host** — they were written from a
Windows dev box.

Linux is more heterogeneous than the other two platforms (distro,
desktop environment, Chrome vs. Chromium, snap vs. apt vs. flatpak),
so expect this to need more iteration than the macOS path. The five
sections below mirror `CHROME_WINDOWS.md` / `CHROME_MAC.md`.

---

## 1. Where Linux-specific code lives

All platform branching is keyed off `process.platform === 'linux'`.
The dedicated Linux files are:

- `packages/server-for-chrome-extension/src/chrome/linux-detector.js`
  — enumerates Chrome browser-parent processes by walking `/proc/<pid>/
  comm` for entries matching `chrome`, `chromium`, `chrome-browser`,
  or anything starting with `chrome`. For matches it reads
  `/proc/<pid>/cmdline` (NUL-separated arg list) and skips entries
  with `--type=` (renderer/GPU children). Dispatched from
  `chrome/detector.js`.
- `packages/server-for-chrome-extension/src/chrome/closer.js`
  (`sigTerm` function — used for both Linux and as fallback elsewhere)
  — sends SIGTERM to each PID, polls liveness via `process.kill(pid,
  0)` until exit or timeout. No graceful-shutdown DBus call is
  attempted; Chrome's own SIGTERM handler runs session save before
  exit.
- `packages/server-for-chrome-extension/src/notifications/linux.js`
  — fires desktop notifications via `notify-send -u critical "<title>"
  "<body-with-optional-url>"`. Relies on libnotify being installed
  (the `notify-send` binary).
- `packages/server-for-chrome-extension/src/service/linux.js`
  — registers the server as a `systemd --user` unit by writing
  `webpilot-server.service` into `~/.config/systemd/user/` and
  `systemctl --user enable && start`-ing it. Calls `loginctl
  enable-linger <user>` for headless support (non-fatal if denied).
- `packages/server-for-chrome-extension/src/chrome/paths.js`
  (linux branches) — searches `/usr/bin/google-chrome`,
  `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`,
  `/usr/bin/chromium-browser`, `/snap/bin/chromium` in that order;
  default user-data-dir is `$XDG_CONFIG_HOME/google-chrome` (falls
  back to `~/.config/google-chrome`).
- `packages/server-for-chrome-extension/src/service/paths.js`
  (linux branch in `getDataDir()`) — in dev mode, WebPilot's own
  data dir is `$XDG_CONFIG_HOME/WebPilot` (defaults to
  `~/.config/WebPilot`). In pkg-binary mode it sits next to the
  binary under `Programs/WebPilot/data/`.
- `packages/server-for-chrome-extension/src/service/open-browser.js`
  (`spawnOpen` linux branch) — opens the web UI on `--foreground`
  startup via `xdg-open <url>`.

There is no separate Linux launcher; `chrome/launcher.js` is
platform-agnostic and only relies on `paths.js` for the binary path.

## 2. What was scaffolded honestly but never tested on real hardware

Every Linux file under `chrome/` and `notifications/` carries a
`NOTE: scaffold-quality` comment. Functions most likely to surface
real issues first, ranked by guessed risk:

1. **`linux-detector.detect()`** — `/proc/<pid>/comm` is truncated to
   15 characters on Linux (`TASK_COMM_LEN` = 16 including the NUL).
   The matcher accepts `chrome-browser` and anything starting with
   `chrome`, but if the distro packages Chrome as
   `google-chrome-stable` the comm will show as `google-chrome-s`
   (15 chars, truncated mid-word). The current prefix check
   `comm.startsWith('chrome')` would miss this entirely. The same
   prefix check also carries a false-positive risk: any non-Chrome
   process whose `comm` begins with `chrome` (test binaries, dev
   tooling named `chrome-*`, etc.) would be matched as a real Chrome
   instance. Also: snap-packaged Chromium runs under a confinement
   wrapper that may show as `snap-confine` or `chromium` depending on
   the snap version. **Expect this matcher to need broadening on
   first run.**
2. **`linux-detector.readCmdline()`** — reads NUL-separated
   `/proc/<pid>/cmdline` and splits on `\\0`. Should be robust, but
   verify that args with embedded spaces (e.g. `--user-data-dir=
   /home/user/My Profile`) survive intact — `cmdline` preserves them
   because the separator is NUL, not space, so this should work
   where macOS's `ps` form does not.
3. **`closer.sigTerm()` on Linux** — sends SIGTERM directly. Chrome
   handles SIGTERM via its session-restore logic, but the behavior
   is *less* well-documented than the macOS `osascript quit` path.
   In particular, sending SIGTERM to the browser-parent should
   cleanly close all child processes, but if the user has unsaved
   form input on a page, the "Leave site?" prompt may block the
   shutdown until the SIGTERM-kill timeout (20 s) expires and the
   closer reports `closed: false, remaining: [pid]`. Test with a
   page that has the `beforeunload` hook firing.
4. **`notifications/linux.js`** — assumes `notify-send` is installed
   and that the user's session has a running notification daemon
   (e.g. `dunst`, GNOME's `gnome-shell --mode=...`, KDE's
   `plasmashell`). Headless / SSH-only sessions have neither, and
   `notify-send` will exit nonzero. The current code logs the error
   and resolves — the notification is silently lost. Acceptable for
   the first Linux release (tracked in repo issue #49); document the
   limitation. The `-u critical` urgency level
   means notifications won't auto-time-out on most DEs — verify
   that pairing-request notifications don't pile up indefinitely if
   the user is AFK.
5. **`service/linux.js install()`** — writes a systemd `--user` unit
   and runs `loginctl enable-linger <user>` to let the server keep
   running across logout. `enable-linger` requires either root or
   the `org.freedesktop.login1.set-self-linger` polkit rule; on
   stock Ubuntu/Fedora this may prompt for sudo or fail silently. The
   code swallows the failure and continues — verify that
   `systemctl --user is-active webpilot-server.service` returns
   `active` after `install()` completes.
6. **`paths.getDefaultChromePath()` — distro/snap divergence** —
   the candidate list `/usr/bin/google-chrome`,
   `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`,
   `/usr/bin/chromium-browser`, `/snap/bin/chromium` covers the
   common Debian/Ubuntu/Fedora packagings but **does not include**:
   - Arch's `/usr/bin/google-chrome` (which is fine — first entry
     matches)
   - Flatpak Chrome at
     `/var/lib/flatpak/exports/bin/com.google.Chrome`
   - User-flatpak at
     `~/.local/share/flatpak/exports/bin/com.google.Chrome`
   - Snap Chrome (different snap from Chromium) under `/snap/bin/`
   If the user has only flatpak Chrome installed, WebPilot will
   fail to launch with a missing-binary error. Document the
   `chromePath` config override in that case.

## 3. What to verify on first boot

Tick each of these by hand on first run.

### Chrome user-data-dir path resolution

- [ ] Confirm `~/.config/google-chrome` (or `$XDG_CONFIG_HOME` if
      set) exists and contains `Local State`, `Default/`, etc.
- [ ] If you use Chromium instead of Google Chrome, the path is
      `~/.config/chromium` — WebPilot's `getDefaultUserDataDir()`
      will return the wrong path and you'll need a config override.
      Open question for the user: should the path resolution try
      both directories?
- [ ] Snap-packaged Chromium uses
      `~/snap/chromium/common/.config/chromium/` instead. This is
      currently **not handled** — snap Chrome users will need a
      `chromePath` + `userDataDir` config override on day one.
- [ ] Flatpak Chrome uses a similarly different path
      (`~/.var/app/com.google.Chrome/config/google-chrome`) — also
      not handled.

### Process detection via `/proc/<pid>/cmdline`

- [ ] After launching Chrome normally, hit `/api/ui/chrome/refresh`
      and confirm `detectChromeBrowsers()` returns one entry per
      running Chrome browser-parent.
- [ ] If empty: open a terminal and run `for p in /proc/[0-9]*; do
      echo "=== $p ==="; cat $p/comm 2>/dev/null; done | grep -i
      chrome` to see what `comm` values you actually have.
- [ ] Compare to the matcher in `linux-detector.listChromePids()`.
      Update if needed.
- [ ] Verify `--user-data-dir=` and `--profile-directory=` are
      correctly extracted from `cmdline`. The NUL-separated format
      should preserve spaces correctly.

### Notification system

- [ ] Run `which notify-send` — if absent, install
      `libnotify-bin` (Debian/Ubuntu) or `libnotify` (Arch/Fedora).
- [ ] Run `notify-send "test" "test body"` to verify your
      notification daemon is running.
- [ ] Trigger a pairing request and confirm the notification
      appears with title, body, and URL on a second line.
- [ ] Click-to-open from notification is **explicitly deferred** on
      Linux. The `notify-send -u critical` notification will display,
      but clicking it will not open the pairing URL. Workaround: copy
      the URL from the notification body manually, or visit
      `http://localhost:<port>/ui/pairings`.

### Launch flag wiring

- [ ] After WebPilot kills and relaunches Chrome, run
      `cat /proc/<chrome-pid>/cmdline | tr '\\0' ' '; echo` and
      confirm both `--profile-directory=<name>` and
      `--silent-debugger-extension-api` are present.
- [ ] Verify Chrome auto-restores the previous session's tabs (this
      is Chrome's behavior, not WebPilot's — see `CHROME_WINDOWS.md`).

### Distro / packaging concerns

- [ ] Where does **your** Chrome binary live?
      `which google-chrome google-chrome-stable chromium
      chromium-browser 2>/dev/null` — confirm one of those matches
      `paths.getDefaultChromePath()`'s candidate list.
- [ ] If snap Chromium: WebPilot will detect the binary at
      `/snap/bin/chromium`, but the *user-data-dir* will be wrong
      (defaults to `~/.config/google-chrome`, actually lives at
      `~/snap/chromium/common/.config/chromium/`). Override via
      config.
- [ ] If flatpak Chrome: neither binary path nor user-data-dir is
      detected. Both need overrides.

### `xdg-open` for click-to-open + auto-open of web UI

- [ ] On `webpilot-server --foreground` startup, the web UI should
      auto-open in your default browser via `xdg-open
      http://localhost:<port>/ui/`. Verify it does.
- [ ] If it doesn't: run `xdg-open http://example.com` manually and
      check the error. Headless / SSH sessions usually need
      `WEBPILOT_NO_OPEN=1` set in the environment to suppress this
      behavior.
- [ ] On Wayland sessions (GNOME 42+, KDE 5.25+), `xdg-open` should
      still work via `xdg-desktop-portal`, but verify.

## 4. Known untested paths

Every TODO/scaffold marker in the Linux code paths:

- `chrome/linux-detector.js:9` — top-of-file scaffold note.
- `chrome/linux-detector.js:74` — TODO log line printed on every
  call.
- `chrome/detector.js:22` — `platform=linux not yet fully implemented
  — running scaffold` log.
- `notifications/linux.js:10` — scaffold note in module header.
- `notifications/linux.js:25` — TODO log on every notification.

Linux detector / launcher / closer / notifications were scaffolded per
spec but have not been smoke-tested on real Linux hardware. Click-to-
open from notifications is explicitly deferred.

No FIXME comments found.

## 5. How to send feedback

- Open a GitHub issue on the WebPilot repo with the prefix `[Linux]`.
- Include: distro + version (`/etc/os-release`), desktop environment
  (`echo $XDG_CURRENT_DESKTOP`), Chrome/Chromium channel + version,
  packaging (apt/dnf/pacman/snap/flatpak), the relevant section
  heading from this doc, log output from `~/.config/WebPilot/
  logs/server.log`, and what you expected vs. what happened.
- For detector issues, please attach the verbatim output of:
  ```
  for p in /proc/[0-9]*; do
    name=$(cat $p/comm 2>/dev/null)
    case "$name" in chrome*|chromium*) echo "$p ($name)";; esac
  done
  ```
  for one of the missed processes — that lets us fix the matcher
  without another round-trip.

---

## Cross-references

- Windows equivalents and source-of-truth structure: `CHROME_WINDOWS.md`.
- macOS equivalents: `CHROME_MAC.md`.
- Broader server architecture: `MCP_SERVER.md`.
- Extension side: `CHROME_EXTENSION.md`.
