'use strict';

/**
 * Split the mixed `global_site_rules` table into one table per tier.
 *
 *   a. config key `global_site_blocklist_enabled` → `global_tier_enabled`
 *      (the toggle now switches the whole global tier, not just the signed
 *      blocklist). Value preserved.
 *   b. `global_site_rules` rows are copied into:
 *        - `global_user_site_rules`      (source='user')
 *        - `global_site_blocklist_rules` (source='global_site_blocklist',
 *                                         decision='block')
 *      Wildcard domains (containing '*') and signed-allow rows cannot be
 *      represented in the new shape; they are skipped and logged. Every
 *      eligible row is verified present in its target, then the old table is
 *      dropped.
 *   c. In the old shape `domain` was a single PRIMARY KEY across both
 *      sources, so a user rule silently masked any signed rule for the same
 *      domain. If any user rows were migrated, the stored blocklist version is
 *      prefixed with `pre-002:` so the next updater tick sees a version
 *      mismatch and re-syncs the signed table (restoring masked domains). The
 *      meta row is deliberately NOT deleted: the updater's `_readMetaVersion()`
 *      fail-skip guard must stay truthy.
 *   d. If the toggle was 'false' and user rows were migrated, warn that those
 *      user rules are now inactive while the global tier is off.
 *
 * MUST run BEFORE `_db.exec(schemaSql)` in connection.js:init(). Every step
 * checks that the table it touches exists, so a truly empty DB (only the
 * `schema_migrations` ledger) is a clean no-op, as is re-running `up()` on an
 * already-migrated DB. The runner wraps `up()` in a transaction; a thrown
 * Error rolls everything back (and exits the daemon — see
 * docs/SCHEMA_MIGRATIONS.md).
 *
 * @param {object} db  better-sqlite3 Database handle
 */

