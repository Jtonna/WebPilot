const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createMcpHandler } = require('./mcp-handler');
const { createExtensionBridge } = require('./extension-bridge');
const pairedKeys = require('./paired-keys');

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

function createServer({ port, apiKey, host: initialHost = '127.0.0.1', publicHost: initialPublicHost = 'localhost' }) {
  let host = initialHost;
  let publicHost = initialPublicHost;
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = http.createServer(app);

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

        if (message.type === 'revoke_key') {
          const { apiKey: keyToRevoke } = message;
          const revoked = pairedKeys.revokeKey(keyToRevoke);
          console.log(`[pairing] Revoke key ${keyToRevoke.slice(0, 8)}...: ${revoked ? 'removed' : 'not found'}`);
          ws.send(JSON.stringify({ type: 'paired_agents_list', agents: pairedKeys.listKeys() }));
          return;
        }

        if (message.type === 'rename_agent') {
          const { apiKey: keyToRename, newName } = message;
          const renamed = pairedKeys.renameKey(keyToRename, newName);
          console.log(`[pairing] Rename key ${keyToRename.slice(0, 8)}...: ${renamed ? 'renamed to ' + newName : 'not found'}`);
          ws.send(JSON.stringify({ type: 'paired_agents_list', agents: pairedKeys.listKeys() }));
          return;
        }

        if (message.type === 'list_paired_agents') {
          const agents = pairedKeys.listKeys();
          console.log(`[pairing] Listed ${agents.length} paired agent(s)`);
          ws.send(JSON.stringify({ type: 'paired_agents_list', agents }));
          return;
        }

        if (message.type === 'set_network_mode') {
          const networkEnabled = message.enabled;
          host = networkEnabled ? '0.0.0.0' : '127.0.0.1';
          publicHost = networkEnabled ? getLocalIP() : 'localhost';

          server.close(() => {
            server.listen(port, host, () => {
              console.log(`Network mode ${networkEnabled ? 'enabled' : 'disabled'}: listening on ${host}:${port}`);
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

  const mcpHandler = createMcpHandler(extensionBridge, apiKey, pairedKeys);

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
      apiKey,
      serverUrl: `ws://${publicHost}:${port}`,
      sseUrl: `http://${publicHost}:${port}/sse`,
      networkMode: host === '0.0.0.0'
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

    console.log(`Server URL: ws://${publicHost}:${port}`);
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
