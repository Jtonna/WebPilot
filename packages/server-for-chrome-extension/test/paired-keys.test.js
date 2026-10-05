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
    const { apiKey: plaintext, id } = pairedKeys.addKey('agent-a', 'Default');
    assert.equal(typeof plaintext, 'string');
    assert.ok(plaintext.length > 0);
    assert.equal(typeof id, 'number');

    const entry = pairedKeys.validateKey(plaintext);
    assert.ok(entry, 'validateKey should return the agent entry for a valid plaintext key');
    assert.equal(entry.agentName, 'agent-a');
    assert.equal(entry.profileId, 'Default');
    assert.equal(entry.state, 'active');
    // The entry exposes the non-secret row id, never a key/hash/plaintext.
    assert.equal(entry.id, id);
    assert.equal(entry.key, undefined);
    assert.equal(entry.api_key_hash, undefined);
    assert.equal(entry.apiKey, undefined);
  });

  test('createPairedAgent mints a key that validateKey accepts and returns its id', () => {
    const { apiKey, id, agentName } = pairedKeys.createPairedAgent({
      agentName: 'agent-paired',
      profileId: 'Profile 2',
    });
    assert.equal(typeof apiKey, 'string');
    assert.equal(typeof id, 'number');
    const entry = pairedKeys.validateKey(apiKey);
    assert.ok(entry);
    assert.equal(entry.id, id);
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
    const { apiKey: plaintext } = pairedKeys.addKey('agent-b2');
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

// ── listKeys never leaks key material ─────────────────────────────────────────

describe('listKeys — no key material', () => {
  test('entries contain id + metadata but no key/hash/preview', () => {
    const { id } = pairedKeys.addKey('agent-list', 'Default');
    const list = pairedKeys.listKeys();
    assert.equal(list.length, 1);
    const entry = list[0];
    assert.equal(entry.id, id);
    assert.equal(entry.agentName, 'agent-list');
    assert.equal(entry.profileId, 'Default');
    // No key material of any flavour.
    assert.equal(entry.key, undefined);
    assert.equal(entry.api_key_hash, undefined);
    assert.equal(entry.keyDisplay, undefined);
    assert.equal(entry.apiKey, undefined);
    // And definitely no value equal to the stored hash.
    const storedHash = storedHashFor('agent-list');
    for (const v of Object.values(entry)) {
      assert.notEqual(v, storedHash);
    }
  });
});

// ── regenerateKey rotates the credential ──────────────────────────────────────

describe('regenerateKey', () => {
  test('mints a new plaintext; the OLD key stops validating, the NEW one works', () => {
    const { apiKey: oldKey, id } = pairedKeys.addKey('agent-regen', 'Default');
    assert.ok(pairedKeys.validateKey(oldKey), 'precondition: old key validates');

    const newKey = pairedKeys.regenerateKey(id);
    assert.equal(typeof newKey, 'string');
    assert.ok(newKey.length > 0);
    assert.notEqual(newKey, oldKey);

    // Old key is dead; new key authenticates to the SAME agent (same id).
    assert.equal(pairedKeys.validateKey(oldKey), null, 'old key must stop authenticating');
    const entry = pairedKeys.validateKey(newKey);
    assert.ok(entry, 'new key must authenticate');
    assert.equal(entry.id, id);
    assert.equal(entry.agentName, 'agent-regen');
  });

  test('returns null for an unknown or revoked agent id', () => {
    assert.equal(pairedKeys.regenerateKey(999999), null);
    const { id } = pairedKeys.addKey('agent-regen-revoked');
    assert.equal(pairedKeys.revokeKey(id), true);
    assert.equal(pairedKeys.regenerateKey(id), null, 'revoked agent cannot regenerate');
  });
});

// ── admin ops resolve by row id (never by hash) ───────────────────────────────

describe('rename / revoke / rebind by id', () => {
  test('renameKey(id) updates the name', () => {
    const { id } = pairedKeys.addKey('agent-d', 'Default');
    assert.equal(pairedKeys.renameKey(id, 'agent-d-renamed'), true);
    assert.equal(storedHashFor('agent-d'), null);
    assert.ok(storedHashFor('agent-d-renamed'));
  });

  test('updateProfileBinding(id) rebinds the profile', () => {
    const { id } = pairedKeys.addKey('agent-rebind', 'Default');
    assert.equal(pairedKeys.updateProfileBinding(id, 'Profile 2'), true);
    assert.equal(pairedKeys.listKeys().find((a) => a.id === id).profileId, 'Profile 2');
  });

  test('revokeKey(id) soft-deletes the row', () => {
    const { apiKey, id } = pairedKeys.addKey('agent-e');
    assert.equal(pairedKeys.revokeKey(id), true);
    assert.equal(pairedKeys.validateKey(apiKey), null);
    assert.equal(pairedKeys.listKeys().some((a) => a.id === id), false);
  });

  test('the stored api_key_hash is NOT a valid identifier for admin ops', () => {
    pairedKeys.addKey('agent-hash-id', 'Default');
    const storedHash = storedHashFor('agent-hash-id');
    // Passing the hash where an id is expected resolves nothing.
    assert.equal(pairedKeys.renameKey(storedHash, 'nope'), false);
    assert.equal(pairedKeys.revokeKey(storedHash), false);
    assert.equal(pairedKeys.updateProfileBinding(storedHash, 'Profile 2'), false);
    assert.ok(storedHashFor('agent-hash-id'), 'agent is untouched by hash-keyed ops');
  });

  test('findAgentRowByKeyHash has been removed', () => {
    assert.equal(pairedKeys.findAgentRowByKeyHash, undefined);
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
