'use strict';

/**
 * SQLite connection singleton for WebPilot's server (P2 — phase 1).
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
 * @yao-pkg/pkg toolchain has historically been finicky with native modules.
 * See package.json's `pkg.assets` and the TODO there. Phase 1 does NOT verify
 * the pkg-compiled binary — that's Phase 7 cleanup.
 */

const path = require('node:path');
const fs = require('node:fs');

const { getDataDir } = require('../service/paths');

// ---------------------------------------------------------------------------
// better-sqlite3 native-binding path resolution.
//
// @yao-pkg/pkg cannot bundle the native `.node` binding into its snapshot,
// so the post-build step (scripts/copy-native-deps.js) drops
// `better_sqlite3.node` next to the pkg-compiled `.exe`. In v12.x, the
// loader's auto-discovery (`require('bindings')(...)`) walks the snapshot
// filesystem and fails because the .node sits OUTSIDE the snapshot. The
// `BETTER_SQLITE3_BINDING_PATH` env var we used in earlier attempts was
// never read by better-sqlite3 — it only honours the `nativeBinding`
// constructor option (see node_modules/better-sqlite3/lib/database.js,
// commit 12.x). We therefore pass the resolved sibling path explicitly
// when constructing the Database below.
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

  try {
    _db.exec(schemaSql);
  } catch (e) {
    console.error('[db] schema exec failed:', e && e.message);
    throw e;
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
