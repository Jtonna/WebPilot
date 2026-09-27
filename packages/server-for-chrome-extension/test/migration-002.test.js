'use strict';

// Unit coverage for schema migration 002-split-site-rules-per-tier.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const { runAll, listMigrations } = require('../src/db/schema-migrations');
const migration002 = require('../src/db/schema-migrations/002-split-site-rules-per-tier');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
const ID_001 = '001-rename-baseline-to-global-site-blocklist';
const ID_002 = '002-split-site-rules-per-tier';

// ── Fixtures ────────────────────────────────────────────────────────────────

// Post-001 shape: what an install that already ran 001 (but not 002) holds.
const POST_001_SCHEMA = `
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

// Pre-001 ("vintage") shape.
const VINTAGE_SCHEMA = `
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

const T1 = '2025-01-01T00:00:00.000Z';
const T2 = '2025-02-02T00:00:00.000Z';

function insertRule(db, domain, decision, source, createdAt = T1, updatedAt = T2) {
  db.prepare(
    `INSERT INTO global_site_rules (domain, decision, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(domain, decision, source, createdAt, updatedAt);
}

function setConfig(db, key, value) {
  db.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, T1);
}

function setMeta(db, version, table = 'global_site_blocklist_meta') {
  db.prepare(
    `INSERT INTO ${table} (id, version, last_fetched_at, source_url, domain_count)
     VALUES (1, ?, ?, 'https://example.com/manifest.json', 3)`
  ).run(version, T1);
}

// Post-001 DB with 001 already recorded in the ledger, so runAll only applies 002.
function seedPost001(db) {
  db.exec(POST_001_SCHEMA);
  runAll(db, { _migrationsDir: emptyMigrationsDir() }); // creates the ledger only
  db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(ID_001, T1);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function tableSql(db, name) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  return row ? row.sql : undefined;
}

function dump(db) {
  const out = {};
  for (const { name } of db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name != 'schema_migrations' ORDER BY name"
  ).all()) {
    out[name] = db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all();
  }
  return out;
}

// Captures console.warn output during fn().
function captureWarn(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try { fn(); } finally { console.warn = orig; }
  return warnings;
}

// ── Tmpdir helpers ──────────────────────────────────────────────────────────

let tmpDirs = [];
function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-mig002-test-'));
  tmpDirs.push(d);
  return d;
}
function emptyMigrationsDir() {
  return makeTmpDir();
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
  tmpDirs = [];
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('migration 002: split global_site_rules per tier', () => {
  test('is discovered by the runner after 001', () => {
    const ids = listMigrations().map(m => m.id);
    assert.ok(ids.indexOf(ID_002) > ids.indexOf(ID_001) && ids.indexOf(ID_001) >= 0);
  });

  test('DDL in the migration matches schema.sql exactly', () => {
    const fromSchema = new Database(':memory:');
    fromSchema.exec(SCHEMA_SQL);
    const fromMigration = new Database(':memory:');
    fromMigration.exec(POST_001_SCHEMA);
    migration002.up(fromMigration);
    for (const t of ['global_user_site_rules', 'global_site_blocklist_rules']) {
      assert.ok(tableSql(fromSchema, t), `schema.sql should create ${t}`);
      assert.equal(tableSql(fromMigration, t), tableSql(fromSchema, t), `${t} DDL drift`);
    }
    assert.equal(tableExists(fromSchema, 'global_site_rules'), false, 'schema.sql must not create global_site_rules');
    fromSchema.close();
    fromMigration.close();
  });

  test('post-001 DB with mixed rows splits correctly', () => {
    const db = new Database(':memory:');
    seedPost001(db);
    setConfig(db, 'global_site_blocklist_enabled', 'true');
    setMeta(db, 'v7');
    insertRule(db, 'mine-allow.example', 'allow', 'user', T1, T2);
    insertRule(db, 'mine-block.example', 'block', 'user', T2, T2);
    insertRule(db, 'bad.example', 'block', 'global_site_blocklist', T1, T1);
    insertRule(db, 'worse.example', 'block', 'global_site_blocklist', T2, T2);
    insertRule(db, 'worst.example', 'block', 'global_site_blocklist', T1, T2);

    runAll(db, {});

    assert.equal(tableExists(db, 'global_site_rules'), false, 'old table should be dropped');
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(ID_002), 'ledger row');

    assert.deepEqual(
      db.prepare('SELECT * FROM global_user_site_rules ORDER BY domain').all(),
      [
        { domain: 'mine-allow.example', decision: 'allow', created_at: T1, updated_at: T2 },
        { domain: 'mine-block.example', decision: 'block', created_at: T2, updated_at: T2 },
      ]
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM global_site_blocklist_rules ORDER BY domain').all(),
      [
        { domain: 'bad.example', created_at: T1 },
        { domain: 'worse.example', created_at: T2 },
        { domain: 'worst.example', created_at: T1 },
      ]
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM global_user_site_rules').get().c, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM global_site_blocklist_rules').get().c, 3);

    // Config key renamed, value preserved.
    assert.equal(db.prepare("SELECT value FROM config WHERE key = 'global_tier_enabled'").get().value, 'true');
    assert.equal(db.prepare("SELECT 1 FROM config WHERE key = 'global_site_blocklist_enabled'").get(), undefined);

    // schema.sql then applies cleanly on top.
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));
    db.close();
  });

  test('user rows migrated → meta version prefixed with pre-002: (row kept)', () => {
    const db = new Database(':memory:');
    seedPost001(db);
    setMeta(db, '2025.09.01');
    insertRule(db, 'mine.example', 'block', 'user');
    insertRule(db, 'bad.example', 'block', 'global_site_blocklist');

    runAll(db, {});

    const meta = db.prepare('SELECT * FROM global_site_blocklist_meta WHERE id = 1').get();
    assert.ok(meta, 'meta row must not be deleted');
    assert.equal(meta.version, 'pre-002:2025.09.01');
    assert.equal(meta.domain_count, 3);

    // Re-running up() directly must not double-prefix.
    migration002.up(db);
    assert.equal(
      db.prepare('SELECT version FROM global_site_blocklist_meta WHERE id = 1').get().version,
      'pre-002:2025.09.01'
    );
    db.close();
  });

  test('no user rows → meta version unchanged', () => {
    const db = new Database(':memory:');
    seedPost001(db);
    setMeta(db, 'v3');
    insertRule(db, 'bad.example', 'block', 'global_site_blocklist');

    runAll(db, {});

    assert.equal(db.prepare('SELECT version FROM global_site_blocklist_meta WHERE id = 1').get().version, 'v3');
    db.close();
  });

  test('user rows but no meta row → no error, nothing created', () => {
    const db = new Database(':memory:');
    seedPost001(db);
    insertRule(db, 'mine.example', 'allow', 'user');

    assert.doesNotThrow(() => runAll(db, {}));
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM global_site_blocklist_meta').get().c, 0);
    db.close();
  });

  test("wildcard and signed-allow rows are skipped with a warning, not an error", () => {
    const db = new Database(':memory:');
    seedPost001(db);
    insertRule(db, '*', 'block', 'user');
    insertRule(db, '*.wild.example', 'allow', 'user');
    insertRule(db, '*.sig.example', 'block', 'global_site_blocklist');
    insertRule(db, 'signed-allow.example', 'allow', 'global_site_blocklist');
    insertRule(db, 'ok-user.example', 'allow', 'user');
    insertRule(db, 'ok-signed.example', 'block', 'global_site_blocklist');

    let warnings;
    assert.doesNotThrow(() => { warnings = captureWarn(() => runAll(db, {})); });

    assert.deepEqual(
      db.prepare('SELECT domain FROM global_user_site_rules ORDER BY domain').all().map(r => r.domain),
      ['ok-user.example']
    );
    assert.deepEqual(
      db.prepare('SELECT domain FROM global_site_blocklist_rules ORDER BY domain').all().map(r => r.domain),
      ['ok-signed.example']
    );
    assert.equal(tableExists(db, 'global_site_rules'), false);
    const skipWarn = warnings.find(w => w.includes('skipped 4'));
    assert.ok(skipWarn, `expected a "skipped 4" warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(skipWarn.includes('signed-allow.example'));
    db.close();
  });

  test("toggle 'false' with user rows → warns, value kept", () => {
    const db = new Database(':memory:');
    seedPost001(db);
    setConfig(db, 'global_site_blocklist_enabled', 'false');
    insertRule(db, 'mine.example', 'block', 'user');

    const warnings = captureWarn(() => runAll(db, {}));

    assert.equal(db.prepare("SELECT value FROM config WHERE key = 'global_tier_enabled'").get().value, 'false');
    assert.ok(
      warnings.some(w => w.includes('global_tier_enabled') && w.includes('inactive')),
      `expected an inactive-tier warning, got: ${JSON.stringify(warnings)}`
    );
    db.close();
  });

  test('both config keys present → new key wins, old removed', () => {
    const db = new Database(':memory:');
    seedPost001(db);
    setConfig(db, 'global_site_blocklist_enabled', 'false');
    setConfig(db, 'global_tier_enabled', 'true');

    runAll(db, {});

    assert.equal(db.prepare("SELECT value FROM config WHERE key = 'global_tier_enabled'").get().value, 'true');
    assert.equal(db.prepare("SELECT 1 FROM config WHERE key = 'global_site_blocklist_enabled'").get(), undefined);
    db.close();
  });

  test('second runAll is a no-op; calling up() twice directly is a no-op', () => {
    const db = new Database(':memory:');
    seedPost001(db);
    setConfig(db, 'global_site_blocklist_enabled', 'true');
    setMeta(db, 'v1');
    insertRule(db, 'mine.example', 'allow', 'user');
    insertRule(db, 'bad.example', 'block', 'global_site_blocklist');

    runAll(db, {});
    const after1 = dump(db);
    const ledger1 = db.prepare('SELECT * FROM schema_migrations ORDER BY id').all();

    runAll(db, {});
    assert.deepEqual(dump(db), after1);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY id').all(), ledger1);

    // Bypass the ledger (restore-from-backup scenario): in-body guards must hold.
    assert.doesNotThrow(() => { migration002.up(db); migration002.up(db); });
    assert.deepEqual(dump(db), after1);
    db.close();
  });

  test('up() twice directly on a post-001 DB (no runner) is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(POST_001_SCHEMA);
    setMeta(db, 'v1');
    insertRule(db, 'mine.example', 'allow', 'user');
    insertRule(db, 'bad.example', 'block', 'global_site_blocklist');

    migration002.up(db);
    const after1 = dump(db);
    migration002.up(db);
    assert.deepEqual(dump(db), after1);
    assert.equal(after1.global_site_blocklist_meta[0].version, 'pre-002:v1');
    db.close();
  });

  test('truly empty DB is a no-op and schema.sql then applies cleanly', () => {
    const db = new Database(':memory:');

    assert.doesNotThrow(() => migration002.up(db));
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      [],
      'up() on an empty DB must create nothing'
    );

    runAll(db, { dataDir: makeTmpDir() });
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(ID_002));
    assert.ok(tableExists(db, 'global_user_site_rules'));
    assert.ok(tableExists(db, 'global_site_blocklist_rules'));
    assert.equal(tableExists(db, 'global_site_rules'), false);
    db.close();
  });

  test("vintage 'baseline' DB goes through 001 then 002 end to end", () => {
    const db = new Database(':memory:');
    db.exec(VINTAGE_SCHEMA);
    setConfig(db, 'baseline_blocklist_enabled', 'true');
    setMeta(db, 'v1.0.0', 'baseline_blocklist_meta');
    insertRule(db, 'evil.example', 'block', 'baseline', T1, T1);
    insertRule(db, 'user-added.example', 'allow', 'user', T1, T2);

    runAll(db, { dataDir: makeTmpDir() });
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));

    const ledger = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(r => r.id);
    assert.deepEqual(ledger, [ID_001, ID_002]);
    assert.equal(tableExists(db, 'global_site_rules'), false);
    assert.equal(tableExists(db, 'baseline_blocklist_meta'), false);
    assert.deepEqual(
      db.prepare('SELECT * FROM global_site_blocklist_rules').all(),
      [{ domain: 'evil.example', created_at: T1 }]
    );
    assert.deepEqual(
      db.prepare('SELECT * FROM global_user_site_rules').all(),
      [{ domain: 'user-added.example', decision: 'allow', created_at: T1, updated_at: T2 }]
    );
    assert.deepEqual(
      db.prepare('SELECT key, value FROM config ORDER BY key').all(),
      [{ key: 'global_tier_enabled', value: 'true' }]
    );
    assert.equal(
      db.prepare('SELECT version FROM global_site_blocklist_meta WHERE id = 1').get().version,
      'pre-002:v1.0.0'
    );
    db.close();
  });

  test('new tables reject wildcard domains', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    assert.throws(
      () => db.prepare("INSERT INTO global_user_site_rules VALUES ('*.x.example', 'block', ?, ?)").run(T1, T1),
      /CHECK constraint failed/
    );
    assert.throws(
      () => db.prepare("INSERT INTO global_site_blocklist_rules VALUES ('*', ?)").run(T1),
      /CHECK constraint failed/
    );
    // agent_site_overrides.domain may be the literal '*'.
    db.exec(`INSERT INTO agents (id, name, api_key_hash, created_at, state) VALUES (1, 'a', 'h', '${T1}', 'active')`);
    assert.doesNotThrow(() =>
      db.prepare("INSERT INTO agent_site_overrides (agent_id, domain, decision, created_at) VALUES (1, '*', 'block', ?)").run(T1)
    );
    db.close();
  });
});
