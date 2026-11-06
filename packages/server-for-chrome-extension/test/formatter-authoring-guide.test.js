'use strict';

// Issue #163: the formatter authoring guide (webpilot_get_formatter_info ->
// howToCreateCustomFormatter) must cover workflows, the per-platform manifest
// and page-side node resolution, and the MCP instructions / tool descriptions
// must point agents at it. The guide's code samples must actually run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const vm = require('node:vm');

// ---- stub registry (mcp-handler pulls in several heavy modules) ----
const stubs = {};
const originalLoad = Module._load;
Module._load = function (request) {
  const key = request.replace(/\\/g, '/');
  for (const [pattern, stub] of Object.entries(stubs)) {
    if (key === pattern || key.endsWith('/' + pattern)) return stub;
  }
  return originalLoad.apply(this, arguments);
};
stubs['./lib/mcp-config-template'] = { buildMcpConfigJson: () => '{}' };
stubs['./formatter-logs'] = {
  recordSuccess: () => {},
  recordError: () => ({ id: 'x' }),
  getStatus: () => ({}),
  getLogs: () => [],
  buildDiagnostics: () => ({}),
};
stubs['./site-policy'] = {
  resolveAgentIdFromApiKey: () => 1,
  isAllowed: (_a, url) => ({ allowed: true, domain: null, url }),
};
stubs['./site-policy-events'] = { record: () => {}, _resetForTests: () => {} };

delete require.cache[require.resolve('../src/mcp-handler')];
const { createMcpHandler } = require('../src/mcp-handler');
const formatterManager = require('../src/formatter-manager');

const guide = formatterManager.getFormatterInfo().howToCreateCustomFormatter;

test('guide has workflows section with files, export rule, declaration and primitives', () => {
  const w = guide.workflows;
  assert.ok(w, 'workflows section');
  assert.match(w.files, /workflows\.js/);
  assert.match(w.exportRule, /EVERY export/);
  assert.match(w.declaration, /manifest/);
  assert.match(w.declaration, /parameters/);
  assert.match(w.runSignature, /params, browser, tabId, findInTree/);
  const prims = w.browserPrimitives.join('\n');
  for (const name of ['getAccessibilityTree', 'click', 'type', 'scroll', 'getTabs', 'createTab', 'resolveRefs']) {
    assert.ok(prims.includes('browser.' + name), 'primitive ' + name);
  }
  assert.match(w.sitePolicy, /site policy/);
  assert.match(w.conventions.join('\n'), /pending: true/);
  assert.match(w.findInTree, /name_starts_with/);
});

test('guide has platformManifest section describing notes, custom suffix and shadowing', () => {
  const m = guide.platformManifest;
  assert.ok(m, 'platformManifest section');
  for (const f of ['name', 'version', 'match', 'description', 'notes', 'errorHandling', 'workflows']) {
    assert.ok(f in m.fields, 'field ' + f);
  }
  assert.match(m.fields.notes, /webpilot_get_formatter_info/);
  assert.match(m.fields.version, /-custom/);
  assert.match(m.shadowing, /shadowedRemote/);
  const parsed = JSON.parse(m.example.join('\n'));
  assert.equal(parsed.name, 'mysite');
  assert.equal(parsed.workflows[0].name, 'open_item');
});

test('stale guide text is fixed', () => {
  assert.match(guide.customFormatters.step4, /webpilot_reload_formatters/);
  assert.doesNotMatch(guide.customFormatters.step4, /Restart the server/);
  assert.match(guide.functionSignature, /ONLY/);
  assert.match(guide.functionSignature, /RootWebArea/);
});

