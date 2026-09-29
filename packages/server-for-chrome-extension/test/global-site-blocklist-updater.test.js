'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ── Signing-key fixture ──────────────────────────────────────────────────────
// Generate an ed25519 key pair once, write the public half to a tmp file, and
// point WEBPILOT_PUBKEY_PATH at it BEFORE any require of manifest-verifier
// (it caches the loaded key at module scope on first use).

const { publicKey: pubKey, privateKey: privKey } = crypto.generateKeyPairSync('ed25519');
const pubKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-pubkey-'));
const pubKeyPath = path.join(pubKeyDir, 'PUBKEY.pem');
fs.writeFileSync(pubKeyPath, pubKey.export({ type: 'spki', format: 'pem' }));
process.env.WEBPILOT_PUBKEY_PATH = pubKeyPath;

const { stableStringify } = require('../src/lib/manifest-verifier');

// ── DB fixture setup ────────────────────────────────────────────────────────
// Same pattern as test/site-policy.test.js: load schema.sql into an
// in-memory better-sqlite3 DB and stub `../src/db/connection` via
// require.cache so the module under test (and site-policy, which it
// lazy-requires) both see the same connection.

const schemaPath = path.join(__dirname, '../src/db/schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

let testDb;
let tmpDir;
let savedFetch;

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
  delete require.cache[require.resolve('../src/lib/manifest-verifier')];
  return require('../src/global-site-blocklist-updater');
}

