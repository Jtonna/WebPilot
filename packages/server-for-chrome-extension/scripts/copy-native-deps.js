'use strict';

/**
 * copy-native-deps.js
 *
 * @yao-pkg/pkg cannot bundle native `.node` bindings into its snapshot. The
 * server's runtime dep `better-sqlite3` ships its native binding at
 *   node_modules/better-sqlite3/build/Release/better_sqlite3.node
 * which must be shipped as a loose file next to the pkg-built `.exe`.
 *
 * This script is run after each `pkg` build (see build:win / build:mac /
 * build:linux in package.json). It locates the hoisted .node and copies it
 * into `dist/` alongside the binary. The runtime shim in
 * `src/db/connection.js` points better-sqlite3 at this file via
 * BETTER_SQLITE3_BINDING_PATH.
 *
 * Exits non-zero on failure so the parent build halts.
 */

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const DIST_DIR = path.join(PACKAGE_DIR, 'dist');
const BINDING_REL = path.join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

const CANDIDATES = [
  // Hoisted to the monorepo root (the common case for this repo).
  path.join(REPO_ROOT, 'node_modules', BINDING_REL),
  // Fallback: installed locally under the package.
  path.join(PACKAGE_DIR, 'node_modules', BINDING_REL),
];

function findBinding() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  const source = findBinding();
  if (!source) {
    console.error('[copy-native-deps] FAIL: better_sqlite3.node not found. Looked in:');
    for (const candidate of CANDIDATES) console.error('  - ' + candidate);
    process.exit(1);
  }

  if (!fs.existsSync(DIST_DIR)) {
    console.error('[copy-native-deps] FAIL: dist/ does not exist at ' + DIST_DIR + '. Run pkg before this script.');
    process.exit(1);
  }

  const dest = path.join(DIST_DIR, 'better_sqlite3.node');
  try {
    fs.copyFileSync(source, dest);
  } catch (err) {
    console.error('[copy-native-deps] FAIL: copy ' + source + ' -> ' + dest + ': ' + (err && err.message));
    process.exit(1);
  }

  let size = 0;
  try { size = fs.statSync(dest).size; } catch (_) { /* non-fatal */ }
  console.log('[copy-native-deps] OK: ' + source + ' -> ' + dest + ' (' + size + ' bytes)');
}

main();
