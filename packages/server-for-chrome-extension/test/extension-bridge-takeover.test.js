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

describe('extension-bridge: pending commands on a replaced socket', () => {
  // Resolves to the rejection error (or null if resolved); fails if still pending well before the command timeout.
  async function settle(p, ms = 500) {
    let t;
    const guard = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('still pending')), ms); });
    try {
      return await Promise.race([p.then(() => null, (e) => e), guard]);
    } finally {
      clearTimeout(t);
    }
  }

  test('same-install replace rejects prev in-flight command immediately', async () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 5000 });
    const next = fakeWs({ _installId: 'a' });
    assert.deepEqual(bridge.setConnection('Default', next), { ok: true });
    const err = await settle(p);
    assert.match(err.message, /replaced/);
    assert.deepEqual(prev.closed, { code: 4000, reason: 'replaced_by_new_connection' });
    // prev's later close event is a no-op and does not disturb the new socket.
    assert.doesNotThrow(() => bridge.clearConnection(prev));
    assert.ok(bridge.isConnected('Default'));
  });

  test('stale replace rejects prev in-flight command immediately', async () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 5000 });
    prev._lastActivity = Date.now() - STALE_CONNECTION_MS - 1000;
    assert.equal(bridge.setConnection('Default', fakeWs({ _installId: 'b' })).ok, true);
    const err = await settle(p);
    assert.match(err.message, /replaced/);
    assert.deepEqual(prev.closed, { code: 4000, reason: 'stale_connection' });
    assert.doesNotThrow(() => bridge.clearConnection(prev));
  });

  test('dead prev (readyState 3) still in the map has its pending command rejected', async () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 5000 });
    prev.readyState = 3;
    assert.equal(bridge.setConnection('Default', fakeWs({ _installId: 'b' })).ok, true);
    const err = await settle(p);
    assert.match(err.message, /replaced/);
    assert.equal(prev.closed, null, 'dead prev is not closed again');
  });

  test('same socket re-hello does not reject its in-flight command', async () => {
    const bridge = createExtensionBridge();
    const ws = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', ws);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 500 });
    assert.deepEqual(bridge.setConnection('Default', ws), { ok: true });
    const id = ws.sent.find((m) => m.type === 'get_tabs').id;
    bridge.handleResponse({ id, success: true, result: 'OK' }, ws);
    assert.equal(await p, 'OK');
  });

  test('refused takeover does not reject the live socket in-flight command', async () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 500 });
    assert.equal(bridge.setConnection('Default', fakeWs({ _installId: 'b' })).ok, false);
    const id = prev.sent.find((m) => m.type === 'get_tabs').id;
    bridge.handleResponse({ id, success: true, result: 'OK' }, prev);
    assert.equal(await p, 'OK');
  });

  test('pending command on the new socket is untouched by the replace', async () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    const next = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    const pOld = bridge.sendCommand('Default', 'old', {}, { timeout: 5000 });
    bridge.setConnection('Default', next);
    const pNew = bridge.sendCommand('Default', 'new', {}, { timeout: 500 });
    assert.match((await settle(pOld)).message, /replaced/);
    bridge.clearConnection(prev); // late close of prev must not touch next's command
    const id = next.sent.find((m) => m.type === 'new').id;
    bridge.handleResponse({ id, success: true, result: 'NEW' }, next);
    assert.equal(await pNew, 'NEW');
  });

  test('late response for a rejected id on prev is logged as unknown and ignored', async () => {
    const bridge = createExtensionBridge();
    const prev = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', prev);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 5000 });
    const id = prev.sent.find((m) => m.type === 'get_tabs').id;
    bridge.setConnection('Default', fakeWs({ _installId: 'a' }));
    await settle(p);
    const logs = [];
    console.log = (...a) => logs.push(a.join(' '));
    assert.doesNotThrow(() => bridge.handleResponse({ id, success: true, result: 'late' }, prev));
    assert.ok(logs.some((l) => l.includes('unknown command response')));
  });

  test('clearConnection(unmatched ws) leaves other sockets commands alone', async () => {
    const bridge = createExtensionBridge();
    const live = fakeWs({ _installId: 'a' });
    bridge.setConnection('Default', live);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 500 });
    bridge.clearConnection(fakeWs()); // unrelated anonymous socket
    const id = live.sent.find((m) => m.type === 'get_tabs').id;
    bridge.handleResponse({ id, success: true, result: 'OK' }, live);
    assert.equal(await p, 'OK');
  });
});
