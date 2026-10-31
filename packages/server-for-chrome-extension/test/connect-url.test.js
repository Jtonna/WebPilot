'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { makeConnectHandler } = require('../src/server');

function fakeRes() {
  return { body: null, json(obj) { this.body = obj; return this; } };
}

describe('/connect serverUrl / sseUrl (#125, #136)', () => {
  test('serverUrl is loopback even when host binding is 0.0.0.0', () => {
    const handler = makeConnectHandler({ port: 3456, host: '0.0.0.0' });
    const res = fakeRes();
    handler({}, res);
    assert.equal(res.body.serverUrl, 'ws://127.0.0.1:3456');
    // sseUrl is loopback too (#136).
    assert.equal(res.body.sseUrl, 'http://127.0.0.1:3456/sse');
    assert.equal(res.body.networkMode, true);
  });

  test('serverUrl is loopback on a loopback bind too', () => {
    const handler = makeConnectHandler({ port: 3999, host: '127.0.0.1' });
    const res = fakeRes();
    handler({}, res);
    assert.equal(res.body.serverUrl, 'ws://127.0.0.1:3999');
    assert.equal(res.body.sseUrl, 'http://127.0.0.1:3999/sse');
    assert.equal(res.body.networkMode, false);
  });
});
