'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { makeConnectHandler } = require('../src/server');

function fakeRes() {
  return { body: null, json(obj) { this.body = obj; return this; } };
}

describe('/connect serverUrl (#125)', () => {
  test('serverUrl is loopback even when host binding is 0.0.0.0', () => {
    const handler = makeConnectHandler({ port: 3456, publicHost: '192.168.1.5', host: '0.0.0.0' });
    const res = fakeRes();
    handler({}, res);
    assert.equal(res.body.serverUrl, 'ws://127.0.0.1:3456');
    // sseUrl may continue to reflect the public host (informational).
    assert.equal(res.body.sseUrl, 'http://192.168.1.5:3456/sse');
    assert.equal(res.body.networkMode, true);
  });

  test('serverUrl is loopback on a loopback bind too', () => {
    const handler = makeConnectHandler({ port: 3999, publicHost: 'localhost', host: '127.0.0.1' });
    const res = fakeRes();
    handler({}, res);
    assert.equal(res.body.serverUrl, 'ws://127.0.0.1:3999');
    assert.equal(res.body.sseUrl, 'http://localhost:3999/sse');
    assert.equal(res.body.networkMode, false);
  });
});
