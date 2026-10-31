'use strict';

// #138 — pending identification + identify_required profile flags.
//
// The extension WS hello handler lives inside createServer() (which boots
// SQLite, the Chrome manager against the real user-data dir, etc.), so its
// pieces are extracted into exported helpers and covered here directly:
//   - buildKnownProfiles()               — identify_required knownProfiles shape
//   - loadRegisteredProfileIds()         — shared with GET /api/ui/status
//   - createPendingIdentificationTracker — the pending-socket set + broadcast
//   - GET /api/ui/status                 — pendingIdentification.count
// createServer() wires the tracker: add on each identify_required send,
// delete on hello_ack / 4409 refusal / close.

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-ident-pending-'));
process.env.WEBPILOT_DATA_DIR = tmpDataDir;

const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

let db;
function createTestDb() {
  const d = new Database(':memory:');
  d.exec(schemaSql);
  return d;
}

// Inject the in-memory DB BEFORE requiring server.js so paired-keys and
// extension-installs share it.
require.cache[require.resolve('../src/db/connection')] = {
  exports: { getDb: () => db, init: () => db },
};
delete require.cache[require.resolve('../src/paired-keys')];
delete require.cache[require.resolve('../src/extension-installs')];

const pairedKeys = require('../src/paired-keys');
const {
  mountWebUiRoutes,
  buildKnownProfiles,
  loadRegisteredProfileIds,
  createPendingIdentificationTracker,
} = require('../src/server');

function insertInstall(installId, profileId, lastSeen = '2026-01-01T00:00:00.000Z') {
  db.prepare(
    'INSERT INTO extension_installs (install_id, profile_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)'
  ).run(installId, profileId, lastSeen, lastSeen);
}

let origLog;
let origError;
beforeEach(() => {
  db = createTestDb();
  origLog = console.log;
  origError = console.error;
  console.log = () => {};
  console.error = () => {};
});
afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

