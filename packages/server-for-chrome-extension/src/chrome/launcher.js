'use strict';

const { spawn } = require('node:child_process');
const { log, error } = require('./logger');
const { getDefaultChromePath, getDefaultUserDataDir } = require('./paths');

const FLAG = '--silent-debugger-extension-api';

/**
 * Launch Chrome for a specific profile. Spawns Chrome detached so the server
 * process doesn't own its lifetime.
 *
 * opts:
 *   chromePath        — path to chrome binary; defaults to getDefaultChromePath()
 *   userDataDir       — overrides default; if equal to the default we DO NOT pass --user-data-dir
 *   profileDirectory  — required; e.g. "Default", "Profile 1"
 *   withFlag          — if true (default), passes --silent-debugger-extension-api
 *   extraArgs         — optional array of additional CLI args, appended last
 *
 * Returns: { pid, chromePath, args }
 */
function launchChromeProfile(opts) {
  const options = opts || {};
  const chromePath = options.chromePath || getDefaultChromePath();
  const profileDirectory = options.profileDirectory;
  const withFlag = options.withFlag !== false;
  const requestedUserDataDir = options.userDataDir;
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];

  log('launcher', 'launchChromeProfile called', {
    chromePath,
    profileDirectory,
    withFlag,
    userDataDir: requestedUserDataDir,
    extraArgsCount: extraArgs.length,
  });

  if (!profileDirectory) {
    const e = new Error('launchChromeProfile requires profileDirectory');
    error('launcher', 'missing profileDirectory', e);
    throw e;
  }
  if (!chromePath) {
    const e = new Error('launchChromeProfile could not resolve chrome path');
    error('launcher', 'no chrome path resolved', e);
    throw e;
  }

  const defaultUdd = getDefaultUserDataDir();
  const args = [];

  // Only pass --user-data-dir if non-default; Chrome behaves better when omitted
  if (requestedUserDataDir && requestedUserDataDir !== defaultUdd) {
    args.push('--user-data-dir=' + requestedUserDataDir);
  }

  args.push('--profile-directory=' + profileDirectory);

  if (withFlag) args.push(FLAG);

  for (const a of extraArgs) args.push(a);

  log('launcher', 'spawning chrome', { chromePath, args });

  let child;
  try {
    child = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
  } catch (e) {
    error('launcher', 'spawn threw', e);
    throw e;
  }

  // Unref so node can exit independently of chrome
  try { child.unref(); } catch (e) { /* non-fatal */ }

  child.on('error', (err) => {
    error('launcher', 'chrome process error event', err);
  });

  log('launcher', 'chrome launched', { pid: child.pid, chromePath, args });

  return { pid: child.pid, chromePath, args };
}

module.exports = { launchChromeProfile, FLAG };
