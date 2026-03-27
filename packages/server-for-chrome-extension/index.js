const os = require('os');
const fs = require('fs');
const path = require('path');
const { createServer } = require('./src/server');
const { getPort, getApiKey, getLogPath, getDataDir } = require('./src/service/paths');
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
const API_KEY = getApiKey();
let NETWORK = process.argv.includes('--network') || process.env.NETWORK === '1';
try {
  const val = fs.readFileSync(path.join(getDataDir(), 'network.enabled'), 'utf8').trim();
  NETWORK = val === '1';
} catch (e) {
  // No config file, use CLI flag default
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

createServer({ port: PORT, apiKey: API_KEY, host, publicHost });
