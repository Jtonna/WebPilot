'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { log, error } = require('./logger');

const FLAG = '--silent-debugger-extension-api';

// NOTE: scaffold-quality. The /proc-based approach is correct per the spec
// but is not exercised on this Windows host. Validate on real Linux before
// relying on this code path.

function extractUserDataDir(args) {
  for (const a of args) {
    if (a && a.startsWith('--user-data-dir=')) return a.substring('--user-data-dir='.length);
  }
  return null;
}

function extractProfileDirectory(args) {
  for (const a of args) {
    if (a && a.startsWith('--profile-directory=')) return a.substring('--profile-directory='.length);
  }
  return null;
}

function isBrowserParent(args) {
  for (const a of args) {
    if (a && a.startsWith('--type=')) return false;
  }
  return true;
}

function readCmdline(pid) {
  try {
    const buf = fs.readFileSync(path.join('/proc', String(pid), 'cmdline'));
    // NUL-separated, often with trailing NUL
    const parts = buf.toString('utf8').split('\0').filter((s) => s.length > 0);
    return parts;
  } catch (e) {
    return null;
  }
}

function listChromePids() {
  // Walk /proc/<digit>/comm to find chrome processes
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch (e) {
    error('linux-detector', 'failed to read /proc', e);
    return [];
  }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let comm;
    try {
      comm = fs.readFileSync(path.join('/proc', name, 'comm'), 'utf8').trim();
    } catch (e) {
      continue;
    }
    // Chrome's comm is typically "chrome" or "chromium" (often truncated to 15 chars)
    if (comm === 'chrome' || comm === 'chromium' || comm === 'chrome-browser' || comm.startsWith('chrome')) {
      out.push(Number(name));
    }
  }
  log('linux-detector', 'candidate pids', { count: out.length });
  return out;
}

async function detect() {
  log('linux-detector', 'TODO: Linux detection is scaffolded — verify on real Linux before trusting results');
  log('linux-detector', 'starting detection');

  const pids = listChromePids();
  if (pids.length === 0) {
    log('linux-detector', 'no chrome processes');
    return [];
  }

  const out = [];
  for (const pid of pids) {
    const args = readCmdline(pid);
    if (!args || args.length === 0) continue;
    if (!isBrowserParent(args)) continue;

    // Reconstruct a printable command line for logging
    const cmdLine = args.join(' ');

    const entry = {
      pid,
      commandLine: cmdLine,
      hasFlag: args.indexOf(FLAG) !== -1,
      userDataDir: extractUserDataDir(args),
      profileDirectory: extractProfileDirectory(args),
    };
    log('linux-detector', 'browser-parent identified', entry);
    out.push(entry);
  }

  log('linux-detector', 'detection complete', { browserParents: out.length });
  return out;
}

module.exports = { detect, FLAG };
