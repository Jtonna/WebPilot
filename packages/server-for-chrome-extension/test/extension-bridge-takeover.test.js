'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createExtensionBridge, STALE_CONNECTION_MS } = require('../src/extension-bridge');

function fakeWs(props = {}) {
  return {
    readyState: 1,
    sent: [],
    closed: null,
    send(json) { this.sent.push(JSON.parse(json)); },
    close(code, reason) { this.closed = { code, reason }; this.readyState = 3; },
    ...props,
  };
}

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; });

describe('extension-bridge: connection takeover policy', () => {
  test('first registration is accepted and stamps _lastActivity', () => {
    const bridge = createExtensionBridge();
    const ws = fakeWs({ _installId: 'a' });
    assert.deepEqual(bridge.setConnection('Default', ws), { ok: true });
    assert.equal(typeof ws._lastActivity, 'number');
    assert.ok(bridge.isConnected('Default'));
  });

  test('same socket re-hello is accepted and not closed', () => {
    const bridge = createExtensionBridge();
    const ws = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', ws);
    assert.deepEqual(bridge.setConnection('Default', ws), { ok: true });
    assert.equal(ws.closed, null);
    assert.ok(bridge.isConnected('Default'));
  });

  test('different install with a live, fresh prev is refused; prev untouched and still routed', () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    const next = fakeWs({ _installId: 'b' });
    bridge.setConnection('Default', prev);
    assert.deepEqual(bridge.setConnection('Default', next), { ok: false, reason: 'connection_in_use' });
    assert.equal(prev.closed, null);
    assert.equal(next.closed, null, 'bridge leaves closing the refused socket to the caller');
    bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 50 }).catch(() => {});
    assert.ok(prev.sent.some((m) => m.type === 'get_tabs'));
    assert.equal(next.sent.length, 0);
  });

  test('closed prev is replaced', () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a', readyState: 3 });
    bridge.setConnection('Default', prev);
    const next = fakeWs({ _installId: 'b' });
    assert.deepEqual(bridge.setConnection('Default', next), { ok: true });
    bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 50 }).catch(() => {});
    assert.ok(next.sent.some((m) => m.type === 'get_tabs'));
  });

  test('same installId replaces prev and closes it with the replace code', () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    const next = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    assert.deepEqual(bridge.setConnection('Default', next), { ok: true });
    assert.deepEqual(prev.closed, { code: 4000, reason: 'replaced_by_new_connection' });
  });

  test('stale prev (idle > STALE_CONNECTION_MS) is replaced and closed', () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    prev._lastActivity = Date.now() - STALE_CONNECTION_MS - 1000;
    const next = fakeWs({ _installId: 'b' });
    assert.deepEqual(bridge.setConnection('Default', next), { ok: true });
    assert.deepEqual(prev.closed, { code: 4000, reason: 'stale_connection' });
  });

  test('prev idle just under the threshold is not stale', () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    prev._lastActivity = Date.now() - STALE_CONNECTION_MS + 5000;
    assert.equal(bridge.setConnection('Default', fakeWs({ _installId: 'b' })).ok, false);
  });

  test('live prev with no _lastActivity from a different install is refused', () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    delete prev._lastActivity;
    const res = bridge.setConnection('Default', fakeWs({ _installId: 'b' }));
    assert.deepEqual(res, { ok: false, reason: 'connection_in_use' });
    assert.equal(prev.closed, null);
  });

  test('a refused socket does not disturb pending commands on the live socket', async () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 500 });
    const next = fakeWs({ _installId: 'b' });
    assert.equal(bridge.setConnection('Default', next).ok, false);
    // Refused socket closing is an anonymous disconnect: must be a no-op.
    bridge.clearConnection(next);
    const id = prev.sent.find((m) => m.type === 'get_tabs').id;
    bridge.handleResponse({ id, success: true, result: { tabs: ['OK'] } }, prev);
    assert.deepEqual(await p, { tabs: ['OK'] });
    assert.ok(bridge.isConnected('Default'));
  });
});
