const os = require('os');
const { createServer } = require('./src/server');
const {
  getPort,
  getLogPath,
} = require('./src/service/paths');
const { setupLogging } = require('./src/service/logger');

const logPath = getLogPath();
setupLogging(logPath);
console.log(`log: ${logPath}`);

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
// Network-mode preference resolution:
//   1. Prefer the SQLite `config.network_enabled` row (DB is the source of
//      truth).
//   2. Otherwise, use the CLI flag / env-var default that was just resolved.
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
  }
} catch (e) {
  // DB init failure — this fallback only protects the network-mode read: it
  // falls back to the CLI/env default so this lookup doesn't crash before
  // createServer() gets a chance to run. If init() failed here, createServer()
  // below will call init() again and rethrow, and the daemon exits 1 via the
  // uncaughtException handler above. The error is therefore logged twice on a
  // broken DB — that is intended.
  console.error('[boot] network-mode DB lookup failed, using CLI/env default:', e && e.message);
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