test('nodeResolution has rules, limits and a runnable example with a non-enumerable __resolve', () => {
  const n = guide.nodeResolution;
  assert.ok(Array.isArray(n.rules) && n.rules.length >= 5);
  assert.match(n.rules.join('\n'), /self-contained/);
  assert.match(n.rules.join('\n'), /localStorage/);
  assert.match(n.workflows, /browser\.resolveRefs/);

  const mod = { exports: {} };
  vm.runInNewContext(n.example.join('\n'), { module: mod, Object, JSON }, { filename: 'guide-example.js' });
  const format = mod.exports;
  assert.equal(typeof format, 'function');

  const nodes = [
    { role: { value: 'link' }, name: { value: 'Alpha' }, backendDOMNodeId: 7 },
    { role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 8 },
    { role: { value: 'link' }, name: { value: 'Hidden' }, backendDOMNodeId: 9, ignored: true },
  ];
  const result = format(nodes);
  assert.equal(result.elementCount, 2);
  assert.ok(!Object.keys(result).includes('__resolve'), '__resolve must be non-enumerable');
  assert.ok(!('__resolve' in JSON.parse(JSON.stringify(result))));

  const spec = result.__resolve;
  assert.equal(JSON.stringify(spec.requests), JSON.stringify([{ key: 'e1', backendNodeId: 7, resolver: 'itemId' }]));
  assert.equal(typeof spec.resolvers.itemId, 'string');

  // The resolver source runs with this = element and is self-contained.
  const resolver = vm.runInNewContext('(' + spec.resolvers.itemId + ')');
  assert.equal(resolver.call({ getAttribute: () => 'abc' }), 'abc');
  assert.equal(resolver.call({ getAttribute: () => { throw new Error('x'); } }), null);

  const applied = spec.apply({ e1: 'abc' });
  assert.match(applied.tree, /\[e1\] link: Alpha \[id=abc\]/);
  assert.ok(!Object.keys(applied).includes('__resolve'));
  assert.ok(!Object.getOwnPropertyDescriptor(applied, '__resolve'));
  assert.equal(JSON.stringify(applied.refs), JSON.stringify(result.refs));
  assert.doesNotMatch(result.tree, /\[id=/, 'base tree stays valid without resolution');
});

test('workflow skeleton in the guide is a valid workflow module', async () => {
  const mod = { exports: {} };
  vm.runInNewContext(guide.workflows.skeleton.join('\n'), { module: mod }, { filename: 'skeleton.js' });
  const wf = mod.exports.open_item;
  assert.equal(typeof wf.description, 'string');
  assert.equal(wf.parameters.name.type, 'string');
  const { findInTree } = require('../src/lib/tree-query');
  const calls = [];
  const out = await wf.run({
    params: { name: 'alp' },
    tabId: 3,
    findInTree,
    browser: {
      getAccessibilityTree: async () => ({ tree: '[e1] link: Alpha\n[e2] button: Go', refs: {} }),
      click: async (a) => { calls.push(a); },
    },
  });
  assert.equal(JSON.stringify(calls), JSON.stringify([{ tab_id: 3, ref: 'e1' }]));
  assert.equal(out.clicked, '[e1] link: Alpha');
  const bad = await wf.run({ params: {}, tabId: 3, findInTree, browser: {} });
  assert.equal(bad.ok, false);
});

test('MCP instructions and tool descriptions point at the guide', async () => {
  const handler = createMcpHandler({ isConnected: () => false }, { validateKey: () => null, touchKey: () => {} }, formatterManager, () => false, {});
  const init = await handler.processRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null);
  const ins = init.result.instructions;
  assert.match(ins, /Building a formatter for a new site/);
  assert.match(ins, /howToCreateCustomFormatter/);
  assert.match(ins, /__resolve/);
  assert.match(ins, /browser\.resolveRefs/);

  const list = await handler.processRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, null);
  const byName = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  assert.match(byName.webpilot_get_formatter_info.description, /howToCreateCustomFormatter/);
  assert.match(byName.webpilot_get_formatter_info.description, /node resolution/);
  assert.match(byName.webpilot_run_workflow.description, /workflows\.js/);
  assert.match(byName.webpilot_run_workflow.description, /howToCreateCustomFormatter\.workflows/);
});
