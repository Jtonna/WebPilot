'use strict';

/**
 * extension-installs.js
 *
 * Persistent server-side store mapping a per-install UUID (`installId`) minted
 * by the Chrome extension on `chrome.runtime.onInstalled` to the Chrome
 * `profileId` (profile-directory name) the server resolved for that install.
 *
 * Why this exists:
 *   The hello handshake has several resolution paths (direct profileId match
 *   from extension storage, gaiaEmail lookup against Local State, inference
 *   by exclusion, manual picker). When extension storage gets cleared (user
 *   resets, profile rebuilt, etc.) the cached `profileId` is gone and the
 *   server falls all the way back to the picker. This store gives the server
 *   an independent mapping keyed by an install-bound UUID that survives
 *   extension-storage wipes, so re-identification is automatic.
 *
 * On-disk shape (<dataDir>/config/extension-installs.json):
 *   {
 *     "<uuid>": {
 *       "profileId":    "<chrome profile directory name>",
 *       "firstSeen":    "<iso-8601>",
 *       "lastResolved": "<iso-8601>"
 *     },
 *     ...
 *   }
 */

const path = require('node:path');
const fs = require('node:fs');

const { getDataDir } = require('./service/paths');

function getInstallsPath() {
  return path.join(getDataDir(), 'config', 'extension-installs.json');
}

/**
 * Reads extension-installs.json. Creates the file with `{}` on first use.
 * Returns a plain object keyed by installId.
 *
 * @returns {Object<string, { profileId: string, firstSeen: string, lastResolved: string }>}
 */
function loadInstalls() {
  const filePath = getInstallsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      console.log(
        '[extension-installs:load] file content was not a plain object — treating as empty'
      );
      return {};
    }
    // First boot — initialise an empty file so admins can find it on disk.
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({}, null, 2), 'utf8');
    console.log(`[extension-installs:load] created empty store at ${filePath}`);
    return {};
  } catch (e) {
    console.log(`[extension-installs:load] failed to read store: ${e.message}`);
    return {};
  }
}

/**
 * Atomic write of the full installs object.
 *
 * @param {Object} data
 */
function saveInstalls(data) {
  const filePath = getInstallsPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.log(`[extension-installs:save] failed to write store: ${e.message}`);
  }
}

/**
 * Look up the profileId mapped to an installId. Touches `lastResolved` on
 * success so the entry stays fresh and won't get garbage-collected by
 * `cleanupStaleInstalls`.
 *
 * @param {string} installId
 * @returns {string|null} profileId, or null if not present
 */
function getProfileForInstall(installId) {
  if (typeof installId !== 'string' || installId.length === 0) {
    return null;
  }
  const installs = loadInstalls();
  const entry = installs[installId];
  if (!entry || typeof entry.profileId !== 'string' || entry.profileId.length === 0) {
    console.log(
      `[extension-installs:get] no mapping for installId="${installId.slice(0, 8)}..."`
    );
    return null;
  }
  entry.lastResolved = new Date().toISOString();
  saveInstalls(installs);
  console.log(
    `[extension-installs:get] resolved installId="${installId.slice(0, 8)}..." -> ` +
      `profileId="${entry.profileId}"`
  );
  return entry.profileId;
}

/**
 * Upsert the mapping for `installId` -> `profileId`. Sets `firstSeen` on
 * insert; always updates `lastResolved` (and `profileId`, in case the user
 * intentionally re-bound to a different profile in the picker).
 *
 * @param {string} installId
 * @param {string} profileId
 * @returns {boolean} true if the store was written, false if inputs invalid
 */
function setProfileForInstall(installId, profileId) {
  if (typeof installId !== 'string' || installId.length === 0) {
    console.log('[extension-installs:set] refusing — installId must be a non-empty string');
    return false;
  }
  if (typeof profileId !== 'string' || profileId.length === 0) {
    console.log('[extension-installs:set] refusing — profileId must be a non-empty string');
    return false;
  }
  const installs = loadInstalls();
  const now = new Date().toISOString();
  const existing = installs[installId];
  if (!existing) {
    installs[installId] = {
      profileId,
      firstSeen: now,
      lastResolved: now,
    };
    console.log(
      `[extension-installs:set] inserted installId="${installId.slice(0, 8)}..." -> ` +
        `profileId="${profileId}"`
    );
  } else {
    const before = existing.profileId;
    existing.profileId = profileId;
    existing.lastResolved = now;
    if (!existing.firstSeen) existing.firstSeen = now;
    if (before !== profileId) {
      console.log(
        `[extension-installs:set] rebound installId="${installId.slice(0, 8)}..." ` +
          `profileId "${before}" -> "${profileId}"`
      );
    } else {
      console.log(
        `[extension-installs:set] touched installId="${installId.slice(0, 8)}..." ` +
          `profileId="${profileId}"`
      );
    }
  }
  saveInstalls(installs);
  return true;
}

/**
 * Drop entries whose `lastResolved` is older than `maxAgeDays`. Intended to be
 * called once at server startup so the file doesn't grow forever on machines
 * where extensions get reinstalled frequently.
 *
 * @param {number} [maxAgeDays=90]
 * @returns {{ removed: number, kept: number }}
 */
function cleanupStaleInstalls(maxAgeDays = 90) {
  const installs = loadInstalls();
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const kept = {};
  let removed = 0;
  for (const [installId, entry] of Object.entries(installs)) {
    if (!entry || typeof entry !== 'object') {
      removed += 1;
      continue;
    }
    const last = entry.lastResolved ? Date.parse(entry.lastResolved) : NaN;
    if (Number.isFinite(last) && last < cutoffMs) {
      removed += 1;
      continue;
    }
    kept[installId] = entry;
  }
  if (removed > 0) {
    saveInstalls(kept);
  }
  const keptCount = Object.keys(kept).length;
  console.log(
    `[extension-installs:cleanup] removed=${removed} kept=${keptCount} ` +
      `(maxAgeDays=${maxAgeDays})`
  );
  return { removed, kept: keptCount };
}

module.exports = {
  loadInstalls,
  saveInstalls,
  getProfileForInstall,
  setProfileForInstall,
  cleanupStaleInstalls,
};
