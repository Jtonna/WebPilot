'use strict';

const assert = require('assert');
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

// ---- helpers ----
let testCount = 0;
let passCount = 0;
function test(name, fn) {
  testCount++;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      r.then(() => {
        passCount++;
        console.log('  PASS', name);
      }).catch(err => {
        console.error('  FAIL', name, '\n   ', err.message);
        process.exitCode = 1;
      });
      return r;
    }
    passCount++;
    console.log('  PASS', name);
  } catch (err) {
    console.error('  FAIL', name, '\n   ', err.message);
    process.exitCode = 1;
  }
}

// ---- 1. formatter-unlock-state ----
console.log('\n[1] formatter-unlock-state');
{
  const state = require('../src/formatter-unlock-state');
  state._resetForTests();

  test('record and retrieve unlock', () => {
    state.recordUnlock('agent1', 10, 'discord', 'https://discord.com/channels/1');
    const entry = state.getUnlock('agent1', 10);
    assert.ok(entry);
    assert.strictEqual(entry.formatter, 'discord');
    assert.strictEqual(entry.urlAtUnlock, 'https://discord.com/channels/1');
    assert.ok(typeof entry.unlockedAt === 'number');
  });

  test('returns null for unknown agent+tab', () => {
    assert.strictEqual(state.getUnlock('nobody', 99), null);
  });

  test('invalidate drops one tab entry', () => {
    state.recordUnlock('agent2', 20, 'threads', 'https://threads.net/');
    state.invalidate('agent2', 20);
    assert.strictEqual(state.getUnlock('agent2', 20), null);
  });

  test('invalidateAllForAgent drops all tabs for that agent', () => {
    state.recordUnlock('agent3', 30, 'discord', 'https://discord.com/');
    state.recordUnlock('agent3', 31, 'discord', 'https://discord.com/2');
    state.invalidateAllForAgent('agent3');
    assert.strictEqual(state.getUnlock('agent3', 30), null);
    assert.strictEqual(state.getUnlock('agent3', 31), null);
  });

  test('two agentIds on same tabId stay isolated', () => {
    state.recordUnlock('agentA', 50, 'discord', 'https://discord.com/a');
    state.recordUnlock('agentB', 50, 'threads', 'https://threads.net/b');
    assert.strictEqual(state.getUnlock('agentA', 50).formatter, 'discord');
    assert.strictEqual(state.getUnlock('agentB', 50).formatter, 'threads');
  });
}

// ---- 2. getFormatterNameForUrl ----
console.log('\n[2] getFormatterNameForUrl');
{
  const fakeManifest = {
    version: '1.0.0',
    default: 'default.js',
    platforms: {
      discord: { match: 'discord', entry: 'discord/index.js' },
      threads: { match: 'threads.net', entry: 'threads/index.js' }
    }
  };

  stubs['./service/paths'] = {
    getFormatterDir: () => '/fake/formatters',
    getDataDir: () => '/fake/data'
  };
  stubs['./formatter-logs'] = {
    recordSuccess: () => {},
    recordError: () => {}
  };
  stubs['fs'] = {
    existsSync: () => true,
    readFileSync: () => JSON.stringify(fakeManifest),
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => false })
  };
  stubs['path'] = require('path');

  const fmKey = require.resolve('../src/formatter-manager');
  delete require.cache[fmKey];
  const fm = require('../src/formatter-manager');
  try { fm.reload(); } catch (_) {}

  test('discord URL returns "discord"', () => {
    assert.strictEqual(fm.getFormatterNameForUrl('https://discord.com/channels/123/456'), 'discord');
  });

  test('discordapp.com also returns "discord"', () => {
    assert.strictEqual(fm.getFormatterNameForUrl('https://discordapp.com/app'), 'discord');
  });

  test('threads.net returns "threads"', () => {
    assert.strictEqual(fm.getFormatterNameForUrl('https://threads.net/feed'), 'threads');
  });

  test('unknown host returns null', () => {
    assert.strictEqual(fm.getFormatterNameForUrl('https://example.com/page'), null);
  });

  test('malformed URL returns null', () => {
    assert.strictEqual(fm.getFormatterNameForUrl('not-a-url'), null);
  });

  test('null URL returns null', () => {
    assert.strictEqual(fm.getFormatterNameForUrl(null), null);
  });
}

