'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ── DB fixture setup ────────────────────────────────────────────────────────

const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(schemaSql);
  return db;
}

function injectDb(db) {
  require.cache[require.resolve('../src/db/connection')] = {
    exports: { getDb: () => db, init: () => db },
  };
}

function injectThrowingDb() {
  require.cache[require.resolve('../src/db/connection')] = {
    exports: {
      getDb: () => {
        throw new Error('db unavailable');
      },
      init: () => null,
    },
  };
}

function loadModule() {
  delete require.cache[require.resolve('../src/site-policy')];
  delete require.cache[require.resolve('../src/site-policy-events')];
  const mod = require('../src/site-policy-events');
  mod._resetForTests();
  return mod;
}

// ── Seed helpers ────────────────────────────────────────────────────────────

function seedAgent(db, { id, state = 'active' }) {
  db.prepare(
    `INSERT INTO agents (id, name, api_key_hash, created_at, state) VALUES (?, ?, ?, ?, ?)`
  ).run(id, 'agent_' + id, 'hash_' + id, new Date().toISOString(), state);
}

function seedAgentRule(db, { agentId, domain, decision }) {
  db.prepare(
    `INSERT INTO agent_site_rules (agent_id, domain, decision, created_at) VALUES (?, ?, ?, ?)`
  ).run(agentId, domain, decision, new Date().toISOString());
}

function verdict(domain, decision = 'allow', source = 'default', matchedDomain = null) {
  return { allowed: decision === 'allow', decision, source, domain, matchedDomain };
}

function rows(db) {
  return db.prepare('SELECT * FROM site_policy_events ORDER BY id').all();
}

function at(iso) {
  return { now: new Date(iso) };
}

function captureEvents(mod) {
  const seen = [];
  mod.events.on('changed', (e) => seen.push(e));
  return seen;
}

// Silence expected warnings/logs while keeping them assertable.
let origWarn;
let origLog;
let warnings;
beforeEach(() => {
  origWarn = console.warn;
  origLog = console.log;
  warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = () => {};
});
afterEach(() => {
  console.warn = origWarn;
  console.log = origLog;
});

// ── record ──────────────────────────────────────────────────────────────────

