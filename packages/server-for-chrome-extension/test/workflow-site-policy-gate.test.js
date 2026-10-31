'use strict';

// Issue #114: webpilot_run_workflow exposes `browser` primitives to workflow
// code via buildBrowserPrimitives(apiKey). Those primitives must re-apply the
// site-policy gate (mirroring browser_request_chain's per-step re-check) so a
// workflow cannot open arbitrary URLs or act on unchecked tabs and bypass site
// blocks. A blocked primitive throws; webpilot_run_workflow returns the
// standard policy envelope (as a direct tool call would) and never records the
// block as a formatter error (#131).
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
  // validateKey resolves the acting key to the seeded agent row (id=1).
  // `id` satisfies #129's resolveAgentIdFromApiKey (which reads entry.id);
  // `key` (the api_key_hash) keeps the pre-#129 hash-lookup path resolving
  // too, so this fixture matches the agent on both contracts.
  validateKey: (key) =>
    key === 'k1' ? { id: 1, key: 'h1', profileId: 'default', agentName: 'A' } : null,
  touchKey: () => {},
};
stubs['./paired-keys'] = fakePairedKeys;
stubs['./lib/mcp-config-template'] = { buildMcpConfigJson: () => '{}' };
stubs['./lib/tree-query'] = { findInTree: () => null };
// recordError / buildDiagnostics are spies (reset in beforeEach): a policy
// outcome must never reach them, since any recorded error lowers formatter
// health.
const formatterLogCalls = { recordError: [], buildDiagnostics: [] };
stubs['./formatter-logs'] = {
  recordSuccess: () => {},
  recordError: (...a) => {
    formatterLogCalls.recordError.push(a);
    return { id: 'incident-1' };
  },
  getStatus: () => ({}),
  getLogs: () => [],
  buildDiagnostics: (...a) => {
    formatterLogCalls.buildDiagnostics.push(a);
    return {};
  },
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
function runWorkflow(outerTabId = 7) {
  return callTool(prime(), 'webpilot_run_workflow', {
    platform: 'p',
    workflow: 'w',
    tab_id: outerTabId,
    params: {},
  });
}
function assertNotFormatterError() {
  assert.equal(formatterLogCalls.recordError.length, 0, 'policy outcome must not be recorded as a formatter error');
  assert.equal(formatterLogCalls.buildDiagnostics.length, 0, 'policy outcome must not build formatter diagnostics');
}
// Standard checkpoint-B blocked envelope for tab 8 (blocked.com).
function assertBlockedAtB(res) {
  const body = bodyOf(res);
  assert.equal(res.result.isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'site blocked by policy');
  assert.equal(body.domain, 'blocked.com');
  assert.equal(body.tabId, 8);
  assert.ok(body.tabWillCloseAt, 'expected tabWillCloseAt');
  assert.equal(body.tabCloseInSeconds, 5);
  assertNotFormatterError();
  return body;
}

beforeEach(() => {
  freshDb();
  sitePolicyEvents._resetForTests();
  sentCommands = [];
  connected = true;
  currentWorkflow = null;
  formatterLogCalls.recordError = [];
  formatterLogCalls.buildDiagnostics = [];
  getTabsImpl = async () => ({
    tabs: [
      { id: 7, url: 'https://www.example.com/x' },
      { id: 8, url: 'https://www.blocked.com/y' },
    ],
  });
});

// Checkpoint A: a workflow calling browser.createTab({url:<blocked>}) is
// blocked before the create_tab command reaches the extension, and returns the
// standard blocked envelope (no tabId: nothing was opened, nothing to close).
test('workflow createTab to a blocked url -> blocked envelope at checkpoint A', async () => {
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
  assert.equal(body.error, 'site blocked by policy');
  assert.equal(body.domain, 'blocked.com');
  assert.equal(body.tabId, undefined, 'checkpoint A has no tab to close');
  assert.equal(body.diagnostics, undefined, 'policy block must not carry formatter diagnostics');
  assertNotFormatterError();
  assert.ok(
    !sentCommands.some((c) => c.cmd === 'create_tab'),
    'blocked create_tab must not reach the extension'
  );
});

// Checkpoint B: a workflow calling browser.click on a tab that resolves to a
// blocked site is blocked before the click reaches the extension, returning the
// standard blocked envelope including the auto-close countdown.
test('workflow click on a tab resolving to a blocked site -> blocked envelope at checkpoint B', async (t) => {
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
  assertBlockedAtB(res);
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
  assert.equal(body.policyBlocked, undefined, 'allowed run must not report policyBlocked');
  assertNotFormatterError();
  assert.ok(sentCommands.some((c) => c.cmd === 'create_tab'), 'allowed create_tab should dispatch');
  assert.ok(sentCommands.some((c) => c.cmd === 'click'), 'allowed click should dispatch');
});

// The other checkpoint-B primitives (#131 coverage): each blocked call returns
// the same envelope and never reaches the extension.
for (const [prim, cmd, args] of [
  ['type', 'type', { tab_id: 8, text: 'hi' }],
  ['scroll', 'scroll', { tab_id: 8, pixels: 100 }],
  ['getAccessibilityTree', 'get_accessibility_tree', { tab_id: 8 }],
]) {
  test(`workflow ${prim} on a blocked tab -> blocked envelope at checkpoint B`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    seedAgentBlock('blocked.com');
    currentWorkflow = {
      parameters: {},
      run: async ({ browser }) => {
        await browser[prim](args);
        return { done: true };
      },
    };
    assertBlockedAtB(await runWorkflow());
    assert.ok(!sentCommands.some((c) => c.cmd === cmd), `blocked ${prim} must not reach the extension`);
    t.mock.timers.tick(5000);
  });
}

