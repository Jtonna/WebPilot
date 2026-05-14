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

/**
 * Locate the built web-ui static directory. Resolves both dev mode
 * (packages/server-web-ui/out) and pkg mode (bundled into the snapshot via
 * `pkg.assets`). When running from pkg the __dirname is rooted at
 * /snapshot/... and the relative path resolution still finds the assets
 * bundled by `pkg.assets`.
 */
function resolveWebUiDir() {
  const inPkg = !!process.pkg;
  // Candidate paths in order of preference
  const candidates = [
    path.join(__dirname, '..', '..', 'server-web-ui', 'out'),
    path.join(__dirname, '..', 'server-web-ui', 'out'),
  ];
  if (inPkg) {
    // pkg snapshot root — the assets glob "../server-web-ui/out/**/*" places
    // the files at <snapshot>/packages/server-web-ui/out/. __dirname is
    // <snapshot>/packages/server-for-chrome-extension/src so the first
    // candidate above is the correct snapshot path. Express.static + pkg's
    // patched fs accept reads from /snapshot.
    console.log('[web-ui] running inside pkg snapshot');
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        console.log(`[web-ui] static dir resolved: ${c}`);
        return c;
      }
    } catch (e) { /* ignore */ }
  }
  console.log('[web-ui] no static dir found, will serve 503 for /ui — run `npm run build:web-ui`');
  return null;
}

// Minimal extension->mime map for the file types Next.js static export
// emits. `mime-types` is not a runtime dependency; hand-rolled to keep the
// pkg bundle lean.
const WEB_UI_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function _webUiMimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return WEB_UI_MIME[ext] || 'application/octet-stream';
}

/**
 * Map a URL request path to a file under the resolved web-ui-out directory,
 * keeping the traversal scoped inside that directory. Returns the absolute
 * filesystem path, or null if the requested resource cannot be served.
 *
 * Handles Next.js static-export conventions:
 *   /ui          -> index.html
 *   /ui/         -> index.html
 *   /ui/pairings -> pairings.html or pairings/index.html
 *   /ui/_next/.. -> _next/..
 */
