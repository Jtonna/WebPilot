'use strict';

// Issue #132: browser_create_tab maps each ChromeManager.ensureReady outcome
// to one result. ensureReady owns the only connect wait; the handler must not
// add its own. When Chrome was spawned with the URL, the handler finds the tab
// Chrome opened via get_tabs instead of calling create_tab (no double open).
//
// ChromeManager and the extension bridge are fakes; nothing launches Chrome.
// site-policy is stubbed to allow everything (the gate is covered elsewhere).

const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

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

const fakePairedKeys = {
  validateKey: (key) =>
    key === 'k1' ? { id: 1, key: 'h1', profileId: 'Default', agentName: 'A' } : null,
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
stubs['./site-policy'] = {
  resolveAgentIdFromApiKey: () => 1,
  isAllowed: (_agentId, url) => ({ allowed: true, domain: null, url }),
};
stubs['./site-policy-events'] = { record: () => {}, _resetForTests: () => {} };
stubs['./service/paths'] = {
  getFormatterDir: () => '/fake',
  getDataDir: () => '/fake',
  getPort: () => 3456,
  loadConfig: () => ({ managedProfile: 'Default' }),
};

delete require.cache[require.resolve('../src/mcp-handler')];
const { createMcpHandler } = require('../src/mcp-handler');

// ---- fakes ----
let sent;
let connected;
let getTabsImpl;
let ensureCalls;
let ensureImpl;

const fakeBridge = {
  isConnected: () => connected,
  sendCommand: async (profileId, cmd, args) => {
    sent.push({ profileId, cmd, args });
    if (cmd === 'get_tabs') return getTabsImpl();
    if (cmd === 'create_tab') return { tab_id: 99, url: args.url, title: '' };
    return {};
  },
};
const fakeChromeManager = {
  ensureReady: async (profiles, opts) => {
    ensureCalls.push({ profiles, opts });
    return ensureImpl(profiles, opts);
  },
};
const fm = {
  getFormatterNameForUrl: () => null,
  formatTree: (_url, nodes) => nodes,
  getWorkflow: () => null,
};

function makeHandler() {
  return createMcpHandler(fakeBridge, fakePairedKeys, fm, () => true, {
    chromeManager: fakeChromeManager,
    tabDiscoveryTimeoutMs: 30,
    tabDiscoveryPollMs: 5,
  });
}

let nextId = 1;
function createTab(url) {
  return makeHandler().processRequest(
    { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'browser_create_tab', arguments: { url } } },
    'k1'
  );
}
function bodyOf(res) {
  assert.ok(res && res.result, `expected result envelope, got ${JSON.stringify(res)}`);
  return JSON.parse(res.result.content[0].text);
}
function errorOf(res) {
  assert.ok(res && res.error, `expected error, got ${JSON.stringify(res)}`);
  return res.error.message;
}
const cmds = (name) => sent.filter((c) => c.cmd === name);

beforeEach(() => {
  sent = [];
  connected = true;
  ensureCalls = [];
  getTabsImpl = async () => [];
  ensureImpl = async () => ({ action: 'noop', launched: [], urlLaunched: false, connected: true });
});

afterEach(() => {
  mock.timers.reset();
});

test('noop / connected → create_tab called once', async () => {
  const res = await createTab('https://example.com/a');
  const body = bodyOf(res);
  assert.equal(body.tab_id, 99);
  assert.equal(cmds('create_tab').length, 1);
  assert.equal(cmds('get_tabs').length, 0);
  assert.equal(ensureCalls.length, 1);
  assert.deepEqual(ensureCalls[0].profiles, ['Default']);
  assert.equal(ensureCalls[0].opts.url, 'https://example.com/a');
  assert.equal(ensureCalls[0].opts.waitForConnect, true);
});

test('URL launched → tab found via get_tabs, create_tab NOT called', async () => {
  ensureImpl = async () => ({
    action: 'launch-additional',
    launched: [{ profileDirectory: 'Default', pid: 1, url: 'https://example.com/a' }],
    urlLaunched: true,
    connected: true,
  });
  getTabsImpl = async () => [
    { id: 3, url: 'https://other.com/', title: 'Other', active: false },
    { id: 7, url: 'HTTPS://Example.com/a/', title: 'Example', active: true },
  ];
  const body = bodyOf(await createTab('https://example.com/a'));
  assert.equal(body.tab_id, 7);
  assert.equal(body.title, 'Example');
  assert.equal(body.opened_by_chrome_launch, true);
  assert.equal(cmds('create_tab').length, 0);
});

test('URL launched → matches pendingUrl while the tab is still loading', async () => {
  ensureImpl = async () => ({ action: 'launch', launched: [], urlLaunched: true, connected: true });
  getTabsImpl = async () => [
    { id: 4, url: '', pendingUrl: 'https://example.com/a', title: '' },
    { id: 5, url: 'https://restored.com/', title: 'r' },
  ];
  const body = bodyOf(await createTab('https://example.com/a'));
  assert.equal(body.tab_id, 4);
  assert.equal(cmds('create_tab').length, 0);
});

