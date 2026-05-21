'use strict';

/**
 * Auto-open the WebPilot web UI in the user's default browser when the
 * server starts in foreground (`--foreground`) mode. Skipped in daemon /
 * background mode because that path fires on every login and would spam
 * the user. Also skipped when `WEBPILOT_NO_OPEN=1` is set for headless /
 * CI / SSH usage.
 *
 * Implementation notes
 * --------------------
 * - Polls `/health` at 250 ms intervals until the server responds 200 (or
 *   the timeout elapses), then fires the OS-level open command.
 * - Open command is platform-specific:
 *     Windows: `cmd.exe /c start "" "<url>"`
 *     macOS:   `open "<url>"`
 *     Linux:   `xdg-open "<url>"`
 *   Each is spawned detached + unrefed so it never holds the server
 *   process open and never blocks if the GUI shell is slow.
 * - All errors are non-fatal: if the open command fails, polling times
 *   out, or the platform is unrecognized, we just log and move on. The
 *   server keeps running regardless.
 *
 * Logging prefix: `[browser-open]` for grep-ability.
 */

const http = require('node:http');
const { spawn } = require('node:child_process');

const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_TIMEOUT_MS = 15000;

function log(msg) {
  console.log('[browser-open] ' + msg);
}

function pollHealth(port, host) {
  const url = `http://${host}:${port}/health`;
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;

  return new Promise((resolve) => {
    function attempt() {
      const req = http.get(url, { timeout: HEALTH_POLL_INTERVAL_MS }, (res) => {
        // Drain so the socket can be reused / closed cleanly.
        res.resume();
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          retry();
        }
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    }

    function retry() {
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(attempt, HEALTH_POLL_INTERVAL_MS);
    }

    attempt();
  });
}

function spawnOpen(url) {
  const platform = process.platform;
  let cmd;
  let args;

  if (platform === 'win32') {
    cmd = 'cmd.exe';
    // Empty "" is the start command's window-title placeholder so the URL
    // isn't misinterpreted as a title when it contains spaces.
    args = ['/c', 'start', '""', url];
  } else if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'linux') {
    cmd = 'xdg-open';
    args = [url];
  } else {
    log(`unsupported platform=${platform}; skipping browser auto-open`);
    return;
  }

  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => {
      log(`open command failed: ${err && err.message}`);
    });
    child.unref();
  } catch (err) {
    log(`open command threw: ${err && err.message}`);
  }
}

/**
 * Fire-and-forget. Resolves once we've either attempted the open or
 * decided not to. Never rejects.
 *
 * @param {object} opts
 * @param {number} opts.port  Server port (use the resolved port, NOT a
 *                            hardcoded default).
 * @param {string} [opts.host='127.0.0.1']  Host to poll for /health.
 * @param {string} [opts.path='/ui/']  Path appended after host:port.
 */
async function openWebUi(opts) {
  if (process.env.WEBPILOT_NO_OPEN === '1') {
    log('WEBPILOT_NO_OPEN=1 set; skipping browser auto-open');
    return;
  }

  const port = opts && opts.port;
  if (!port) {
    log('no port provided; skipping browser auto-open');
    return;
  }
  const host = (opts && opts.host) || '127.0.0.1';
  const uiPath = (opts && opts.path) || '/ui/';
  const url = `http://localhost:${port}${uiPath}`;

  log(`waiting for /health on ${host}:${port} before opening ${url}`);
  const ready = await pollHealth(port, host);
  if (!ready) {
    log(`timed out waiting for /health after ${HEALTH_POLL_TIMEOUT_MS}ms; skipping open`);
    return;
  }
  log(`opening ${url}`);
  spawnOpen(url);
}

module.exports = { openWebUi };
