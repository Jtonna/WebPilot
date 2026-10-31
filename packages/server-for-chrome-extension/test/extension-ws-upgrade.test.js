'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const { makeExtensionUpgradeHandler } = require('../src/server');

// Bare harness: an http.Server whose `upgrade` runs the real extension WS
// upgrade handler against a real `ws` WebSocketServer (noServer). hostBinding
// is '0.0.0.0' to prove loopback is accepted even on a network bind.
let server;
let wss;
let port;
const connections = [];

before(async () => {
  wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, req) => {
    connections.push({ ws, installId: ws._installId, url: req.url });
  });
  const handler = makeExtensionUpgradeHandler({ wss, hostBinding: '0.0.0.0', log: () => {} });
  server = http.createServer((req, res) => res.end('ok'));
  server.on('upgrade', handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  for (const c of connections) {
    try { c.ws.close(); } catch (_e) { /* ignore */ }
  }
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
});

describe('extension WS upgrade — live loopback client', () => {
  test('loopback client with installId is accepted (happy path)', async () => {
    const before = connections.length;
    const client = new WebSocket(`ws://127.0.0.1:${port}/?installId=abc-123`);
    await new Promise((resolve, reject) => {
      client.on('open', resolve);
      client.on('error', reject);
      client.on('unexpected-response', (_req, res) => reject(new Error('unexpected ' + res.statusCode)));
    });
    // Give the 'connection' handler a tick to record the socket.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(connections.length, before + 1);
    assert.equal(connections[connections.length - 1].installId, 'abc-123');
    client.close();
  });

  test('an http(s) Origin is rejected even over loopback', async () => {
    const before = connections.length;
    const client = new WebSocket(`ws://127.0.0.1:${port}/?installId=xyz`, {
      headers: { Origin: 'https://evil.example' },
    });
    const outcome = await new Promise((resolve) => {
      client.on('open', () => resolve('open'));
      client.on('error', () => resolve('error'));
      client.on('unexpected-response', (_req, res) => resolve('status:' + res.statusCode));
    });
    assert.notEqual(outcome, 'open');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(connections.length, before, 'no connection should be recorded for a web-Origin upgrade');
  });

  test('missing installId is rejected (401)', async () => {
    const before = connections.length;
    const client = new WebSocket(`ws://127.0.0.1:${port}/`);
    const outcome = await new Promise((resolve) => {
      client.on('open', () => resolve('open'));
      client.on('error', () => resolve('error'));
      client.on('unexpected-response', (_req, res) => resolve('status:' + res.statusCode));
    });
    assert.notEqual(outcome, 'open');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(connections.length, before);
  });
});

describe('extension WS upgrade — fabricated non-loopback request', () => {
  // A real socket from the OS is always 127.0.0.1, so the non-loopback case is
  // driven at the gate level with a fabricated request/socket.
  function fabricate(remoteAddress, headers = {}) {
    const events = { destroyed: false, written: [] };
    const socket = {
      remoteAddress,
      write(chunk) { events.written.push(String(chunk)); },
      destroy() { events.destroyed = true; },
    };
    const request = {
      socket,
      headers: { host: `127.0.0.1:${port}`, ...headers },
      url: '/?installId=lan-client',
    };
    return { request, socket, events };
  }

  test('non-loopback remote is rejected with 403 and the socket destroyed', () => {
    const handler = makeExtensionUpgradeHandler({ wss, hostBinding: '0.0.0.0', log: () => {} });
    const before = connections.length;
    const { request, socket, events } = fabricate('192.168.1.50');
    handler(request, socket, Buffer.alloc(0));
    assert.equal(events.destroyed, true);
    assert.ok(events.written.some((w) => w.includes('403')), events.written.join('|'));
    assert.equal(connections.length, before, 'no ws connection for a non-loopback upgrade');
  });

  test('dev mode does NOT bypass the gate on a 0.0.0.0 bind', () => {
    // hostBinding 0.0.0.0 => even if WEBPILOT_DEV were set, no bypass. The
    // module under test was loaded without WEBPILOT_DEV, so this is the
    // production path; the assertion documents the network-bind invariant.
    const handler = makeExtensionUpgradeHandler({ wss, hostBinding: '0.0.0.0', log: () => {} });
    const { request, socket, events } = fabricate('10.1.2.3');
    handler(request, socket, Buffer.alloc(0));
    assert.equal(events.destroyed, true);
    assert.ok(events.written.some((w) => w.includes('403')));
  });
});
