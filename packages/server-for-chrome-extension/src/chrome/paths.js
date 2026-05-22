'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { log } = require('./logger');

/**
 * Returns the default Chrome executable path for the current OS, or null
 * if no obvious candidate exists. Caller may override via config.
 */
function getDefaultChromePath() {
  const platform = process.platform;

  if (platform === 'win32') {
    const candidates = [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) {
        log('paths', 'resolved chrome path', { platform, path: c });
        return c;
      }
    }
    log('paths', 'no chrome.exe found in standard locations', { candidates });
    return candidates[0]; // best-effort fallback
  }

  if (platform === 'darwin') {
    const candidate = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    log('paths', 'resolved chrome path', { platform, path: candidate });
    return candidate;
  }

  // linux & friends
  const linuxCandidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
  for (const c of linuxCandidates) {
    if (fs.existsSync(c)) {
      log('paths', 'resolved chrome path', { platform, path: c });
      return c;
    }
  }
  log('paths', 'no chrome binary found in standard linux locations', { candidates: linuxCandidates });
  return linuxCandidates[0];
}

/**
 * Returns the default Chrome user-data-dir for the current OS.
 * This is the parent directory containing "Local State" and "Default/",
 * "Profile 1/", etc.
 */
function getDefaultUserDataDir() {
  const platform = process.platform;

  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const dir = path.join(local, 'Google', 'Chrome', 'User Data');
    log('paths', 'resolved user-data-dir', { platform, path: dir });
    return dir;
  }

  if (platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    log('paths', 'resolved user-data-dir', { platform, path: dir });
    return dir;
  }

  // Linux
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dir = path.join(configHome, 'google-chrome');
  log('paths', 'resolved user-data-dir', { platform, path: dir });
  return dir;
}

module.exports = {
  getDefaultChromePath,
  getDefaultUserDataDir,
};