describe('record', () => {
  let db;
  let mod;
  beforeEach(() => {
    db = createTestDb();
    injectDb(db);
    mod = loadModule();
    seedAgent(db, { id: 1 });
  });

  test('new row emits created and returns created result', () => {
    const seen = captureEvents(mod);
    const res = mod.record(1, verdict('example.com'), at('2026-01-01T00:00:00.000Z'));
    assert.deepEqual(res, { created: true, decisionChanged: false, verdictChanged: false });
    assert.deepEqual(seen, [{ reason: 'created', agentId: 1, domain: 'example.com' }]);
    const [r] = rows(db);
    assert.equal(r.decision, 'allow');
    assert.equal(r.source, 'default');
    assert.equal(r.matched_domain, null);
    assert.equal(r.hit_count, 1);
    assert.equal(r.first_seen_at, '2026-01-01T00:00:00.000Z');
    assert.equal(r.last_seen_at, '2026-01-01T00:00:00.000Z');
    assert.equal(r.decision_changed_at, '2026-01-01T00:00:00.000Z');
  });

  test('repeated record dedupes: one row, hit_count N, last_seen_at advances', () => {
    mod.record(1, verdict('example.com'), at('2026-01-01T00:00:00.000Z'));
    mod.record(1, verdict('example.com'), at('2026-01-01T00:01:00.000Z'));
    mod.record(1, verdict('example.com'), at('2026-01-01T00:02:00.000Z'));
    const all = rows(db);
    assert.equal(all.length, 1);
    assert.equal(all[0].hit_count, 3);
    assert.equal(all[0].first_seen_at, '2026-01-01T00:00:00.000Z');
    assert.equal(all[0].last_seen_at, '2026-01-01T00:02:00.000Z');
    assert.equal(all[0].decision_changed_at, '2026-01-01T00:00:00.000Z');
  });

  test('hit bump alone does not emit', () => {
    mod.record(1, verdict('example.com'), at('2026-01-01T00:00:00.000Z'));
    const seen = captureEvents(mod);
    const res = mod.record(1, verdict('example.com'), at('2026-01-01T00:01:00.000Z'));
    assert.deepEqual(res, { created: false, decisionChanged: false, verdictChanged: false });
    assert.deepEqual(seen, []);
  });

  test('allow -> block flip keeps id and first_seen_at, updates decision_changed_at, emits decision_changed', () => {
    mod.record(1, verdict('example.com'), at('2026-01-01T00:00:00.000Z'));
    const before = rows(db)[0];
    const seen = captureEvents(mod);
    const res = mod.record(
      1,
      verdict('example.com', 'block', 'agent_rule', 'example.com'),
      at('2026-01-02T00:00:00.000Z')
    );
    assert.equal(res.decisionChanged, true);
    assert.deepEqual(seen, [{ reason: 'decision_changed', agentId: 1, domain: 'example.com' }]);
    const [after] = rows(db);
    assert.equal(after.id, before.id);
    assert.equal(after.first_seen_at, '2026-01-01T00:00:00.000Z');
    assert.equal(after.decision_changed_at, '2026-01-02T00:00:00.000Z');
    assert.equal(after.last_seen_at, '2026-01-02T00:00:00.000Z');
    assert.equal(after.decision, 'block');
    assert.equal(after.source, 'agent_rule');
    assert.equal(after.matched_domain, 'example.com');
    assert.equal(after.hit_count, 2);
  });

  test('decision derived from verdict.allowed when decision is absent', () => {
    mod.record(1, { allowed: false, source: 'global_user', domain: 'x.com', matchedDomain: 'x.com' });
    assert.equal(rows(db)[0].decision, 'block');
  });

  test('source-only change emits verdict_changed and leaves decision_changed_at', () => {
    mod.record(1, verdict('example.com', 'block', 'global_user', 'example.com'), at('2026-01-01T00:00:00.000Z'));
    const seen = captureEvents(mod);
    const res = mod.record(
      1,
      verdict('example.com', 'block', 'global_site_blocklist', 'example.com'),
      at('2026-01-03T00:00:00.000Z')
    );
    assert.deepEqual(res, { created: false, decisionChanged: false, verdictChanged: true });
    assert.deepEqual(seen, [{ reason: 'verdict_changed', agentId: 1, domain: 'example.com' }]);
    const [r] = rows(db);
    assert.equal(r.source, 'global_site_blocklist');
    assert.equal(r.decision_changed_at, '2026-01-01T00:00:00.000Z');
    assert.equal(r.last_seen_at, '2026-01-03T00:00:00.000Z');
  });

  test('matched_domain-only change emits verdict_changed', () => {
    mod.record(1, verdict('a.example.com', 'block', 'agent_rule', '*'));
    const seen = captureEvents(mod);
    mod.record(1, verdict('a.example.com', 'block', 'agent_rule', 'example.com'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].reason, 'verdict_changed');
  });

  test('invalid inputs: no write, no throw, null result', () => {
    const seen = captureEvents(mod);
    assert.equal(mod.record(null, verdict('example.com')), null);
    assert.equal(mod.record(0, verdict('example.com')), null);
    assert.equal(mod.record(1, null), null);
    assert.equal(mod.record(1, verdict(null)), null);
    assert.equal(mod.record(1, verdict('')), null);
    assert.equal(mod.record(1, verdict('example.com', 'allow', 'bogus')), null);
    assert.equal(mod.record(1, { decision: 'maybe', source: 'default', domain: 'example.com' }), null);
    assert.equal(mod.record(1, { source: 'default', domain: 'example.com' }), null);
    assert.equal(rows(db).length, 0);
    assert.deepEqual(seen, []);
    assert.ok(warnings.some((w) => w.includes('[site-policy-events]') && w.includes('bogus')));
  });

  test('DB error (table dropped) returns null without throwing', () => {
    db.exec('DROP TABLE site_policy_events');
    let res;
    assert.doesNotThrow(() => {
      res = mod.record(1, verdict('example.com'));
    });
    assert.equal(res, null);
    assert.ok(warnings.some((w) => w.includes('[site-policy-events] record failed')));
  });

  test('getDb throwing returns null without throwing', () => {
    injectThrowingDb();
    const m = loadModule();
    let res;
    assert.doesNotThrow(() => {
      res = m.record(1, verdict('example.com'));
    });
    assert.equal(res, null);
  });

  test('throwing listener does not escape record', () => {
    mod.events.on('changed', () => {
      throw new Error('listener boom');
    });
    let res;
    assert.doesNotThrow(() => {
      res = mod.record(1, verdict('example.com'));
    });
    assert.equal(res, null);
    assert.equal(rows(db).length, 1);
  });

  test('IP host is recorded', () => {
    mod.record(1, verdict('192.168.1.1'));
    assert.equal(rows(db)[0].domain, '192.168.1.1');
  });

  test('swapping the DB does not reuse stale prepared statements', () => {
    mod.record(1, verdict('example.com'));
    const db2 = createTestDb();
    seedAgent(db2, { id: 1 });
    // Same module instance (no reload), same connection module, new handle:
    // the statement cache must re-key on it.
    require.cache[require.resolve('../src/db/connection')].exports.getDb = () => db2;
    assert.ok(mod.record(1, verdict('other.com')));
    assert.equal(rows(db2).length, 1);
    assert.equal(rows(db).length, 1);
  });

  test('ON DELETE CASCADE removes rows when the agent is deleted', () => {
    db.pragma('foreign_keys = ON');
    mod.record(1, verdict('example.com'));
    mod.record(1, verdict('other.com'));
    assert.equal(rows(db).length, 2);
    db.prepare('DELETE FROM agents WHERE id = 1').run();
    assert.equal(rows(db).length, 0);
  });
});

