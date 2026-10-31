'use strict';

// Functional coverage for the Web UI agent-admin endpoints after #129:
//   - GET  /api/ui/status            — pairedAgents carry `id`, never a hash.
//   - POST /api/ui/agents/:id/regenerate — returns a new key, kills the old one.
//   - POST /api/ui/agents/:id/rename     — by row id.
//   - DELETE /api/ui/agents/:id          — by row id.
//   - the mutating gate rejects non-loopback callers (loopback-gated).

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');

// Pepper + paths isolation.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-ui-agents-'));
process.env.WEBPILOT_DATA_DIR = tmpDataDir;

const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

let db;
function createTestDb() {
  const d = new Database(':memory:');
  d.exec(schemaSql);
  return d;
}

// Inject the in-memory DB BEFORE requiring server.js / paired-keys so both the
// routes and the key store share it.
require.cache[require.resolve('../src/db/connection')] = {
  exports: { getDb: () => db, init: () => db },
};
delete require.cache[require.resolve('../src/paired-keys')];

const pairedKeys = require('../src/paired-keys');
const { mountWebUiRoutes, makeMutatingUiAuth } = require('../src/server');

// ── HTTP harness ──────────────────────────────────────────────────────────────

let server;
let base;
const broadcasts = [];

const chromeManager = {
  userDataDir: tmpDataDir,
  getStatus: async () => ({ running: false, knownProfiles: [] }),
};
const extensionBridge = {
  getConnectedProfiles: () => [],
  isAnyConnected: () => false,
};

before(async () => {
  const app = express();
  mountWebUiRoutes(app, {
    chromeManager,
    extensionBridge,
    pairedKeys,
    server: null,
    port: 1234,
    broadcastUiEvent: (e) => broadcasts.push(e),
    hostBinding: '127.0.0.1',
    setNetworkMode: () => {},
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let origLog;
let origError;
beforeEach(() => {
  db = createTestDb();
  pairedKeys._resetPepperCacheForTests();
  broadcasts.length = 0;
  origLog = console.log;
  origError = console.error;
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

function status() {
  return fetch(`${base}/api/ui/status`);
}
function regenerate(id) {
  return fetch(`${base}/api/ui/agents/${encodeURIComponent(id)}/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}
function rename(id, newName) {
  return fetch(`${base}/api/ui/agents/${encodeURIComponent(id)}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newName }),
  });
}
function revoke(id) {
  return fetch(`${base}/api/ui/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── GET /api/ui/status ──────────────────────────────────────────────────────

describe('GET /api/ui/status', () => {
  test('pairedAgents expose id + metadata but never a key/hash', async () => {
    const { id } = pairedKeys.createPairedAgent({ agentName: 'agent-x', profileId: 'Default' });
    const res = await status();
    assert.equal(res.status, 200);
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(body.pairedAgents.length, 1);
    const entry = body.pairedAgents[0];
    assert.equal(entry.id, id);
    assert.equal(entry.agentName, 'agent-x');
    assert.equal(entry.key, undefined);
    assert.equal(entry.api_key_hash, undefined);
    assert.equal(entry.keyDisplay, undefined);
    // Nothing in the whole status payload equals the stored hash.
    const storedHash = db.prepare('SELECT api_key_hash FROM agents WHERE id = ?').get(id).api_key_hash;
    assert.ok(!text.includes(storedHash), 'status payload must not contain the api_key_hash');
  });
});

// ── POST /api/ui/agents/:id/regenerate ────────────────────────────────────────

describe('POST /api/ui/agents/:id/regenerate', () => {
  test('returns a new key and invalidates the old one', async () => {
    const { apiKey: oldKey, id } = pairedKeys.createPairedAgent({ agentName: 'rotate', profileId: 'Default' });
    assert.ok(pairedKeys.validateKey(oldKey));

    const res = await regenerate(id);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.apiKey, 'string');
    assert.notEqual(body.apiKey, oldKey);
    assert.deepEqual(Object.keys(body), ['apiKey']); // only the plaintext, nothing else

    assert.equal(pairedKeys.validateKey(oldKey), null, 'old key must stop working');
    assert.ok(pairedKeys.validateKey(body.apiKey), 'new key must work');
    assert.ok(broadcasts.some((b) => b.type === 'agents_changed'));
  });

  test('404 for an unknown id', async () => {
    const res = await regenerate(987654);
    assert.equal(res.status, 404);
  });
});

// ── rename / revoke by id ─────────────────────────────────────────────────────

describe('rename / revoke by id', () => {
  test('rename by id succeeds', async () => {
    const { id } = pairedKeys.createPairedAgent({ agentName: 'before', profileId: 'Default' });
    const res = await rename(id, 'after');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.agents.find((a) => a.id === id).agentName, 'after');
  });

  test('revoke by id succeeds and removes the agent', async () => {
    const { apiKey, id } = pairedKeys.createPairedAgent({ agentName: 'doomed', profileId: 'Default' });
    const res = await revoke(id);
    assert.equal(res.status, 200);
    assert.equal(pairedKeys.validateKey(apiKey), null);
    assert.equal(pairedKeys.listKeys().some((a) => a.id === id), false);
  });

  test('404 for rename/revoke of an unknown id', async () => {
    assert.equal((await rename(987654, 'x')).status, 404);
    assert.equal((await revoke(987654)).status, 404);
  });
});

// ── the mutating gate is loopback-only ────────────────────────────────────────

describe('mutating admin endpoints are loopback-gated', () => {
  function fakeReq(remoteAddress) {
    return { socket: { remoteAddress }, method: 'POST', url: '/api/ui/agents/1/regenerate' };
  }
  function fakeRes() {
    return {
      statusCode: null,
      body: null,
      status(c) { this.statusCode = c; return this; },
      json(o) { this.body = o; return this; },
      setHeader() {},
    };
  }

  test('non-loopback remote -> 403, loopback -> next()', () => {
    // The same gate guards rename / revoke / regenerate (mutatingAuth).
    const gate = makeMutatingUiAuth('0.0.0.0');

    const denied = fakeRes();
    let deniedNext = false;
    gate(fakeReq('192.168.1.42'), denied, () => { deniedNext = true; });
    assert.equal(deniedNext, false);
    assert.equal(denied.statusCode, 403);

    let okNext = false;
    gate(fakeReq('127.0.0.1'), fakeRes(), () => { okNext = true; });
    assert.equal(okNext, true);
  });
});
