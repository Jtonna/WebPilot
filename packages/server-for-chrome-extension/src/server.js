const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createMcpHandler } = require('./mcp-handler');
const { createExtensionBridge } = require('./extension-bridge');

const { getDataDir } = require('./service/paths');

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

function writePidAndPortFiles(port) {
  const dataDir = getDataDir();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'server.pid'), String(process.pid), 'utf8');
    fs.writeFileSync(path.join(dataDir, 'server.port'), String(port), 'utf8');
  } catch (e) {
    console.error('Warning: Could not write PID/port files:', e.message);
  }
}

function cleanupPidAndPortFiles() {
  const dataDir = getDataDir();
  try { fs.unlinkSync(path.join(dataDir, 'server.pid')); } catch (e) { /* non-fatal */ }
  try { fs.unlinkSync(path.join(dataDir, 'server.port')); } catch (e) { /* non-fatal */ }
}

function generateConnectionString(serverUrl, apiKey) {
  const data = { v: 1, s: serverUrl, k: apiKey };
  const json = JSON.stringify(data);
  const base64 = Buffer.from(json).toString('base64url');
  return `vf://${base64}`;
}

function createServer({ port, apiKey, host = '127.0.0.1', publicHost = 'localhost' }) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = http.createServer(app);

  let currentHost = host;
  let currentPublicHost = publicHost;

  const extensionBridge = createExtensionBridge(apiKey);

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const clientApiKey = url.searchParams.get('apiKey');

    if (clientApiKey !== apiKey) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    console.log('Extension connected');
    extensionBridge.setConnection(ws);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (message.type === 'set_network_mode') {
          const networkEnabled = message.enabled;
          currentHost = networkEnabled ? '0.0.0.0' : '127.0.0.1';
          currentPublicHost = networkEnabled ? getLocalIP() : 'localhost';

          // Persist preference
          const configPath = path.join(getDataDir(), 'network.enabled');
          try {
            fs.writeFileSync(configPath, networkEnabled ? '1' : '0', 'utf8');
          } catch (e) {
            console.error('Failed to save network mode:', e.message);
          }

          console.log(`[network] Switching to ${networkEnabled ? 'network' : 'local'} mode, restarting listener on ${currentHost}:${port}`);

          // Force-close all connections so server.close() completes immediately
          server.closeAllConnections();
          server.close(() => {
            server.listen(port, currentHost, () => {
              console.log(`[network] Now listening on ${currentHost}:${port}`);
            });
          });
          return;
        }

        extensionBridge.handleResponse(message);
      } catch (e) {
        console.error('Invalid message from extension:', e);
      }
    });

    ws.on('close', () => {
      console.log('Extension disconnected');
      extensionBridge.clearConnection();
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  const mcpHandler = createMcpHandler(extensionBridge, apiKey);

  app.get('/sse', mcpHandler.handleSSE);
  app.post('/message', mcpHandler.handleMessage);

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      extensionConnected: extensionBridge.isConnected(),
      sessions: mcpHandler.getSessionCount()
    });
  });

  app.get('/connect', (req, res) => {
    const currentWsUrl = `ws://${currentPublicHost}:${port}`;
    const currentConnectionString = generateConnectionString(currentWsUrl, apiKey);
    const networkMode = currentHost === '0.0.0.0';
    res.json({
      connectionString: currentConnectionString,
      serverUrl: currentWsUrl,
      sseUrl: `http://${currentPublicHost}:${port}/sse`,
      networkMode: networkMode
    });
  });

  server.listen(port, currentHost, () => {
    // Write PID and port files for service management
    writePidAndPortFiles(port);

    const networkMode = currentHost === '0.0.0.0';
    const currentWsUrl = `ws://${currentPublicHost}:${port}`;
    const currentConnectionString = generateConnectionString(currentWsUrl, apiKey);

    // Startup info in YAML format
    console.log('server:');
    console.log(`  host: ${currentHost}`);
    console.log(`  port: ${port}`);
    console.log('  local:');
    console.log(`    sse: http://localhost:${port}/sse`);
    console.log(`    ws: ws://localhost:${port}`);
    console.log('  network:');
    if (networkMode) {
      console.log(`    sse: http://${currentPublicHost}:${port}/sse`);
      console.log(`    ws: ws://${currentPublicHost}:${port}`);
    } else {
      console.log('    sse: disabled');
      console.log('    ws: disabled');
    }

    // Connection string for pasting into the extension
    console.log(`connection_string: ${currentConnectionString}`);
  });

  // Clean up PID/port files on shutdown
  process.on('SIGTERM', () => {
    cleanupPidAndPortFiles();
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    cleanupPidAndPortFiles();
    server.close(() => process.exit(0));
  });
  process.on('exit', () => {
    cleanupPidAndPortFiles();
  });

  return { app, server, wss };
}

module.exports = { createServer };