// ── cleanup ─────────────────────────────────────────────────────────────────

describe('cleanup', () => {
  let db;
  let mod;
  const NOW = new Date('2026-06-01T00:00:00.000Z');
  const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000);

  beforeEach(() => {
    db = createTestDb();
    injectDb(db);
    mod = loadModule();
    seedAgent(db, { id: 1 });
  });

  test('defaults are exported', () => {
    assert.equal(mod.DEFAULT_MAX_AGE_DAYS, 30);
    assert.equal(mod.DEFAULT_MAX_ROWS, 5000);
  });

  test('age: 31-day-old removed, 29-day-old kept, emits retention', () => {
    mod.record(1, verdict('old.com'), { now: daysAgo(31) });
    mod.record(1, verdict('young.com'), { now: daysAgo(29) });
    const seen = captureEvents(mod);
    const res = mod.cleanup({ now: NOW });
    assert.deepEqual(res, { removedByAge: 1, removedByCap: 0, removed: 1, kept: 1 });
    assert.deepEqual(rows(db).map((r) => r.domain), ['young.com']);
    assert.deepEqual(seen, [{ reason: 'retention' }]);
  });

  test('cap: maxRows 3 with 5 rows keeps the 3 newest by last_seen_at', () => {
    // Insert in an order that differs from last_seen_at order.
    const plan = [
      ['a.com', 5],
      ['b.com', 1],
      ['c.com', 4],
      ['d.com', 2],
      ['e.com', 3],
    ];
    for (const [domain, d] of plan) mod.record(1, verdict(domain), { now: daysAgo(d) });
    const res = mod.cleanup({ now: NOW, maxRows: 3 });
    assert.deepEqual(res, { removedByAge: 0, removedByCap: 2, removed: 2, kept: 3 });
    assert.deepEqual(rows(db).map((r) => r.domain).sort(), ['b.com', 'd.com', 'e.com']);
  });

  test('age and cap combine in counts', () => {
    mod.record(1, verdict('old.com'), { now: daysAgo(40) });
    mod.record(1, verdict('a.com'), { now: daysAgo(3) });
    mod.record(1, verdict('b.com'), { now: daysAgo(2) });
    mod.record(1, verdict('c.com'), { now: daysAgo(1) });
    const res = mod.cleanup({ now: NOW, maxRows: 2 });
    assert.deepEqual(res, { removedByAge: 1, removedByCap: 1, removed: 2, kept: 2 });
  });

  test('nothing removed: no retention emit', () => {
    mod.record(1, verdict('young.com'), { now: daysAgo(1) });
    const seen = captureEvents(mod);
    const res = mod.cleanup({ now: NOW });
    assert.deepEqual(res, { removedByAge: 0, removedByCap: 0, removed: 0, kept: 1 });
    assert.deepEqual(seen, []);
  });

  test('getDb throwing returns zeros', () => {
    injectThrowingDb();
    const m = loadModule();
    assert.deepEqual(m.cleanup(), { removedByAge: 0, removedByCap: 0, removed: 0, kept: 0 });
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe('list', () => {
  let db;
  let mod;

  beforeEach(() => {
    db = createTestDb();
    injectDb(db);
    mod = loadModule();
    seedAgent(db, { id: 1 });
    seedAgent(db, { id: 2 });
  });

  test('orders by last_seen_at DESC and maps entry shape without numeric ids', () => {
    mod.record(1, verdict('a.com'), at('2026-01-01T00:00:00.000Z'));
    mod.record(1, verdict('b.com', 'block', 'global_user', 'b.com'), at('2026-01-03T00:00:00.000Z'));
    mod.record(2, verdict('c.com'), at('2026-01-02T00:00:00.000Z'));
    const { entries, hasMore, nextCursor } = mod.list();
    assert.deepEqual(entries.map((e) => e.domain), ['b.com', 'c.com', 'a.com']);
    assert.equal(hasMore, false);
    assert.equal(nextCursor, null);
    assert.deepEqual(entries[0], {
      agentKey: 'hash_1',
      agentName: 'agent_1',
      domain: 'b.com',
      decision: 'block',
      source: 'global_user',
      matchedDomain: 'b.com',
      firstSeenAt: '2026-01-03T00:00:00.000Z',
      lastSeenAt: '2026-01-03T00:00:00.000Z',
      decisionChangedAt: '2026-01-03T00:00:00.000Z',
      hitCount: 1,
      actionable: true,
      agentRuleDecision: null,
    });
    for (const e of entries) {
      assert.equal('id' in e, false);
      assert.equal('agentId' in e, false);
      assert.equal('agent_id' in e, false);
    }
    assert.equal(entries[1].agentKey, 'hash_2');
    assert.equal(entries[1].agentName, 'agent_2');
  });

  test('limit + hasMore + cursor round-trip, including a timestamp tie broken by id', () => {
    const tie = '2026-01-05T00:00:00.000Z';
    mod.record(1, verdict('t1.com'), at(tie));
    mod.record(1, verdict('t2.com'), at(tie));
    mod.record(1, verdict('t3.com'), at(tie));
    mod.record(1, verdict('older.com'), at('2026-01-04T00:00:00.000Z'));
    mod.record(1, verdict('newest.com'), at('2026-01-06T00:00:00.000Z'));

    const p1 = mod.list({ limit: 2 });
    assert.deepEqual(p1.entries.map((e) => e.domain), ['newest.com', 't3.com']);
    assert.equal(p1.hasMore, true);
    assert.equal(typeof p1.nextCursor, 'string');

    const p2 = mod.list({ limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.entries.map((e) => e.domain), ['t2.com', 't1.com']);
    assert.equal(p2.hasMore, true);

    const p3 = mod.list({ limit: 2, cursor: p2.nextCursor });
    assert.deepEqual(p3.entries.map((e) => e.domain), ['older.com']);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.nextCursor, null);
  });

  test('limit normalization: NaN/<=0 -> 50, capped at 200', () => {
    for (let i = 0; i < 205; i++) {
      mod.record(1, verdict(`d${i}.com`), { now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    }
    assert.equal(mod.list({ limit: NaN }).entries.length, 50);
    assert.equal(mod.list({ limit: 0 }).entries.length, 50);
    assert.equal(mod.list({ limit: -5 }).entries.length, 50);
    assert.equal(mod.list({ limit: 1000 }).entries.length, 200);
    assert.equal(mod.list({ limit: 1000 }).hasMore, true);
  });

  test('agentId filter', () => {
    mod.record(1, verdict('a.com'));
    mod.record(2, verdict('b.com'));
    const { entries } = mod.list({ agentId: 2 });
    assert.deepEqual(entries.map((e) => e.domain), ['b.com']);
  });

  test('decision filter', () => {
    mod.record(1, verdict('a.com'));
    mod.record(1, verdict('b.com', 'block', 'global_user', 'b.com'));
    assert.deepEqual(mod.list({ decision: 'block' }).entries.map((e) => e.domain), ['b.com']);
    assert.deepEqual(mod.list({ decision: 'allow' }).entries.map((e) => e.domain), ['a.com']);
  });

  test('invalid decision throws INVALID_DECISION', () => {
    assert.throws(() => mod.list({ decision: 'maybe' }), (e) => e.code === 'INVALID_DECISION');
  });

  test('revoked agent rows are excluded', () => {
    seedAgent(db, { id: 3, state: 'revoked' });
    mod.record(1, verdict('a.com'));
    mod.record(3, verdict('r.com'));
    assert.deepEqual(mod.list().entries.map((e) => e.domain), ['a.com']);
  });

  test('actionable is false for IP and single-label hosts', () => {
    mod.record(1, verdict('192.168.1.1'), at('2026-01-02T00:00:00.000Z'));
    mod.record(1, verdict('localhost'), at('2026-01-01T00:00:00.000Z'));
    const { entries } = mod.list();
    assert.equal(entries[0].domain, '192.168.1.1');
    assert.equal(entries[0].actionable, false);
    assert.equal(entries[1].actionable, false);
  });

  test('agentRuleDecision reflects an exact-domain agent_site_rules row', () => {
    seedAgentRule(db, { agentId: 1, domain: 'ruled.com', decision: 'block' });
    seedAgentRule(db, { agentId: 1, domain: '*', decision: 'allow' });
    seedAgentRule(db, { agentId: 2, domain: 'plain.com', decision: 'allow' });
    mod.record(1, verdict('ruled.com', 'block', 'agent_rule', 'ruled.com'), at('2026-01-02T00:00:00.000Z'));
    mod.record(1, verdict('plain.com', 'allow', 'agent_rule', '*'), at('2026-01-01T00:00:00.000Z'));
    const { entries } = mod.list();
    assert.equal(entries[0].domain, 'ruled.com');
    assert.equal(entries[0].agentRuleDecision, 'block');
    // '*' row and another agent's exact row do not count.
    assert.equal(entries[1].domain, 'plain.com');
    assert.equal(entries[1].agentRuleDecision, null);
  });

  test('bad cursor throws INVALID_CURSOR', () => {
    for (const cursor of ['garbage', '|5', '2026-01-01T00:00:00.000Z|abc', '2026-01-01T00:00:00.000Z|0', 42]) {
      assert.throws(
        () => mod.list({ cursor }),
        (e) => e.code === 'INVALID_CURSOR' && e.message === 'invalid cursor',
        `cursor ${JSON.stringify(cursor)} should be rejected`
      );
    }
  });
});
