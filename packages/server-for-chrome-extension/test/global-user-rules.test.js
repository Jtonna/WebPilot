'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ── DB fixture setup ────────────────────────────────────────────────────────

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
delete require.cache[require.resolve('../src/site-policy')];
delete require.cache[require.resolve('../src/global-user-rules')];
const sitePolicy = require('../src/site-policy');
const { upsertGlobalUserRule, clearGlobalUserRule } = require('../src/global-user-rules');

// ── Seed helpers ────────────────────────────────────────────────────────────

function seedSigned(domain) {
  db.prepare(
    `INSERT OR REPLACE INTO global_site_blocklist_rules (domain, created_at) VALUES (?, ?)`
  ).run(domain, new Date().toISOString());
}

function userRow(domain) {
  return db.prepare('SELECT * FROM global_user_site_rules WHERE domain = ?').get(domain);
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

// ── upsertGlobalUserRule ─────────────────────────────────────────────────────

describe('upsertGlobalUserRule', () => {
  test('rejects wildcard "*"', () => {
    const result = upsertGlobalUserRule({ domain: '*', decision: 'allow' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid domain');
    assert.equal(
      result.body.reason,
      "wildcard ('*') rules are per-agent only — add them under Per-agent rules on the Sites page"
    );
  });

  test('rejects wildcard with surrounding whitespace " * "', () => {
    const result = upsertGlobalUserRule({ domain: ' * ', decision: 'allow' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid domain');
    assert.equal(
      result.body.reason,
      "wildcard ('*') rules are per-agent only — add them under Per-agent rules on the Sites page"
    );
  });

  test('rejects non-string domain', () => {
    const result = upsertGlobalUserRule({ domain: 12345, decision: 'allow' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid domain');
    assert.equal(result.body.reason, `domain ${JSON.stringify(12345)} did not normalize to a usable hostname`);
  });

  test('rejects empty string domain', () => {
    const result = upsertGlobalUserRule({ domain: '', decision: 'allow' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid domain');
    assert.equal(result.body.reason, `domain ${JSON.stringify('')} did not normalize to a usable hostname`);
  });

  test('rejects IP literal domain', () => {
    const result = upsertGlobalUserRule({ domain: '192.168.1.1', decision: 'allow' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid domain');
    assert.equal(
      result.body.reason,
      `domain ${JSON.stringify('192.168.1.1')} did not normalize to a usable hostname`
    );
  });

  test('rejects wildcard-subdomain pattern "*.foo.com"', () => {
    const result = upsertGlobalUserRule({ domain: '*.foo.com', decision: 'allow' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid domain');
    assert.equal(
      result.body.reason,
      `domain ${JSON.stringify('*.foo.com')} did not normalize to a usable hostname`
    );
  });

  test('rejects an invalid decision', () => {
    const result = upsertGlobalUserRule({ domain: 'example.com', decision: 'deny' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid decision');
    assert.equal(result.body.reason, "decision must be 'allow' or 'block'");
  });

  test('upserts a valid rule', () => {
    const result = upsertGlobalUserRule({ domain: 'example.com', decision: 'allow' });
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'upsert');
    assert.equal(result.rule.domain, 'example.com');
    assert.equal(result.rule.decision, 'allow');
    assert.equal(result.rule.source, 'user');
    assert.ok(result.rule.createdAt);
    assert.ok(result.rule.updatedAt);
  });

  test('second upsert keeps createdAt, updates updatedAt, overwrites decision', async () => {
    const first = upsertGlobalUserRule({ domain: 'example.com', decision: 'allow' });
    assert.equal(first.ok, true);
    // Ensure a measurable timestamp difference.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = upsertGlobalUserRule({ domain: 'example.com', decision: 'block' });
    assert.equal(second.ok, true);
    assert.equal(second.rule.decision, 'block');
    assert.equal(second.rule.createdAt, first.rule.createdAt);
    assert.notEqual(second.rule.updatedAt, first.rule.updatedAt);
  });

  test('normalizes a full URL input', () => {
    const result = upsertGlobalUserRule({ domain: 'https://www.Example.com/x', decision: 'allow' });
    assert.equal(result.ok, true);
    assert.equal(result.rule.domain, 'example.com');
  });
});

// ── clearGlobalUserRule ──────────────────────────────────────────────────────

describe('clearGlobalUserRule', () => {
  test('deletes an existing user row', () => {
    upsertGlobalUserRule({ domain: 'example.com', decision: 'allow' });
    const result = clearGlobalUserRule('example.com');
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'delete');
    assert.equal(result.domain, 'example.com');
    assert.equal(userRow('example.com'), undefined);
  });

  test('refuses to delete a signed-only blocklist domain', () => {
    seedSigned('bad.com');
    const result = clearGlobalUserRule('bad.com');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'cannot delete signed blocklist rule');
    assert.equal(
      result.body.reason,
      "signed block list entries can't be deleted; turn off the global block list on the Sites page"
    );
    assert.equal(result.body.domain, 'bad.com');
    assert.equal(result.body.source, 'global_site_blocklist');
  });

  test('404s when neither tier has the domain', () => {
    const result = clearGlobalUserRule('nowhere.com');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: 'rule not found', domain: 'nowhere.com' });
  });

  test('deletes a user row shadowing a signed entry, exposing the signed block', () => {
    seedSigned('shadowed.com');
    upsertGlobalUserRule({ domain: 'shadowed.com', decision: 'allow' });
    const result = clearGlobalUserRule('shadowed.com');
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'delete');
    assert.equal(userRow('shadowed.com'), undefined);

    const verdict = sitePolicy.isAllowed(null, 'shadowed.com');
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.source, 'global_site_blocklist');
  });

  test('"*" gets the generic normalization reason, not the wildcard-specific one', () => {
    const result = clearGlobalUserRule('*');
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid domain');
    assert.equal(result.body.reason, `domain ${JSON.stringify('*')} did not normalize to a usable hostname`);
    assert.notEqual(
      result.body.reason,
      "wildcard ('*') rules are per-agent only — add them under Per-agent rules on the Sites page"
    );
  });
});
