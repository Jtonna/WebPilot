'use strict';

/**
 * Rename the per-agent site-policy tier from "overrides" to "rules".
 *
 *   a. `agent_site_overrides` → `agent_site_rules`. Rows whose agent still
 *      exists are copied (agent_id, domain, decision, created_at); orphaned
 *      rows (agent deleted while foreign_keys was off) are skipped and
 *      logged. If both tables exist (restore-from-backup), rows already in
 *      `agent_site_rules` win. Every eligible old row is verified present by
 *      (agent_id, domain), then the old table and its redundant
 *      `idx_agent_overrides` index (it duplicated the UNIQUE autoindex) are
 *      dropped.
 *   b. `site_policy_events.source` CHECK: 'agent_override' → 'agent_rule'.
 *      SQLite cannot alter a CHECK in place, so the table is rebuilt: rename
 *      to `site_policy_events_old`, create the new shape, copy rows (ids
 *      preserved, source value mapped, orphans skipped and logged), verify
 *      the row count, drop the old table, recreate both indexes.
 *
 * MUST run BEFORE `_db.exec(schemaSql)` in connection.js:init(). Every step
 * checks that the table it touches exists (and, for b, that it still has the
 * old CHECK), so a truly empty DB (only the `schema_migrations` ledger) is a
 * clean no-op, as is re-running `up()` on an already-migrated DB. The runner
 * wraps `up()` in a transaction; a thrown Error rolls everything back (and
 * exits the daemon — see docs/SCHEMA_MIGRATIONS.md).
 *
 * @param {object} db  better-sqlite3 Database handle
 */

// DDL must stay identical to the matching statements in src/db/schema.sql.
const AGENT_SITE_RULES_DDL = `CREATE TABLE IF NOT EXISTS agent_site_rules (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,                     -- normalized, or the literal '*' (agent-wide default)
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, domain)
)`;

