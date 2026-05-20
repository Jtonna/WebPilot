const os = require('os');
const fs = require('fs');
const path = require('path');
const { createServer } = require('./src/server');
const {
  getPort,
  getLogPath,
  getDataDir,
  migrateLegacyInstallData,
} = require('./src/service/paths');
const { setupLogging } = require('./src/service/logger');

// One-time upgrade migration: pkg builds <= 1.1.5 wrote user data to
// `<install>\data\`, which electron-builder wipes on every upgrade. From
// 1.1.6 onward the daemon uses %APPDATA%\WebPilot (or the platform
// equivalent) — see src/service/paths.js. Run this BEFORE setupLogging
// so the very first log line on the upgrade boot lands in the new
// (preserved) location, not back in the doomed install dir.
const _migration = migrateLegacyInstallData();

const logPath = getLogPath();
setupLogging(logPath);
console.log(`log: ${logPath}`);

if (_migration.ran) {
  console.log(`[migration] copied legacy user data: ${_migration.copiedFrom} -> ${_migration.copiedTo}`);
} else if (_migration.reason && _migration.reason !== 'no-legacy-dir' && _migration.reason !== 'flag-present') {
  console.log(`[migration] skipped: ${_migration.reason}`);
}

// ---------------------------------------------------------------------------
// Crash handlers — log fatal errors before the process dies
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
  const ts = new Date().toISOString();
  console.error(`\n[${ts}] FATAL uncaughtException: ${err.stack || err}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const ts = new Date().toISOString();
  console.error(`\n[${ts}] FATAL unhandledRejection: ${reason instanceof Error ? reason.stack : reason}`);
  process.exit(1);
});

// Log when process receives termination signals
process.on('SIGTERM', () => {
  console.error(`\n[${new Date().toISOString()}] Received SIGTERM`);
  process.exit(0);
});
process.on('SIGINT', () => {
  console.error(`\n[${new Date().toISOString()}] Received SIGINT`);
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Memory monitor — log heap usage every 30s so we can spot OOM before a kill
// ---------------------------------------------------------------------------
setInterval(() => {
  const mem = process.memoryUsage();
  const rss = (mem.rss / 1048576).toFixed(1);
  const heap = (mem.heapUsed / 1048576).toFixed(1);
  const heapTotal = (mem.heapTotal / 1048576).toFixed(1);
  console.log(`[mem] rss=${rss}MB heap=${heap}/${heapTotal}MB`);
}, 30000).unref();

const PORT = getPort();
let NETWORK = process.argv.includes('--network') || process.env.NETWORK === '1';
// Network-mode preference resolution (P2 phase 7):
//   1. Prefer the SQLite `config.network_enabled` row (DB is the new source of
//      truth post-migration).
//   2. Fall back to the legacy `<dataDir>/network.enabled` flag file. This
//      branch fires only on the very first boot of the new version — once
//      `runImportFromJsonStores()` archives the flag to `.imported.<TS>` the
//      DB row takes over and this fallback never matches again.
//   3. Otherwise, use the CLI flag / env-var default that was just resolved.
//
// We initialize the DB here in index.js (before createServer wires the rest of
// the server) so the read happens against the same connection createServer
// will reuse — better-sqlite3 caches the handle in the connection module.
try {
  require('./src/db/connection').init();
  const db = require('./src/db/connection').getDb();
  const row = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('network_enabled');
  if (row && typeof row.value === 'string') {
    NETWORK = row.value === 'true' || row.value === '1';
  } else {
    // No DB row yet — fall back to the legacy flag file (first-boot path).
    try {
      const val = fs.readFileSync(path.join(getDataDir(), 'network.enabled'), 'utf8').trim();
      NETWORK = val === '1';
    } catch (_e) {
      // No flag file either; keep CLI/env default.
    }
  }
} catch (e) {
  // DB init failure — fall back to the legacy flag file so the daemon still
  // boots in a useful mode. This branch should not fire in normal use.
  console.error('[boot] network-mode DB lookup failed, falling back to flag file:', e && e.message);
  try {
    const val = fs.readFileSync(path.join(getDataDir(), 'network.enabled'), 'utf8').trim();
    NETWORK = val === '1';
  } catch (_e) {
    // No flag file either; keep CLI/env default.
  }
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const host = NETWORK ? '0.0.0.0' : '127.0.0.1';
const publicHost = NETWORK ? getLocalIP() : 'localhost';

createServer({ port: PORT, host, publicHost });