test('URL launched → redirect accepted when the profile has exactly one tab', async () => {
  ensureImpl = async () => ({ action: 'launch', launched: [], urlLaunched: true, connected: true });
  getTabsImpl = async () => [{ id: 6, url: 'https://www.example.com/landing', title: 'x' }];
  const body = bodyOf(await createTab('https://example.com/a'));
  assert.equal(body.tab_id, 6);
  assert.equal(cmds('create_tab').length, 0);
});

test('URL launched but no matching tab → fallback create_tab once', async () => {
  ensureImpl = async () => ({ action: 'restart', launched: [], urlLaunched: true, connected: true });
  getTabsImpl = async () => [
    { id: 1, url: 'https://restored-one.com/' },
    { id: 2, url: 'https://restored-two.com/' },
  ];
  const body = bodyOf(await createTab('https://example.com/a'));
  assert.equal(body.tab_id, 99);
  assert.equal(cmds('create_tab').length, 1);
  assert.ok(cmds('get_tabs').length >= 1);
});

test('partial → "not connected within Ns" error that never says to call browser_create_tab', async () => {
  connected = false;
  ensureImpl = async () => ({
    action: 'partial',
    launched: [{ profileDirectory: 'Default', pid: 1 }],
    urlLaunched: true,
    connected: false,
    stillMissing: ['Default'],
    budgetMs: 10000,
  });
  const msg = errorOf(await createTab('https://example.com/a'));
  assert.equal(
    msg,
    "Chrome is running for profile 'Default' but the WebPilot extension has not connected within 10s. " +
      'It may still be starting — retry in a few seconds. If this persists, check chrome://extensions.'
  );
  assert.ok(!/call browser_create_tab/i.test(msg));
  assert.equal(sent.length, 0);
});

test('launch timed out (connected:false) → same not-connected error', async () => {
  connected = false;
  ensureImpl = async () => ({ action: 'launch', launched: [], urlLaunched: true, connected: false, budgetMs: 15000 });
  const msg = errorOf(await createTab('https://example.com/a'));
  assert.match(msg, /has not connected within 15s/);
  assert.ok(!/call browser_create_tab/i.test(msg));
});

test('abort chrome_state_unknown → unknown-state error, nothing sent', async () => {
  ensureImpl = async () => ({
    action: 'abort',
    launched: [],
    unknown: true,
    reason: 'chrome_state_unknown',
    message: 'could not determine whether Chrome is running (process scan failed): ps down',
  });
  const msg = errorOf(await createTab('https://example.com/a'));
  assert.match(msg, /Could not determine whether Chrome is running for profile 'Default'/);
  assert.ok(!/call browser_create_tab/i.test(msg));
  assert.equal(sent.length, 0);
});

test('other abort → its reason is surfaced', async () => {
  ensureImpl = async () => ({ action: 'abort', launched: [], reason: 'graceful close timed out; remaining=12' });
  const msg = errorOf(await createTab('https://example.com/a'));
  assert.match(msg, /graceful close timed out; remaining=12/);
});

test('invalid URL is rejected before ensureReady (nothing launched)', async () => {
  const msg = errorOf(await createTab('chrome://settings'));
  assert.match(msg, /only http\(s\) URLs/);
  assert.equal(ensureCalls.length, 0);
});

test('scheme-less URL is normalized for the launch', async () => {
  await createTab('example.com/x');
  assert.equal(ensureCalls[0].opts.url, 'https://example.com/x');
  // create_tab still gets the agent's original value (the extension normalizes it).
  assert.equal(cmds('create_tab')[0].args.url, 'example.com/x');
});

test('handler does no wait of its own: a partial resolves with frozen timers', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  connected = false;
  ensureImpl = async () => ({ action: 'partial', launched: [], urlLaunched: false, connected: false, budgetMs: 10000 });
  // Timers never advance: if the handler slept/polled anywhere, this would hang.
  const res = await createTab('https://example.com/a');
  assert.match(errorOf(res), /has not connected within 10s/);
});

test('handler does no wait of its own: launch + connected goes straight to create_tab', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  ensureImpl = async () => ({ action: 'launch', launched: [], urlLaunched: false, connected: true });
  const body = bodyOf(await createTab('https://example.com/a'));
  assert.equal(body.tab_id, 99);
  assert.equal(cmds('create_tab').length, 1);
});

test('other tools: disconnected message points at Chrome or browser_create_tab', async () => {
  connected = false;
  const res = await makeHandler().processRequest(
    { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'browser_get_tabs', arguments: {} } },
    'k1'
  );
  assert.equal(
    errorOf(res),
    "No browser instance connected for profile 'Default'. Open Chrome on that profile, or call browser_create_tab to launch it."
  );
});
