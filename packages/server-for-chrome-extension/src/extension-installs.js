'use strict';

/**
 * extension-installs.js — SQLite-backed store for the per-install UUID
 * (`installId`) minted by the Chrome extension on
 * `chrome.runtime.onInstalled`, mapped to the Chrome `profileId`
 * (profile-directory name) the server resolved for that install. Rows
 * live in `extension_installs` (see `src/db/schema.sql`).
 *
 * Exports:
 *   - loadInstalls() — full snapshot; used by server.js for the status page.
 *   - saveInstalls(data) — compat shim that does a full table replace.
 *   - getProfileForInstall(installId)
 *   - setProfileForInstall(installId, profileId)
 *   - cleanupStaleInstalls(maxAgeDays)
 *
 * Why `loadInstalls` / `saveInstalls` are still exported: server.js
 * snapshots the whole map for status-page rendering. The shims keep that
 * endpoint mechanical instead of forcing a wider refactor.
 */

const dbModule = require('./db/connection');

/**
 * Returns a plain object keyed by installId — same shape the JSON store used
 * to produce. Built by querying every row in `extension_installs`. Used by
 * server.js to render the status snapshot.
 *
 * @returns {Object<string, { profileId: string, firstSeen: string, lastResolved: string }>}
 */
function loadInstalls() {
  try {
    const db = dbModule.getDb();
    const rows = db
      .prepare('SELECT install_id, profile_id, first_seen_at, last_seen_at FROM extension_installs')
      .all();
    const out = {};
    for (const row of rows) {
      if (!row || typeof row.install_id !== 'string') continue;
      out[row.install_id] = {
        profileId: row.profile_id || '',
        firstSeen: row.first_seen_at || '',
        lastResolved: row.last_seen_at || '',
      };
    }
    return out;
  } catch (e) {
    console.log(`[extension-installs:load] DB read failed: ${e && e.message}`);
    return {};
  }
}

/**
 * Full-replace write. Kept for compatibility with any external caller that
 * grabbed the snapshot via loadInstalls() and edited it in-memory. Not the
 * recommended path — use setProfileForInstall() for upsert and
 * cleanupStaleInstalls() for pruning.
 *
 * @param {Object} data
 */
function saveInstalls(data) {
  if (!data || typeof data !== 'object') {
    console.log('[extension-installs:save] refusing — data must be a plain object');
    return;
  }
  try {
    const db = dbModule.getDb();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM extension_installs').run();
      const insert = db.prepare(
        `INSERT INTO extension_installs (install_id, profile_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const [installId, entry] of Object.entries(data)) {
        if (!installId || !entry || typeof entry !== 'object') continue;
        insert.run(
          installId,
          entry.profileId || null,
          entry.firstSeen || new Date().toISOString(),
          entry.lastResolved || new Date().toISOString()
        );
      }
    });
    tx();
  } catch (e) {
    console.log(`[extension-installs:save] DB write failed: ${e && e.message}`);
  }
}

/**
 * Look up the profileId mapped to an installId. Touches `last_seen_at` on
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
  try {
    const db = dbModule.getDb();
    const row = db
      .prepare('SELECT profile_id FROM extension_installs WHERE install_id = ?')
      .get(installId);
    if (!row || typeof row.profile_id !== 'string' || row.profile_id.length === 0) {
      console.log(
        `[extension-installs:get] no mapping for installId="${installId.slice(0, 8)}..."`
      );
      return null;
    }
    const nowIso = new Date().toISOString();
    db.prepare('UPDATE extension_installs SET last_seen_at = ? WHERE install_id = ?')
      .run(nowIso, installId);
    console.log(
      `[extension-installs:get] resolved installId="${installId.slice(0, 8)}..." -> ` +
        `profileId="${row.profile_id}"`
    );
    return row.profile_id;
  } catch (e) {
    console.log(`[extension-installs:get] DB lookup failed: ${e && e.message}`);
    return null;
  }
}

/**
 * Upsert the mapping for `installId` -> `profileId`. Sets `first_seen_at` on
 * insert; always updates `last_seen_at` (and `profile_id`, in case the user
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
  try {
    const db = dbModule.getDb();
    const nowIso = new Date().toISOString();
    const existing = db
      .prepare('SELECT install_id, profile_id FROM extension_installs WHERE install_id = ?')
      .get(installId);
    if (!existing) {
      db.prepare(
        `INSERT INTO extension_installs (install_id, profile_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)`
      ).run(installId, profileId, nowIso, nowIso);
      console.log(
        `[extension-installs:set] inserted installId="${installId.slice(0, 8)}..." -> ` +
          `profileId="${profileId}"`
      );
    } else {
      const before = existing.profile_id;
      db.prepare(
        'UPDATE extension_installs SET profile_id = ?, last_seen_at = ? WHERE install_id = ?'
      ).run(profileId, nowIso, installId);
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
    return true;
  } catch (e) {
    console.log(`[extension-installs:set] DB write failed: ${e && e.message}`);
    return false;
  }
}

/**
 * Drop entries whose `last_seen_at` is older than `maxAgeDays`. Intended to be
 * called once at server startup so the table doesn't grow forever on machines
 * where extensions get reinstalled frequently.
 *
 * @param {number} [maxAgeDays=90]
 * @returns {{ removed: number, kept: number }}
 */
function cleanupStaleInstalls(maxAgeDays = 90) {
  try {
    const db = dbModule.getDb();
    const cutoffIso = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const res = db
      .prepare('DELETE FROM extension_installs WHERE last_seen_at < ?')
      .run(cutoffIso);
    const removed = res.changes || 0;
    const kept = db.prepare('SELECT COUNT(*) AS c FROM extension_installs').get().c;
    console.log(
      `[extension-installs:cleanup] removed=${removed} kept=${kept} ` +
        `(maxAgeDays=${maxAgeDays})`
    );
    return { removed, kept };
  } catch (e) {
    console.log(`[extension-installs:cleanup] DB op failed: ${e && e.message}`);
    return { removed: 0, kept: 0 };
  }
}

module.exports = {
  loadInstalls,
  saveInstalls,
  getProfileForInstall,
  setProfileForInstall,
  cleanupStaleInstalls,
};