function seedUserRule(db, domain) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO global_user_site_rules (domain, decision, created_at, updated_at)
     VALUES (?, 'block', ?, ?)`
  ).run(domain, now, now);
}

function metaRow() {
  return testDb.prepare('SELECT * FROM global_site_blocklist_meta WHERE id = 1').get();
}

function rows() {
  return testDb
    .prepare('SELECT domain FROM global_site_blocklist_rules ORDER BY domain')
    .all()
    .map((r) => r.domain);
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Build a signed bundle fixture matching the real manifest shape the
 * updater parses (src/global-site-blocklist-updater.js ~:365-380):
 * `{version, lists: [{name, file}]}`.
 */
function makeBundle({ version, lists }) {
  const fileNames = Object.keys(lists);
  const manifestText = JSON.stringify({
    version,
    lists: fileNames.map((file) => ({ name: file, file })),
  });
  const files = { 'manifest.json': sha256hex(manifestText) };
  for (const [file, body] of Object.entries(lists)) {
    files[file] = sha256hex(body);
  }
  const signedText = stableStringify({ algorithm: 'sha256', version, files }) + '\n';
  const sigText = crypto.sign(null, Buffer.from(signedText, 'utf8'), privKey).toString('base64');
  return { manifestText, signedText, sigText, lists };
}

/**
 * Stub globalThis.fetch. `routes` maps a URL suffix (matched via
 * `url.endsWith(suffix)`) to a value:
 *   - string  -> 200 response with that body
 *   - number  -> response with that status code, empty body
 *   - 'NETERR' -> throws a TypeError('fetch failed')
 * Suffixes are checked in the order `.sig`, `signed-manifest.json`,
 * `manifest.json`, then any remaining (list file) routes.
 */
function stubFetch(routes) {
  const orderedSuffixes = Object.keys(routes).sort((a, b) => {
    const rank = (s) => {
      if (s.endsWith('.sig')) return 0;
      if (s.endsWith('signed-manifest.json')) return 1;
      if (s.endsWith('manifest.json')) return 2;
      return 3;
    };
    return rank(a) - rank(b);
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    for (const suffix of orderedSuffixes) {
      if (urlStr.endsWith(suffix)) {
        const value = routes[suffix];
        if (value === 'NETERR') {
          throw new TypeError('fetch failed');
        }
        if (typeof value === 'number') {
          return new Response('', { status: value });
        }
        return new Response(value);
      }
    }
    return new Response('', { status: 404 });
  };
}

stubFetch.network = function network() {
  globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
};

/**
 * Write a signed bundle to the on-disk cache dir, matching the file names
 * `_readLocalCache` expects: manifest.json, signed-manifest.json,
 * signed-manifest.json.sig, plus each referenced list file.
 */
function writeCache(bundle) {
  const dir = path.join(tmpDir, 'global-site-blocklists');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), bundle.manifestText, 'utf8');
  fs.writeFileSync(path.join(dir, 'signed-manifest.json'), bundle.signedText, 'utf8');
  fs.writeFileSync(path.join(dir, 'signed-manifest.json.sig'), bundle.sigText, 'utf8');
  for (const [file, body] of Object.entries(bundle.lists)) {
    const dest = path.join(dir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, 'utf8');
  }
  return dir;
}

let _silencedConsole = [];

function silenceConsole() {
  for (const method of ['warn', 'log']) {
    const orig = console[method];
    _silencedConsole.push([method, orig]);
    console[method] = () => {};
  }
}

function restoreConsole() {
  for (const [method, orig] of _silencedConsole) {
    console[method] = orig;
  }
  _silencedConsole = [];
}

beforeEach(() => {
  testDb = createTestDb();
  injectDb(testDb);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-blocklist-'));
  require.cache[require.resolve('../src/service/paths')] = {
    exports: { getDataDir: () => tmpDir },
  };
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  restoreConsole();
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

  // ── checkForUpdates: no-write-on-unavailable behavior ───────────────────

  test('case 0: valid remote bundle, empty DB -> updated, cache written [GREEN]', async () => {
    silenceConsole();
    const baseUrl = 'https://example.test/blocklists';
    const updater = loadUpdater();
    updater.init({ baseUrl });

    const bundle = makeBundle({ version: 'v2', lists: { 'list.txt': 'a.com\nb.com\n' } });
    stubFetch({
      '.sig': bundle.sigText,
      'signed-manifest.json': bundle.signedText,
      'manifest.json': bundle.manifestText,
      'list.txt': bundle.lists['list.txt'],
    });

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, true);
    assert.equal(result.source, baseUrl);
    assert.deepEqual(rows(), ['a.com', 'b.com']);

    const cacheDir = path.join(tmpDir, 'global-site-blocklists');
    assert.ok(fs.existsSync(path.join(cacheDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(cacheDir, 'list.txt')));
  });

  test('case 1 [fix]: network error, no cache, seeded rows -> unavailable, rows/meta unchanged', async () => {
    silenceConsole();
    const updater = loadUpdater();
    updater._applySignedTier(['x.com', 'y.com'], 'v1', 'seed');
    const before = metaRow();

    stubFetch.network();

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, false);
    assert.equal(result.skipped, 'unavailable');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);

    assert.deepEqual(rows(), ['x.com', 'y.com']);
    const after = metaRow();
    assert.equal(after.version, 'v1');
    assert.equal(after.last_fetched_at, before.last_fetched_at);
  });

  test('case 2 [fix]: network error, empty DB -> no throw, no meta row, no manifest cache file', async () => {
    silenceConsole();
    const updater = loadUpdater();

    stubFetch.network();

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, false);
    assert.equal(metaRow(), undefined);

    const status = updater.getStatus();
    assert.equal(status.version, null);
    assert.equal(status.lastFetchedAt, null);
    assert.equal(status.domainCount, 0);
    assert.ok(status.lastCheckError, 'lastCheckError should be set');

    assert.ok(
      !fs.existsSync(path.join(tmpDir, 'global-site-blocklists', 'manifest.json')),
      'no manifest.json should have been written to the cache dir'
    );
  });

  test('case 3 [fix]: signed-manifest 404, no cache, seeded v1 -> no-signed-manifest, rows kept', async () => {
    silenceConsole();
    const updater = loadUpdater();
    updater._applySignedTier(['x.com'], 'v1', 'seed');

    stubFetch({ '.sig': 404, 'signed-manifest.json': 404 });

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, false);
    assert.equal(result.skipped, 'no-signed-manifest');
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.deepEqual(rows(), ['x.com']);
  });

  test('case 3b [fix]: signed-manifest 404, empty DB -> no-signed-manifest, no meta row', async () => {
    silenceConsole();
    const updater = loadUpdater();

    stubFetch({ '.sig': 404, 'signed-manifest.json': 404 });

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, false);
    assert.equal(result.skipped, 'no-signed-manifest');
    assert.equal(metaRow(), undefined);
  });

  test('case 4: signature OK but manifest.json body altered after signing -> hash mismatch [GREEN]', async () => {
    silenceConsole();
    const updater = loadUpdater();
    updater._applySignedTier(['x.com'], 'v1', 'seed');
    const before = metaRow();

    const bundle = makeBundle({ version: 'v2', lists: { 'list.txt': 'a.com\n' } });
    stubFetch({
      '.sig': bundle.sigText,
      'signed-manifest.json': bundle.signedText,
      // altered after signing — hash in signedText no longer matches.
      'manifest.json': bundle.manifestText + '\n// tampered',
      'list.txt': bundle.lists['list.txt'],
    });

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, false);
    assert.equal(result.error, 'manifest.json hash mismatch');
    assert.deepEqual(rows(), ['x.com']);
    const after = metaRow();
    assert.equal(after.version, before.version);
  });

  test('case 5 [fix on lastCheckError]: valid signed cache + network error -> updated from cache, lastCheckError mentions remote failure', async () => {
    silenceConsole();
    const updater = loadUpdater();
    updater._applySignedTier(['x.com'], 'v1', 'seed');

    const cacheBundle = makeBundle({ version: 'v3', lists: { 'list.txt': 'c.com\n' } });
    writeCache(cacheBundle);

    stubFetch.network();

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, true);
    assert.ok(String(result.source).startsWith('cache:'));
    assert.deepEqual(rows(), ['c.com']);
    assert.equal(metaRow().version, 'v3');

    const status = updater.getStatus();
    assert.ok(
      status.lastCheckError && /fetch failed/i.test(status.lastCheckError),
      `expected lastCheckError to mention the remote failure, got: ${status.lastCheckError}`
    );
  });

  test('case 6 [fix]: meta "pre-002:v1" + rows + network error + no cache -> version kept, unavailable', async () => {
    silenceConsole();
    const updater = loadUpdater();
    updater._applySignedTier(['x.com'], 'pre-002:v1', 'seed');

    stubFetch.network();

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, false);
    assert.equal(result.skipped, 'unavailable');
    assert.deepEqual(rows(), ['x.com']);
    assert.equal(metaRow().version, 'pre-002:v1');
  });

  test('case 7 [fix]: signature+manifest OK, one list file 404, no cache, seeded v1 -> unavailable, reason names file', async () => {
    silenceConsole();
    const updater = loadUpdater();
    updater._applySignedTier(['x.com'], 'v1', 'seed');

    const bundle = makeBundle({ version: 'v2', lists: { 'missing.txt': 'a.com\n' } });
    stubFetch({
      '.sig': bundle.sigText,
      'signed-manifest.json': bundle.signedText,
      'manifest.json': bundle.manifestText,
      'missing.txt': 404,
    });

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, false);
    assert.equal(result.skipped, 'unavailable');
    assert.ok(
      typeof result.reason === 'string' && result.reason.includes('missing.txt'),
      `expected reason to mention missing.txt, got: ${result.reason}`
    );
    assert.deepEqual(rows(), ['x.com']);
  });

  test('case 7b [fix]: same, but pre-existing cache dir missing one list file on disk -> cache left untouched, rows kept', async () => {
    silenceConsole();
    const updater = loadUpdater();
    updater._applySignedTier(['x.com'], 'v1', 'seed');

    // Pre-existing cache with two list files.
    const cacheBundle = makeBundle({
      version: 'v1',
      lists: { 'a.txt': 'q.com\n', 'b.txt': 'r.com\n' },
    });
    const cacheDir = writeCache(cacheBundle);
    // Simulate corruption: one of the cached list files is missing on disk.
    fs.unlinkSync(path.join(cacheDir, 'b.txt'));

    const cacheFilesBefore = {};
    for (const f of ['manifest.json', 'signed-manifest.json', 'signed-manifest.json.sig', 'a.txt']) {
      cacheFilesBefore[f] = fs.readFileSync(path.join(cacheDir, f));
    }

    const bundle = makeBundle({ version: 'v2', lists: { 'missing.txt': 'a.com\n' } });
    stubFetch({
      '.sig': bundle.sigText,
      'signed-manifest.json': bundle.signedText,
      'manifest.json': bundle.manifestText,
      'missing.txt': 404,
    });

    const result = await updater.checkForUpdates();

    assert.equal(result.updated, false);
    assert.equal(result.skipped, 'unavailable');
    assert.deepEqual(rows(), ['x.com']);

    for (const [f, before] of Object.entries(cacheFilesBefore)) {
      const after = fs.readFileSync(path.join(cacheDir, f));
      assert.ok(after.equals(before), `cache file ${f} should be byte-identical after the run`);
    }
    assert.ok(!fs.existsSync(path.join(cacheDir, 'b.txt')), 'b.txt should still be absent');
  });

  test('case 8 [fix]: lastCheckedAt/lastCheckError sequence across runs', async () => {
    silenceConsole();
    const updater = loadUpdater();

    let status = updater.getStatus();
    assert.equal(status.lastCheckedAt, null);
    assert.equal(status.lastCheckError, null);

    stubFetch.network();
    await updater.checkForUpdates();
    status = updater.getStatus();
    assert.ok(typeof status.lastCheckedAt === 'string' && status.lastCheckedAt.length > 0);
    assert.ok(/fetch failed/i.test(status.lastCheckError));
    const afterNetworkError = status.lastCheckedAt;

    const bundle = makeBundle({ version: 'v9', lists: { 'list.txt': 'a.com\n' } });
    stubFetch({
      '.sig': bundle.sigText,
      'signed-manifest.json': bundle.signedText,
      'manifest.json': bundle.manifestText,
      'list.txt': bundle.lists['list.txt'],
    });
    await updater.checkForUpdates();
    status = updater.getStatus();
    assert.equal(status.lastCheckError, null);
    assert.ok(status.lastCheckedAt >= afterNetworkError);

    // Hash mismatch run.
    const tamperedBundle = makeBundle({ version: 'v10', lists: { 'list.txt': 'b.com\n' } });
    stubFetch({
      '.sig': tamperedBundle.sigText,
      'signed-manifest.json': tamperedBundle.signedText,
      'manifest.json': tamperedBundle.manifestText + '\n// tampered',
      'list.txt': tamperedBundle.lists['list.txt'],
    });
    await updater.checkForUpdates();
    status = updater.getStatus();
    assert.equal(status.lastCheckError, 'manifest.json hash mismatch');
  });
});
