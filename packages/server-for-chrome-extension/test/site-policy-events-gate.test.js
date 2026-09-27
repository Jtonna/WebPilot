'use strict';

// End-to-end check that the site-policy gate in mcp-handler.js records
// site_policy_events rows. Uses the REAL site-policy and site-policy-events
// modules against an in-memory SQLite DB; everything else the handler pulls
// in is stubbed via the same Module._load harness as platform-guide-gate.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const Database = require('better-sqlite3');

// ---- stub registry ----
const stubs = {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const key = request.replace(/\\/g, '/');
  for (const [pattern, stub] of Object.entries(stubs)) {
    if (key === pattern || key.endsWith('/' + pattern)) return stub;
  }
  return originalLoad.apply(this, arguments);
};

// ---- DB fixture ----
const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
let db = null;
function freshDb() {
  db = new Database(':memory:');
  db.exec(schemaSql);
  db.prepare(
    `INSERT INTO agents (id, name, api_key_hash, profile_id, created_at, state)
     VALUES (1, 'A', 'h1', 'default', ?, 'active')`
  ).run(new Date().toISOString());
  return db;
}
function seedAgentBlock(domain) {
  db.prepare(
    `INSERT INTO agent_site_overrides (agent_id, domain, decision, created_at)
     VALUES (1, ?, 'block', ?)`
  ).run(domain, new Date().toISOString());
}
function eventRows() {
  return db.prepare('SELECT * FROM site_policy_events ORDER BY id').all();
}

// ---- stubs ----
stubs['./db/connection'] = { getDb: () => db, init: () => db };
const fakePairedKeys = {
  validateKey: (key) => (key === 'k1' ? { key: 'h1', profileId: 'default', agentName: 'A' } : null),
  touchKey: () => {},
};
stubs['./paired-keys'] = fakePairedKeys;
stubs['./lib/mcp-config-template'] = { buildMcpConfigJson: () => '{}' };
stubs['./lib/tree-query'] = { findInTree: () => null };
stubs['./formatter-logs'] = {
  recordSuccess: () => {},
  recordError: () => {},
  getStatus: () => ({}),
  getLogs: () => [],
  buildDiagnostics: () => ({}),
};
stubs['./service/paths'] = {
  getFormatterDir: () => '/fake',
  getDataDir: () => '/fake',
  getPort: () => 3456,
  loadConfig: () => ({ managedProfile: 'default' }),
};

// Load the real modules through the harness.
for (const m of ['../src/site-policy', '../src/site-policy-events', '../src/mcp-handler']) {
  delete require.cache[require.resolve(m)];
}
const sitePolicyEvents = require('../src/site-policy-events');
const { createMcpHandler } = require('../src/mcp-handler');

// ---- fakes ----
let sentCommands = [];
const fakeBridge = {
  isConnected: () => true,
  sendCommand: async (_profileId, cmd, args) => {
    sentCommands.push({ cmd, args });
    if (cmd === 'get_tabs') return { tabs: [{ id: 7, url: 'https://www.example.com/x' }] };
    if (cmd === 'create_tab') return { tab_id: 7 };
    return {};
  },
};
const fm = {
  getFormatterNameForUrl: () => null,
  formatTree: (_url, nodes) => nodes,
};

function makeHandler({ pairingRequired = true } = {}) {
  return createMcpHandler(fakeBridge, fakePairedKeys, fm, () => pairingRequired);
}

let nextId = 1;
function callTool(handler, name, args, apiKey = 'k1') {
  return handler.processRequest(
    { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
    apiKey
  );
}
function bodyOf(res) {
  assert.ok(res && res.result, `expected result envelope, got ${JSON.stringify(res)}`);
  return JSON.parse(res.result.content[0].text);
}

beforeEach(() => {
  freshDb();
  sitePolicyEvents._resetForTests();
  sentCommands = [];
});

test('create_tab twice -> one allow/default row with hit_count 2', async () => {
  const h = makeHandler();
  await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/a' });
  await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/a' });
  const rows = eventRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, 1);
  assert.equal(rows[0].domain, 'example.com');
  assert.equal(rows[0].hit_count, 2);
  assert.equal(rows[0].decision, 'allow');
  assert.equal(rows[0].source, 'default');
});

