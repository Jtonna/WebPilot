'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ── DB fixture setup ────────────────────────────────────────────────────────
// Same pattern as test/site-policy.test.js: load schema.sql into an
// in-memory better-sqlite3 DB and stub `../src/db/connection` via
// require.cache so the module under test (and site-policy, which it
// lazy-requires) both see the same connection.

const schemaPath = path.join(__dirname, '../src/db/schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

let testDb;

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(schemaSql);
  return db;
}

function injectDb(db) {
  require.cache[require.resolve('../src/db/connection')] = {
    exports: { getDb: () => db, init: () => db },
  };
}

function loadUpdater() {
  delete require.cache[require.resolve('../src/global-site-blocklist-updater')];
  delete require.cache[require.resolve('../src/site-policy')];
  return require('../src/global-site-blocklist-updater');
}

function seedUserRule(db, domain) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO global_user_site_rules (domain, decision, created_at, updated_at)
     VALUES (?, 'block', ?, ?)`
  ).run(domain, now, now);
}

beforeEach(() => {
  testDb = createTestDb();
  injectDb(testDb);
});

describe('global-site-blocklist-updater', () => {
  test('_applySignedTier inserts signed domains and leaves user rows alone', () => {
    const updater = loadUpdater();
    seedUserRule(testDb, 'x.com');

    const result = updater._applySignedTier(['x.com', 'y.com'], 'v1', 'test-source');

    assert.equal(result.inserted, 2);

    const userRow = testDb
      .prepare('SELECT * FROM global_user_site_rules WHERE domain = ?')
      .get('x.com');
    assert.ok(userRow, 'user row for x.com should still exist');

    const signedDomains = testDb
      .prepare('SELECT domain FROM global_site_blocklist_rules ORDER BY domain')
      .all()
      .map((r) => r.domain);
    assert.deepEqual(signedDomains, ['x.com', 'y.com']);
  });

  test('a second _applySignedTier call replaces the signed set and leaves user rows alone', () => {
    const updater = loadUpdater();
    seedUserRule(testDb, 'x.com');

    updater._applySignedTier(['x.com', 'y.com'], 'v1', 'test-source');
    const second = updater._applySignedTier(['z.com'], 'v2', 'test-source');

    assert.equal(second.deleted, 2);
    assert.equal(second.inserted, 1);

    const signedDomains = testDb
      .prepare('SELECT domain FROM global_site_blocklist_rules ORDER BY domain')
      .all()
      .map((r) => r.domain);
    assert.deepEqual(signedDomains, ['z.com']);

    const userRow = testDb
      .prepare('SELECT * FROM global_user_site_rules WHERE domain = ?')
      .get('x.com');
    assert.ok(userRow, 'user row for x.com should survive the second swap');
  });

  test('duplicate domains in the input array do not throw', () => {
    const updater = loadUpdater();

    assert.doesNotThrow(() => {
      updater._applySignedTier(['dup.com', 'dup.com', 'other.com'], 'v1', 'test-source');
    });

    const signedDomains = testDb
      .prepare('SELECT domain FROM global_site_blocklist_rules ORDER BY domain')
      .all()
      .map((r) => r.domain);
    assert.deepEqual(signedDomains, ['dup.com', 'other.com']);
  });

  test('getStatus().domainCount equals the signed table size', () => {
    const updater = loadUpdater();
    updater._applySignedTier(['a.com', 'b.com', 'c.com'], 'v1', 'test-source');

    const status = updater.getStatus();
    assert.equal(status.domainCount, 3);
  });

  test('getStatus().enabled follows global_tier_enabled', () => {
    const updater = loadUpdater();
    const sitePolicy = require('../src/site-policy');

    sitePolicy.setGlobalTierEnabled(false);
    assert.equal(updater.getStatus().enabled, false);

    sitePolicy.setGlobalTierEnabled(true);
    assert.equal(updater.getStatus().enabled, true);
  });

  test('getStatus().version reflects the meta row', () => {
    const updater = loadUpdater();
    assert.equal(updater.getStatus().version, null);

    updater._applySignedTier(['a.com'], '2024.09.01', 'test-source');
    assert.equal(updater.getStatus().version, '2024.09.01');

    updater._applySignedTier(['a.com', 'b.com'], '2024.10.01', 'test-source');
    assert.equal(updater.getStatus().version, '2024.10.01');
  });
});
