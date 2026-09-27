'use strict';

// Separate test FILE (not just a separate describe block) so the
// connection.js module-level singleton (`_db` / `_initialized`) starts fresh
// for this process — node --test runs each file in its own worker.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const connection = require('../src/db/connection');
const { listMigrations } = require('../src/db/schema-migrations');

const EXPECTED_TABLES = [
  'agents',
  'pairings',
  'global_site_rules',
  'agent_site_overrides',
  'global_site_blocklist_meta',
  'formatter_incidents',
  'config',
  'extension_installs',
  'schema_migrations',
];

// Matches the ledger DDL in src/db/schema-migrations/index.js exactly.
const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`;

let currentDataDir = null;

function freshDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-conn-test-'));
  process.env.WEBPILOT_DATA_DIR = d;
  currentDataDir = d;
  return d;
}

function rmDataDirWithRetry(dir) {
  const attempts = process.platform === 'win32' ? 5 : 1;
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === attempts - 1) throw e;
      // Windows can briefly hold the file handle busy (EBUSY) right after
      // close(); a short synchronous wait lets the OS release it.
      const until = Date.now() + 50;
      while (Date.now() < until) { /* busy-wait briefly */ }
    }
  }
}

afterEach(() => {
  connection.close();
  if (currentDataDir) {
    try { rmDataDirWithRetry(currentDataDir); } catch (_e) { /* best-effort */ }
    currentDataDir = null;
  }
  delete process.env.WEBPILOT_DATA_DIR;
});

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(r => r.name);
}

describe('connection.init() regression tests', () => {
  test('fresh boot: init() succeeds, ledger + all tables present, config queryable', () => {
    freshDataDir();

    assert.doesNotThrow(() => connection.init());
    const db = connection.getDb();

    const expectedIds = listMigrations().map(m => m.id).sort();
    const ledgerIds = db.prepare('SELECT id FROM schema_migrations').all().map(r => r.id).sort();
    assert.deepEqual(ledgerIds, expectedIds);

    assert.deepEqual(tableNames(db).sort(), [...EXPECTED_TABLES].sort());

    assert.doesNotThrow(() => db.prepare('SELECT * FROM config').all());
  });

  test('idempotent: second init() returns same handle; after close(), re-init succeeds with unchanged ledger', () => {
    freshDataDir();

    const db1 = connection.init();
    const db2 = connection.init();
    assert.equal(db1, db2, 'second init() call should return the same handle');

    const countBefore = db1.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;

    connection.close();
    assert.doesNotThrow(() => connection.init());
    const db3 = connection.getDb();
    const countAfter = db3.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get().c;

    assert.equal(countAfter, countBefore, 'ledger row count should be unchanged after close()+init()');
  });

  test('recovery from stuck v2.2.0 file: DB with only the ledger table still boots to full schema', () => {
    const dataDir = freshDataDir();
    fs.mkdirSync(dataDir, { recursive: true });

    const Database = require('better-sqlite3');
    const dbPath = path.join(dataDir, 'webpilot.db');
    const stuckDb = new Database(dbPath);
    stuckDb.exec(LEDGER_DDL);
    stuckDb.close();

    assert.doesNotThrow(() => connection.init());
    const db = connection.getDb();
    assert.deepEqual(tableNames(db).sort(), [...EXPECTED_TABLES].sort());
  });

  test('failed init cleans up: garbage DB file causes init() to throw, close exactly the handle it opened, and allow retry', () => {
    const dataDir = freshDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'webpilot.db');
    // Not a valid SQLite file — the first PRAGMA call will throw SQLITE_NOTADB.
    fs.writeFileSync(dbPath, Buffer.from('this is not a sqlite database file, just garbage bytes\0\0\0'));

    const BetterSqlite3 = require('better-sqlite3');
    const originalClose = BetterSqlite3.prototype.close;
    let closeCallCount = 0;
    BetterSqlite3.prototype.close = function patchedClose(...args) {
      closeCallCount += 1;
      return originalClose.apply(this, args);
    };

    let threw = false;
    try {
      try {
        connection.init();
      } catch (_e) {
        threw = true;
      }

      assert.equal(threw, true, 'init() should throw on a corrupt DB file');
      assert.throws(() => connection.getDb(), /getDb\(\) called before init\(\)/);
      assert.equal(closeCallCount, 1, 'exactly one close() call should have happened for the failed init');

      if (process.platform === 'win32') {
        // On Windows a held-open native handle would keep the file locked and
        // this would throw EBUSY. Success here proves close() actually
        // released the OS-level file handle, not just the JS reference.
        assert.doesNotThrow(() => fs.rmSync(dbPath));
      } else {
        fs.rmSync(dbPath, { force: true });
      }
    } finally {
      BetterSqlite3.prototype.close = originalClose;
    }

    // Retry after removing the garbage file: init() should succeed cleanly.
    assert.doesNotThrow(() => connection.init());
    const db = connection.getDb();
    assert.deepEqual(tableNames(db).sort(), [...EXPECTED_TABLES].sort());
  });
});

describe('better-sqlite3 loads under plain node', () => {
  test('native binding resolves via normal node_modules resolution (not pkg)', () => {
    assert.equal(!!process.pkg, false, 'process.pkg should be unset under plain node');
    assert.doesNotThrow(() => require('better-sqlite3'));
    const Database = require('better-sqlite3');
    assert.equal(typeof Database, 'function');
    // A quick real open/close proves the native binding actually loaded and
    // linked correctly, which is what getBundledBindingPath()'s null return
    // (pkg detection off) is meant to allow.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webpilot-conn-binding-test-'));
    const dbPath = path.join(tmp, 'probe.db');
    const db = new Database(dbPath);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
