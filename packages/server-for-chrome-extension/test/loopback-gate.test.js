'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  isLoopbackRemote,
  evaluateLoopbackAccess,
  makeLoopbackGate,
} = require('../src/loopback');

// Fabricate an express-ish req with a given remote address.
function fakeReq(remoteAddress, { method = 'GET', url = '/x' } = {}) {
  return { socket: { remoteAddress }, method, url };
}

// Fabricate a minimal res that records status/json/headers.
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

describe('isLoopbackRemote', () => {
  test('accepts IPv4, IPv6 and IPv4-mapped loopback', () => {
    assert.equal(isLoopbackRemote('127.0.0.1'), true);
    assert.equal(isLoopbackRemote('::1'), true);
    assert.equal(isLoopbackRemote('::ffff:127.0.0.1'), true);
  });

  test('rejects LAN / public / empty', () => {
    assert.equal(isLoopbackRemote('192.168.1.10'), false);
    assert.equal(isLoopbackRemote('10.0.0.5'), false);
    assert.equal(isLoopbackRemote('203.0.113.9'), false);
    assert.equal(isLoopbackRemote(''), false);
    assert.equal(isLoopbackRemote(undefined), false);
  });
});

describe('evaluateLoopbackAccess (no dev mode)', () => {
  test('loopback allowed regardless of bind', () => {
    assert.deepEqual(evaluateLoopbackAccess('127.0.0.1', '0.0.0.0'), { allowed: true, devBypass: false });
    assert.deepEqual(evaluateLoopbackAccess('::1', '127.0.0.1'), { allowed: true, devBypass: false });
  });

  test('non-loopback rejected on any bind (dev mode off)', () => {
    assert.deepEqual(evaluateLoopbackAccess('192.168.1.10', '127.0.0.1'), { allowed: false, devBypass: false });
    assert.deepEqual(evaluateLoopbackAccess('192.168.1.10', '0.0.0.0'), { allowed: false, devBypass: false });
  });
});

describe('makeLoopbackGate middleware', () => {
  test('loopback remote calls next()', () => {
    const gate = makeLoopbackGate('0.0.0.0', { log: () => {} });
    let nexted = false;
    const res = fakeRes();
    gate(fakeReq('127.0.0.1'), res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(res.statusCode, null);
  });

  test('non-loopback remote -> 403 and no next()', () => {
    const gate = makeLoopbackGate('0.0.0.0', { log: () => {} });
    let nexted = false;
    const res = fakeRes();
    gate(fakeReq('192.168.1.10'), res, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, { error: 'Forbidden: loopback-only' });
  });

  // Faithful to how the popup mounts its gate (label '/api/popup'); this is
  // the middleware-level popup gate assertion.
  test('popup-style gate: non-loopback rejected, loopback passes', () => {
    const gate = makeLoopbackGate('0.0.0.0', { label: '/api/popup', log: () => {} });
    const rejectRes = fakeRes();
    let rejectNext = false;
    gate(fakeReq('10.0.0.9', { method: 'POST', url: '/api/popup/site-toggle' }), rejectRes, () => { rejectNext = true; });
    assert.equal(rejectRes.statusCode, 403);
    assert.equal(rejectNext, false);

    let okNext = false;
    gate(fakeReq('127.0.0.1', { url: '/api/popup/state' }), fakeRes(), () => { okNext = true; });
    assert.equal(okNext, true);
  });
});

// Dev-bypass behavior depends on WEBPILOT_DEV being set at module load, so we
// re-require a fresh copy of the module with the env var in place.
describe('dev-mode bypass (WEBPILOT_DEV=1)', () => {
  function freshLoopbackWithDev() {
    const prev = process.env.WEBPILOT_DEV;
    process.env.WEBPILOT_DEV = '1';
    delete require.cache[require.resolve('../src/loopback')];
    const mod = require('../src/loopback');
    // restore env + module for the rest of the suite
    if (prev === undefined) delete process.env.WEBPILOT_DEV;
    else process.env.WEBPILOT_DEV = prev;
    return mod;
  }

  test('bypass only on a loopback bind; never on 0.0.0.0', () => {
    const dev = freshLoopbackWithDev();
    // loopback bind -> non-local allowed with devBypass flag
    assert.deepEqual(
      dev.evaluateLoopbackAccess('192.168.1.10', '127.0.0.1'),
      { allowed: true, devBypass: true }
    );
    assert.deepEqual(
      dev.evaluateLoopbackAccess('192.168.1.10', 'localhost'),
      { allowed: true, devBypass: true }
    );
    // network bind -> never bypassed even in dev mode
    assert.deepEqual(
      dev.evaluateLoopbackAccess('192.168.1.10', '0.0.0.0'),
      { allowed: false, devBypass: false }
    );
    assert.equal(dev.isDevBypassSafe('127.0.0.1'), true);
    assert.equal(dev.isDevBypassSafe('0.0.0.0'), false);
  });

  test('gate stamps X-WebPilot-Dev-Bypass on a dev loopback-bind bypass', () => {
    const dev = freshLoopbackWithDev();
    const gate = dev.makeLoopbackGate('127.0.0.1', { log: () => {} });
    const res = fakeRes();
    let nexted = false;
    gate(fakeReq('192.168.1.10'), res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(res.headers['X-WebPilot-Dev-Bypass'], '1');
  });

  // reset the cached module back to the non-dev instance for other suites
  test('restore non-dev module cache', () => {
    delete require.cache[require.resolve('../src/loopback')];
    require('../src/loopback');
    assert.ok(true);
  });
});
