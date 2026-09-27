'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ── DB fixture setup ────────────────────────────────────────────────────────

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

function loadSitePolicy() {
  delete require.cache[require.resolve('../src/site-policy')];
  return require('../src/site-policy');
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

function setGlobalTier(db, enabled) {
  db.prepare(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('global_tier_enabled', ?, ?)`
  ).run(enabled ? 'true' : 'false', new Date().toISOString());
}

function seedSigned(db, domain) {
  db.prepare(
    `INSERT OR REPLACE INTO global_site_blocklist_rules (domain, created_at) VALUES (?, ?)`
  ).run(domain, new Date().toISOString());
}

function seedGlobalUser(db, { domain, decision }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO global_user_site_rules (domain, decision, created_at, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run(domain, decision, now, now);
}

function seedAgent(db, { id, apiKey = 'hash_' + id }) {
  db.prepare(
    `INSERT OR REPLACE INTO agents (id, name, api_key_hash, created_at, state) VALUES (?, ?, ?, ?, 'active')`
  ).run(id, 'agent_' + id, apiKey, new Date().toISOString());
}

function seedAgentRule(db, { agentId, domain, decision }) {
  db.prepare(
    `INSERT OR REPLACE INTO agent_site_overrides (agent_id, domain, decision, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(agentId, domain, decision, new Date().toISOString());
}

function clearTables(db) {
  db.exec(
    'DELETE FROM agent_site_overrides; DELETE FROM global_user_site_rules; DELETE FROM global_site_blocklist_rules; DELETE FROM agents; DELETE FROM config;'
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('worked examples (#102)', () => {
  beforeEach(() => {
    testDb = createTestDb();
    injectDb(testDb);
  });

  test('Coinbase: signed block + global user allow → global user wins for agents without overrides', () => {
    seedSigned(testDb, 'coinbase.com');
    seedGlobalUser(testDb, { domain: 'coinbase.com', decision: 'allow' });
    seedAgent(testDb, { id: 1 });
    seedAgent(testDb, { id: 2 });
    seedAgentRule(testDb, { agentId: 2, domain: 'coinbase.com', decision: 'block' });
    const { isAllowed } = loadSitePolicy();

    const r1 = isAllowed(1, 'https://coinbase.com');
    assert.equal(r1.allowed, true);
    assert.equal(r1.source, 'global_user');

    const r2 = isAllowed(2, 'https://coinbase.com');
    assert.equal(r2.allowed, false);
    assert.equal(r2.source, 'agent_override');

    const rNull = isAllowed(null, 'https://coinbase.com');
    assert.equal(rNull.allowed, true);
    assert.equal(rNull.source, 'global_user');
  });

  test('Amex: signed block, per-agent allow overrides for one agent, blocked for others and null', () => {
    seedSigned(testDb, 'americanexpress.com');
    seedAgent(testDb, { id: 1 });
    seedAgent(testDb, { id: 2 });
    seedAgent(testDb, { id: 3 });
    seedAgentRule(testDb, { agentId: 1, domain: 'americanexpress.com', decision: 'allow' });
    const { isAllowed } = loadSitePolicy();

    const r1 = isAllowed(1, 'https://americanexpress.com');
    assert.equal(r1.allowed, true);
    assert.equal(r1.source, 'agent_override');

    const r1sub = isAllowed(1, 'https://www.americanexpress.com/x');
    assert.equal(r1sub.allowed, true);
    assert.equal(r1sub.source, 'agent_override');

    for (const agentId of [2, 3, null]) {
      const r = isAllowed(agentId, 'https://americanexpress.com');
      assert.equal(r.allowed, false);
      assert.equal(r.source, 'global_site_blocklist');
    }
  });

  test('LinkedIn + wildcard: toggle off, agent wildcard block with named allow override', () => {
    setGlobalTier(testDb, false);
    seedSigned(testDb, 'linkedin.com');
    seedGlobalUser(testDb, { domain: 'example.com', decision: 'allow' });
    seedAgent(testDb, { id: 1 });
    seedAgent(testDb, { id: 2 });
    seedAgentRule(testDb, { agentId: 1, domain: '*', decision: 'block' });
    seedAgentRule(testDb, { agentId: 1, domain: 'linkedin.com', decision: 'allow' });
    const { isAllowed } = loadSitePolicy();

    const rLinkedin = isAllowed(1, 'https://linkedin.com');
    assert.equal(rLinkedin.allowed, true);
    assert.equal(rLinkedin.matchedDomain, 'linkedin.com');

    const rWwwLinkedin = isAllowed(1, 'https://www.linkedin.com');
    assert.equal(rWwwLinkedin.allowed, true);
    assert.equal(rWwwLinkedin.matchedDomain, 'linkedin.com');

    const rExample = isAllowed(1, 'https://example.com');
    assert.equal(rExample.allowed, false);
    assert.equal(rExample.matchedDomain, '*');

    const rChase = isAllowed(1, 'https://chase.com');
    assert.equal(rChase.allowed, false);
    assert.equal(rChase.matchedDomain, '*');

    const rIp = isAllowed(1, 'http://192.168.1.1/');
    assert.equal(rIp.allowed, false);
    assert.equal(rIp.matchedDomain, '*');

    const rLocalhost = isAllowed(1, 'http://localhost:3000');
    assert.equal(rLocalhost.allowed, false);
    assert.equal(rLocalhost.matchedDomain, '*');

    const rAgent2 = isAllowed(2, 'https://example.com');
    assert.equal(rAgent2.allowed, true);
    assert.equal(rAgent2.source, 'default');
  });

  test('toggle off disables global user tier, control toggle on re-enables it', () => {
    setGlobalTier(testDb, false);
    seedGlobalUser(testDb, { domain: 'example.com', decision: 'block' });
    seedAgent(testDb, { id: 1 });
    const { isAllowed } = loadSitePolicy();

    const rOff = isAllowed(1, 'https://example.com');
    assert.equal(rOff.allowed, true);
    assert.equal(rOff.source, 'default');

    setGlobalTier(testDb, true);
    const rOn = isAllowed(1, 'https://example.com');
    assert.equal(rOn.allowed, false);
    assert.equal(rOn.source, 'global_user');
  });
});

describe('acceptance tests (#102)', () => {
  beforeEach(() => {
    testDb = createTestDb();
    injectDb(testDb);
  });

  test('removing a global user rule restores signed behavior', () => {
    seedSigned(testDb, 'x.com');
    const { isAllowed, setGlobalRule, removeGlobalRule } = loadSitePolicy();

    const before = isAllowed(null, 'https://x.com');
    assert.equal(before.allowed, false);
    assert.equal(before.source, 'global_site_blocklist');

    setGlobalRule('x.com', 'allow');
    const afterSet = isAllowed(null, 'https://x.com');
    assert.equal(afterSet.allowed, true);
    assert.equal(afterSet.source, 'global_user');

    const signedCountAfterSet = testDb
      .prepare('SELECT COUNT(*) AS c FROM global_site_blocklist_rules')
      .get().c;
    assert.equal(signedCountAfterSet, 1);

    removeGlobalRule('x.com');
    const afterRemove = isAllowed(null, 'https://x.com');
    assert.equal(afterRemove.allowed, false);
    assert.equal(afterRemove.source, 'global_site_blocklist');

    const signedCountAfterRemove = testDb
      .prepare('SELECT COUNT(*) AS c FROM global_site_blocklist_rules')
      .get().c;
    assert.equal(signedCountAfterRemove, 1);
  });

  test('toggle off disables both global tiers', () => {
    seedSigned(testDb, 'a.com');
    seedGlobalUser(testDb, { domain: 'b.com', decision: 'block' });
    setGlobalTier(testDb, false);
    const { isAllowed } = loadSitePolicy();

    const rA = isAllowed(null, 'https://a.com');
    assert.equal(rA.allowed, true);
    assert.equal(rA.source, 'default');

    const rB = isAllowed(null, 'https://b.com');
    assert.equal(rB.allowed, true);
    assert.equal(rB.source, 'default');
  });
});

describe('additional coverage (#102)', () => {
  beforeEach(() => {
    testDb = createTestDb();
    injectDb(testDb);
  });

  test('named block beats wildcard allow', () => {
    seedAgent(testDb, { id: 1 });
    seedAgentRule(testDb, { agentId: 1, domain: '*', decision: 'allow' });
    seedAgentRule(testDb, { agentId: 1, domain: 'evil.com', decision: 'block' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(1, 'https://evil.com');
    assert.equal(result.allowed, false);
    assert.equal(result.matchedDomain, 'evil.com');
  });

  test('named chase.com covers secure.chase.com ahead of wildcard', () => {
    seedAgent(testDb, { id: 1 });
    seedAgentRule(testDb, { agentId: 1, domain: '*', decision: 'block' });
    seedAgentRule(testDb, { agentId: 1, domain: 'chase.com', decision: 'allow' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(1, 'https://secure.chase.com');
    assert.equal(result.allowed, true);
    assert.equal(result.matchedDomain, 'chase.com');
  });

  test("setGlobalRule('*') throws", () => {
    const { setGlobalRule } = loadSitePolicy();
    assert.throws(() => setGlobalRule('*', 'block'));
  });

  test("normalizeDomain('*.foo.com') returns null", () => {
    const { normalizeDomain } = loadSitePolicy();
    assert.equal(normalizeDomain('*.foo.com'), null);
  });

  test('normalizeRuleDomain wildcard handling', () => {
    const { normalizeRuleDomain } = loadSitePolicy();
    assert.equal(normalizeRuleDomain('*', { allowWildcard: true }), '*');
    assert.equal(normalizeRuleDomain('*'), null);
  });

  test('setAgentOverride / removeAgentOverride round-trip on wildcard', () => {
    seedAgent(testDb, { id: 1 });
    const { setAgentOverride, removeAgentOverride, isAllowed } = loadSitePolicy();
    setAgentOverride(1, '*', 'block');
    const blocked = isAllowed(1, 'https://anywhere.com');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.matchedDomain, '*');

    removeAgentOverride(1, '*');
    const allowed = isAllowed(1, 'https://anywhere.com');
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.source, 'default');
  });

  test('toggle is enabled when key is missing', () => {
    const { isGlobalTierEnabled } = loadSitePolicy();
    assert.equal(isGlobalTierEnabled(), true);
  });

  test('setGlobalTierEnabled(false) flips mid-test', () => {
    seedGlobalUser(testDb, { domain: 'example.com', decision: 'block' });
    const { isAllowed, setGlobalTierEnabled } = loadSitePolicy();
    const before = isAllowed(null, 'https://example.com');
    assert.equal(before.allowed, false);

    setGlobalTierEnabled(false);
    const after = isAllowed(null, 'https://example.com');
    assert.equal(after.allowed, true);
    assert.equal(after.source, 'default');
  });

  test('listGlobalRules returns both tiers, incl. same domain in both, ordered', () => {
    seedSigned(testDb, 'shared.com');
    seedSigned(testDb, 'zzz.com');
    seedGlobalUser(testDb, { domain: 'shared.com', decision: 'allow' });
    seedGlobalUser(testDb, { domain: 'aaa.com', decision: 'block' });
    const { listGlobalRules } = loadSitePolicy();
    const rules = listGlobalRules();

    const userShared = rules.find(r => r.source === 'user' && r.domain === 'shared.com');
    const signedShared = rules.find(
      r => r.source === 'global_site_blocklist' && r.domain === 'shared.com'
    );
    assert.ok(userShared, 'user tier row for shared.com should be present');
    assert.equal(userShared.decision, 'allow');
    assert.ok(signedShared, 'signed tier row for shared.com should be present');
    assert.equal(signedShared.decision, 'block');
    assert.equal(signedShared.updatedAt, signedShared.createdAt);

    // ordered by source then domain
    for (let i = 1; i < rules.length; i++) {
      const prev = rules[i - 1];
      const cur = rules[i];
      const key = r => `${r.source}\u0000${r.domain}`;
      assert.ok(key(prev) <= key(cur), 'rules should be ordered by source then domain');
    }
  });

  test('about:blank and empty string default allow even with agent wildcard block', () => {
    seedAgent(testDb, { id: 1 });
    seedAgentRule(testDb, { agentId: 1, domain: '*', decision: 'block' });
    const { isAllowed } = loadSitePolicy();

    const rBlank = isAllowed(1, 'about:blank');
    assert.equal(rBlank.allowed, true);
    assert.equal(rBlank.source, 'default');

    const rEmpty = isAllowed(1, '');
    assert.equal(rEmpty.allowed, true);
    assert.equal(rEmpty.source, 'default');

    const rChrome = isAllowed(1, 'chrome://x');
    assert.equal(rChrome.allowed, true);
    assert.equal(rChrome.source, 'default');

    const rData = isAllowed(1, 'data:text/plain,hi');
    assert.equal(rData.allowed, true);
    assert.equal(rData.source, 'default');
  });

  test('agent block beats global user allow', () => {
    seedGlobalUser(testDb, { domain: 'example.com', decision: 'allow' });
    seedAgent(testDb, { id: 1 });
    seedAgentRule(testDb, { agentId: 1, domain: 'example.com', decision: 'block' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(1, 'https://example.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'agent_override');
  });

  test("wildcard host input does not match the agent's '*' row", () => {
    seedAgent(testDb, { id: 1 });
    seedAgentRule(testDb, { agentId: 1, domain: '*', decision: 'block' });
    const { isAllowed } = loadSitePolicy();
    for (const input of ['*.foo.com', 'https://*.foo.com/x']) {
      const r = isAllowed(1, input);
      assert.equal(r.allowed, true, input);
      assert.equal(r.source, 'default', input);
      assert.equal(r.domain, null, input);
      assert.equal(r.matchedDomain, null, input);
    }
  });

  test('normalizeRuleDomain normalizes non-wildcard input in both modes', () => {
    const { normalizeRuleDomain } = loadSitePolicy();
    for (const opts of [undefined, { allowWildcard: true }]) {
      assert.equal(normalizeRuleDomain('https://WWW.Foo.com/x', opts), 'foo.com');
      assert.equal(normalizeRuleDomain('*.foo.com', opts), null);
      assert.equal(normalizeRuleDomain('localhost', opts), null);
    }
    assert.equal(normalizeRuleDomain('  *  ', { allowWildcard: true }), '*');
  });

  test('getGlobalUserRule / isSignedBlocklisted are exact-match per tier', () => {
    seedSigned(testDb, 'chase.com');
    seedGlobalUser(testDb, { domain: 'chase.com', decision: 'allow' });
    const { getGlobalUserRule, isSignedBlocklisted, removeGlobalRule } = loadSitePolicy();

    assert.equal(getGlobalUserRule('chase.com').decision, 'allow');
    assert.equal(getGlobalUserRule('secure.chase.com'), null);
    assert.equal(isSignedBlocklisted('https://www.chase.com'), true);
    assert.equal(isSignedBlocklisted('secure.chase.com'), false);

    assert.equal(removeGlobalRule('chase.com'), true);
    assert.equal(removeGlobalRule('chase.com'), false);
    assert.equal(getGlobalUserRule('chase.com'), null);
    assert.equal(isSignedBlocklisted('chase.com'), true);
  });
});
