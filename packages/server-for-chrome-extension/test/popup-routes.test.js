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
delete require.cache[require.resolve('../src/global-user-rules')];
delete require.cache[require.resolve('../src/popup-routes')];
const sitePolicy = require('../src/site-policy');
const { mountPopupRoutes, _statePillFromPolicy } = require('../src/popup-routes');

// ── Seed helpers ────────────────────────────────────────────────────────────

function seedUserRule(domain, decision) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO global_user_site_rules (domain, decision, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(domain, decision, now, now);
}

function seedSigned(domain) {
  db.prepare(
    `INSERT OR REPLACE INTO global_site_blocklist_rules (domain, created_at) VALUES (?, ?)`
  ).run(domain, new Date().toISOString());
}

function setGlobalTier(enabled) {
  db.prepare(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, ?)`
  ).run('global_tier_enabled', enabled ? 'true' : 'false', new Date().toISOString());
}

function userRows(domain) {
  return db.prepare('SELECT * FROM global_user_site_rules WHERE domain = ?').all(domain);
}

// ── HTTP harness ────────────────────────────────────────────────────────────

let server;
let base;
const broadcasts = [];

const extensionInstalls = {
  getProfileForInstall: (id) => (id === 'good' ? 'Default' : null),
};
const extensionBridge = { isConnected: () => true };

before(async () => {
  const app = express();
  mountPopupRoutes(app, {
    extensionInstalls,
    extensionBridge,
    broadcastUiEvent: (e) => broadcasts.push(e),
    port: 1234,
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
  broadcasts.length = 0;
  origLog = console.log;
  origError = console.error;
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

function getState(tabUrl, headers = { 'X-Install-Id': 'good' }) {
  const qs = tabUrl === undefined ? '' : `?tabUrl=${encodeURIComponent(tabUrl)}`;
  return fetch(`${base}/api/popup/state${qs}`, { headers });
}

function toggle(body, headers = { 'X-Install-Id': 'good' }) {
  return fetch(`${base}/api/popup/site-toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ── _statePillFromPolicy ────────────────────────────────────────────────────

describe('_statePillFromPolicy', () => {
  test('allow -> allowed', () => {
    assert.equal(_statePillFromPolicy({ decision: 'allow', source: 'default' }), 'allowed');
    assert.equal(_statePillFromPolicy({ decision: 'allow', source: 'global_user' }), 'allowed');
  });

  test('signed block -> blocked_global_site_blocklist', () => {
    assert.equal(
      _statePillFromPolicy({ decision: 'block', source: 'global_site_blocklist' }),
      'blocked_global_site_blocklist'
    );
  });

  test('user block -> blocked_user', () => {
    assert.equal(_statePillFromPolicy({ decision: 'block', source: 'global_user' }), 'blocked_user');
  });
});

// ── Auth ────────────────────────────────────────────────────────────────────

describe('popup auth', () => {
  test('401 with no installId', async () => {
    const res = await getState(undefined, {});
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  });

  test('401 with unknown installId', async () => {
    const res = await getState(undefined, { 'X-Install-Id': 'nope' });
    assert.equal(res.status, 401);
  });

  test('401 with a web Origin', async () => {
    const res = await getState(undefined, {
      'X-Install-Id': 'good',
      Origin: 'https://evil.example',
    });
    assert.equal(res.status, 401);
  });

  test('401 on toggle with a web Origin', async () => {
    const res = await toggle(
      { domain: 'example.com', action: 'block' },
      { 'X-Install-Id': 'good', Origin: 'https://evil.example' }
    );
    assert.equal(res.status, 401);
    assert.equal(userRows('example.com').length, 0);
  });

  test('200 with a chrome-extension Origin', async () => {
    const res = await getState(undefined, {
      'X-Install-Id': 'good',
      Origin: 'chrome-extension://abc',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.connection, 'connected');
    assert.equal(body.profileId, 'Default');
    assert.equal(body.agent, null);
    assert.match(body.serverUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(body.globalTierEnabled, true);
    assert.equal(body.currentTab, undefined);
  });
});

// ── GET /api/popup/state ────────────────────────────────────────────────────

describe('GET /api/popup/state', () => {
  test('tabUrl longer than 8192 -> 400', async () => {
    const res = await getState('https://example.com/' + 'a'.repeat(8200));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'tabUrl too long' });
  });

  test('default domain -> allowed/default', async () => {
    const res = await getState('https://example.com/page');
    assert.equal(res.status, 200);
    const { currentTab } = await res.json();
    assert.deepEqual(currentTab, {
      url: 'https://example.com/page',
      domain: 'example.com',
      state: 'allowed',
      source: 'default',
      decision: 'allow',
      matchedDomain: null,
    });
  });

  test('user allow -> allowed/global_user', async () => {
    seedUserRule('example.com', 'allow');
    const { currentTab } = await (await getState('https://example.com/')).json();
    assert.equal(currentTab.state, 'allowed');
    assert.equal(currentTab.source, 'global_user');
    assert.equal(currentTab.decision, 'allow');
    assert.equal(currentTab.matchedDomain, 'example.com');
  });

  test('user block -> blocked_user', async () => {
    seedUserRule('example.com', 'block');
    const { currentTab } = await (await getState('https://example.com/')).json();
    assert.equal(currentTab.state, 'blocked_user');
    assert.equal(currentTab.source, 'global_user');
    assert.equal(currentTab.decision, 'block');
  });

  test('signed domain -> blocked_global_site_blocklist', async () => {
    seedSigned('bad.example');
    const { currentTab } = await (await getState('https://bad.example/')).json();
    assert.equal(currentTab.state, 'blocked_global_site_blocklist');
    assert.equal(currentTab.source, 'global_site_blocklist');
    assert.equal(currentTab.decision, 'block');
    assert.equal(currentTab.matchedDomain, 'bad.example');
  });

  test('parent-domain user rule reports the parent as matchedDomain', async () => {
    seedUserRule('example.com', 'block');
    const { currentTab } = await (await getState('https://sub.example.com/x')).json();
    assert.equal(currentTab.domain, 'sub.example.com');
    assert.equal(currentTab.matchedDomain, 'example.com');
    assert.equal(currentTab.state, 'blocked_user');
  });

  test('override pill strings never appear', async () => {
    seedUserRule('a.example', 'allow');
    seedUserRule('b.example', 'block');
    seedSigned('c.example');
    for (const url of [
      'https://a.example/',
      'https://b.example/',
      'https://c.example/',
      'https://d.example/',
    ]) {
      const text = await (await getState(url)).text();
      assert.ok(!text.includes('allowed_override'), text);
      assert.ok(!text.includes('blocked_override'), text);
    }
  });

  test('global tier off -> allowed/default, globalTierEnabled false', async () => {
    seedUserRule('example.com', 'block');
    seedSigned('example.com');
    setGlobalTier(false);
    const body = await (await getState('https://example.com/')).json();
    assert.equal(body.globalTierEnabled, false);
    assert.equal(body.currentTab.state, 'allowed');
    assert.equal(body.currentTab.source, 'default');
    assert.equal(body.currentTab.decision, 'allow');
  });
});

// ── POST /api/popup/site-toggle ─────────────────────────────────────────────

describe('POST /api/popup/site-toggle', () => {
  test('action block -> blocked_user', async () => {
    const res = await toggle({ domain: 'example.com', action: 'block' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      domain: 'example.com',
      decision: 'block',
      newState: 'blocked_user',
      globalTierEnabled: true,
      source: 'global_user',
      policyDecision: 'block',
    });
    assert.deepEqual(broadcasts, [{ type: 'site_policy_changed', reason: 'popup_toggle' }]);
  });

  test('decision alias works when action is absent', async () => {
    const res = await toggle({ domain: 'example.com', decision: 'allow' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.decision, 'allow');
    assert.equal(body.newState, 'allowed');
    assert.equal(userRows('example.com')[0].decision, 'allow');
    assert.deepEqual(broadcasts, [{ type: 'site_policy_changed', reason: 'popup_toggle' }]);
  });

  test('action wins when both action and decision are present', async () => {
    const res = await toggle({ domain: 'example.com', action: 'block', decision: 'allow' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.decision, 'block');
    assert.equal(userRows('example.com')[0].decision, 'block');
  });

  test("wildcard '*' -> 400 per-agent only", async () => {
    const res = await toggle({ domain: '*', action: 'block' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid domain');
    assert.ok(body.reason.includes('per-agent only'), body.reason);
    assert.equal(broadcasts.length, 0);
  });

  test('domain longer than 512 -> 400 domain too long', async () => {
    const res = await toggle({ domain: 'a'.repeat(513) + '.com', action: 'block' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'domain too long' });
  });

  test('bad action -> 400 invalid decision', async () => {
    const res = await toggle({ domain: 'example.com', action: 'maybe' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid decision');
    assert.equal(typeof body.reason, 'string');
    assert.equal(userRows('example.com').length, 0);
    assert.equal(broadcasts.length, 0);
  });

  test('block then allow leaves one allow row', async () => {
    await toggle({ domain: 'example.com', action: 'block' });
    const res = await toggle({ domain: 'example.com', action: 'allow' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.newState, 'allowed');
    const rows = userRows('example.com');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, 'allow');
    assert.deepEqual(broadcasts, [
      { type: 'site_policy_changed', reason: 'popup_toggle' },
      { type: 'site_policy_changed', reason: 'popup_toggle' },
    ]);
  });

  test('allow on a signed domain creates a user allow row', async () => {
    seedSigned('bad.example');
    const res = await toggle({ domain: 'bad.example', action: 'allow' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.newState, 'allowed');
    assert.equal(body.source, 'global_user');
    assert.equal(body.policyDecision, 'allow');
    assert.equal(userRows('bad.example').length, 1);
    assert.equal(userRows('bad.example')[0].decision, 'allow');
  });

  test('401 with no installId leaves no row', async () => {
    const res = await toggle({ domain: 'example.com', action: 'block' }, {});
    assert.equal(res.status, 401);
    assert.equal(userRows('example.com').length, 0);
  });

  test('setGlobalRule throwing -> 500 {error}', async () => {
    const orig = sitePolicy.setGlobalRule;
    sitePolicy.setGlobalRule = () => {
      throw new Error('boom');
    };
    try {
      const res = await toggle({ domain: 'example.com', action: 'block' });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'boom' });
      assert.equal(broadcasts.length, 0);
    } finally {
      sitePolicy.setGlobalRule = orig;
    }
  });
});