// The extension drops mid-run. The outer gate (tab 7) already passed, so the
// disconnect happens inside run(): the step fails closed with the
// policy-unavailable envelope.
test('workflow step after the extension disconnects -> site policy check failed', async () => {
  currentWorkflow = {
    parameters: {},
    run: async ({ browser }) => {
      connected = false;
      await browser.click({ tab_id: 7, x: 1, y: 1 });
      return { done: true };
    },
  };
  const res = await runWorkflow();
  const body = bodyOf(res);
  assert.equal(res.result.isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'site policy check failed');
  assert.equal(body.reason, 'extension_disconnected');
  assert.equal(body.tabId, 7);
  assertNotFormatterError();
  assert.ok(!sentCommands.some((c) => c.cmd === 'click'), 'click must not reach the extension');
});

test('workflow step without tab_id -> invalid_tab_id envelope', async () => {
  currentWorkflow = {
    parameters: {},
    run: async ({ browser }) => {
      await browser.click({ x: 1, y: 1 });
      return { done: true };
    },
  };
  const res = await runWorkflow();
  const body = bodyOf(res);
  assert.equal(res.result.isError, true);
  assert.equal(body.error, 'site policy check failed');
  assert.equal(body.reason, 'invalid_tab_id');
  assertNotFormatterError();
  assert.ok(!sentCommands.some((c) => c.cmd === 'click'), 'click must not reach the extension');
});

// A workflow that catches the block and carries on still succeeds, but the
// response reports the refused step as policyBlocked.
test('workflow that swallows a block -> ok:true with policyBlocked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  seedAgentBlock('blocked.com');
  currentWorkflow = {
    parameters: {},
    run: async ({ browser }) => {
      try {
        await browser.click({ tab_id: 8, x: 1, y: 1 });
      } catch (_e) { /* carry on */ }
      return { done: true };
    },
  };
  const res = await runWorkflow();
  const body = bodyOf(res);
  assert.equal(res.result.isError, undefined);
  assert.equal(body.ok, true);
  assert.equal(body.done, true);
  assert.ok(body.policyBlocked, 'expected policyBlocked');
  assert.equal(body.policyBlocked.error, 'site blocked by policy');
  assert.equal(body.policyBlocked.domain, 'blocked.com');
  assert.equal(body.policyBlocked.tabId, 8);
  assertNotFormatterError();
  t.mock.timers.tick(5000);
});

// The workflow re-wraps the block with `cause`: the envelope is found on the
// cause chain.
test('workflow that rethrows a block wrapped with cause -> blocked envelope', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  seedAgentBlock('blocked.com');
  currentWorkflow = {
    parameters: {},
    run: async ({ browser }) => {
      try {
        await browser.click({ tab_id: 8, x: 1, y: 1 });
      } catch (err) {
        throw new Error('wrapped', { cause: err });
      }
      return { done: true };
    },
  };
  assertBlockedAtB(await runWorkflow());
  t.mock.timers.tick(5000);
});

// The workflow throws a fresh error without `cause`: the per-run tracker still
// knows a step was blocked, so the run is reported as a policy outcome.
test('workflow that rethrows a block without cause -> tracked blocked envelope', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  seedAgentBlock('blocked.com');
  currentWorkflow = {
    parameters: {},
    run: async ({ browser }) => {
      try {
        await browser.click({ tab_id: 8, x: 1, y: 1 });
      } catch (_e) {
        throw new Error('step failed');
      }
      return { done: true };
    },
  };
  assertBlockedAtB(await runWorkflow());
  t.mock.timers.tick(5000);
});

// Non-policy failures keep the existing formatter-error path.
test('workflow that throws a plain error -> recorded as a formatter error', async () => {
  currentWorkflow = {
    parameters: {},
    run: async () => {
      throw new Error('selector not found');
    },
  };
  const res = await runWorkflow();
  const body = bodyOf(res);
  assert.equal(res.result.isError, true);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'selector not found');
  assert.ok('diagnostics' in body, 'expected formatter diagnostics');
  assert.equal(formatterLogCalls.recordError.length, 1, 'plain failure must be recorded');
  assert.equal(formatterLogCalls.buildDiagnostics.length, 1);
});

// Helper: returns a handler (named for readability at call sites).
function prime() {
  return makeHandler();
}
