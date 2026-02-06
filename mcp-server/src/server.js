const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createMcpHandler } = require('./mcp-handler');
const { createExtensionBridge } = require('./extension-bridge');

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
    const networkMode = host === '0.0.0.0';
    console.log(`MCP Server running on ${host}:${port}${networkMode ? ' (network mode)' : ''}`);
    console.log(`  SSE endpoint: http://${publicHost}:${port}/sse`);
    console.log(`  WebSocket: ${wsUrl}`);
    if (networkMode) {
      console.log('');
      console.log(`\x1b[33m  Network access enabled — other devices can connect at:`);
      console.log(`    http://${publicHost}:${port}/sse`);
      console.log(`    ws://${publicHost}:${port}\x1b[0m`);
    } else {
      console.log('');
      console.log('\x1b[90m  Localhost only. Use --network flag or npm run dev:network for LAN access.\x1b[0m');
    }
    console.log('');
    console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
    console.log('\x1b[36m  Connection String (paste in extension):\x1b[0m');
    console.log('');
    console.log(`  \x1b[32m${connectionString}\x1b[0m`);
    console.log('');
    console.log('\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m');
  });

  return { app, server, wss };
}

module.exports = { createServer };
