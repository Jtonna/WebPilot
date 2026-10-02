'use strict';

// Issue #114: webpilot_run_workflow exposes `browser` primitives to workflow
// code via buildBrowserPrimitives(apiKey). Those primitives must re-apply the
// site-policy gate (mirroring browser_request_chain's per-step re-check) so a
// workflow cannot open arbitrary URLs or act on unchecked tabs and bypass site
// blocks. A blocked primitive throws, and webpilot_run_workflow's try/catch
// surfaces it as a failed step (ok:false, isError:true).
//
// Uses the REAL site-policy / site-policy-events modules against an in-memory
// SQLite DB; everything else is stubbed via the same Module._load harness as
// site-policy-events-gate.test.js.

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
  recordError: () => ({ id: 'incident-1' }),
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
const sitePolicy = require('../src/site-policy');

// ---- fakes ----
let sentCommands = [];
let connected = true;
// Tab 7 is an allowed site (used as the OUTER workflow tab_id so the outer
// webpilot_run_workflow gate passes); tab 8 resolves to a blocked site.
let getTabsImpl = async () => ({
  tabs: [
    { id: 7, url: 'https://www.example.com/x' },
    { id: 8, url: 'https://www.blocked.com/y' },
  ],
});
const fakeBridge = {
  isConnected: (_profileId) => connected,
  sendCommand: async (_profileId, cmd, args) => {
    sentCommands.push({ cmd, args });
    if (cmd === 'get_tabs') return getTabsImpl();
    if (cmd === 'create_tab') return { tab_id: 99 };
    return {};
  },
};

// Configurable workflow registry: set `currentWorkflow` per test.
let currentWorkflow = null;
const fm = {
  getFormatterNameForUrl: () => null,
  formatTree: (_url, nodes) => nodes,
  getWorkflow: (_platform, _name) => currentWorkflow,
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
  connected = true;
  currentWorkflow = null;
  getTabsImpl = async () => ({
    tabs: [
      { id: 7, url: 'https://www.example.com/x' },
      { id: 8, url: 'https://www.blocked.com/y' },
    ],
  });
});

// Checkpoint A: a workflow calling browser.createTab({url:<blocked>}) is
// blocked before the create_tab command reaches the extension, and surfaces
// as a failed step.
test('workflow createTab to a blocked url -> blocked at checkpoint A, failed step', async () => {
  seedAgentBlock('blocked.com');
  currentWorkflow = {
    parameters: {},
    run: async ({ browser }) => {
      const t = await browser.createTab({ url: 'https://www.blocked.com/landing' });
      return { openedTab: t };
    },
  };
  const res = await callTool(prime(), 'webpilot_run_workflow', {
    platform: 'p',
    workflow: 'w',
    tab_id: 7,
    params: {},
  });
  const body = bodyOf(res);
  assert.equal(res.result.isError, true, 'blocked workflow must be an error envelope');
  assert.equal(body.ok, false);
  assert.match(body.error, /site policy/i, `error should mention site policy, got: ${body.error}`);
  assert.match(body.error, /blocked\.com/, `error should name the blocked domain, got: ${body.error}`);
  assert.ok(
    !sentCommands.some((c) => c.cmd === 'create_tab'),
    'blocked create_tab must not reach the extension'
  );
});

// Checkpoint B: a workflow calling browser.click on a tab that resolves to a
// blocked site is blocked before the click reaches the extension, surfacing as
// a failed step.
test('workflow click on a tab resolving to a blocked site -> blocked at checkpoint B, failed step', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  seedAgentBlock('blocked.com');
  currentWorkflow = {
    parameters: {},
    run: async ({ browser }) => {
      // tab 8 resolves (via get_tabs) to https://www.blocked.com/y
      const r = await browser.click({ tab_id: 8, x: 10, y: 10 });
      return { clicked: r };
    },
  };
  const res = await callTool(prime(), 'webpilot_run_workflow', {
    platform: 'p',
    workflow: 'w',
    tab_id: 7,
    params: {},
  });
  const body = bodyOf(res);
  assert.equal(res.result.isError, true);
  assert.equal(body.ok, false);
  assert.match(body.error, /site policy/i, `error should mention site policy, got: ${body.error}`);
  assert.ok(
    !sentCommands.some((c) => c.cmd === 'click'),
    'blocked click must not reach the extension'
  );
  // Drain the checkpoint-B auto-close timer so the process does not wait on it.
  t.mock.timers.tick(5000);
});

// A workflow that only touches allowed sites runs to completion with no false
// block: createTab (allowed url) and click (allowed tab 7) both dispatch.
test('workflow acting only on allowed sites -> succeeds, no false block', async () => {
  currentWorkflow = {
    parameters: {},
    run: async ({ browser }) => {
      const t = await browser.createTab({ url: 'https://www.example.com/landing' });
      const c = await browser.click({ tab_id: 7, x: 5, y: 5 });
      return { openedTab: t, clicked: c, done: true };
    },
  };
  const res = await callTool(prime(), 'webpilot_run_workflow', {
    platform: 'p',
    workflow: 'w',
    tab_id: 7,
    params: {},
  });
  const body = bodyOf(res);
  assert.equal(res.result && res.result.isError, undefined, 'allowed workflow must not be an error');
  assert.equal(body.ok, true, `expected ok:true, got: ${JSON.stringify(body)}`);
  assert.equal(body.done, true);
  assert.ok(sentCommands.some((c) => c.cmd === 'create_tab'), 'allowed create_tab should dispatch');
  assert.ok(sentCommands.some((c) => c.cmd === 'click'), 'allowed click should dispatch');
});

// Helper: returns a handler (named for readability at call sites).
function prime() {
  return makeHandler();
}