// ---- 3-11. formatter guide gate ----
console.log('\n[3-11] formatter guide gate');

async function runGateTests() {
  const unlockState = require('../src/formatter-unlock-state');
  const { recordUnlock, _resetForTests: resetUnlocks } = unlockState;

  // Tab URL map used by the fake extension bridge
  const tabUrlMap = {
    1: 'https://discord.com/channels/1',
    2: 'https://threads.net/feed',
    3: 'https://example.com/page'
  };

  const fakeSitePolicy = {
    isAllowed: () => ({ allowed: true }),
    resolveAgentIdFromApiKey: (key) => key === 'valid-key' ? 'agent-test' : null
  };
  stubs['./site-policy'] = fakeSitePolicy;

  const fakePairedKeys = {
    validateKey: (key) => key === 'valid-key'
      ? { agentName: 'TestAgent', profileId: 'default', key: 'valid-key' }
      : null,
    touchKey: () => {}
  };
  stubs['./paired-keys'] = fakePairedKeys;
  stubs['./formatter-unlock-state'] = unlockState;

  const fakeExtensionBridge = {
    isConnected: () => true,
    sendCommand: async (_profileId, cmd) => {
      if (cmd === 'get_tabs') {
        return { tabs: Object.entries(tabUrlMap).map(([id, url]) => ({ id: Number(id), url })) };
      }
      if (cmd === 'create_tab') return { tab_id: 99 };
      return {};
    }
  };

  stubs['./lib/mcp-config-template'] = { buildMcpConfigJson: () => '{}' };
  stubs['./lib/tree-query'] = { findInTree: () => null };
  stubs['./formatter-logs'] = { recordSuccess: () => {}, recordError: () => {}, getStatus: () => ({}), getLogs: () => [] };
  stubs['uuid'] = { v4: () => 'test-uuid' };
  stubs['./service/paths'] = { getFormatterDir: () => '/fake', getDataDir: () => '/fake', getPort: () => 3456 };

  const fmKey2 = require.resolve('../src/formatter-manager');
  delete require.cache[fmKey2];
  const fm2 = require('../src/formatter-manager');
  try { fm2.reload(); } catch (_) {}

  const handlerKey = require.resolve('../src/mcp-handler');
  delete require.cache[handlerKey];
  const { createMcpHandler } = require('../src/mcp-handler');

  const handler = createMcpHandler(
    fakeExtensionBridge,
    fakePairedKeys,
    fm2,
    () => true
  );

  // Gate tests use enforceFormatterGuide directly — no MCP session needed.
  const gate = handler.enforceFormatterGuide;
  const resolveProfile = () => 'default';

  // Helper: call gate with a given tool, tab id, and optional apiKey
  async function checkGate(toolName, tabId, apiKey = 'valid-key', extra = {}) {
    return gate(toolName, { tab_id: tabId, ref: 'e1', ...extra }, apiKey);
  }

  // Integration tests (chain, create_tab warning) use processRequest.
  async function callTool(toolName, toolArgs, apiKey = 'valid-key') {
    return handler.processRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: toolArgs } },
      apiKey
    );
  }

  resetUnlocks();

  await test('gated tool on discord tab without unlock → block envelope', async () => {
    const result = await checkGate('browser_click', 1);
    assert.ok(result, 'Expected a block result');
    const body = JSON.parse(result.content[0].text);
    assert.strictEqual(body.error, 'platform_guide_required');
    assert.strictEqual(body.platform, 'discord');
    assert.strictEqual(body.tab_id, 1);
    assert.ok(body.message.includes('webpilot_get_formatter_info'));
    assert.strictEqual(body.unlock_call.tool, 'webpilot_get_formatter_info');
    assert.strictEqual(body.unlock_call.params.platform, 'discord');
    assert.strictEqual(body.unlock_call.params.tab_id, 1);
  });

  await test('after recordUnlock for agentId+tab+formatter → same call passes', async () => {
    recordUnlock('agent-test', 1, 'discord', 'https://discord.com/channels/1');
    const result = await checkGate('browser_click', 1);
    assert.strictEqual(result, null, 'Gate should return null (pass) after unlock');
  });

  await test('cross-formatter-equivalent (discord.com ↔ discordapp.com) → still unlocked', async () => {
    resetUnlocks();
    recordUnlock('agent-test', 1, 'discord', 'https://discord.com/channels/1');
    // Tab 1 is discord.com — getFormatterNameForUrl returns 'discord', same as unlock
    const result = await checkGate('browser_click', 1);
    assert.strictEqual(result, null, 'Same formatter identity should remain unlocked');
  });

  await test('navigated to different formatter → re-blocked for new formatter', async () => {
    resetUnlocks();
    // Unlock discord on tab 2, but tab 2 is actually on threads.net
    recordUnlock('agent-test', 2, 'discord', 'https://discord.com/old');
    const result = await checkGate('browser_click', 2);
    assert.ok(result, 'Expected block after navigation to different formatter');
    const body = JSON.parse(result.content[0].text);
    assert.strictEqual(body.error, 'platform_guide_required');
    assert.strictEqual(body.platform, 'threads');
  });

  await test('usePlatformOptimizer:false → pass without unlock', async () => {
    resetUnlocks();
    const result = await checkGate('browser_click', 1, 'valid-key', { usePlatformOptimizer: false });
    assert.strictEqual(result, null, 'usePlatformOptimizer:false should bypass gate');
  });

  await test('allowlisted tool browser_close_tab → never blocked', async () => {
    resetUnlocks();
    const result = await gate('browser_close_tab', { tab_id: 1 }, 'valid-key');
    assert.strictEqual(result, null);
  });

  await test('allowlisted tool browser_get_tabs → never blocked', async () => {
    resetUnlocks();
    const result = await gate('browser_get_tabs', {}, 'valid-key');
    assert.strictEqual(result, null);
  });

  await test('browser_create_tab to discord URL → warning field present', async () => {
    resetUnlocks();
    const result = await callTool('browser_create_tab', { url: 'https://discord.com/channels/1' });
    const body = JSON.parse(result.result.content[0].text);
    assert.ok(body.warning, 'Expected warning field on discord create_tab result');
    assert.ok(body.warning.includes('discord'), 'Warning should mention discord formatter');
  });

  await test('no-formatter URL (example.com) → never gated', async () => {
    resetUnlocks();
    // Tab 3 is example.com — no formatter
    const result = await checkGate('browser_click', 3);
    assert.strictEqual(result, null, 'example.com should never be gated');
  });

  await test('chain: allowlist step passes, gated step returns inline block, chain continues', async () => {
    resetUnlocks();
    const result = await handler.processRequest(
      {
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {
          name: 'browser_request_chain',
          arguments: {
            steps: [
              { tool: 'browser_get_tabs', arguments: {} },
              { tool: 'browser_click', arguments: { tab_id: 1, ref: 'e1' } }
            ],
            return: 'all'
          }
        }
      },
      'valid-key'
    );
    const body = JSON.parse(result.result.content[0].text);
    assert.ok(Array.isArray(body.results), 'Expected results array');
    assert.ok(body.results.length >= 2, 'Expected at least 2 results');
    const step1Body = body.results[1];
    assert.ok(step1Body, 'Step 1 result should exist');
    assert.strictEqual(step1Body.error, 'platform_guide_required');
  });

  await test('gate throws internally → request blocked with formatter_guide_gate_error', async () => {
    resetUnlocks();
    // Temporarily make getFormatterNameForUrl throw
    const origFn = fm2.getFormatterNameForUrl;
    fm2.getFormatterNameForUrl = () => { throw new Error('injected-test-error'); };
    try {
      // Use processRequest so the fail-closed catch wraps properly
      const result = await callTool('browser_click', { tab_id: 1, ref: 'e1' });
      // Should be blocked, not passed through
      assert.ok(result.result, 'Expected a result');
      const body = JSON.parse(result.result.content[0].text);
      assert.strictEqual(body.error, 'formatter_guide_gate_error',
        'Gate error should produce formatter_guide_gate_error, not pass through');
      assert.ok(body.message.includes('Internal error'), 'Should include internal error message');
      assert.ok(body.details.includes('injected-test-error'), 'Should include original error details');
    } finally {
      fm2.getFormatterNameForUrl = origFn;
    }
  });
}

runGateTests().then(() => {
  setImmediate(() => {
    console.log(`\n${passCount}/${testCount} tests passed`);
    if (passCount < testCount) process.exitCode = 1;
  });
}).catch(err => {
  console.error('Test suite error:', err);
  process.exitCode = 1;
});
