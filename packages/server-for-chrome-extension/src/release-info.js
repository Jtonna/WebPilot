'use strict';

/**
 * getReleaseInfo() — single source of truth for build provenance.
 *
 * At build time the CI workflow writes
 *   packages/server-for-chrome-extension/release-info.json
 * containing { ref, channel, version, builtAt }.
 *
 * At runtime (both plain Node and inside a pkg binary snapshot) this module
 * reads that file once and memoises the result. All consumers — serverInfo,
 * /api/ui/release, the UI version display — call getReleaseInfo() so version
 * is always derived from a single location.
 *
 * Fallback (dev checkouts / legacy builds / any parse error):
 *   { ref: null, channel: 'dev', version: <package.json version>, builtAt: null }
 */

const fs = require('fs');
const path = require('path');

let _cached = null;

function getReleaseInfo() {
  if (_cached !== null) return _cached;

  const infoPath = path.join(__dirname, '..', 'release-info.json');
  try {
    const raw = fs.readFileSync(infoPath, 'utf8');
    const info = JSON.parse(raw);

    // Validate shape: all four fields must be present, non-empty strings.
    const required = ['ref', 'channel', 'version', 'builtAt'];
    const allPresent = required.every(
      (k) => info && typeof info[k] === 'string' && info[k].length > 0
    );

    if (allPresent) {
      _cached = {
        ref: info.ref,
        channel: info.channel,
        version: info.version,
        builtAt: info.builtAt,
      };
      return _cached;
    }

    console.warn('[release-info] release-info.json is missing required fields — falling back to dev');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Malformed JSON or unexpected read error — worth logging.
      console.warn('[release-info] release-info.json missing or malformed — falling back to dev');
    }
    // ENOENT in dev checkouts: silent fallback.
  }

  // Fallback: derive version from package.json (always present, pkg snapshots bundle it).
  let pkgVersion = '0.0.0';
  try {
    pkgVersion = require('../package.json').version;
  } catch (_e) { /* ignore */ }

  _cached = { ref: null, channel: 'dev', version: pkgVersion, builtAt: null };
  return _cached;
}

// Allow tests to reset the memo between scenarios.
function _resetCache() {
  _cached = null;
}

module.exports = { getReleaseInfo, _resetCache };
