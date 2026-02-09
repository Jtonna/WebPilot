const os = require('os');
const { createServer } = require('./src/server');
const { getPort, getApiKey } = require('./src/service/paths');

const PORT = getPort();
const API_KEY = getApiKey();
const NETWORK = process.argv.includes('--network') || process.env.NETWORK === '1';

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