const SITE_POLICY_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS site_policy_events (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,                       -- verdict.domain: normalized host, or raw IP/single-label host
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  source TEXT NOT NULL CHECK(source IN ('agent_rule','global_user','global_site_blocklist','default')),
  matched_domain TEXT,                        -- stored domain of matching rule; '*' for agent wildcard; NULL for default
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  decision_changed_at TEXT NOT NULL,          -- = first_seen_at until the decision first flips
  hit_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(agent_id, domain)
)`;

const SITE_POLICY_EVENTS_INDEX_DDL = [
  'CREATE INDEX IF NOT EXISTS idx_site_policy_events_last_seen ON site_policy_events(last_seen_at DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_site_policy_events_agent_last_seen ON site_policy_events(agent_id, last_seen_at DESC)',
];

// The quoted source value only the old site_policy_events CHECK allows.
const OLD_SOURCE_TOKEN = "'agent_override'";

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function warnOrphans(table, sample, total) {
  if (total === 0) return;
  const shown = sample.map(r => `agent ${r.agent_id}: ${r.domain}`).join(', ');
  console.warn(
    `[migration] skipped ${total} ${table} row(s) whose agent no longer exists: ${shown}` +
    (total > sample.length ? ', ...' : '')
  );
}

module.exports = {
  id: '003-rename-agent-site-overrides-to-agent-site-rules',
  description: "Rename agent_site_overrides → agent_site_rules; site_policy_events source 'agent_override' → 'agent_rule'",
  AGENT_SITE_RULES_DDL,
  SITE_POLICY_EVENTS_DDL,
  SITE_POLICY_EVENTS_INDEX_DDL,
  up(db) {
    // ─── a. agent_site_overrides → agent_site_rules ────────────────────────
    if (tableExists(db, 'agent_site_overrides')) {
      if (!tableExists(db, 'agents')) {
        throw new Error('[migration] 003: agent_site_overrides exists but agents does not; aborting');
      }
      db.exec(AGENT_SITE_RULES_DDL);

      const eligible = db.prepare(
        'SELECT COUNT(*) AS c FROM agent_site_overrides o JOIN agents a ON a.id = o.agent_id'
      ).get().c;
      const orphanCount = db.prepare(
        `SELECT COUNT(*) AS c FROM agent_site_overrides o
         LEFT JOIN agents a ON a.id = o.agent_id WHERE a.id IS NULL`
      ).get().c;
      const orphanSample = db.prepare(
        `SELECT o.agent_id, o.domain FROM agent_site_overrides o
         LEFT JOIN agents a ON a.id = o.agent_id WHERE a.id IS NULL
         ORDER BY o.agent_id, o.domain LIMIT 10`
      ).all();
      warnOrphans('agent_site_overrides', orphanSample, orphanCount);

      // Rows already in agent_site_rules (restore-from-backup) win.
      db.exec(
        `INSERT OR IGNORE INTO agent_site_rules (agent_id, domain, decision, created_at)
         SELECT o.agent_id, o.domain, o.decision, o.created_at
         FROM agent_site_overrides o JOIN agents a ON a.id = o.agent_id`
      );

      // Verify every eligible old row landed before dropping.
      const missing = db.prepare(
        `SELECT COUNT(*) AS c FROM agent_site_overrides o JOIN agents a ON a.id = o.agent_id
         WHERE NOT EXISTS (
           SELECT 1 FROM agent_site_rules r WHERE r.agent_id = o.agent_id AND r.domain = o.domain
         )`
      ).get().c;
      if (missing > 0) {
        throw new Error(
          `[migration] 003 verification failed: ${missing} of ${eligible} agent_site_overrides row(s) ` +
          'missing from agent_site_rules; aborting (transaction rolled back, agent_site_overrides left intact)'
        );
      }

      db.exec('DROP TABLE agent_site_overrides');
      db.exec('DROP INDEX IF EXISTS idx_agent_overrides');
      console.log(
        `[migration] renamed agent_site_overrides → agent_site_rules: ${eligible} row(s) carried over, ` +
        `${orphanCount} orphan(s) skipped; old table dropped`
      );
    }

    // ─── b. site_policy_events source CHECK rewrite ────────────────────────
    const eventsHasOldCheck = tableExists(db, 'site_policy_events') && !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_policy_events' AND instr(sql, ?) > 0"
    ).get(OLD_SOURCE_TOKEN);
    if (eventsHasOldCheck) {
      if (tableExists(db, 'site_policy_events_old')) {
        throw new Error('[migration] 003: site_policy_events_old already exists; aborting (resolve by hand)');
      }
      if (!tableExists(db, 'agents')) {
        throw new Error('[migration] 003: site_policy_events exists but agents does not; aborting');
      }
      // Free the index names before the rename carries them to the old table.
      db.exec('DROP INDEX IF EXISTS idx_site_policy_events_last_seen');
      db.exec('DROP INDEX IF EXISTS idx_site_policy_events_agent_last_seen');
      db.exec('ALTER TABLE site_policy_events RENAME TO site_policy_events_old');
      db.exec(SITE_POLICY_EVENTS_DDL);

      const eligible = db.prepare(
        'SELECT COUNT(*) AS c FROM site_policy_events_old e JOIN agents a ON a.id = e.agent_id'
      ).get().c;
      const orphanCount = db.prepare(
        `SELECT COUNT(*) AS c FROM site_policy_events_old e
         LEFT JOIN agents a ON a.id = e.agent_id WHERE a.id IS NULL`
      ).get().c;
      const orphanSample = db.prepare(
        `SELECT e.agent_id, e.domain FROM site_policy_events_old e
         LEFT JOIN agents a ON a.id = e.agent_id WHERE a.id IS NULL
         ORDER BY e.agent_id, e.domain LIMIT 10`
      ).all();
      warnOrphans('site_policy_events', orphanSample, orphanCount);

      db.exec(
        `INSERT INTO site_policy_events
           (id, agent_id, domain, decision, source, matched_domain,
            first_seen_at, last_seen_at, decision_changed_at, hit_count)
         SELECT e.id, e.agent_id, e.domain, e.decision,
                CASE e.source WHEN 'agent_override' THEN 'agent_rule' ELSE e.source END,
                e.matched_domain, e.first_seen_at, e.last_seen_at, e.decision_changed_at, e.hit_count
         FROM site_policy_events_old e JOIN agents a ON a.id = e.agent_id`
      );

      const copied = db.prepare('SELECT COUNT(*) AS c FROM site_policy_events').get().c;
      if (copied !== eligible) {
        throw new Error(
          `[migration] 003 verification failed: copied ${copied} of ${eligible} site_policy_events row(s); ` +
          'aborting (transaction rolled back, site_policy_events left intact)'
        );
      }

      db.exec('DROP TABLE site_policy_events_old');
      for (const ddl of SITE_POLICY_EVENTS_INDEX_DDL) db.exec(ddl);
      console.log(
        `[migration] rebuilt site_policy_events with source 'agent_rule': ${copied} row(s) carried over, ` +
        `${orphanCount} orphan(s) skipped`
      );
    }
  },
};
