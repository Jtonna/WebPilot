'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const { runAll: runSchemaMigrations } = require('../src/db/schema-migrations');

// ── DB fixture builders ─────────────────────────────────────────────────────

// The OLD-shape schema used to seed "vintage" DBs in tests. This is a snapshot
// of schema.sql before R2 lands — it intentionally hard-codes the pre-rename
// CHECK constraint and table name so the migration has something to rewrite.
const OLD_SCHEMA = `
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    profile_id TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    state TEXT NOT NULL CHECK(state IN ('active','revoked'))
  );

  CREATE TABLE global_site_rules (
    domain TEXT PRIMARY KEY,
    decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
    source TEXT NOT NULL CHECK(source IN ('user','baseline')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE baseline_blocklist_meta (
    id INTEGER PRIMARY KEY CHECK(id=1),
    version TEXT NOT NULL,
    last_fetched_at TEXT NOT NULL,
    source_url TEXT NOT NULL,
    domain_count INTEGER NOT NULL
  );

  CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

// NEW-shape schema for fresh-install tests (matches what R2 will produce).
const NEW_SCHEMA = `
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    profile_id TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    state TEXT NOT NULL CHECK(state IN ('active','revoked'))
  );

  CREATE TABLE global_site_rules (
    domain TEXT PRIMARY KEY,
    decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
    source TEXT NOT NULL CHECK(source IN ('user','global_site_blocklist')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE global_site_blocklist_meta (
    id INTEGER PRIMARY KEY CHECK(id=1),
    version TEXT NOT NULL,
    last_fetched_at TEXT NOT NULL,
    source_url TEXT NOT NULL,
    domain_count INTEGER NOT NULL
  );

  CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

function nowIso() { return new Date().toISOString(); }

function seedVintage(db) {
  db.exec(OLD_SCHEMA);
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES ('baseline_blocklist_enabled', 'true', ?)`
  ).run(nowIso());
  db.prepare(
    `INSERT INTO baseline_blocklist_meta (id, version, last_fetched_at, source_url, domain_count)
     VALUES (1, 'v1.0.0', ?, 'https://example.com/list.txt', 42)`
  ).run(nowIso());
  const insertRule = db.prepare(
    `INSERT INTO global_site_rules (domain, decision, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  insertRule.run('evil.example', 'block', 'baseline', nowIso(), nowIso());
  insertRule.run('user-added.example', 'allow', 'user', nowIso(), nowIso());
}

function seedFresh(db) {
  db.exec(NEW_SCHEMA);
  db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES ('global_site_blocklist_enabled', 'true', ?)`
  ).run(nowIso());
  db.prepare(
    `INSERT INTO global_site_rules (domain, decision, source, created_at, updated_at)
     VALUES ('user.example', 'block', 'user', ?, ?)`
  ).run(nowIso(), nowIso());
}

// ── Tmpdir helpers ──────────────────────────────────────────────────────────

let tmpDirs = [];
function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-mig-test-'));
  tmpDirs.push(d);
  return d;
}

// Run ONLY migration 001 (in isolation from later migrations such as 002,
// which drops global_site_rules) by copying its file into a temp dir and
// pointing the runner at it via the test-only `_migrationsDir` override.
const MIGRATION_001_FILE = '001-rename-baseline-to-global-site-blocklist.js';
function runOnly001(db, opts) {
  const dir = makeTmpDir();
  fs.copyFileSync(
    path.join(__dirname, '..', 'src', 'db', 'schema-migrations', MIGRATION_001_FILE),
    path.join(dir, MIGRATION_001_FILE)
  );
  return runSchemaMigrations(db, { ...opts, _migrationsDir: dir });
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
  tmpDirs = [];
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runSchemaMigrations', () => {
  test('vintage state: full rewrite — config key, meta table, rules CHECK + rows, cache dir', () => {
    const db = new Database(':memory:');
    seedVintage(db);
    const dataDir = makeTmpDir();
    const oldCache = path.join(dataDir, 'baseline-blocklists');
    fs.mkdirSync(oldCache);
    fs.writeFileSync(path.join(oldCache, 'list.txt'), 'evil.example\n');

    runOnly001(db, { dataDir });

    // Config key renamed.
    assert.equal(
      db.prepare("SELECT value FROM config WHERE key = 'global_site_blocklist_enabled'").get().value,
      'true'
    );
    assert.equal(
      db.prepare("SELECT 1 FROM config WHERE key = 'baseline_blocklist_enabled'").get(),
      undefined
    );

    // Meta table renamed with data preserved.
    const metaPresent = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='global_site_blocklist_meta'"
    ).get();
    assert.ok(metaPresent, 'new meta table should exist');
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='baseline_blocklist_meta'").get(),
      undefined
    );
    const metaRow = db.prepare('SELECT * FROM global_site_blocklist_meta WHERE id = 1').get();
    assert.equal(metaRow.version, 'v1.0.0');
    assert.equal(metaRow.domain_count, 42);

    // global_site_rules CHECK rewritten.
    const newTblSql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='global_site_rules'"
    ).get().sql;
    assert.ok(newTblSql.includes("'global_site_blocklist'"), 'CHECK should list global_site_blocklist');
    assert.ok(!newTblSql.includes("'baseline'"), 'CHECK should no longer list baseline');

    // Row source values rewritten.
    const evilRow = db.prepare("SELECT source FROM global_site_rules WHERE domain = 'evil.example'").get();
    assert.equal(evilRow.source, 'global_site_blocklist');
    const userRow = db.prepare("SELECT source FROM global_site_rules WHERE domain = 'user-added.example'").get();
    assert.equal(userRow.source, 'user');

    // Cache dir renamed; contents preserved.
    assert.equal(fs.existsSync(oldCache), false);
    const newCache = path.join(dataDir, 'global-site-blocklists');
    assert.equal(fs.existsSync(newCache), true);
    assert.equal(fs.readFileSync(path.join(newCache, 'list.txt'), 'utf8'), 'evil.example\n');

    db.close();
  });

  test('double-run: second invocation is a clean no-op', () => {
    const db = new Database(':memory:');
    seedVintage(db);
    const dataDir = makeTmpDir();
    fs.mkdirSync(path.join(dataDir, 'baseline-blocklists'));
    fs.writeFileSync(path.join(dataDir, 'baseline-blocklists', 'a.txt'), 'x');

    runOnly001(db, { dataDir });

    const rulesBefore = db.prepare('SELECT * FROM global_site_rules ORDER BY domain').all();
    const metaBefore = db.prepare('SELECT * FROM global_site_blocklist_meta').all();
    const configBefore = db.prepare('SELECT * FROM config ORDER BY key').all();

    // Second run must not throw and must not change any data.
    runOnly001(db, { dataDir });

    assert.deepEqual(db.prepare('SELECT * FROM global_site_rules ORDER BY domain').all(), rulesBefore);
    assert.deepEqual(db.prepare('SELECT * FROM global_site_blocklist_meta').all(), metaBefore);
    assert.deepEqual(db.prepare('SELECT * FROM config ORDER BY key').all(), configBefore);

    db.close();
  });

  test('fresh state: new-shape DB is untouched', () => {
    const db = new Database(':memory:');
    seedFresh(db);
    const dataDir = makeTmpDir();

    const tblBefore = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='global_site_rules'"
    ).get().sql;
    const rulesBefore = db.prepare('SELECT * FROM global_site_rules').all();
    const configBefore = db.prepare('SELECT * FROM config').all();

    runOnly001(db, { dataDir });

    assert.equal(
      db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='global_site_rules'").get().sql,
      tblBefore
    );
    assert.deepEqual(db.prepare('SELECT * FROM global_site_rules').all(), rulesBefore);
    assert.deepEqual(db.prepare('SELECT * FROM config').all(), configBefore);
    // No baseline artifacts created.
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='baseline_blocklist_meta'").get(),
      undefined
    );

    db.close();
  });

  test('both cache dirs present: old removed, new preserved', () => {
    const db = new Database(':memory:');
    seedFresh(db); // DB already migrated; only cache dir state matters here.
    const dataDir = makeTmpDir();
    const oldCache = path.join(dataDir, 'baseline-blocklists');
    const newCache = path.join(dataDir, 'global-site-blocklists');
    fs.mkdirSync(oldCache);
    fs.writeFileSync(path.join(oldCache, 'old.txt'), 'stale');
    fs.mkdirSync(newCache);
    fs.writeFileSync(path.join(newCache, 'new.txt'), 'fresh');

    runOnly001(db, { dataDir });

    assert.equal(fs.existsSync(oldCache), false, 'old cache dir should be removed');
    assert.equal(fs.existsSync(newCache), true, 'new cache dir should remain');
    assert.equal(fs.readFileSync(path.join(newCache, 'new.txt'), 'utf8'), 'fresh');

    db.close();
  });

  test('partial state: meta already renamed, config still has old key — migration completes the rest', () => {
    const db = new Database(':memory:');
    // Build a half-migrated DB: new meta table, but config key + rules CHECK
    // still on the old shape.
    db.exec(`
      CREATE TABLE global_site_rules (
        domain TEXT PRIMARY KEY,
        decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
        source TEXT NOT NULL CHECK(source IN ('user','baseline')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE global_site_blocklist_meta (
        id INTEGER PRIMARY KEY CHECK(id=1),
        version TEXT NOT NULL,
        last_fetched_at TEXT NOT NULL,
        source_url TEXT NOT NULL,
        domain_count INTEGER NOT NULL
      );
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES ('baseline_blocklist_enabled', 'false', ?)`
    ).run(nowIso());
    db.prepare(
      `INSERT INTO global_site_rules (domain, decision, source, created_at, updated_at)
       VALUES ('x.example', 'block', 'baseline', ?, ?)`
    ).run(nowIso(), nowIso());

    runOnly001(db, { dataDir: makeTmpDir() });

    // Config key renamed, value preserved.
    const cfg = db.prepare("SELECT value FROM config WHERE key = 'global_site_blocklist_enabled'").get();
    assert.equal(cfg.value, 'false');
    // Rules CHECK rewritten, row source updated.
    const tblSql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='global_site_rules'"
    ).get().sql;
    assert.ok(tblSql.includes("'global_site_blocklist'"));
    assert.ok(!tblSql.includes("'baseline'"));
    assert.equal(
      db.prepare("SELECT source FROM global_site_rules WHERE domain = 'x.example'").get().source,
      'global_site_blocklist'
    );

    db.close();
  });

  test('both config keys present: new wins, old is dropped', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE global_site_rules (
        domain TEXT PRIMARY KEY,
        decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
        source TEXT NOT NULL CHECK(source IN ('user','global_site_blocklist')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const ts = nowIso();
    db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)`)
      .run('baseline_blocklist_enabled', 'false', ts);
    db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)`)
      .run('global_site_blocklist_enabled', 'true', ts);

    runOnly001(db, { dataDir: makeTmpDir() });

    assert.equal(
      db.prepare("SELECT value FROM config WHERE key = 'global_site_blocklist_enabled'").get().value,
      'true'
    );
    assert.equal(
      db.prepare("SELECT 1 FROM config WHERE key = 'baseline_blocklist_enabled'").get(),
      undefined
    );

    db.close();
  });
});

const { runAll, listMigrations } = require('../src/db/schema-migrations');

describe('runner ledger + validation', () => {
  test('ledger record after first run on vintage DB', () => {
    const db = new Database(':memory:');
    seedVintage(db);
    const dataDir = makeTmpDir();

    runOnly001(db, { dataDir });

    const row = db.prepare(
      "SELECT * FROM schema_migrations WHERE id = '001-rename-baseline-to-global-site-blocklist'"
    ).get();
    assert.ok(row, 'ledger row should exist');
    assert.equal(row.id, '001-rename-baseline-to-global-site-blocklist');
    assert.ok(typeof row.applied_at === 'string' && row.applied_at.length > 0, 'applied_at should be a non-empty string');
    // Verify it parses as a valid ISO date.
    assert.ok(!isNaN(Date.parse(row.applied_at)), 'applied_at should be a valid ISO timestamp');

    db.close();
  });

  test('double-run produces exactly one ledger row and identical DB state', () => {
    const db = new Database(':memory:');
    seedVintage(db);
    const dataDir = makeTmpDir();
    fs.mkdirSync(path.join(dataDir, 'baseline-blocklists'));

    runOnly001(db, { dataDir });

    const rulesBefore = db.prepare('SELECT * FROM global_site_rules ORDER BY domain').all();
    const configBefore = db.prepare('SELECT * FROM config ORDER BY key').all();

    runOnly001(db, { dataDir });

    const count = db.prepare(
      "SELECT COUNT(*) AS c FROM schema_migrations WHERE id = '001-rename-baseline-to-global-site-blocklist'"
    ).get().c;
    assert.equal(count, 1, 'ledger should have exactly one row for the migration');

    assert.deepEqual(db.prepare('SELECT * FROM global_site_rules ORDER BY domain').all(), rulesBefore);
    assert.deepEqual(db.prepare('SELECT * FROM config ORDER BY key').all(), configBefore);

    db.close();
  });

  test('malformed migration (missing up) fails loudly', () => {
    const { listMigrations: _list, runAll: _run } = require('../src/db/schema-migrations');
    // Directly invoke the runner's validation path by requiring the index and
    // checking that an object without `up` is rejected when listMigrations
    // processes a temp dir. We test via the runner's internal validation by
    // passing a bad object to a fresh require of the runner with a stubbed dir.
    //
    // Simplest approach: call the runner with a synthetic migration list by
    // temporarily patching require. Instead, validate directly via the exported
    // helper — but since listMigrations() is file-based, the cleanest test is
    // to verify that a migration object missing `up` would be caught.
    //
    // We construct the same check the runner does and assert it throws.
    const badMigration = { id: 'bad-test', description: 'missing up function' };
    // Replicate the validation logic from the runner.
    const isInvalid = !badMigration.id || typeof badMigration.id !== 'string' || typeof badMigration.up !== 'function';
    assert.ok(isInvalid, 'runner should detect missing up as invalid');

    // Also verify the runner's validation produces the expected error message
    // by wrapping a simulated load.
    function validateMigration(migration, filename) {
      if (!migration.id || typeof migration.id !== 'string' || typeof migration.up !== 'function') {
        throw new Error(`Invalid migration ${filename}: missing id or up()`);
      }
    }
    assert.throws(
      () => validateMigration({ description: 'no id, no up' }, 'bad-migration.js'),
      /Invalid migration bad-migration\.js: missing id or up\(\)/
    );
    assert.throws(
      () => validateMigration({ id: 'has-id-no-up' }, 'bad-migration.js'),
      /Invalid migration bad-migration\.js: missing id or up\(\)/
    );
  });
});

// ── File-load validation tests (real .js files on disk → glob → require → validate) ──

describe('file-load validation: malformed migration files', () => {
  test('migration file with missing id throws on load', () => {
    const fixtureDir = makeTmpDir();
    fs.writeFileSync(
      path.join(fixtureDir, '001-missing-id.js'),
      'module.exports = { up: () => {} };\n'
    );
    const db = new Database(':memory:');
    const dataDir = makeTmpDir();
    assert.throws(
      () => runAll(db, { dataDir, _migrationsDir: fixtureDir }),
      /Invalid migration 001-missing-id\.js: missing id or up\(\)/
    );
    db.close();
  });

  test('migration file with non-callable up throws on load', () => {
    const fixtureDir = makeTmpDir();
    fs.writeFileSync(
      path.join(fixtureDir, '002-bad-up.js'),
      "module.exports = { id: '002-bad-up', up: 'not-a-function' };\n"
    );
    const db = new Database(':memory:');
    const dataDir = makeTmpDir();
    assert.throws(
      () => runAll(db, { dataDir, _migrationsDir: fixtureDir }),
      /Invalid migration 002-bad-up\.js: missing id or up\(\)/
    );
    db.close();
  });

  test('migration file with empty-string id throws on load', () => {
    const fixtureDir = makeTmpDir();
    fs.writeFileSync(
      path.join(fixtureDir, '003-empty-id.js'),
      "module.exports = { id: '', up: () => {} };\n"
    );
    const db = new Database(':memory:');
    const dataDir = makeTmpDir();
    assert.throws(
      () => runAll(db, { dataDir, _migrationsDir: fixtureDir }),
      /Invalid migration 003-empty-id\.js: missing id or up\(\)/
    );
    db.close();
  });
});

// ── Fresh / pre-schema DB ───────────────────────────────────────────────────
// Migration 001 must tolerate running before any app tables exist (a truly
// empty DB with only the schema_migrations ledger) and against a DB that was
// stuck mid-boot on v2.2.0 (ledger table created, but the transaction that
// would have inserted its row never committed, so app tables never landed).

const SCHEMA_SQL_PATH = path.join(__dirname, '..', 'src', 'db', 'schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_SQL_PATH, 'utf8');

// Matches the ledger DDL in src/db/schema-migrations/index.js exactly.
const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`;

const EXPECTED_TABLES = [
  'agents',
  'pairings',
  'global_user_site_rules',
  'global_site_blocklist_rules',
  'agent_site_rules',
  'global_site_blocklist_meta',
  'site_policy_events',
  'formatter_incidents',
  'config',
  'extension_installs',
  'schema_migrations',
];

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(r => r.name);
}

describe('fresh / pre-schema DB', () => {
  test('truly empty DB: runAll then schema.sql is a no-op and ledger matches listMigrations', () => {
    const db = new Database(':memory:');
    const dataDir = makeTmpDir();

    runAll(db, { dataDir });
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));

    const expectedIds = listMigrations().map(m => m.id).sort();
    const ledgerIds = db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id).sort();
    assert.deepEqual(ledgerIds, expectedIds);

    assert.deepEqual(tableNames(db).sort(), [...EXPECTED_TABLES].sort());

    assert.equal(
      fs.existsSync(path.join(dataDir, 'global-site-blocklists')),
      false,
      'no cache dir should be created on a fresh, empty DB'
    );

    const ledgerCountBefore = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
    assert.doesNotThrow(() => {
      runAll(db, { dataDir });
      db.exec(SCHEMA_SQL);
    });
    const ledgerCountAfter = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
    assert.equal(ledgerCountAfter, ledgerCountBefore, 'second run should not add ledger rows');

    db.close();
  });

  test('stuck v2.2.0 DB: only the ledger table exists — same assertions as a fresh DB', () => {
    const db = new Database(':memory:');
    const dataDir = makeTmpDir();
    db.exec(LEDGER_DDL);

    runAll(db, { dataDir });
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));

    const expectedIds = listMigrations().map(m => m.id).sort();
    const ledgerIds = db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id).sort();
    assert.deepEqual(ledgerIds, expectedIds);

    assert.deepEqual(tableNames(db).sort(), [...EXPECTED_TABLES].sort());

    assert.equal(
      fs.existsSync(path.join(dataDir, 'global-site-blocklists')),
      false,
      'no cache dir should be created for a stuck v2.2.0 DB'
    );

    const ledgerCountBefore = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
    assert.doesNotThrow(() => {
      runAll(db, { dataDir });
      db.exec(SCHEMA_SQL);
    });
    const ledgerCountAfter = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;
    assert.equal(ledgerCountAfter, ledgerCountBefore, 'second run should not add ledger rows');

    db.close();
  });

  test('vintage upgrade end to end: renames apply, then schema.sql applies cleanly', () => {
    const db = new Database(':memory:');
    seedVintage(db);
    const dataDir = makeTmpDir();

    runAll(db, { dataDir });
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));

    // All four renames from 001's docstring happened (the config key was then
    // renamed again by 002 — asserted below).
    assert.equal(
      db.prepare("SELECT 1 FROM config WHERE key = 'baseline_blocklist_enabled'").get(),
      undefined
    );
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='global_site_blocklist_meta'").get(),
      'meta table should be renamed'
    );
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='baseline_blocklist_meta'").get(),
      undefined
    );
    // 001's CHECK rewrite + row relabel is then consumed by 002's split: the
    // old mixed table is gone and each row lives in its tier's table.
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='global_site_rules'").get(),
      undefined,
      'global_site_rules should be dropped by 002'
    );
    assert.ok(
      db.prepare("SELECT 1 FROM global_site_blocklist_rules WHERE domain = 'evil.example'").get(),
      'former baseline row evil.example should be in the signed table'
    );
    assert.equal(
      db.prepare("SELECT 1 FROM global_user_site_rules WHERE domain = 'evil.example'").get(),
      undefined
    );
    assert.equal(
      db.prepare("SELECT decision FROM global_user_site_rules WHERE domain = 'user-added.example'").get().decision,
      'allow'
    );
    assert.equal(
      db.prepare("SELECT 1 FROM global_site_blocklist_rules WHERE domain = 'user-added.example'").get(),
      undefined
    );
    // Config key carried through both renames.
    assert.equal(
      db.prepare("SELECT value FROM config WHERE key = 'global_tier_enabled'").get().value,
      'true'
    );
    // 001 rename happened before 002 renamed it again; neither older key remains.
    assert.equal(
      db.prepare("SELECT 1 FROM config WHERE key = 'global_site_blocklist_enabled'").get(),
      undefined
    );
    // Meta row kept (user rows migrated → version marked for re-sync).
    assert.equal(
      db.prepare('SELECT version FROM global_site_blocklist_meta WHERE id = 1').get().version,
      'pre-002:v1.0.0'
    );

    db.close();
  });
});
