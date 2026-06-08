'use strict';

/**
 * SQLite connection singleton for WebPilot's server.
 *
 * Opens `<dataDir>/webpilot.db` via better-sqlite3, sets the recommended
 * PRAGMAs (WAL journal, foreign-keys ON, synchronous=NORMAL), and applies the
 * schema in `./schema.sql` on every boot. Every CREATE in that file uses
 * `IF NOT EXISTS`, so the apply step is idempotent — it doubles as the
 * "create on first boot" path.
 *
 * Other modules acquire the handle by calling `getDb()` after `init()` has
 * been called once at server boot. The handle is a synchronous, fast,
 * single-process resource — that matches WebPilot's runtime model exactly.
 *
 * IMPORTANT pkg risk: better-sqlite3 ships a native binding (.node file). The
 * @yao-pkg/pkg toolchain has historically been finicky with native modules;
 * see package.json's `pkg.assets` and the native-binding resolution block
 * below for how we pass the binding path explicitly.
 */

const path = require('node:path');
const fs = require('node:fs');

const { getDataDir } = require('../service/paths');

// ---------------------------------------------------------------------------
// better-sqlite3 native-binding path resolution.
//
// @yao-pkg/pkg cannot bundle the native `.node` binding into its snapshot,
// so the post-build step (scripts/copy-native-deps.js) drops
// `better_sqlite3.node` next to the pkg-compiled `.exe`. The loader's
// auto-discovery (`require('bindings')(...)`) walks the snapshot
// filesystem and fails because the .node sits OUTSIDE the snapshot.
// better-sqlite3 only honours the `nativeBinding` constructor option
// (see node_modules/better-sqlite3/lib/database.js) — env vars like
// `BETTER_SQLITE3_BINDING_PATH` are NOT read. We therefore pass the
// resolved sibling path explicitly when constructing the Database below.
//
// In dev (running under node.exe), `getBundledBindingPath()` returns null
// and better-sqlite3 resolves the binding from node_modules normally.
// ---------------------------------------------------------------------------
function isPkgBinary() {
  if (process.pkg) return true;
  if (process.platform === 'win32') {
    const exe = path.basename(process.execPath).toLowerCase();
    return exe.endsWith('.exe') && exe !== 'node.exe';
  }
  return false;
}

function getBundledBindingPath() {
  if (!isPkgBinary()) return null;
  const candidate = path.join(path.dirname(process.execPath), 'better_sqlite3.node');
  if (fs.existsSync(candidate)) return candidate;
  console.error('[db] better_sqlite3.node not found next to exe at ' + candidate + '; bindings will fail');
  return null;
}

let _db = null;
let _initialized = false;

function getDbPath() {
  return path.join(getDataDir(), 'webpilot.db');
}

/**
 * Initialize the SQLite connection. Safe to call once at server boot.
 * Re-calling is a no-op (returns the existing handle).
 *
 * @returns {object} the better-sqlite3 Database handle
 */
function init() {
  if (_initialized && _db) return _db;

  // Lazy-require so importing this module doesn't immediately load the
  // native binding (helps unit tests that stub the module out).
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    console.error('[db] failed to load better-sqlite3:', err && err.message);
    throw err;
  }

  const dataDir = getDataDir();
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* non-fatal */ }

  const dbPath = getDbPath();
  const existed = fs.existsSync(dbPath);
  console.log(`[db] opening ${dbPath} (existed=${existed})`);

  // Best-effort tighten perms on the dataDir itself BEFORE opening the DB,
  // so any file better-sqlite3 creates inherits a private parent.
  // On POSIX this is 0o700 (owner rwx, group/other none). On Windows
  // fs.chmodSync only maps the broad read-only bit — Windows ACLs would be
  // strictly correct, but adding that without a native binding is impossible.
  // The owner-only intent is honoured by most NTFS volumes where the user
  // profile dir already inherits restrictive ACLs from %APPDATA%.
  try { fs.chmodSync(dataDir, 0o700); } catch (_e) { /* non-fatal on Windows */ }

  // In pkg-binary mode, the native .node binding sits as a loose file next
  // to the exe (see getBundledBindingPath above). Pass it explicitly via
  // the `nativeBinding` option — auto-discovery via `require('bindings')`
  // searches the snapshot and fails. In dev mode the path is null and
  // better-sqlite3 falls back to its normal node_modules resolution.
  const nativeBinding = getBundledBindingPath();
  const dbOptions = nativeBinding ? { nativeBinding } : undefined;
  _db = dbOptions ? new Database(dbPath, dbOptions) : new Database(dbPath);

  // Recommended PRAGMAs for our workload: a single writer process, many
  // small synchronous reads, durability-over-perf is not required (the
  // server itself is the only writer, crashes are rare, WAL gives us
  // crash-safety in the common case).
  try {
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('synchronous = NORMAL');
  } catch (e) {
    console.error('[db] pragma setup failed:', e && e.message);
    throw e;
  }

  // Apply schema. Every CREATE uses IF NOT EXISTS so this is a no-op on
  // subsequent boots. If we ever need a non-idempotent migration, add it
  // to db/migration.js — NOT here.
  const schemaPath = path.join(__dirname, 'schema.sql');
  let schemaSql;
  try {
    schemaSql = fs.readFileSync(schemaPath, 'utf8');
  } catch (e) {
    console.error(`[db] failed to read schema.sql at ${schemaPath}:`, e && e.message);
    throw e;
  }

  // Run idempotent rename migrations BEFORE applying schema.sql. The
  // baseline → global_site_blocklist rename predates schema.sql being
  // updated to the new shape; running the migration first means existing
  // installs are rewritten and the subsequent IF-NOT-EXISTS schema apply
  // is a no-op for the renamed objects. See db/migration.js.
  try {
    const migrations = require('./schema-migrations');
    migrations.runAll(_db, { dataDir });
  } catch (e) {
    console.error('[db] schema migration failed:', e && e.message);
    throw e;
  }

  try {
    _db.exec(schemaSql);
  } catch (e) {
    console.error('[db] schema exec failed:', e && e.message);
    throw e;
  }

  // Restrict perms on the DB file (and its WAL/SHM sidecars when they exist).
  // The DB contains api_key_hash columns, optional plaintext apiKey blobs in
  // pairings.metadata_json (until consumed), and the `config` table — none of
  // it should be readable by other local users. Best-effort on Windows where
  // fs.chmodSync only maps the read-only attribute; on POSIX this is 0o600.
  // Done after opening so the file definitely exists.
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    } catch (_e) { /* non-fatal */ }
  }

  _initialized = true;
  console.log(`[db] init complete — ${existed ? 'reused existing' : 'created new'} DB at ${dbPath}`);
  return _db;
}

/**
 * Return the singleton DB handle. Throws if init() hasn't been called yet.
 */
function getDb() {
  if (!_db || !_initialized) {
    throw new Error('[db] getDb() called before init() — call require("./db/connection").init() at server boot');
  }
  return _db;
}

/**
 * Close the DB handle. Used in tests; production never calls this — the
 * process exit handles cleanup via WAL checkpointing.
 */
function close() {
  if (_db) {
    try { _db.close(); } catch (e) { /* non-fatal */ }
  }
  _db = null;
  _initialized = false;
}

module.exports = {
  init,
  getDb,
  close,
  getDbPath,
};
