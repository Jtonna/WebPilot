'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createExtensionBridge } = require('../src/extension-bridge');

// A fake ws that is always "open" (readyState 1) and captures sent frames so
// the test can recover the command id the bridge generated.
function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    send(json) { this.sent.push(JSON.parse(json)); },
    close() { this.readyState = 3; },
  };
}

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; });

describe('extension-bridge: response bound to originating socket', () => {
  test('a response on a DIFFERENT socket than the command was sent on is dropped', async () => {
    const bridge = createExtensionBridge();
    const wsA = fakeWs();
    bridge.setConnection('Default', wsA);

    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 200 });
    const sent = wsA.sent.find((m) => m.type === 'get_tabs');
    assert.ok(sent && sent.id, 'command was sent with an id');
    const id = sent.id;

    // A response for the same command id, but arriving on a different socket.
    const wsB = fakeWs();
    bridge.handleResponse({ id, success: true, result: { tabs: ['WRONG'] } }, wsB);

    // The promise must NOT have resolved from the foreign-socket response; it
    // should still time out. Prove it by racing against a short timer.
    const raced = await Promise.race([
      p.then(() => 'resolved', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    assert.equal(raced, 'pending', 'foreign-socket response must be ignored');

    // The correct socket then answers -> resolves.
    bridge.handleResponse({ id, success: true, result: { tabs: ['OK'] } }, wsA);
    const result = await p;
    assert.deepEqual(result, { tabs: ['OK'] });
  });

  test('same-socket response resolves (happy path)', async () => {
    const bridge = createExtensionBridge();
    const ws = fakeWs();
    bridge.setConnection('Default', ws);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 500 });
    const id = ws.sent.find((m) => m.type === 'get_tabs').id;
    bridge.handleResponse({ id, success: true, result: 42 }, ws);
    assert.equal(await p, 42);
  });

  test('id-only matching still works when no ws is supplied (back-compat)', async () => {
    const bridge = createExtensionBridge();
    const ws = fakeWs();
    bridge.setConnection('Default', ws);
    const p = bridge.sendCommand('Default', 'get_tabs', {}, { timeout: 500 });
    const id = ws.sent.find((m) => m.type === 'get_tabs').id;
    // No ws argument -> falls back to id-only matching.
    bridge.handleResponse({ id, success: true, result: 'legacy' });
    assert.equal(await p, 'legacy');
  });
});
