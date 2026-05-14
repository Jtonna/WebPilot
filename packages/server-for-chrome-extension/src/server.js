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
const formatterManager = require('./formatter-manager');
const formatterUpdater = require('./formatter-updater');
const { createChromeManager, readProfiles } = require('./chrome');

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
  let pairingRequired = true; // default: pairing required
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = http.createServer(app);

  const extensionBridge = createExtensionBridge(apiKey);
  const chromeManager = createChromeManager({ userDataDir: null, log: console.log });

  // Web UI WebSocket clients (separate from extension WS — they receive UI events
  // like pairing requests, status changes, etc.)
  const uiWsClients = new Set();
  function broadcastUiEvent(event) {
    const json = JSON.stringify(event);
    let sent = 0;
    for (const ws of uiWsClients) {
      if (ws.readyState === 1) {
        try { ws.send(json); sent += 1; } catch (e) { /* ignore */ }
      }
    }
    if (sent > 0) {
      console.log(`[ui-ws] broadcast type=${event.type} -> ${sent} client(s)`);
    }
  }

  const extensionWss = new WebSocketServer({ noServer: true });
  const uiWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);

    // Route web UI events WebSocket — auth: localhost or valid X-API-Key (header
    // not available on WS handshake from browsers, so localhost-only by default)
    if (url.pathname === '/api/ui/events') {
      const remoteAddr = request.socket.remoteAddress || '';
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      const clientApiKey = url.searchParams.get('apiKey');
      const apiKeyOk = clientApiKey && clientApiKey === apiKey;
      if (!isLocal && !apiKeyOk) {
        console.log(`[ui-ws] rejecting non-local UI WS from ${remoteAddr} (no api key)`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      uiWss.handleUpgrade(request, socket, head, (ws) => {
        uiWss.emit('connection', ws, request);
      });
      return;
    }

    // Extension WebSocket (default path)
    const clientApiKey = url.searchParams.get('apiKey');
    if (clientApiKey !== apiKey) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    extensionWss.handleUpgrade(request, socket, head, (ws) => {
      extensionWss.emit('connection', ws, request);
    });
  });

  uiWss.on('connection', (ws) => {
    console.log(`[ui-ws] client connected (total=${uiWsClients.size + 1})`);
    uiWsClients.add(ws);
    ws.on('close', () => {
      uiWsClients.delete(ws);
      console.log(`[ui-ws] client disconnected (total=${uiWsClients.size})`);
    });
    ws.on('error', (err) => {
      console.log(`[ui-ws] client error: ${err.message}`);
    });
    // Send initial snapshot
    try {
      ws.send(JSON.stringify({ type: 'hello', timestamp: Date.now() }));
    } catch (e) { /* ignore */ }
  });

  extensionWss.on('connection', (ws) => {
    console.log('[extension-bridge] WebSocket opened, awaiting hello');

    // Wait up to 5s for hello; if it doesn't arrive, ask the extension to identify itself.
    let registeredProfileId = null;
    const helloDeadline = setTimeout(() => {
      if (!registeredProfileId) {
        try {
          const profiles = readProfiles(chromeManager.userDataDir).map((p) => ({
            directoryName: p.directoryName,
            displayName: p.displayName,
            gaiaEmail: p.gaiaEmail,
          }));
          console.log(
            `[extension-bridge] hello timeout — sending identify_required with ${profiles.length} known profile(s)`
          );
          ws.send(JSON.stringify({ type: 'identify_required', knownProfiles: profiles }));
        } catch (e) {
          console.log(`[extension-bridge] failed to send identify_required: ${e.message}`);
        }
      }
    }, 5000);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (message.type === 'hello') {
          clearTimeout(helloDeadline);
          // Try direct profileId match first, then fall back to gaiaEmail lookup.
          let resolvedProfileId = message.profileId || null;
          if (!resolvedProfileId && message.gaiaEmail) {
            try {
              const profiles = readProfiles(chromeManager.userDataDir);
              const match = profiles.find(
                (p) => p.gaiaEmail && p.gaiaEmail.toLowerCase() === String(message.gaiaEmail).toLowerCase()
              );
              if (match) {
                resolvedProfileId = match.directoryName;
                console.log(
                  `[extension-bridge] resolved profileId="${resolvedProfileId}" from gaiaEmail`
                );
              }
            } catch (e) {
              console.log(`[extension-bridge] gaiaEmail resolution failed: ${e.message}`);
            }
          }

          if (!resolvedProfileId) {
            // Can't determine profile — tell the extension to show its picker
            try {
              const profiles = readProfiles(chromeManager.userDataDir).map((p) => ({
                directoryName: p.directoryName,
                displayName: p.displayName,
                gaiaEmail: p.gaiaEmail,
              }));
              console.log(
                `[extension-bridge] hello without resolvable profile — sending identify_required (${profiles.length} known)`
              );
              ws.send(JSON.stringify({ type: 'identify_required', knownProfiles: profiles }));
            } catch (e) {
              console.log(`[extension-bridge] identify_required send failed: ${e.message}`);
            }
            return;
          }

          registeredProfileId = resolvedProfileId;
          extensionBridge.setConnection(resolvedProfileId, ws);
          console.log(
            `[extension-bridge] hello accepted profileId="${resolvedProfileId}" ` +
              `displayName="${message.profileDisplayName || ''}"`
          );
          try {
            ws.send(JSON.stringify({ type: 'hello_ack', profileId: resolvedProfileId }));
          } catch (e) { /* ignore */ }
          broadcastUiEvent({
            type: 'extension_connected',
            profileId: resolvedProfileId,
            connectedProfiles: extensionBridge.getConnectedProfiles(),
          });
          return;
        }

        if (message.type === 'revoke_key') {
          const { apiKey: keyToRevoke } = message;
          const revoked = pairedKeys.revokeKey(keyToRevoke);
          console.log(`[pairing] Revoke key ${keyToRevoke.slice(0, 8)}...: ${revoked ? 'removed' : 'not found'}`);
          ws.send(JSON.stringify({ type: 'paired_agents_list', agents: pairedKeys.listKeys() }));
          broadcastUiEvent({ type: 'agents_changed', agents: pairedKeys.listKeys() });
          return;
        }

        if (message.type === 'rename_agent') {
          const { apiKey: keyToRename, newName } = message;
          const renamed = pairedKeys.renameKey(keyToRename, newName);
          console.log(`[pairing] Rename key ${keyToRename.slice(0, 8)}...: ${renamed ? 'renamed to ' + newName : 'not found'}`);
          ws.send(JSON.stringify({ type: 'paired_agents_list', agents: pairedKeys.listKeys() }));
          broadcastUiEvent({ type: 'agents_changed', agents: pairedKeys.listKeys() });
          return;
        }

        if (message.type === 'list_paired_agents') {
          const agents = pairedKeys.listKeys();
          console.log(`[pairing] Listed ${agents.length} paired agent(s)`);
          ws.send(JSON.stringify({ type: 'paired_agents_list', agents }));
          return;
        }

        if (message.type === 'check_formatter_updates') {
          formatterUpdater.checkForUpdates()
            .then(result => ws.send(JSON.stringify({ type: 'formatter_update_result', ...result })))
            .catch(err => ws.send(JSON.stringify({ type: 'formatter_update_result', updated: false, error: err.message })));
          return;
        }

        if (message.type === 'set_network_mode') {
          const networkEnabled = message.enabled;
          host = networkEnabled ? '0.0.0.0' : '127.0.0.1';
          publicHost = networkEnabled ? getLocalIP() : 'localhost';

          // Persist preference so it survives server restarts
          try {
            fs.writeFileSync(path.join(getDataDir(), 'network.enabled'), networkEnabled ? '1' : '0', 'utf8');
          } catch (e) {
            console.error('Failed to save network mode:', e.message);
          }

          console.log(`[network] Switching to ${networkEnabled ? 'network' : 'local'} mode, restarting listener on ${host}:${port}`);

          // Force-close all connections so server.close() completes immediately
          server.closeAllConnections();
          server.close(() => {
            server.listen(port, host, () => {
              console.log(`[network] Now listening on ${host}:${port}`);
            });
          });
          return;
        }

        if (message.type === 'set_pairing_required') {
          pairingRequired = message.enabled !== false;
          console.log(`[config] Pairing requirement ${pairingRequired ? 'enabled' : 'disabled'}`);
          return;
        }

        extensionBridge.handleResponse(message);
      } catch (e) {
        console.error('Invalid message from extension:', e);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloDeadline);
      const wasProfileId = registeredProfileId;
      console.log(`[extension-bridge] Extension disconnected profile="${wasProfileId || '(unidentified)'}"`);
      extensionBridge.clearConnection(ws);
      if (wasProfileId) {
        broadcastUiEvent({
          type: 'extension_disconnected',
          profileId: wasProfileId,
          connectedProfiles: extensionBridge.getConnectedProfiles(),
        });
      }
    });

    ws.on('error', (error) => {
      console.error('[extension-bridge] WebSocket error:', error);
    });
  });

  formatterManager.init();

  formatterUpdater.init(formatterManager);
  formatterUpdater.checkForUpdates().catch(err => console.error('[server] Formatter update check failed:', err));
  setInterval(
    () => formatterUpdater.checkForUpdates().catch(err => console.error('[server] Periodic formatter update check failed:', err)),
    3600000
  );

  // Bridge async-pairing events back to the extension's WS so existing
  // `paired_agents_list` listeners in background.js keep working even though
  // approval now happens via the web UI rather than the extension popup.
  pairedKeys.onPairingEvent('approved', (entry) => {
    try {
      console.log(
        `[pairing] broadcasting paired_agents_list after approve of pairingId=${entry.pairingId}`
      );
      extensionBridge.notifyAll({ type: 'paired_agents_list', agents: pairedKeys.listKeys() });
      broadcastUiEvent({ type: 'pairing_approved', pairing: entry, agents: pairedKeys.listKeys() });
    } catch (e) {
      console.log(`[pairing] failed to broadcast paired_agents_list: ${e.message}`);
    }
  });

  pairedKeys.onPairingEvent('denied', (entry) => {
    try {
      broadcastUiEvent({ type: 'pairing_denied', pairing: entry });
    } catch (e) { /* ignore */ }
  });

  pairedKeys.onPairingEvent('requested', (entry) => {
    try {
      broadcastUiEvent({ type: 'pairing_requested', pairing: entry });
    } catch (e) { /* ignore */ }
  });

  const mcpHandler = createMcpHandler(
    extensionBridge,
    apiKey,
    pairedKeys,
    formatterManager,
    () => pairingRequired,
    { port, chromeManager }
  );

  app.get('/sse', mcpHandler.handleSSE);
  app.post('/message', mcpHandler.handleMessage);

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      extensionConnected: extensionBridge.isAnyConnected(),
      connectedProfiles: extensionBridge.getConnectedProfiles(),
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

  return { app, server, wss: extensionWss, uiWss, chromeManager, extensionBridge, broadcastUiEvent };
}

module.exports = { createServer };