function _resolveWebUiFile(rootDir, urlPath) {
  // Strip "/ui" prefix
  let rel = urlPath.replace(/^\/ui\/?/, '');
  // Decode percent-escapes (e.g. spaces). Tolerate malformed URIs.
  try {
    rel = decodeURIComponent(rel);
  } catch (_) { /* keep raw */ }
  // Reject any traversal attempts (".." segments)
  if (rel.split(/[\\/]/).some((seg) => seg === '..')) return null;

  // Default empty/dir paths to index.html
  if (rel === '' || rel.endsWith('/')) rel = rel + 'index.html';

  // Compose candidate paths to try in order
  const candidates = [path.join(rootDir, rel)];
  if (!path.extname(rel)) {
    candidates.push(path.join(rootDir, rel + '.html'));
    candidates.push(path.join(rootDir, rel, 'index.html'));
  }

  for (const candidate of candidates) {
    // Containment check — abort if any candidate escaped rootDir
    const resolved = path.resolve(candidate);
    const resolvedRoot = path.resolve(rootDir);
    if (!resolved.startsWith(resolvedRoot)) {
      console.log(`[web-ui] rejecting out-of-root path: ${resolved}`);
      continue;
    }
    try {
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) return resolved;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

function mountWebUiStatic(app) {
  const dir = resolveWebUiDir();
  if (!dir) {
    app.get(/^\/ui($|\/)/, (req, res) => {
      res.status(503).type('text/plain').send(
        'WebPilot UI is not built. Run `npm run build:web-ui` in packages/server-web-ui.'
      );
    });
    return;
  }

  // Manual file handler — replaces `express.static` so that pkg snapshot
  // reads go through `fs.readFileSync` (which pkg patches). See QOL fix-up F8.
  app.get(/^\/ui($|\/.*)/, (req, res) => {
    const filePath = _resolveWebUiFile(dir, req.path);
    if (!filePath) {
      console.log(`[web-ui] 404 for ${req.path}`);
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    try {
      const body = fs.readFileSync(filePath);
      res.setHeader('Content-Type', _webUiMimeFor(filePath));
      // Aggressive caching only for the immutable Next chunks; everything
      // else stays fresh so dev iterations show up immediately.
      if (filePath.includes(`${path.sep}_next${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
      console.log(`[web-ui] serving ${req.path} -> ${filePath} (${body.length}B)`);
      res.status(200).end(body);
    } catch (e) {
      console.log(`[web-ui] read failed for ${filePath}: ${e.message}`);
      res.status(500).type('text/plain').send('UI load failed: ' + e.message);
    }
  });
}

/**
 * Validate a profile-directory name supplied by a UI client before passing it
 * into a Chrome `--profile-directory=` arg and a filesystem path. See QOL
 * review C1.
 *
 * Rules:
 *  - non-empty string after trim
 *  - length 1..60
 *  - allowed chars: [A-Za-z0-9 _-] only (no slashes, dots, colons, quotes,
 *    `<>|*?`, control chars)
 *  - reject Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
 *    case-insensitive
 *  - reject names starting with `.` or ending with `.` or a space
 *  - reject if `<userDataDir>/<name>` already exists (case-insensitive on
 *    Windows)
 *
 * @param {string} name
 * @param {string} userDataDir
 * @returns {{ ok: true, name: string } | { ok: false, reason: string }}
 */
function validateProfileName(name, userDataDir) {
  if (typeof name !== 'string') {
    return { ok: false, reason: 'name must be a string' };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'name must be non-empty after trim' };
  }
  if (trimmed.length > 60) {
    return { ok: false, reason: 'name must be 60 characters or fewer' };
  }
  if (!/^[A-Za-z0-9 _-]+$/.test(trimmed)) {
    return {
      ok: false,
      reason:
        'name may only contain letters, digits, spaces, underscores, and hyphens',
    };
  }
  if (trimmed.startsWith('.')) {
    return { ok: false, reason: 'name must not start with a dot' };
  }
  if (trimmed.endsWith('.') || trimmed.endsWith(' ')) {
    return { ok: false, reason: 'name must not end with a dot or space' };
  }
  const upper = trimmed.toUpperCase();
  const reserved = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ]);
  if (reserved.has(upper)) {
    return { ok: false, reason: `name "${trimmed}" is a Windows reserved name` };
  }
  // Collision check against the user-data-dir. Case-insensitive on Windows
  // because NTFS treats `Default` and `default` as the same directory.
  if (userDataDir) {
    try {
      const entries = fs.readdirSync(userDataDir);
      const lower = trimmed.toLowerCase();
      const collides = entries.some((entry) =>
        process.platform === 'win32'
          ? entry.toLowerCase() === lower
          : entry === trimmed
      );
      if (collides) {
        return {
          ok: false,
          reason: `a profile directory named "${trimmed}" already exists`,
        };
      }
    } catch (e) {
      // userDataDir not readable — fall through; the launch attempt will
      // surface a clearer error than blocking on this check.
    }
  }
  return { ok: true, name: trimmed };
}

/**
 * Authentication for /api/ui/* routes: LOCALHOST ONLY.
 *
 * The web UI dashboard intentionally requires NO API key. It is bound to the
 * loopback interface of the machine hosting WebPilot. Network mode binds the
 * extension WS endpoint to 0.0.0.0, but the UI surface stays loopback-only
 * (this middleware rejects everything that does not arrive over 127.0.0.1
 * / ::1 with HTTP 403). The MCP and extension WS endpoints have their own
 * API-key auth and are untouched.
 */
function makeUiAuth(/* apiKey unused: see localhost-only contract above */) {
  return function uiAuth(req, res, next) {
    const remote = req.socket && req.socket.remoteAddress;
    const isLocal =
      remote === '127.0.0.1' ||
      remote === '::1' ||
      remote === '::ffff:127.0.0.1';
    if (isLocal) {
      return next();
    }
    console.log(`[ui-auth] rejecting non-local request to ${req.method} ${req.url} from ${remote}`);
    return res.status(403).json({ error: 'Forbidden: web UI is localhost-only' });
  };
}

function mountWebUiRoutes(app, deps) {
  const { chromeManager, extensionBridge, pairedKeys, setNetworkMode } = deps;
  // Web UI is localhost-only — no API key involved. See makeUiAuth().
  const auth = makeUiAuth();

  app.get('/api/ui/status', auth, async (req, res) => {
    try {
      const chromeStatus = await chromeManager.getStatus();
      const profiles = chromeStatus.knownProfiles || [];
      res.json({
        chrome: chromeStatus,
        profiles,
        connectedProfiles: extensionBridge.getConnectedProfiles(),
        pendingPairings: pairedKeys.listPendingPairings(),
        pairedAgents: pairedKeys.listKeys(),
        networkMode: (() => {
          try {
            const fp = path.join(getDataDir(), 'network.enabled');
            return fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').trim() === '1';
          } catch (e) { return false; }
        })(),
      });
    } catch (e) {
      console.error('[ui-api] /status failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/pairings/:id/approve', auth, express.json(), (req, res) => {
    try {
      const id = req.params.id;
      console.log(`[ui-api] approve pairing id=${id}`);
      const entry = pairedKeys.approvePairing(id);
      if (!entry) return res.status(404).json({ error: 'pairing not found' });
      res.json({ pairing: entry, agents: pairedKeys.listKeys() });
    } catch (e) {
      console.error('[ui-api] approve failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/pairings/:id/deny', auth, express.json(), (req, res) => {
    try {
      const id = req.params.id;
      console.log(`[ui-api] deny pairing id=${id}`);
      const entry = pairedKeys.denyPairing(id);
      if (!entry) return res.status(404).json({ error: 'pairing not found' });
      res.json({ pairing: entry });
    } catch (e) {
      console.error('[ui-api] deny failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/profiles', auth, express.json(), (req, res) => {
    try {
      const rawName = req.body && req.body.name;
      const v = validateProfileName(rawName, chromeManager.userDataDir);
      if (!v.ok) {
        console.log(`[ui-api:profiles] rejected profile name: ${v.reason}`);
        return res.status(400).json({ error: 'invalid profile name', reason: v.reason });
      }
      const name = v.name;
      console.log(`[ui-api] create profile: "${name}"`);
      const { launchChromeProfile } = require('./chrome');
      const launchRes = launchChromeProfile({
        userDataDir: chromeManager.userDataDir,
        profileDirectory: name,
        withFlag: true,
      });
      res.json({
        ok: true,
        profile: { directoryName: name },
        instructions:
          'Chrome should now be open on the new profile. Load the WebPilot ' +
          'unpacked extension in this profile via chrome://extensions ' +
          '(Developer mode > Load unpacked).',
        launch: launchRes,
      });
    } catch (e) {
      console.error('[ui-api] create profile failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/agents/:key/rename', auth, express.json(), (req, res) => {
    try {
      const key = req.params.key;
      const newName = req.body && req.body.newName;
      if (!newName) return res.status(400).json({ error: 'newName required' });
      const ok = pairedKeys.renameKey(key, newName);
      if (!ok) return res.status(404).json({ error: 'agent not found' });
      res.json({ ok: true, agents: pairedKeys.listKeys() });
    } catch (e) {
      console.error('[ui-api] rename failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/ui/agents/:key', auth, (req, res) => {
    try {
      const key = req.params.key;
      const ok = pairedKeys.revokeKey(key);
      if (!ok) return res.status(404).json({ error: 'agent not found' });
      res.json({ ok: true, agents: pairedKeys.listKeys() });
    } catch (e) {
      console.error('[ui-api] revoke failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/settings/network-mode', auth, express.json(), (req, res) => {
    try {
      const enabled = !!(req.body && req.body.enabled);
      console.log(`[ui-api] settings/network-mode enabled=${enabled}`);
      res.json({ ok: true, restarting: true });
      // Trigger restart-spawn after the response is flushed.
      setImmediate(() => setNetworkMode({ enabled }));
    } catch (e) {
      console.error('[ui-api] network-mode failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
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

    // Route web UI events WebSocket — LOCALHOST ONLY (no API key).
    // The web UI dashboard is unauthenticated by design and bound to loopback.
    if (url.pathname === '/api/ui/events') {
      const remoteAddr = request.socket.remoteAddress || '';
      const isLocal =
        remoteAddr === '127.0.0.1' ||
        remoteAddr === '::1' ||
        remoteAddr === '::ffff:127.0.0.1';
      if (!isLocal) {
        console.log(`[ui-ws] rejecting non-local UI WS upgrade from ${remoteAddr}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
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
          // DEPRECATED: the WebPilot extension no longer sends this message
          // (pairing config is owned by the web UI). Kept for forward/backward
          // compatibility with older clients; logs a one-line warning so
          // operators notice if some legacy thing is still pushing it.
          pairingRequired = message.enabled !== false;
          console.log(
            `[config] DEPRECATED set_pairing_required received from extension; ` +
              `accepting value=${pairingRequired} for compatibility. Source clients ` +
              `should manage pairing via the web UI instead.`
          );
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

  // Pending-pairings housekeeping: lazy-expire entries past 24h, hard-drop
  // anything older than 7d. Runs once at startup and then hourly.
  try {
    const initial = pairedKeys.cleanupExpiredPairings();
    console.log(
      `[pairing:cleanup] startup pass: expired=${initial.expired} dropped=${initial.dropped} kept=${initial.kept}`
    );
  } catch (e) {
    console.log(`[pairing:cleanup] startup pass failed: ${e.message}`);
  }
  setInterval(() => {
    try {
      pairedKeys.cleanupExpiredPairings();
    } catch (e) {
      console.log(`[pairing:cleanup] hourly pass failed: ${e.message}`);
    }
  }, 3600 * 1000);

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

  // ---- Web UI static mount + REST ----
  mountWebUiStatic(app);
  mountWebUiRoutes(app, {
    // NOTE: apiKey intentionally omitted — web UI is localhost-only (no key).
    chromeManager,
    extensionBridge,
    pairedKeys,
    server,
    setNetworkMode: ({ enabled }) => {
      // Persist + restart-spawn approach (Section 4.6)
      try {
        fs.writeFileSync(path.join(getDataDir(), 'network.enabled'), enabled ? '1' : '0', 'utf8');
      } catch (e) {
        console.error('[network] Failed to persist network.enabled:', e.message);
      }
      console.log(`[network] Network mode toggled to ${enabled ? 'on' : 'off'}; restarting daemon`);
      // Spawn a fresh detached copy of self before exiting so the user is not stranded.
      try {
        const { spawn } = require('child_process');
        const args = process.argv.slice(1);
        const env = { ...process.env, WEBPILOT_FOREGROUND: '1' };
        const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
        child.unref();
      } catch (e) {
        console.error('[network] Failed to spawn replacement daemon:', e.message);
      }
      setTimeout(() => {
        try { cleanupPidAndPortFiles(); } catch (e) { /* ignore */ }
        process.exit(0);
      }, 500);
    },
  });

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
