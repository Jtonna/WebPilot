'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// ── Pepper isolation ─────────────────────────────────────────────────────────
// hashApiKey() bootstraps a server pepper under getDataDir()/secret. Point the
// daemon data dir at a throwaway temp dir so the test never reads or writes the
// real install's pepper file.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-paired-keys-'));
process.env.WEBPILOT_DATA_DIR = tmpDataDir;

// ── DB fixture setup ──────────────────────────────────────────────────────────
// Mirror popup-routes.test.js: seed a fresh in-memory DB from schema.sql and
// inject it by replacing the db/connection module export in require.cache
// BEFORE requiring the module under test. This exercises the REAL paired-keys.
const schemaSql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

let db; // swapped per test; the injected connection always returns the current one

function createTestDb() {
  const d = new Database(':memory:');
  d.exec(schemaSql);
  return d;
}

require.cache[require.resolve('../src/db/connection')] = {
  exports: { getDb: () => db, init: () => db },
};

delete require.cache[require.resolve('../src/paired-keys')];
const pairedKeys = require('../src/paired-keys');

// ── lifecycle ─────────────────────────────────────────────────────────────────

let origLog;
let origError;
beforeEach(() => {
  db = createTestDb();
  // The pepper is process-cached; reset it so each fresh DB is self-consistent.
  pairedKeys._resetPepperCacheForTests();
  origLog = console.log;
  origError = console.error;
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

// ── helpers ─────────────────────────────────────────────────────────────────

function storedHashFor(agentName) {
  const row = db.prepare('SELECT api_key_hash FROM agents WHERE name = ?').get(agentName);
  return row ? row.api_key_hash : null;
}

// ── validateKey: happy path ───────────────────────────────────────────────────

describe('validateKey — plaintext auth', () => {
  test('a freshly created agent authenticates with its plaintext key', () => {
    const plaintext = pairedKeys.addKey('agent-a', 'Default');
    assert.equal(typeof plaintext, 'string');
    assert.ok(plaintext.length > 0);

    const entry = pairedKeys.validateKey(plaintext);
    assert.ok(entry, 'validateKey should return the agent entry for a valid plaintext key');
    assert.equal(entry.agentName, 'agent-a');
    assert.equal(entry.profileId, 'Default');
    assert.equal(entry.state, 'active');
    // The entry's `.key` surfaces the hash, never the plaintext.
    assert.equal(entry.key, storedHashFor('agent-a'));
  });

  test('createPairedAgent mints a key that validateKey accepts', () => {
    const { apiKey, agentName } = pairedKeys.createPairedAgent({
      agentName: 'agent-paired',
      profileId: 'Profile 2',
    });
    assert.equal(typeof apiKey, 'string');
    const entry = pairedKeys.validateKey(apiKey);
    assert.ok(entry);
    assert.equal(entry.agentName, agentName);
    assert.equal(entry.profileId, 'Profile 2');
  });
});

// ── BUG-2 regression: a leaked api_key_hash must NOT authenticate ─────────────

describe('validateKey — BUG-2 regression', () => {
  test('the stored api_key_hash does NOT authenticate', () => {
    pairedKeys.addKey('agent-b');
    const storedHash = storedHashFor('agent-b');
    assert.ok(storedHash, 'precondition: an api_key_hash is stored');

    // Presenting the raw stored hash as if it were the credential must fail.
    const entry = pairedKeys.validateKey(storedHash);
    assert.equal(entry, null, 'a leaked api_key_hash must not grant authentication');
  });

  test('plaintext still works for the same agent (sanity against over-rejection)', () => {
    const plaintext = pairedKeys.addKey('agent-b2');
    const storedHash = storedHashFor('agent-b2');
    assert.equal(pairedKeys.validateKey(storedHash), null);
    assert.ok(pairedKeys.validateKey(plaintext));
  });
});

// ── validateKey: empty / garbage input ────────────────────────────────────────

describe('validateKey — invalid input', () => {
  test("returns null for '', '   ', and an unknown key", () => {
    pairedKeys.addKey('agent-c');
    assert.equal(pairedKeys.validateKey(''), null);
    assert.equal(pairedKeys.validateKey('   '), null);
    assert.equal(pairedKeys.validateKey('not-a-real-key'), null);
    assert.equal(pairedKeys.validateKey(null), null);
    assert.equal(pairedKeys.validateKey(undefined), null);
  });
});

// ── transitional UI lookup is preserved and separate from auth ────────────────

describe('findAgentRowByKeyHash — transitional UI lookup', () => {
  test('still resolves an agent row from the stored hash', () => {
    pairedKeys.addKey('agent-d', 'Default');
    const storedHash = storedHashFor('agent-d');

    const row = pairedKeys.findAgentRowByKeyHash(storedHash);
    assert.ok(row, 'UI hash lookup is intentionally preserved for group (b)');
    assert.equal(row.name, 'agent-d');
    assert.equal(row.api_key_hash, storedHash);

    // Proof the two paths are separate: the same hash authenticates via the UI
    // lookup but is rejected by the auth path.
    assert.equal(pairedKeys.validateKey(storedHash), null);
  });

  test('returns null for empty / unknown hashes', () => {
    assert.equal(pairedKeys.findAgentRowByKeyHash(''), null);
    assert.equal(pairedKeys.findAgentRowByKeyHash('deadbeef'), null);
    assert.equal(pairedKeys.findAgentRowByKeyHash(null), null);
  });

  test('renameKey/revokeKey still work via the hash (UI contract)', () => {
    pairedKeys.addKey('agent-e');
    const storedHash = storedHashFor('agent-e');
    assert.equal(pairedKeys.renameKey(storedHash, 'agent-e-renamed'), true);
    assert.equal(storedHashFor('agent-e'), null);
    assert.ok(storedHashFor('agent-e-renamed'));
    assert.equal(pairedKeys.revokeKey(storedHash), true);
    // Revoked rows drop out of the active-only lookup.
    assert.equal(pairedKeys.findAgentRowByKeyHash(storedHash), null);
  });
});

// ── constant-time compare sanity ──────────────────────────────────────────────

describe('constantTimeEqual — sanity', () => {
  test('equal-length and different-length inputs do not throw', () => {
    assert.equal(pairedKeys.constantTimeEqual('abcd', 'abcd'), true);
    assert.equal(pairedKeys.constantTimeEqual('abcd', 'abce'), false);
    // Different lengths must be guarded before timingSafeEqual (which throws
    // on unequal-length buffers).
    assert.doesNotThrow(() => pairedKeys.constantTimeEqual('abc', 'abcdef'));
    assert.equal(pairedKeys.constantTimeEqual('abc', 'abcdef'), false);
    assert.equal(pairedKeys.constantTimeEqual('abc', 123), false);
  });
});
