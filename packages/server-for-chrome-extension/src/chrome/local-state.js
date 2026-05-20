'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { log, error } = require('./logger');

/**
 * Reads `<user-data-dir>/Local State` JSON and returns an array of
 *   { directoryName, displayName, gaiaName, gaiaEmail }
 * one entry per profile listed in `profile.info_cache`.
 *
 * Returns [] on read/parse failure (logged).
 */
function readProfiles(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  log('local-state', 'reading profiles', { localStatePath });

  let raw;
  try {
    raw = fs.readFileSync(localStatePath, 'utf8');
  } catch (e) {
    error('local-state', 'failed to read Local State', e);
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    error('local-state', 'failed to parse Local State JSON', e);
    return [];
  }

  const infoCache = parsed && parsed.profile && parsed.profile.info_cache;
  if (!infoCache || typeof infoCache !== 'object') {
    log('local-state', 'no profile.info_cache present');
    return [];
  }

  const out = [];
  for (const [directoryName, info] of Object.entries(infoCache)) {
    out.push({
      directoryName,
      displayName: (info && (info.name || info.shortcut_name)) || directoryName,
      gaiaName: (info && info.gaia_name) || null,
      gaiaEmail: (info && (info.user_name || info.gaia_id_email)) || null,
    });
  }

  log('local-state', 'parsed profiles', { count: out.length, profiles: out.map((p) => p.directoryName) });
  return out;
}

module.exports = { readProfiles };
