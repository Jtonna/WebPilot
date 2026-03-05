const os = require('os');
const fs = require('fs');
const path = require('path');
const { createServer } = require('./src/server');
const { getPort, getApiKey, getDataDir } = require('./src/service/paths');

const PORT = getPort();
const API_KEY = getApiKey();

// Check persisted network mode preference (set via extension toggle), then fall back to CLI flag
let NETWORK = process.argv.includes('--network') || process.env.NETWORK === '1';
try {
  const networkConfigPath = path.join(getDataDir(), 'network.enabled');
  const val = fs.readFileSync(networkConfigPath, 'utf8').trim();
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