after(() => {
  try { fs.rmSync(tmpDataDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
});

// ── buildKnownProfiles ───────────────────────────────────────────────────────

describe('buildKnownProfiles', () => {
  const profiles = [
    { directoryName: 'Default', displayName: 'Person 1', gaiaName: 'P', gaiaEmail: null },
    { directoryName: 'Profile 1', displayName: 'Work', gaiaName: null, gaiaEmail: 'w@example.com' },
    { directoryName: 'Profile 2', displayName: 'Spare', gaiaName: null, gaiaEmail: null },
  ];

  test('keeps the existing fields and adds connected / registered flags', () => {
    const out = buildKnownProfiles({
      profiles,
      connectedProfiles: ['Profile 1'],
      registeredProfiles: new Set(['Profile 1', 'Default']),
    });
    assert.deepEqual(out, [
      { directoryName: 'Default', displayName: 'Person 1', gaiaEmail: null, connected: false, registered: true },
      { directoryName: 'Profile 1', displayName: 'Work', gaiaEmail: 'w@example.com', connected: true, registered: true },
      { directoryName: 'Profile 2', displayName: 'Spare', gaiaEmail: null, connected: false, registered: false },
    ]);
  });

  test('extra Local State fields (gaiaName) are not leaked into the payload', () => {
    const [first] = buildKnownProfiles({ profiles, connectedProfiles: [], registeredProfiles: [] });
    assert.deepEqual(Object.keys(first).sort(), ['connected', 'directoryName', 'displayName', 'gaiaEmail', 'registered']);
  });

  test('missing inputs yield an empty / all-false list', () => {
    assert.deepEqual(buildKnownProfiles({ profiles: [] }), []);
    assert.deepEqual(buildKnownProfiles({}), []);
    const [only] = buildKnownProfiles({ profiles: [{ directoryName: 'Default' }] });
    assert.deepEqual(only, { directoryName: 'Default', displayName: null, gaiaEmail: null, connected: false, registered: false });
  });
});

// ── loadRegisteredProfileIds ─────────────────────────────────────────────────

describe('loadRegisteredProfileIds', () => {
  test('returns every profile with an extension_installs row, ignoring empty profile ids', () => {
    insertInstall('i-1', 'Default');
    insertInstall('i-2', 'Default');
    insertInstall('i-3', 'Profile 3');
    insertInstall('i-4', null);
    const ids = loadRegisteredProfileIds();
    assert.deepEqual([...ids].sort(), ['Default', 'Profile 3']);
  });

  test('is read-only — last_seen_at is not bumped', () => {
    insertInstall('i-1', 'Default', '2020-01-01T00:00:00.000Z');
    loadRegisteredProfileIds();
    const row = db.prepare('SELECT last_seen_at FROM extension_installs WHERE install_id = ?').get('i-1');
    assert.equal(row.last_seen_at, '2020-01-01T00:00:00.000Z');
  });

  test('a DB failure yields an empty set instead of throwing', () => {
    db = { prepare: () => { throw new Error('db gone'); } };
    assert.deepEqual([...loadRegisteredProfileIds()], []);
  });
});

// ── createPendingIdentificationTracker ───────────────────────────────────────

describe('createPendingIdentificationTracker', () => {
  test('broadcasts identification_pending_changed with the count on every real change', () => {
    const events = [];
    const t = createPendingIdentificationTracker({ broadcastUiEvent: (e) => events.push(e) });
    const a = {};
    const b = {};

    assert.equal(t.add(a), true);           // identify_required sent to socket A
    assert.equal(t.add(a), false);          // second identify_required to A: no change
    assert.equal(t.add(b), true);           // socket B
    assert.equal(t.size, 2);
    assert.equal(t.has(a), true);
    assert.equal(t.delete(a), true);        // A got hello_ack / 4409 / closed
    assert.equal(t.delete(a), false);       // close after hello_ack: no change
    assert.equal(t.delete({}), false);      // never-pending socket closes: no change
    assert.equal(t.delete(b), true);
    assert.equal(t.size, 0);

    assert.deepEqual(events, [
      { type: 'identification_pending_changed', count: 1 },
      { type: 'identification_pending_changed', count: 2 },
      { type: 'identification_pending_changed', count: 1 },
      { type: 'identification_pending_changed', count: 0 },
    ]);
  });

  test('works without a broadcaster and survives a throwing one', () => {
    const quiet = createPendingIdentificationTracker();
    quiet.add({});
    assert.equal(quiet.size, 1);

    const noisy = createPendingIdentificationTracker({ broadcastUiEvent: () => { throw new Error('boom'); } });
    const s = {};
    assert.equal(noisy.add(s), true);
    assert.equal(noisy.delete(s), true);
    assert.equal(noisy.size, 0);
  });
});

// ── GET /api/ui/status ───────────────────────────────────────────────────────

describe('GET /api/ui/status — pendingIdentification + shared registered set', () => {
  let server;
  let base;
  let pendingCount = 0;
  let serverNoTracker;
  let baseNoTracker;

  const deps = (extra = {}) => ({
    chromeManager: {
      userDataDir: tmpDataDir,
      getStatus: async () => ({
        running: false,
        knownProfiles: [
          { directoryName: 'Default', displayName: 'Person 1', gaiaEmail: null },
          { directoryName: 'Profile 1', displayName: 'Work', gaiaEmail: null },
        ],
      }),
    },
    extensionBridge: { getConnectedProfiles: () => [], isAnyConnected: () => false },
    pairedKeys,
    server: null,
    port: 1234,
    broadcastUiEvent: () => {},
    hostBinding: '127.0.0.1',
    setNetworkMode: () => {},
    ...extra,
  });

  before(async () => {
    const app = express();
    mountWebUiRoutes(app, deps({ getPendingIdentificationCount: () => pendingCount }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;

    const app2 = express();
    mountWebUiRoutes(app2, deps());
    await new Promise((resolve) => { serverNoTracker = app2.listen(0, '127.0.0.1', resolve); });
    baseNoTracker = `http://127.0.0.1:${serverNoTracker.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => serverNoTracker.close(resolve));
  });

  beforeEach(() => {
    pairedKeys._resetPepperCacheForTests();
  });

  test('reports the live pending count', async () => {
    pendingCount = 0;
    let body = await (await fetch(`${base}/api/ui/status`)).json();
    assert.deepEqual(body.pendingIdentification, { count: 0 });

    pendingCount = 2;
    body = await (await fetch(`${base}/api/ui/status`)).json();
    assert.deepEqual(body.pendingIdentification, { count: 2 });
  });

  test('defaults to { count: 0 } when no tracker is wired', async () => {
    const res = await fetch(`${baseNoTracker}/api/ui/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.pendingIdentification, { count: 0 });
  });

  test('registered profiles still render as "ready" via the shared helper', async () => {
    insertInstall('i-1', 'Profile 1');
    const body = await (await fetch(`${base}/api/ui/status`)).json();
    const byDir = Object.fromEntries(body.profiles.map((p) => [p.directoryName, p.webPilotStatus]));
    assert.deepEqual(byDir, { Default: 'needs_setup', 'Profile 1': 'ready' });
  });
});
