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

function setConfigFlag(db, enabled) {
  db.prepare(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('global_site_blocklist_enabled', ?, ?)`
  ).run(enabled ? 'true' : 'false', new Date().toISOString());
}

function seedGlobalRule(db, { domain, decision, source }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO global_site_rules (domain, decision, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(domain, decision, source, now, now);
}

function seedAgent(db, { id, apiKey = 'hash_' + id }) {
  db.prepare(
    `INSERT OR REPLACE INTO agents (id, name, api_key_hash, created_at, state) VALUES (?, ?, ?, ?, 'active')`
  ).run(id, 'agent_' + id, apiKey, new Date().toISOString());
}

function seedAgentOverride(db, { agentId, domain, decision }) {
  db.prepare(
    `INSERT OR REPLACE INTO agent_site_overrides (agent_id, domain, decision, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(agentId, domain, decision, new Date().toISOString());
}

function clearTables(db) {
  db.exec(
    'DELETE FROM agent_site_overrides; DELETE FROM global_site_rules; DELETE FROM agents; DELETE FROM config;'
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('site-policy isAllowed: global site blocklist flag gate', () => {
  beforeEach(() => {
    testDb = createTestDb();
    injectDb(testDb);
  });

  test('1 — flag-on, global-site-blocklist-block exact match → blocked', () => {
    setConfigFlag(testDb, true);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://evil.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'global_site_blocklist');
  });

  test('2 — flag-on, global-site-blocklist-block parent + subdomain request → blocked', () => {
    setConfigFlag(testDb, true);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://www.sub.evil.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'global_site_blocklist');
  });

  test('3 — flag-off, global-site-blocklist-block exact → default allow', () => {
    setConfigFlag(testDb, false);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://evil.com');
    assert.equal(result.allowed, true);
    assert.equal(result.source, 'default');
  });

  test('4 — flag-off, global-site-blocklist-block parent + subdomain request → default allow', () => {
    setConfigFlag(testDb, false);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://sub.evil.com');
    assert.equal(result.allowed, true);
    assert.equal(result.source, 'default');
  });

  test('5 — flag-off, user-block exact → still blocked (user unaffected by flag)', () => {
    setConfigFlag(testDb, false);
    seedGlobalRule(testDb, { domain: 'spam.com', decision: 'block', source: 'user' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://spam.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'global_user');
  });

  test('6 — flag-on, user-block exact → blocked', () => {
    setConfigFlag(testDb, true);
    seedGlobalRule(testDb, { domain: 'spam.com', decision: 'block', source: 'user' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://spam.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'global_user');
  });

  test('7 — flag-off: global-site-blocklist on subdomain + user-block on parent → user-block wins', () => {
    setConfigFlag(testDb, false);
    seedGlobalRule(testDb, { domain: 'api.evil.com', decision: 'block', source: 'global_site_blocklist' });
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'user' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://api.evil.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'global_user');
    assert.equal(result.matchedDomain, 'evil.com');
  });

  test('8 — flag-off + per-agent block override on global-site-blocklist domain → blocked via override', () => {
    setConfigFlag(testDb, false);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    seedAgent(testDb, { id: 7 });
    seedAgentOverride(testDb, { agentId: 7, domain: 'evil.com', decision: 'block' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(7, 'https://evil.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'agent_override');
  });

  test('9 — flag-off + per-agent allow override on global-site-blocklist domain → allowed via override', () => {
    setConfigFlag(testDb, false);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    seedAgent(testDb, { id: 7 });
    seedAgentOverride(testDb, { agentId: 7, domain: 'evil.com', decision: 'allow' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(7, 'https://evil.com');
    assert.equal(result.allowed, true);
    assert.equal(result.source, 'agent_override');
  });

  test('10 — flag absent (no config row) defaults to enabled → global-site-blocklist block applies', () => {
    // No config row inserted
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://evil.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'global_site_blocklist');
  });

  test('11 — getRulesForAgent returns global-site-blocklist rows when flag is off (admin path unaffected)', () => {
    setConfigFlag(testDb, false);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    seedGlobalRule(testDb, { domain: 'spam.com', decision: 'block', source: 'user' });
    const { getRulesForAgent } = loadSitePolicy();
    const rules = getRulesForAgent(null);
    const globalSiteBlocklistRow = rules.find(r => r.domain === 'evil.com');
    const userRow = rules.find(r => r.domain === 'spam.com');
    assert.ok(globalSiteBlocklistRow, 'global-site-blocklist row should be present in getRulesForAgent results');
    assert.equal(globalSiteBlocklistRow.source, 'global_site_blocklist');
    assert.ok(userRow, 'user row should be present in getRulesForAgent results');
  });

  test('12 — flag toggled mid-test → second call sees new behavior (no module-level caching)', () => {
    setConfigFlag(testDb, true);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    const { isAllowed } = loadSitePolicy();
    const call1 = isAllowed(null, 'https://evil.com');
    assert.equal(call1.allowed, false, 'call1: flag=true should block global-site-blocklist');
    assert.equal(call1.source, 'global_site_blocklist');

    setConfigFlag(testDb, false);
    const call2 = isAllowed(null, 'https://evil.com');
    assert.equal(call2.allowed, true, 'call2: flag=false should allow global-site-blocklist');
    assert.equal(call2.source, 'default');
  });

  test('13 — URL parsing edge inputs: empty string and about:blank → default allow (both flag states)', () => {
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });

    setConfigFlag(testDb, true);
    const { isAllowed: isAllowedOn } = loadSitePolicy();
    assert.equal(isAllowedOn(null, '').allowed, true);
    assert.equal(isAllowedOn(null, '').source, 'default');
    assert.equal(isAllowedOn(null, 'about:blank').allowed, true);
    assert.equal(isAllowedOn(null, 'about:blank').source, 'default');

    setConfigFlag(testDb, false);
    const { isAllowed: isAllowedOff } = loadSitePolicy();
    assert.equal(isAllowedOff(null, '').allowed, true);
    assert.equal(isAllowedOff(null, '').source, 'default');
    assert.equal(isAllowedOff(null, 'about:blank').allowed, true);
    assert.equal(isAllowedOff(null, 'about:blank').source, 'default');
  });

  test('14 — agentId=null with flag off + global-site-blocklist rule → allow (unauthenticated caller gated correctly)', () => {
    setConfigFlag(testDb, false);
    seedGlobalRule(testDb, { domain: 'evil.com', decision: 'block', source: 'global_site_blocklist' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(null, 'https://evil.com');
    assert.equal(result.allowed, true);
    assert.equal(result.source, 'default');
  });

  test('15 — per-agent block override + flag ON + global-site-blocklist allow on domain → override wins', () => {
    setConfigFlag(testDb, true);
    seedGlobalRule(testDb, { domain: 'oddly.com', decision: 'allow', source: 'global_site_blocklist' });
    seedAgent(testDb, { id: 7 });
    seedAgentOverride(testDb, { agentId: 7, domain: 'oddly.com', decision: 'block' });
    const { isAllowed } = loadSitePolicy();
    const result = isAllowed(7, 'https://oddly.com');
    assert.equal(result.allowed, false);
    assert.equal(result.source, 'agent_override');
  });
});