// DDL must stay identical to the matching statements in src/db/schema.sql.
const GLOBAL_USER_SITE_RULES_DDL = `CREATE TABLE IF NOT EXISTS global_user_site_rules (
  domain TEXT PRIMARY KEY CHECK(instr(domain, '*') = 0),
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

const GLOBAL_SITE_BLOCKLIST_RULES_DDL = `CREATE TABLE IF NOT EXISTS global_site_blocklist_rules (
  domain TEXT PRIMARY KEY CHECK(instr(domain, '*') = 0),
  created_at TEXT NOT NULL
)`;

const OLD_KEY = 'global_site_blocklist_enabled';
const NEW_KEY = 'global_tier_enabled';

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

module.exports = {
  id: '002-split-site-rules-per-tier',
  description: 'Split global_site_rules into global_user_site_rules + global_site_blocklist_rules; rename global_site_blocklist_enabled → global_tier_enabled',
  GLOBAL_USER_SITE_RULES_DDL,
  GLOBAL_SITE_BLOCKLIST_RULES_DDL,
  up(db) {
    // ─── a. config key rename ──────────────────────────────────────────────
    // Same pattern as 001: rename in place if the new key is absent; if both
    // coexist the new key wins and the old one is dropped.
    const hasConfig = tableExists(db, 'config');
    if (hasConfig) {
      const renameRes = db.prepare(
        `UPDATE config SET key = ?
         WHERE key = ?
           AND NOT EXISTS (SELECT 1 FROM config WHERE key = ?)`
      ).run(NEW_KEY, OLD_KEY, NEW_KEY);
      if (renameRes.changes > 0) {
        console.log(`[migration] renamed config key ${OLD_KEY} → ${NEW_KEY}`);
      }
      const dropRes = db.prepare(
        `DELETE FROM config WHERE key = ?
           AND EXISTS (SELECT 1 FROM config WHERE key = ?)`
      ).run(OLD_KEY, NEW_KEY);
      if (dropRes.changes > 0) {
        console.log(`[migration] dropped stale config key ${OLD_KEY} (${NEW_KEY} already present)`);
      }
    }

    // ─── b. table split ────────────────────────────────────────────────────
    let migratedUserRows = 0;
    if (tableExists(db, 'global_site_rules')) {
      db.exec(GLOBAL_USER_SITE_RULES_DDL);
      db.exec(GLOBAL_SITE_BLOCKLIST_RULES_DDL);

      const eligibleUser = db.prepare(
        `SELECT COUNT(*) AS c FROM global_site_rules
         WHERE source = 'user' AND instr(domain, '*') = 0`
      ).get().c;
      const eligibleSigned = db.prepare(
        `SELECT COUNT(*) AS c FROM global_site_rules
         WHERE source = 'global_site_blocklist' AND decision = 'block' AND instr(domain, '*') = 0`
      ).get().c;

      db.exec(
        `INSERT OR IGNORE INTO global_user_site_rules (domain, decision, created_at, updated_at)
         SELECT domain, decision, created_at, updated_at FROM global_site_rules
         WHERE source = 'user' AND instr(domain, '*') = 0`
      );
      db.exec(
        `INSERT OR IGNORE INTO global_site_blocklist_rules (domain, created_at)
         SELECT domain, created_at FROM global_site_rules
         WHERE source = 'global_site_blocklist' AND decision = 'block' AND instr(domain, '*') = 0`
      );

      // Rows that cannot be represented in the new shape.
      const skipped = db.prepare(
        `SELECT domain, decision, source FROM global_site_rules
         WHERE instr(domain, '*') > 0
            OR NOT (source = 'user'
                    OR (source = 'global_site_blocklist' AND decision = 'block'))`
      ).all();
      if (skipped.length > 0) {
        const sample = skipped.slice(0, 10)
          .map(r => `${r.domain} (${r.source}/${r.decision})`).join(', ');
        console.warn(
          `[migration] skipped ${skipped.length} global_site_rules row(s) not representable ` +
          `in the per-tier tables (wildcard domains or signed-allow rows): ${sample}` +
          (skipped.length > 10 ? ', ...' : '')
        );
      }

      // Verify every eligible old row landed in its target before dropping.
      const missingUser = db.prepare(
        `SELECT COUNT(*) AS c FROM global_site_rules g
         WHERE g.source = 'user' AND instr(g.domain, '*') = 0
           AND NOT EXISTS (SELECT 1 FROM global_user_site_rules u WHERE u.domain = g.domain)`
      ).get().c;
      const missingSigned = db.prepare(
        `SELECT COUNT(*) AS c FROM global_site_rules g
         WHERE g.source = 'global_site_blocklist' AND g.decision = 'block' AND instr(g.domain, '*') = 0
           AND NOT EXISTS (SELECT 1 FROM global_site_blocklist_rules b WHERE b.domain = g.domain)`
      ).get().c;
      if (missingUser > 0 || missingSigned > 0) {
        throw new Error(
          `[migration] 002 verification failed: ${missingUser} of ${eligibleUser} user row(s) missing from ` +
          `global_user_site_rules and ${missingSigned} of ${eligibleSigned} signed row(s) missing from ` +
          'global_site_blocklist_rules; aborting (transaction rolled back, global_site_rules left intact)'
        );
      }

      db.exec('DROP TABLE global_site_rules');
      migratedUserRows = eligibleUser;
      console.log(
        `[migration] split global_site_rules: ${eligibleUser} user row(s) → global_user_site_rules, ` +
        `${eligibleSigned} signed row(s) → global_site_blocklist_rules, ${skipped.length} skipped; old table dropped`
      );
    }

    // ─── c. force a signed re-sync to restore rows masked by user rules ────
    if (migratedUserRows > 0 && tableExists(db, 'global_site_blocklist_meta')) {
      const res = db.prepare(
        `UPDATE global_site_blocklist_meta SET version = 'pre-002:' || version
         WHERE id = 1 AND version NOT LIKE 'pre-002:%'`
      ).run();
      if (res.changes > 0) {
        console.log('[migration] prefixed global_site_blocklist_meta version with pre-002: to force a signed re-sync');
      }
    }

    // ─── d. warn if the (now whole-tier) toggle is off ─────────────────────
    if (migratedUserRows > 0 && hasConfig) {
      const row = db.prepare('SELECT value FROM config WHERE key = ?').get(NEW_KEY);
      if (row && row.value === 'false') {
        console.warn(
          `[migration] ${NEW_KEY} is 'false': the toggle now disables the whole global tier, so the ` +
          `${migratedUserRows} migrated global user rule(s) are inactive until it is turned back on`
        );
      }
    }
  },
};