test('agent block then browser_scroll -> same row flips to block; blocked envelope', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHandler();
  await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/a' });
  const before = eventRows();
  assert.equal(before.length, 1);

  seedAgentBlock('example.com');
  const res = await callTool(h, 'browser_scroll', { tab_id: 7, direction: 'down' });
  const body = bodyOf(res);
  assert.equal(res.result.isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'site blocked by policy');
  assert.equal(body.domain, 'example.com');
  assert.equal(body.policySource, 'agent_override');
  assert.equal(body.tabId, 7);
  assert.ok(!sentCommands.some((c) => c.cmd === 'scroll'), 'scroll must not reach the extension');

  const after = eventRows();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].decision, 'block');
  assert.equal(after[0].source, 'agent_override');
  assert.equal(after[0].matched_domain, 'example.com');
  assert.equal(after[0].hit_count, 2);

  // Fire the (mocked) auto-close timer so the process never waits on it.
  t.mock.timers.tick(5000);
});

test('browser_request_chain with 2 steps on the same domain -> hit_count +2', async () => {
  const h = makeHandler();
  await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/a' });
  assert.equal(eventRows()[0].hit_count, 1);
  const res = await callTool(h, 'browser_request_chain', {
    steps: [
      { tool: 'browser_scroll', arguments: { tab_id: 7, direction: 'down' } },
      { tool: 'browser_scroll', arguments: { tab_id: 7, direction: 'up' } },
    ],
  });
  const body = bodyOf(res);
  assert.ok(Array.isArray(body.results));
  assert.equal(body.results.length, 2);
  const rows = eventRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hit_count, 3);
  assert.equal(rows[0].decision, 'allow');
});

test('pairing not required and no api key -> gate runs with null agent, no row', async () => {
  const h = makeHandler({ pairingRequired: false });
  const res = await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/a' }, null);
  assert.equal(bodyOf(res).tab_id, 7);
  assert.equal(eventRows().length, 0);
});

test('pairing required and no api key -> auth rejects, no row (sanity)', async () => {
  const h = makeHandler();
  const res = await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/a' }, null);
  assert.equal(res.error && res.error.code, -32001);
  assert.equal(eventRows().length, 0);
});

test('about:blank -> no row', async () => {
  const h = makeHandler();
  await callTool(h, 'browser_create_tab', { url: 'about:blank' });
  assert.equal(eventRows().length, 0);
});

test('throwing recorder does not widen fail-open: allow still allows, block still blocks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const origRecord = sitePolicyEvents.record;
  let calls = 0;
  sitePolicyEvents.record = () => {
    calls++;
    throw new Error('boom');
  };
  try {
    const h = makeHandler();
    const ok = await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/a' });
    assert.equal(bodyOf(ok).tab_id, 7);
    assert.ok(sentCommands.some((c) => c.cmd === 'create_tab'));

    seedAgentBlock('example.com');
    sentCommands = [];
    const blockedA = await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/b' });
    assert.equal(bodyOf(blockedA).error, 'site blocked by policy');
    assert.ok(!sentCommands.some((c) => c.cmd === 'create_tab'), 'blocked create_tab must not reach extension');

    const blockedB = await callTool(h, 'browser_scroll', { tab_id: 7, direction: 'down' });
    const body = bodyOf(blockedB);
    assert.equal(body.error, 'site blocked by policy');
    assert.equal(body.policySource, 'agent_override');
    assert.ok(!sentCommands.some((c) => c.cmd === 'scroll'), 'blocked scroll must not reach extension');

    assert.equal(calls, 3);
    assert.equal(eventRows().length, 0);
    t.mock.timers.tick(5000);
  } finally {
    sitePolicyEvents.record = origRecord;
  }
});
