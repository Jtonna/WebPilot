'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');

// ── DB fixture setup ────────────────────────────────────────────────────────

const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

let db; // swapped per test; the injected connection always returns the current one

function createTestDb() {
  const d = new Database(':memory:');
  d.exec(schemaSql);
  return d;
}

require.cache[require.resolve('../src/db/connection')] = {
  exports: { getDb: () => db, init: () => db },
};
delete require.cache[require.resolve('../src/site-policy')];
delete require.cache[require.resolve('../src/site-policy-events')];
delete require.cache[require.resolve('../src/site-policy-events-routes')];
const sitePolicy = require('../src/site-policy');
const sitePolicyEvents = require('../src/site-policy-events');
const { mountSiteEventRoutes } = require('../src/site-policy-events-routes');

// ── Seed helpers ────────────────────────────────────────────────────────────

function seedAgent(id, state = 'active') {
  db.prepare(
    `INSERT INTO agents (id, name, api_key_hash, created_at, state) VALUES (?, ?, ?, ?, ?)`
  ).run(id, 'agent_' + id, 'hash_' + id, new Date().toISOString(), state);
}

function seedAgentRule(agentId, domain, decision) {
  db.prepare(
    `INSERT INTO agent_site_rules (agent_id, domain, decision, created_at) VALUES (?, ?, ?, ?)`
  ).run(agentId, domain, decision, new Date().toISOString());
}

function seedSigned(domain) {
  db.prepare(
    `INSERT OR REPLACE INTO global_site_blocklist_rules (domain, created_at) VALUES (?, ?)`
  ).run(domain, new Date().toISOString());
}

function recordEvent(agentId, domain, decision, iso, source = 'default') {
  sitePolicyEvents.record(
    agentId,
    { allowed: decision === 'allow', decision, source, domain, matchedDomain: null },
    { now: new Date(iso) }
  );
}

function agentRules(agentId, domain) {
  return db
    .prepare('SELECT * FROM agent_site_rules WHERE agent_id = ? AND domain = ?')
    .all(agentId, domain);
}

function eventRows() {
  return db.prepare('SELECT * FROM site_policy_events ORDER BY id').all();
}

// Same SQL as server.js _agentIdFromKey.
function agentIdFromKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null;
  const row = db
    .prepare("SELECT id FROM agents WHERE api_key_hash = ? AND state = 'active'")
    .get(key);
  return row ? row.id : null;
}

// ── HTTP harness ────────────────────────────────────────────────────────────

let server;
let base;
let denyMutating = false;
const broadcasts = [];

const auth = (req, res, next) => next();
const mutatingAuth = (req, res, next) => {
  if (denyMutating) return res.status(403).json({ error: 'Forbidden' });
  next();
};

