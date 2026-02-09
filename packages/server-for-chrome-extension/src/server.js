const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createMcpHandler } = require('./mcp-handler');
const { createExtensionBridge } = require('./extension-bridge');

const { getDataDir } = require('./service/paths');

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

  const extensionBridge = createExtensionBridge(apiKey);
  const wsUrl = `ws://${publicHost}:${port}`;
  const connectionString = generateConnectionString(wsUrl, apiKey);

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
    res.json({
      connectionString: connectionString,
      serverUrl: wsUrl
    });
  });

  server.listen(port, host, () => {
    // Write PID and port files for service management
    writePidAndPortFiles(port);

    const networkMode = host === '0.0.0.0';

    // Startup info in YAML format
    console.log('server:');
    console.log(`  host: ${host}`);
    console.log(`  port: ${port}`);
    console.log('  local:');
    console.log(`    sse: http://localhost:${port}/sse`);
    console.log(`    ws: ws://localhost:${port}`);
    console.log('  network:');
    if (networkMode) {
      console.log(`    sse: http://${publicHost}:${port}/sse`);
      console.log(`    ws: ws://${publicHost}:${port}`);
    } else {
      console.log('    sse: disabled');
      console.log('    ws: disabled');
    }

    // Connection string for pasting into the extension
    console.log(`connection_string: ${connectionString}`);
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
