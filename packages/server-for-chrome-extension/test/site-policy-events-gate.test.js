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
    `INSERT INTO agent_site_rules (agent_id, domain, decision, created_at)
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
// Load through the same require cache mcp-handler used, so tests that
// monkeypatch sitePolicy.isAllowed patch the SAME instance mcp-handler holds.
const sitePolicy = require('../src/site-policy');

// ---- fakes ----
let sentCommands = [];
let connected = true;
let getTabsImpl = async () => ({ tabs: [{ id: 7, url: 'https://www.example.com/x' }] });
const fakeBridge = {
  isConnected: (_profileId) => connected,
  sendCommand: async (_profileId, cmd, args) => {
    sentCommands.push({ cmd, args });
    if (cmd === 'get_tabs') return getTabsImpl();
    if (cmd === 'create_tab') return { tab_id: 7 };
    return {};
  },
};
const fm = {
  getFormatterNameForUrl: () => null,
  formatTree: (_url, nodes) => nodes,
  getWorkflow: () => null,
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

// Asserts the fail-closed envelope shape:
// { ok:false, error:'site policy check failed', reason, message, [tabId] }
// in result.content[0].text with result.isError === true; nothing recorded
// in site_policy_events, and (when `cmd` is given) that command never sent.
function assertFailClosed(res, reason, cmd) {
  assert.ok(res && res.result, `expected result envelope, got ${JSON.stringify(res)}`);
  assert.equal(res.result.isError, true, `expected isError=true, got ${JSON.stringify(res.result)}`);
  const body = JSON.parse(res.result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'site policy check failed');
  assert.equal(body.reason, reason);
  assert.equal(body.domain, undefined);
  if (cmd) {
    assert.ok(!sentCommands.some((c) => c.cmd === cmd), `${cmd} must not reach the extension`);
  }
  assert.equal(eventRows().length, 0);
  return body;
}

// True only when `res` is the fail-closed policy envelope (used by guard
// tests to assert the CURRENT/legacy paths are untouched).
function isFailClosedEnvelope(res) {
  if (!res || !res.result || res.result.isError !== true) return false;
  try {
    const body = JSON.parse(res.result.content[0].text);
    return !!body && body.ok === false && body.error === 'site policy check failed';
  } catch (e) {
    return false;
  }
}

beforeEach(() => {
  freshDb();
  sitePolicyEvents._resetForTests();
  sentCommands = [];
  connected = true;
  getTabsImpl = async () => ({ tabs: [{ id: 7, url: 'https://www.example.com/x' }] });
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
  assert.equal(body.policySource, 'agent_rule');
  assert.equal(body.tabId, 7);
  assert.ok(!sentCommands.some((c) => c.cmd === 'scroll'), 'scroll must not reach the extension');

  const after = eventRows();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].decision, 'block');
  assert.equal(after[0].source, 'agent_rule');
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
    assert.equal(body.policySource, 'agent_rule');
    assert.ok(!sentCommands.some((c) => c.cmd === 'scroll'), 'blocked scroll must not reach extension');

    assert.equal(calls, 3);
    assert.equal(eventRows().length, 0);
    t.mock.timers.tick(5000);
  } finally {
    sitePolicyEvents.record = origRecord;
  }
});

// ---------------------------------------------------------------------------
// Fail-closed gate cases (issue #100). The [fail-closed] cases are expected
// to fail until the fail-closed implementation lands; the [guard] cases
// protect existing behavior and must pass on current HEAD.
// ---------------------------------------------------------------------------

test('isAllowed throws -> policy_error fail-closed, no command sent [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const origIsAllowed = sitePolicy.isAllowed;
  sitePolicy.isAllowed = () => {
    throw new Error('db down');
  };
  try {
    const h = makeHandler();

    const scrollRes = await callTool(h, 'browser_scroll', { tab_id: 7, direction: 'down' });
    assertFailClosed(scrollRes, 'policy_error', 'scroll');

    sentCommands = [];
    const createRes = await callTool(h, 'browser_create_tab', { url: 'https://www.example.com/a' });
    assertFailClosed(createRes, 'policy_error', 'create_tab');
  } finally {
    sitePolicy.isAllowed = origIsAllowed;
  }
});

test('extension disconnected -> extension_disconnected fail-closed result envelope [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  connected = false;
  const h = makeHandler();
  const res = await callTool(h, 'browser_scroll', { tab_id: 7, direction: 'down' });
  const body = assertFailClosed(res, 'extension_disconnected', 'scroll');
  assert.ok(!res.error, 'must be a result envelope, not a jsonrpc error');
  assert.ok(
    body.message && body.message.includes('No browser instance connected'),
    `expected message to mention "No browser instance connected", got: ${body.message}`
  );
});

test('get_tabs command rejects -> tab_url_unavailable fail-closed [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  getTabsImpl = async () => {
    throw new Error('Command timeout');
  };
  const h = makeHandler();
  const res = await callTool(h, 'browser_scroll', { tab_id: 7, direction: 'down' });
  const body = assertFailClosed(res, 'tab_url_unavailable', 'scroll');
  assert.ok(
    body.message && body.message.includes('Command timeout'),
    `expected message to mention "Command timeout", got: ${body.message}`
  );
});

test('get_tabs returns no tabs -> tab_url_unavailable fail-closed [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  getTabsImpl = async () => ({ tabs: [] });
  const h = makeHandler();
  const res = await callTool(h, 'browser_scroll', { tab_id: 7, direction: 'down' });
  assertFailClosed(res, 'tab_url_unavailable', 'scroll');
});

test('tab_id as a numeric string -> invalid_tab_id fail-closed [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHandler();
  const res = await callTool(h, 'browser_scroll', { tab_id: '7', direction: 'down' });
  assertFailClosed(res, 'invalid_tab_id', 'scroll');
});

test('tab_id as a non-integer number -> invalid_tab_id fail-closed [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHandler();
  const res = await callTool(h, 'browser_scroll', { tab_id: 7.5, direction: 'down' });
  assertFailClosed(res, 'invalid_tab_id', 'scroll');
});

test('missing tab_id on browser_scroll -> invalid_tab_id fail-closed [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHandler();
  const res = await callTool(h, 'browser_scroll', { direction: 'down' });
  assertFailClosed(res, 'invalid_tab_id', 'scroll');
});

test('non-string url on browser_create_tab -> invalid_url fail-closed [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHandler();
  const res = await callTool(h, 'browser_create_tab', { url: ['https://www.example.com'] });
  assertFailClosed(res, 'invalid_url', 'create_tab');
});

test('[guard] empty tab url is allowed by default, no event row', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  getTabsImpl = async () => ({ tabs: [{ id: 7, url: '' }] });
  const h = makeHandler();
  const res = await callTool(h, 'browser_scroll', { tab_id: 7, direction: 'down' });
  assert.ok(!isFailClosedEnvelope(res), `expected a normal (non-policy) response, got: ${JSON.stringify(res)}`);
  assert.ok(sentCommands.some((c) => c.cmd === 'scroll'), 'scroll should have been dispatched');
  assert.equal(eventRows().length, 0);
});

test('chain step whose check throws -> that step is the policy_error envelope, later steps still run [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const origIsAllowed = sitePolicy.isAllowed;
  sitePolicy.isAllowed = () => {
    throw new Error('db down');
  };
  try {
    const h = makeHandler();
    const res = await callTool(h, 'browser_request_chain', {
      steps: [
        { tool: 'browser_scroll', arguments: { tab_id: 7, direction: 'down' } },
        { tool: 'browser_get_tabs', arguments: {} },
      ],
    });
    const body = bodyOf(res);
    assert.ok(Array.isArray(body.results), `expected chain results, got: ${JSON.stringify(body)}`);
    assert.equal(body.results.length, 2);

    const step0 = body.results[0];
    assert.equal(step0.ok, false);
    assert.equal(step0.error, 'site policy check failed');
    assert.equal(step0.reason, 'policy_error');

    const step1 = body.results[1];
    assert.ok(step1, 'step 1 should have run and produced a result');

    assert.ok(!sentCommands.some((c) => c.cmd === 'scroll'), 'scroll must not reach the extension');
  } finally {
    sitePolicy.isAllowed = origIsAllowed;
  }
});

test('webpilot_run_workflow with no tab_id -> invalid_tab_id fail-closed [fail-closed]', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHandler();
  const res = await callTool(h, 'webpilot_run_workflow', { platform: 'x', workflow: 'y' });
  assertFailClosed(res, 'invalid_tab_id');
});

test('[guard] disconnected extension: checkpoint-A still records event and does not return the policy envelope', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  connected = false;
  const h = makeHandler();
  const res = await callTool(h, 'browser_create_tab', { url: 'https://www.example.com' });
  assert.ok(!isFailClosedEnvelope(res), `expected the legacy path, got: ${JSON.stringify(res)}`);
  const sentCreateTab = sentCommands.some((c) => c.cmd === 'create_tab');
  const mentionsDisconnected =
    (res.error && /No browser instance/.test(res.error.message || '')) ||
    (res.result && JSON.stringify(res.result).includes('No browser instance'));
  assert.ok(
    sentCreateTab || mentionsDisconnected,
    `expected either a dispatched create_tab or a "No browser instance" error, got: ${JSON.stringify(res)}`
  );
  const rows = eventRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, 'example.com');
  assert.equal(rows[0].decision, 'allow');
  assert.equal(rows[0].source, 'default');
});

test('[guard] disconnected extension: browser_get_tabs/browser_close_tab never fail-closed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  connected = false;
  const h = makeHandler();

  const getTabsRes = await callTool(h, 'browser_get_tabs', {});
  assert.ok(!isFailClosedEnvelope(getTabsRes), `expected the legacy path, got: ${JSON.stringify(getTabsRes)}`);

  const closeTabRes = await callTool(h, 'browser_close_tab', { tab_id: 7 });
  assert.ok(!isFailClosedEnvelope(closeTabRes), `expected the legacy path, got: ${JSON.stringify(closeTabRes)}`);

  const origIsAllowed = sitePolicy.isAllowed;
  sitePolicy.isAllowed = () => {
    throw new Error('db down');
  };
  try {
    const closeTabRes2 = await callTool(h, 'browser_close_tab', { tab_id: 7 });
    const isPolicyError =
      closeTabRes2.result &&
      closeTabRes2.result.isError === true &&
      (() => {
        try {
          return JSON.parse(closeTabRes2.result.content[0].text).reason === 'policy_error';
        } catch (e) {
          return false;
        }
      })();
    assert.ok(!isPolicyError, `browser_close_tab must not surface a policy_error, got: ${JSON.stringify(closeTabRes2)}`);
  } finally {
    sitePolicy.isAllowed = origIsAllowed;
  }
});