before(async () => {
  const app = express();
  mountSiteEventRoutes(app, {
    auth,
    mutatingAuth,
    broadcastUiEvent: (e) => broadcasts.push(e),
    agentIdFromKey,
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let origLog;
let origError;
beforeEach(() => {
  db = createTestDb();
  sitePolicyEvents._resetForTests();
  broadcasts.length = 0;
  denyMutating = false;
  origLog = console.log;
  origError = console.error;
  console.log = () => {};
  console.error = () => {};
  seedAgent(1);
  seedAgent(2);
  seedAgent(3, 'revoked');
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

function get(qs = '') {
  return fetch(`${base}/api/ui/sites/events${qs}`);
}

function post(agentKey, action, body) {
  return fetch(`${base}/api/ui/agents/${encodeURIComponent(agentKey)}/site-events/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ── GET /api/ui/sites/events ────────────────────────────────────────────────

describe('GET /api/ui/sites/events', () => {
  test('returns list() shape, newest first', async () => {
    recordEvent(1, 'a.com', 'allow', '2026-09-01T00:00:00.000Z');
    recordEvent(2, 'b.com', 'block', '2026-09-02T00:00:00.000Z', 'global_site_blocklist');
    const res = await get();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['entries', 'hasMore', 'nextCursor']);
    assert.equal(body.hasMore, false);
    assert.equal(body.nextCursor, null);
    assert.deepEqual(body.entries.map((e) => e.domain), ['b.com', 'a.com']);
    assert.equal(body.entries[0].agentKey, 'hash_2');
    assert.equal(body.entries[0].agentRuleDecision, null);
    assert.equal(body.entries[1].actionable, true);
  });

  test('paginates with limit / hasMore / cursor round-trip', async () => {
    for (let i = 0; i < 5; i++) {
      recordEvent(1, `d${i}.com`, 'allow', `2026-09-0${i + 1}T00:00:00.000Z`);
    }
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const qs = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await get(qs);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.entries.length <= 2);
      seen.push(...body.entries.map((e) => e.domain));
      if (body.hasMore) assert.ok(body.nextCursor);
      else assert.equal(body.nextCursor, null);
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['d4.com', 'd3.com', 'd2.com', 'd1.com', 'd0.com']);
  });

  test('filters by agentId (api_key_hash) and decision', async () => {
    recordEvent(1, 'a.com', 'allow', '2026-09-01T00:00:00.000Z');
    recordEvent(1, 'b.com', 'block', '2026-09-02T00:00:00.000Z', 'global_site_blocklist');
    recordEvent(2, 'c.com', 'block', '2026-09-03T00:00:00.000Z', 'global_site_blocklist');
    let body = await (await get('?agentId=hash_1')).json();
    assert.deepEqual(body.entries.map((e) => e.domain), ['b.com', 'a.com']);
    body = await (await get('?agentId=hash_1&decision=block')).json();
    assert.deepEqual(body.entries.map((e) => e.domain), ['b.com']);
    body = await (await get('?decision=allow')).json();
    assert.deepEqual(body.entries.map((e) => e.domain), ['a.com']);
  });

  test('unknown agentId -> 404', async () => {
    const res = await get('?agentId=nope');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'agent not found' });
  });

  test('revoked agentId -> 404', async () => {
    const res = await get('?agentId=hash_3');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'agent not found' });
  });

  test('bad decision -> 400', async () => {
    const res = await get('?decision=maybe');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid decision');
    assert.ok(body.reason);
  });

  test('bad cursor -> 400', async () => {
    const res = await get('?cursor=garbage');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid cursor');
    assert.ok(body.reason);
  });

  test('not blocked by mutatingAuth', async () => {
    denyMutating = true;
    const res = await get();
    assert.equal(res.status, 200);
  });
});

// ── POST allow / revoke ─────────────────────────────────────────────────────

describe('POST /api/ui/agents/:agentId/site-events/allow', () => {
  test('writes an allow rule that beats the signed blocklist and an agent "*" block', async () => {
    seedSigned('evil.com');
    seedAgentRule(1, '*', 'block');
    assert.equal(sitePolicy.isAllowed(1, 'https://evil.com').allowed, false);

    const res = await post('hash_1', 'allow', { domain: 'evil.com' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.agentKey, 'hash_1');
    assert.equal(body.domain, 'evil.com');
    assert.equal(body.decision, 'allow');
    assert.equal(typeof body.createdAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(body.createdAt)));

    const rows = agentRules(1, 'evil.com');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, 'allow');
    assert.equal(sitePolicy.isAllowed(1, 'https://evil.com').allowed, true);
    assert.deepEqual(broadcasts, [{ type: 'sites_changed', reason: 'site_event_allow' }]);
  });

  test('normalizes the domain', async () => {
    const res = await post('hash_1', 'allow', { domain: 'WWW.Example.COM' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.domain, sitePolicy.normalizeRuleDomain('WWW.Example.COM'));
    assert.equal(agentRules(1, body.domain).length, 1);
  });
});

describe('POST /api/ui/agents/:agentId/site-events/revoke', () => {
  test('writes a block rule', async () => {
    const res = await post('hash_1', 'revoke', { domain: 'x.com' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(
      { agentKey: body.agentKey, domain: body.domain, decision: body.decision },
      { agentKey: 'hash_1', domain: 'x.com', decision: 'block' }
    );
    assert.equal(typeof body.createdAt, 'string');
    const rows = agentRules(1, 'x.com');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, 'block');
    assert.deepEqual(broadcasts, [{ type: 'sites_changed', reason: 'site_event_revoke' }]);
  });

  test('overwrites a same-domain allow in place (row count stays 1)', async () => {
    seedAgentRule(1, 'x.com', 'allow');
    const prior = agentRules(1, 'x.com')[0];
    const res = await post('hash_1', 'revoke', { domain: 'x.com' });
    assert.equal(res.status, 201);
    const rows = agentRules(1, 'x.com');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, 'block');
    assert.equal((await res.json()).createdAt, prior.created_at);
    assert.equal(sitePolicy.isAllowed(1, 'https://x.com').allowed, false);
  });

  test('leaves a parent-domain allow in place; subdomain is blocked', async () => {
    seedAgentRule(1, 'example.com', 'allow');
    const res = await post('hash_1', 'revoke', { domain: 'sub.example.com' });
    assert.equal(res.status, 201);
    const parent = agentRules(1, 'example.com');
    assert.equal(parent.length, 1);
    assert.equal(parent[0].decision, 'allow');
    assert.equal(sitePolicy.isAllowed(1, 'https://sub.example.com').allowed, false);
    assert.equal(sitePolicy.isAllowed(1, 'https://example.com').allowed, true);
  });
});

describe('POST validation and auth', () => {
  const badBodies = [
    ['IP address', { domain: '10.0.0.1' }],
    ['localhost', { domain: 'localhost' }],
    ['wildcard', { domain: '*' }],
    ['missing domain', {}],
    ['non-string domain', { domain: 42 }],
  ];
  for (const action of ['allow', 'revoke']) {
    for (const [label, body] of badBodies) {
      test(`${action}: ${label} -> 400`, async () => {
        const res = await post('hash_1', action, body);
        assert.equal(res.status, 400);
        const json = await res.json();
        assert.equal(json.error, 'invalid domain');
        assert.match(json.reason, /cannot be the target of a per-agent rule/);
        assert.equal(db.prepare('SELECT COUNT(*) c FROM agent_site_rules').get().c, 0);
        assert.equal(broadcasts.length, 0);
      });
    }

    test(`${action}: unknown agent -> 404`, async () => {
      const res = await post('nope', action, { domain: 'x.com' });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'agent not found' });
    });

    test(`${action}: revoked agent -> 404`, async () => {
      const res = await post('hash_3', action, { domain: 'x.com' });
      assert.equal(res.status, 404);
      assert.equal(agentRules(3, 'x.com').length, 0);
    });

    test(`${action}: mutatingAuth 403 blocks the write`, async () => {
      denyMutating = true;
      const res = await post('hash_1', action, { domain: 'x.com' });
      assert.equal(res.status, 403);
      assert.equal(agentRules(1, 'x.com').length, 0);
      assert.equal(broadcasts.length, 0);
    });
  }
});

describe('actions vs event rows', () => {
  test('event row is unchanged by an action; GET reflects the new agentRuleDecision', async () => {
    recordEvent(1, 'evil.com', 'block', '2026-09-01T00:00:00.000Z', 'global_site_blocklist');
    const beforeRows = eventRows();

    let res = await post('hash_1', 'allow', { domain: 'evil.com' });
    assert.equal(res.status, 201);
    assert.deepEqual(eventRows(), beforeRows);
    let body = await (await get('?agentId=hash_1')).json();
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].decision, 'block');
    assert.equal(body.entries[0].agentRuleDecision, 'allow');

    res = await post('hash_1', 'revoke', { domain: 'evil.com' });
    assert.equal(res.status, 201);
    assert.deepEqual(eventRows(), beforeRows);
    body = await (await get('?agentId=hash_1')).json();
    assert.equal(body.entries[0].agentRuleDecision, 'block');
  });

  test('actions do not require an existing event row', async () => {
    assert.equal(eventRows().length, 0);
    const res = await post('hash_2', 'allow', { domain: 'fresh.com' });
    assert.equal(res.status, 201);
    assert.equal(eventRows().length, 0);
  });
});
