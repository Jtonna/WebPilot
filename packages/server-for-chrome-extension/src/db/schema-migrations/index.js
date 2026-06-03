'use strict';

/**
 * Schema-migration runner.
 *
 * Ordering: migrations apply in lexical filename order. The 3-digit numeric
 * prefix (e.g. 001-, 002-) is the convention — lexical sort is correct up to
 * 999; past that the sort would break (e.g. "1000-" < "002-" lexically).
 *
 * Safe to call before `_db.exec(schemaSql)` in connection.js because the
 * runner only touches its own `schema_migrations` ledger table and the
 * individual migrations are guarded against pre-schema state.
 *
 * Each `up()` runs inside its own transaction managed by this runner. Do not
 * open an outer transaction in `up()` unless you have a specific reason — a
 * nested savepoint is fine for sub-steps.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_FILE_RE = /^\d{3}-.*\.js$/;

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`;

function ensureLedger(db) {
  db.exec(LEDGER_DDL);
}

function listMigrations() {
  const dir = __dirname;
  return fs
    .readdirSync(dir)
    .filter(f => MIGRATION_FILE_RE.test(f))
    .sort()
    .map(filename => {
      const migration = require(path.join(dir, filename));
      if (!migration.id || typeof migration.id !== 'string' || typeof migration.up !== 'function') {
        throw new Error(`Invalid migration ${filename}: missing id or up()`);
      }
      return { filename, id: migration.id, description: migration.description || '', up: migration.up };
    });
}

function runAll(db, opts) {
  ensureLedger(db);
  const migrations = listMigrations();
  for (const { id, description, up } of migrations) {
    const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id);
    if (already) continue;
    console.log(`[migration] applying ${id}: ${description}`);
    db.transaction(() => {
      up(db, opts);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, new Date().toISOString());
    })();
    console.log(`[migration] applied ${id}`);
  }
}

module.exports = { runAll, listMigrations };
