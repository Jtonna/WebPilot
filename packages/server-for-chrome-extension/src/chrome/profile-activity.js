'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { log, error } = require('./logger');

/**
 * Returns an array of profile directory names that have any file inside
 * `<userDataDir>/<profileDir>/` modified within the last `withinSeconds` seconds.
 *
 * Empirically (spec section 2.5), active Chrome profiles write to
 * `SharedStorage-wal` etc. constantly — ~9-13 writes per minute. Inactive
 * profiles have no recent writes.
 *
 * We scan only the immediate children + a few well-known hot files to avoid
 * descending into massive Cache/ subtrees.
 */
const HOT_FILES = [
  'SharedStorage-wal',
  'SharedStorage',
  'Cookies',
  'Cookies-journal',
  'History',
  'History-journal',
  'Preferences',
  'Sessions',
  'Current Session',
  'Current Tabs',
];

function getActiveProfiles(userDataDir, knownProfileDirs, withinSeconds) {
  const cutoffSec = typeof withinSeconds === 'number' ? withinSeconds : 30;
  const cutoffMs = Date.now() - cutoffSec * 1000;

  log('profile-activity', 'checking activity', {
    userDataDir,
    candidates: knownProfileDirs,
    withinSeconds: cutoffSec,
  });

  const active = [];
  for (const dirName of knownProfileDirs || []) {
    const profileDir = path.join(userDataDir, dirName);
    if (!fs.existsSync(profileDir)) {
      log('profile-activity', 'profile dir does not exist, skipping', { profileDir });
      continue;
    }

    let mostRecent = 0;
    let mostRecentFile = null;

    // Check well-known hot files first (fast path)
    for (const name of HOT_FILES) {
      try {
        const st = fs.statSync(path.join(profileDir, name));
        if (st.mtimeMs > mostRecent) {
          mostRecent = st.mtimeMs;
          mostRecentFile = name;
        }
      } catch (e) {
        // file does not exist or unreadable — non-fatal
      }
    }

    // Also peek at the directory mtime itself (cheap)
    try {
      const st = fs.statSync(profileDir);
      if (st.mtimeMs > mostRecent) {
        mostRecent = st.mtimeMs;
        mostRecentFile = '(profile dir)';
      }
    } catch (e) {
      error('profile-activity', 'failed to stat profile dir', e);
    }

    if (mostRecent >= cutoffMs) {
      const ageSec = ((Date.now() - mostRecent) / 1000).toFixed(1);
      log('profile-activity', 'profile is active', {
        directoryName: dirName,
        mostRecentFile,
        ageSec,
      });
      active.push(dirName);
    } else if (mostRecent > 0) {
      const ageSec = ((Date.now() - mostRecent) / 1000).toFixed(1);
      log('profile-activity', 'profile inactive', {
        directoryName: dirName,
        mostRecentFile,
        ageSec,
      });
    } else {
      log('profile-activity', 'profile has no detectable activity', { directoryName: dirName });
    }
  }

  log('profile-activity', 'active profiles', { active });
  return active;
}

module.exports = { getActiveProfiles };
