'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Idempotent startup schema migrations.
 *
 * Renames the `baseline` family of persisted identifiers to `global_site_blocklist`:
 *   1. config key `baseline_blocklist_enabled` → `global_site_blocklist_enabled`
 *   2. table `baseline_blocklist_meta` → `global_site_blocklist_meta`
 *   3. `global_site_rules` CHECK clause `'baseline'` → `'global_site_blocklist'`
 *      AND existing rows where source='baseline' are rewritten to the new literal.
 *      Done via the SQLite 12-step table-rewrite inside an immediate transaction.
 *   4. on-disk cache dir `<dataDir>/baseline-blocklists/` → `<dataDir>/global-site-blocklists/`
 *
 * MUST run BEFORE `_db.exec(schemaSql)` in connection.js:init(). Every step is
 * guarded against the already-renamed state so re-running this on a fresh or
 * post-migration DB is a clean no-op.
 *
 * @param {object} db  better-sqlite3 Database handle
 * @param {{ dataDir: string }} opts
 */

module.exports = {
  id: '001-rename-baseline-to-global-site-blocklist',
  description: 'Rename baseline_* identifiers to global_site_blocklist_* (config key, meta table, CHECK constraint, cache dir)',
  up(db, opts) {
    const dataDir = opts && opts.dataDir;

    // ─── 1. config key rename ───────────────────────────────────────────────
    // If the new key isn't present, rename the old row in place. If both keys
    // coexist (an interrupted earlier rename), the new key wins and the old
    // is dropped.
    const renameRes = db.prepare(
      `UPDATE config SET key = 'global_site_blocklist_enabled'
       WHERE key = 'baseline_blocklist_enabled'
         AND NOT EXISTS (SELECT 1 FROM config WHERE key = 'global_site_blocklist_enabled')`
    ).run();
    if (renameRes.changes > 0) {
      console.log('[migration] renamed config key baseline_blocklist_enabled → global_site_blocklist_enabled');
    }
    const dropRes = db.prepare(
      `DELETE FROM config WHERE key = 'baseline_blocklist_enabled'
         AND EXISTS (SELECT 1 FROM config WHERE key = 'global_site_blocklist_enabled')`
    ).run();
    if (dropRes.changes > 0) {
      console.log('[migration] dropped stale config key baseline_blocklist_enabled (new key already present)');
    }

    // ─── 2. baseline_blocklist_meta table rename ────────────────────────────
    const oldMetaExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='baseline_blocklist_meta'"
    ).get();
    const newMetaExists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='global_site_blocklist_meta'"
    ).get();
    if (oldMetaExists && !newMetaExists) {
      db.exec('ALTER TABLE baseline_blocklist_meta RENAME TO global_site_blocklist_meta');
      console.log('[migration] renamed table baseline_blocklist_meta → global_site_blocklist_meta');
    } else if (oldMetaExists && newMetaExists) {
      db.exec('DROP TABLE baseline_blocklist_meta');
      console.log('[migration] dropped stale table baseline_blocklist_meta (new table already present)');
    }

    // ─── 3. global_site_rules CHECK rewrite ─────────────────────────────────
    // SQLite cannot ALTER a CHECK constraint in place. We detect the old shape
    // by looking for the literal 'baseline' in the stored CREATE TABLE SQL. If
    // present, perform the standard 12-step table-rewrite inside an IMMEDIATE
    // transaction with foreign_keys temporarily disabled, then verify FK
    // integrity with PRAGMA foreign_key_check before committing.
    const tblRow = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='global_site_rules'"
    ).get();
    const needsRewrite = tblRow && typeof tblRow.sql === 'string' && tblRow.sql.includes("'baseline'");

    if (needsRewrite) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        const tx = db.transaction(() => {
          // Column list copied verbatim from schema.sql (same types, NOT NULL,
          // CHECK on `decision`, PRIMARY KEY on `domain`); only the `source`
          // CHECK clause is updated to the new literal.
          db.exec(
            `CREATE TABLE global_site_rules_new (
               domain TEXT PRIMARY KEY,
               decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
               source TEXT NOT NULL CHECK(source IN ('user','global_site_blocklist')),
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             )`
          );

          const oldCount = db.prepare('SELECT COUNT(*) AS c FROM global_site_rules').get().c;

          db.exec(
            `INSERT INTO global_site_rules_new (domain, decision, source, created_at, updated_at)
             SELECT
               domain,
               decision,
               CASE WHEN source = 'baseline' THEN 'global_site_blocklist' ELSE source END,
               created_at,
               updated_at
             FROM global_site_rules`
          );

          const newCount = db.prepare('SELECT COUNT(*) AS c FROM global_site_rules_new').get().c;
          if (newCount !== oldCount) {
            throw new Error(
              `[migration] global_site_rules row count mismatch during rewrite: ` +
              `old=${oldCount} new=${newCount} — aborting`
            );
          }

          db.exec('DROP TABLE global_site_rules');
          db.exec('ALTER TABLE global_site_rules_new RENAME TO global_site_rules');

          // schema.sql defines no indexes on global_site_rules, so nothing to
          // recreate. (Verified at time of writing — if that changes, add the
          // CREATE INDEX statements here.)

          const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
          if (fkCheck.length > 0) {
            throw new Error(
              '[migration] FK check failed after global_site_rules rewrite: ' +
              JSON.stringify(fkCheck)
            );
          }
        });
        tx();
        console.log('[migration] rewrote global_site_rules: CHECK now allows global_site_blocklist; baseline rows updated');
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }

    // ─── 4. on-disk cache dir rename ───────────────────────────────────────
    if (dataDir) {
      const oldDir = path.join(dataDir, 'baseline-blocklists');
      const newDir = path.join(dataDir, 'global-site-blocklists');
      let oldExists = false;
      let newExists = false;
      try { oldExists = fs.existsSync(oldDir); } catch (_e) { /* ignore */ }
      try { newExists = fs.existsSync(newDir); } catch (_e) { /* ignore */ }
      if (oldExists && !newExists) {
        try {
          fs.renameSync(oldDir, newDir);
          console.log(`[migration] renamed cache dir ${oldDir} → ${newDir}`);
        } catch (e) {
          console.warn(`[migration] failed to rename cache dir ${oldDir} → ${newDir}: ${e && e.message}`);
        }
      } else if (oldExists && newExists) {
        // Both present (interrupted rename). The new dir is the source of
        // truth; remove the stale old dir. A failure here is non-fatal — a
        // stale cache directory is harmless beyond wasted disk.
        try {
          fs.rmSync(oldDir, { recursive: true, force: true });
          console.log(`[migration] removed stale cache dir ${oldDir} (new dir already present)`);
        } catch (e) {
          console.warn(`[migration] failed to remove stale cache dir ${oldDir}: ${e && e.message}`);
        }
      }
    }
  },
};
