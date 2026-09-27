'use strict';

// Unit coverage for schema migration 003-rename-agent-site-overrides-to-agent-site-rules.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const { runAll, listMigrations } = require('../src/db/schema-migrations');
const migration003 = require('../src/db/schema-migrations/003-rename-agent-site-overrides-to-agent-site-rules');

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
const ID_001 = '001-rename-baseline-to-global-site-blocklist';
const ID_002 = '002-split-site-rules-per-tier';
const ID_003 = '003-rename-agent-site-overrides-to-agent-site-rules';

// ── Fixtures (old shapes embedded literally; do NOT derive from schema.sql) ──

const AGENTS_SCHEMA = `
  CREATE TABLE agents (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    api_key_hash TEXT NOT NULL UNIQUE,
    profile_id TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    state TEXT NOT NULL CHECK(state IN ('active','revoked'))
  );
`;

// Per-agent tier as shipped in v2.2.0.
const OLD_OVERRIDES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_site_overrides (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,                     -- normalized, or the literal '*' (agent-wide default)
    decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
    created_at TEXT NOT NULL,
    UNIQUE(agent_id, domain)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_overrides ON agent_site_overrides(agent_id, domain);
`;

// Event log as it existed on dev builds between #103 and #104.
const OLD_EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS site_policy_events (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
    source TEXT NOT NULL CHECK(source IN ('agent_override','global_user','global_site_blocklist','default')),
    matched_domain TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    decision_changed_at TEXT NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(agent_id, domain)
  );
  CREATE INDEX IF NOT EXISTS idx_site_policy_events_last_seen ON site_policy_events(last_seen_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_site_policy_events_agent_last_seen ON site_policy_events(agent_id, last_seen_at DESC);
`;

const NEW_RULES_SCHEMA = `
  CREATE TABLE agent_site_rules (
    id INTEGER PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
    created_at TEXT NOT NULL,
    UNIQUE(agent_id, domain)
  );
`;

const T1 = '2025-01-01T00:00:00.000Z';
const T2 = '2025-02-02T00:00:00.000Z';
const T3 = '2025-03-03T00:00:00.000Z';

function addAgent(db, id) {
  db.prepare(
    "INSERT INTO agents (id, name, api_key_hash, created_at, state) VALUES (?, ?, ?, ?, 'active')"
  ).run(id, `agent-${id}`, `hash-${id}`, T1);
}

function addOverride(db, agentId, domain, decision, createdAt = T1) {
  db.prepare(
    'INSERT INTO agent_site_overrides (agent_id, domain, decision, created_at) VALUES (?, ?, ?, ?)'
  ).run(agentId, domain, decision, createdAt);
}

function addEvent(db, id, agentId, domain, decision, source, matched) {
  db.prepare(
    `INSERT INTO site_policy_events
       (id, agent_id, domain, decision, source, matched_domain, first_seen_at, last_seen_at, decision_changed_at, hit_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, agentId, domain, decision, source, matched, T1, T2, T1, id + 1);
}

// Records 001 and 002 in the ledger so runAll only applies 003.
function markPriorApplied(db) {
  runAll(db, { _migrationsDir: makeTmpDir() }); // creates the ledger only
  const ins = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  ins.run(ID_001, T1);
  ins.run(ID_002, T1);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function indexExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?").get(name);
}

function objectSql(db, type, name) {
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
  // Normalize line endings: schema.sql may be checked out with CRLF.
  return row ? row.sql.replace(/\r\n/g, '\n') : undefined;
}

function objects(db) {
  return db.prepare(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY type, name"
  ).all();
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-mig003-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
  tmpDirs = [];
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('migration 003: rename agent_site_overrides → agent_site_rules', () => {
  test('is discovered by the runner after 002', () => {
    const ids = listMigrations().map(m => m.id);
    assert.ok(ids.indexOf(ID_002) >= 0);
    assert.ok(ids.indexOf(ID_003) > ids.indexOf(ID_002));
  });

  test('DDL in the migration matches schema.sql exactly', () => {
    const fromSchema = new Database(':memory:');
    fromSchema.exec(SCHEMA_SQL);
    const fromMigration = new Database(':memory:');
    fromMigration.exec(AGENTS_SCHEMA + OLD_OVERRIDES_SCHEMA + OLD_EVENTS_SCHEMA);
    migration003.up(fromMigration);

    const checks = [
      ['table', 'agent_site_rules'],
      ['table', 'site_policy_events'],
      ['index', 'idx_site_policy_events_last_seen'],
      ['index', 'idx_site_policy_events_agent_last_seen'],
    ];
    for (const [type, name] of checks) {
      assert.ok(objectSql(fromSchema, type, name), `schema.sql should create ${name}`);
      assert.equal(objectSql(fromMigration, type, name), objectSql(fromSchema, type, name), `${name} DDL drift`);
    }
    assert.equal(tableExists(fromSchema, 'agent_site_overrides'), false, 'schema.sql must not create agent_site_overrides');
    assert.equal(indexExists(fromSchema, 'idx_agent_overrides'), false, 'schema.sql must not create idx_agent_overrides');
    assert.equal(SCHEMA_SQL.includes("'agent_override'"), false, "schema.sql must not mention 'agent_override'");
    fromSchema.close();
    fromMigration.close();
  });

  test('v2.2.0-shaped DB migrates per-agent rows; old table and index gone', () => {
    const db = new Database(':memory:');
    db.exec(AGENTS_SCHEMA + OLD_OVERRIDES_SCHEMA);
    addAgent(db, 1);
    addAgent(db, 2);
    addOverride(db, 1, '*', 'block', T1);
    addOverride(db, 1, 'example.com', 'allow', T2);
    addOverride(db, 2, 'evil.com', 'block', T3);
    const before = db.prepare(
      'SELECT agent_id, domain, decision, created_at FROM agent_site_overrides ORDER BY agent_id, domain'
    ).all();
    markPriorApplied(db);

    runAll(db, {});

    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(ID_003), 'ledger row');
    assert.equal(tableExists(db, 'agent_site_overrides'), false);
    assert.equal(indexExists(db, 'idx_agent_overrides'), false);
    assert.deepEqual(
      db.prepare('SELECT agent_id, domain, decision, created_at FROM agent_site_rules ORDER BY agent_id, domain').all(),
      before
    );
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));
    db.close();
  });

  test('dev DB with old-CHECK event log: sources mapped, ids preserved, indexes recreated', () => {
    const db = new Database(':memory:');
    db.exec(AGENTS_SCHEMA + OLD_OVERRIDES_SCHEMA + OLD_EVENTS_SCHEMA);
    addAgent(db, 1);
    addEvent(db, 10, 1, 'a.com', 'block', 'agent_override', '*');
    addEvent(db, 20, 1, 'b.com', 'allow', 'global_user', 'b.com');
    addEvent(db, 30, 1, 'c.com', 'block', 'global_site_blocklist', 'c.com');
    addEvent(db, 40, 1, 'd.com', 'allow', 'default', null);
    const before = db.prepare('SELECT * FROM site_policy_events ORDER BY id').all();
    markPriorApplied(db);

    runAll(db, {});

    const after = db.prepare('SELECT * FROM site_policy_events ORDER BY id').all();
    assert.deepEqual(
      after,
      before.map(r => ({ ...r, source: r.source === 'agent_override' ? 'agent_rule' : r.source }))
    );
    assert.deepEqual(after.map(r => r.source), ['agent_rule', 'global_user', 'global_site_blocklist', 'default']);
    assert.ok(indexExists(db, 'idx_site_policy_events_last_seen'));
    assert.ok(indexExists(db, 'idx_site_policy_events_agent_last_seen'));
    assert.equal(tableExists(db, 'site_policy_events_old'), false);

    const ins = db.prepare(
      `INSERT INTO site_policy_events (agent_id, domain, decision, source, first_seen_at, last_seen_at, decision_changed_at)
       VALUES (1, ?, 'block', ?, ?, ?, ?)`
    );
    assert.throws(() => ins.run('x.com', 'agent_override', T1, T1, T1), /CHECK constraint failed/);
    assert.doesNotThrow(() => ins.run('y.com', 'agent_rule', T1, T1, T1));
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));
    db.close();
  });

  test('orphaned rows are skipped with a warning, not an error', () => {
    const db = new Database(':memory:');
    db.exec(AGENTS_SCHEMA + OLD_OVERRIDES_SCHEMA + OLD_EVENTS_SCHEMA);
    addAgent(db, 1);
    db.pragma('foreign_keys = OFF');
    addOverride(db, 1, 'kept.com', 'allow');
    addOverride(db, 99, 'orphan-rule.com', 'block');
    addEvent(db, 1, 1, 'kept.com', 'allow', 'agent_override', 'kept.com');
    addEvent(db, 2, 99, 'orphan-event.com', 'block', 'default', null);
    db.pragma('foreign_keys = ON');
    markPriorApplied(db);

    let warnings;
    assert.doesNotThrow(() => { warnings = captureWarn(() => runAll(db, {})); });

    assert.deepEqual(db.prepare('SELECT agent_id, domain FROM agent_site_rules').all(), [{ agent_id: 1, domain: 'kept.com' }]);
    assert.deepEqual(
      db.prepare('SELECT id, agent_id, domain, source FROM site_policy_events').all(),
      [{ id: 1, agent_id: 1, domain: 'kept.com', source: 'agent_rule' }]
    );
    assert.ok(warnings.some(w => w.includes('agent_site_overrides') && w.includes('orphan-rule.com')),
      `expected an orphan-rule warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings.some(w => w.includes('site_policy_events') && w.includes('orphan-event.com')),
      `expected an orphan-event warning, got: ${JSON.stringify(warnings)}`);
    assert.equal(tableExists(db, 'agent_site_overrides'), false);
    db.close();
  });

  test('both old and new per-agent tables exist → new rows win, old dropped', () => {
    const db = new Database(':memory:');
    db.exec(AGENTS_SCHEMA + OLD_OVERRIDES_SCHEMA + NEW_RULES_SCHEMA);
    addAgent(db, 1);
    addOverride(db, 1, 'shared.com', 'block', T1);
    addOverride(db, 1, 'old-only.com', 'allow', T1);
    db.prepare(
      "INSERT INTO agent_site_rules (agent_id, domain, decision, created_at) VALUES (1, 'shared.com', 'allow', ?)"
    ).run(T3);
    markPriorApplied(db);

    runAll(db, {});

    assert.equal(tableExists(db, 'agent_site_overrides'), false);
    assert.deepEqual(
      db.prepare('SELECT domain, decision, created_at FROM agent_site_rules ORDER BY domain').all(),
      [
        { domain: 'old-only.com', decision: 'allow', created_at: T1 },
        { domain: 'shared.com', decision: 'allow', created_at: T3 },
      ]
    );
    db.close();
  });

  test('second runAll is a no-op; calling up() twice directly is a no-op', () => {
    const db = new Database(':memory:');
    db.exec(AGENTS_SCHEMA + OLD_OVERRIDES_SCHEMA + OLD_EVENTS_SCHEMA);
    addAgent(db, 1);
    addOverride(db, 1, '*', 'block');
    addEvent(db, 5, 1, 'a.com', 'block', 'agent_override', '*');
    markPriorApplied(db);

    runAll(db, {});
    const after1 = dump(db);
    const objects1 = objects(db);
    const ledger1 = db.prepare('SELECT * FROM schema_migrations ORDER BY id').all();

    runAll(db, {});
    assert.deepEqual(dump(db), after1);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY id').all(), ledger1);

    // Bypass the ledger (restore-from-backup scenario): in-body guards must hold.
    assert.doesNotThrow(() => { migration003.up(db); migration003.up(db); });
    assert.deepEqual(dump(db), after1);
    assert.deepEqual(objects(db), objects1);
    db.close();
  });

  test('truly empty DB is a no-op and schema.sql then applies cleanly', () => {
    const db = new Database(':memory:');

    assert.doesNotThrow(() => migration003.up(db));
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      [],
      'up() on an empty DB must create nothing'
    );

    runAll(db, { dataDir: makeTmpDir() });
    assert.doesNotThrow(() => db.exec(SCHEMA_SQL));
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(ID_003));
    assert.ok(tableExists(db, 'agent_site_rules'));
    assert.equal(tableExists(db, 'agent_site_overrides'), false);
    db.close();
  });

  test('full runAll + schema.sql on an old DB yields the same objects as a fresh schema.sql DB', () => {
    const fresh = new Database(':memory:');
    fresh.exec(SCHEMA_SQL);

    const db = new Database(':memory:');
    db.exec(AGENTS_SCHEMA + OLD_OVERRIDES_SCHEMA + OLD_EVENTS_SCHEMA);
    addAgent(db, 1);
    addOverride(db, 1, 'example.com', 'allow');
    addEvent(db, 1, 1, 'example.com', 'allow', 'agent_override', 'example.com');
    markPriorApplied(db);

    runAll(db, { dataDir: makeTmpDir() });
    db.exec(SCHEMA_SQL);

    assert.deepEqual(objects(db), objects(fresh));
    fresh.close();
    db.close();
  });
});
