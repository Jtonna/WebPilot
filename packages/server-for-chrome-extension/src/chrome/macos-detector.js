'use strict';

const { execFile } = require('node:child_process');
const { log, error } = require('./logger');

const FLAG = '--silent-debugger-extension-api';

// NOTE: scaffold-quality. This is the best understanding of the macOS path
// per the spec, but the author cannot fully validate it on this Windows
// machine. Cross-platform smoke testing required before relying on this.

function extractUserDataDir(cmdLine) {
  if (!cmdLine) return null;
  let m = cmdLine.match(/--user-data-dir=(?:"([^"]*)"|(\S+))/);
  if (m) return m[1] || m[2] || null;
  return null;
}

function extractProfileDirectory(cmdLine) {
  if (!cmdLine) return null;
  const m = cmdLine.match(/--profile-directory=(?:"([^"]*)"|(\S+))/);
  if (m) return m[1] || m[2] || null;
  return null;
}

function isBrowserParent(cmdLine) {
  if (!cmdLine) return false;
  return !/--type=/.test(cmdLine);
}

function pgrepChrome() {
  return new Promise((resolve) => {
    execFile('pgrep', ['-x', 'Google Chrome'], (err, stdout) => {
      if (err) {
        // pgrep returns non-zero when no matches — that's not an error in our model
        log('macos-detector', 'pgrep returned no matches or failed', { code: err.code });
        resolve([]);
        return;
      }
      const pids = (stdout || '')
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isFinite(n));
      log('macos-detector', 'pgrep pids', { pids });
      resolve(pids);
    });
  });
}

function psCommand(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], (err, stdout) => {
      if (err) {
        error('macos-detector', 'ps failed for pid ' + pid, err);
        resolve('');
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

async function detect() {
  log('macos-detector', 'TODO: macOS detection is scaffolded — verify on real macOS before trusting results');
  log('macos-detector', 'starting detection');

  const pids = await pgrepChrome();
  if (pids.length === 0) {
    log('macos-detector', 'no chrome processes');
    return [];
  }

  const out = [];
  for (const pid of pids) {
    const cmd = await psCommand(pid);
    if (!cmd) continue;
    if (!isBrowserParent(cmd)) continue;
    const entry = {
      pid,
      commandLine: cmd,
      hasFlag: cmd.indexOf(FLAG) !== -1,
      userDataDir: extractUserDataDir(cmd),
      profileDirectory: extractProfileDirectory(cmd),
    };
    log('macos-detector', 'browser-parent identified', entry);
    out.push(entry);
  }

  log('macos-detector', 'detection complete', { browserParents: out.length });
  return out;
}

module.exports = { detect, FLAG };
