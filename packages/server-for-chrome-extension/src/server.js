const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createMcpHandler } = require('./mcp-handler');
const { createExtensionBridge } = require('./extension-bridge');
const pairedKeys = require('./paired-keys');
const extensionInstalls = require('./extension-installs');
const formatterManager = require('./formatter-manager');
const formatterUpdater = require('./formatter-updater');
const blocklistUpdater = require('./blocklist-updater');
const formatterLogs = require('./formatter-logs');
const notificationsSettings = require('./notifications-settings');
const { createChromeManager, readProfiles } = require('./chrome');

const { getDataDir, getLogPath } = require('./service/paths');

/**
 * Resolve the absolute path to the WebPilot Chrome-extension folder the user
 * should "Load unpacked" from.
 *
 * - In pkg mode (Electron-bundled installer): the extension lives at
 *   `<install>/resources/chrome-extension/`. `process.execPath` resolves to
 *   `<install>/resources/server/<server-exe>`, so the extension dir is
 *   `path.resolve(execDir, '..', 'chrome-extension')`. If that does not exist
 *   (unexpected install layout), fall back to null so the UI can render the
 *   "find it in resources/chrome-extension" hint.
 * - In dev: the extension lives at `<repoRoot>/packages/chrome-extension-unpacked`.
 *   __dirname is `<repoRoot>/packages/server-for-chrome-extension/src`, so
 *   resolve relatively.
 */
function resolveExtensionPath() {
  try {
    const inPkg = !!process.pkg ||
      (process.platform === 'win32' &&
        path.basename(process.execPath).toLowerCase().endsWith('.exe') &&
        path.basename(process.execPath).toLowerCase() !== 'node.exe');
    if (inPkg) {
      const candidate = path.resolve(path.dirname(process.execPath), '..', 'chrome-extension');
      if (fs.existsSync(candidate)) return candidate;
      return null;
    }
    const devPath = path.resolve(__dirname, '..', '..', 'chrome-extension-unpacked');
    if (fs.existsSync(devPath)) return devPath;
    return devPath; // return anyway — operator can see the expected location
  } catch (e) {
    console.log(`[ui-api:paths] resolveExtensionPath failed: ${e.message}`);
    return null;
  }
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
  // Dev mode: proxy /ui/* to the Next.js dev server so hot reload Just Works.
  // Activated by `npm run dev` at the repo root (which sets WEBPILOT_DEV=1 and
  // spawns `next dev` on port 3100 — see packages/server-web-ui/package.json).
  // The pkg-binary install path never sets this env var, so production
  // continues serving the static export bundled into the pkg snapshot.
  if (process.env.WEBPILOT_DEV === '1') {
    let createProxyMiddleware;
    try {
      ({ createProxyMiddleware } = require('http-proxy-middleware'));
    } catch (e) {
      console.log(
        '[web-ui:dev] WEBPILOT_DEV=1 set but http-proxy-middleware is not installed. ' +
          'Run `npm install` at the repo root. Falling back to static serve.'
      );
      createProxyMiddleware = null;
    }
    if (createProxyMiddleware) {
      console.log('[web-ui:dev] WEBPILOT_DEV=1 — proxying /ui/* to http://localhost:3100');
      app.use(
        '/ui',
        createProxyMiddleware({
          target: 'http://localhost:3100',
          changeOrigin: true,
          ws: true,
          logLevel: 'silent',
        })
      );
      return;
    }
  }

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
/**
 * Dev-mode signal — loosens the localhost-only UI auth so a developer can
 * hit the UI / popup endpoints over LAN (e.g. via `http://192.168.x.x:3456/ui`)
 * during iteration. NEVER true in production: pkg .exe builds don't run with
 * `node --watch` and don't have `WEBPILOT_DEV` set. The check uses both
 * signals so users running plain `node index.js` from source can opt in
 * explicitly, while the `npm run dev` script (which uses `node --watch`)
 * picks it up automatically.
 *
 * In dev mode, ui-auth / mutating-ui-auth / ui-ws-upgrade still LOG that
 * they accepted a non-local request so it's visible in daemon.log, but do
 * not reject. The mutating layer's policy is preserved in production where
 * it matters.
 */
// Detection: `npm_lifecycle_event === 'dev'` is set by npm whenever you run
// `npm run dev` (Node strips `--watch` from `process.execArgv` so the watch
// flag itself isn't a reliable signal). `NODE_ENV === 'development'` and an
// explicit `WEBPILOT_DEV=1` env var are also accepted for setups that
// invoke the server directly without npm.
const IS_DEV_MODE =
  process.env.WEBPILOT_DEV === '1' ||
  process.env.NODE_ENV === 'development' ||
  process.env.npm_lifecycle_event === 'dev';

if (IS_DEV_MODE) {
  console.log(
    '[ui-auth] DEV MODE detected (npm run dev / NODE_ENV=development / WEBPILOT_DEV=1) — localhost-only UI gates will pass-through with a warning log. Do NOT ship a production build in this mode.'
  );
}

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
    if (IS_DEV_MODE) {
      console.log(`[ui-auth] DEV MODE — allowing non-local ${req.method} ${req.url} from ${remote}`);
      return next();
    }
    console.log(`[ui-auth] rejecting non-local request to ${req.method} ${req.url} from ${remote}`);
    return res.status(403).json({ error: 'Forbidden: web UI is localhost-only' });
  };
}

/**
 * Defense-in-depth localhost gate for MUTATING Web UI endpoints
 * (/api/ui/agents/*, /api/ui/profiles, /api/ui/settings/network-mode,
 * /api/ui/server/restart, /api/ui/chrome/restart, /api/ui/pairings/:id/approve,
 * /api/ui/pairings/:id/deny, /api/ui/formatters/:name/dismiss, etc.).
 *
 * The general `makeUiAuth` already rejects non-loopback callers, but mutating
 * admin actions are sensitive enough to deserve a second, narrowly-scoped check
 * that survives any future refactor of the broader UI auth policy. Read-only
 * endpoints (GET /api/ui/status, /api/ui/events WS, etc.) intentionally do NOT
 * use this — if we ever loosen UI auth to allow read-only network access, those
 * endpoints stay reachable while mutating ones stay loopback-only.
 */
function makeMutatingUiAuth() {
  return function mutatingUiAuth(req, res, next) {
    const remote = (req.socket && req.socket.remoteAddress) || '';
    const isLocal =
      remote === '127.0.0.1' ||
      remote === '::1' ||
      remote === '::ffff:127.0.0.1';
    if (isLocal) return next();
    if (IS_DEV_MODE) {
      console.log(`[ui-auth] DEV MODE — allowing non-local MUTATING ${req.method} ${req.url} from ${remote}`);
      return next();
    }
    console.log(`[ui-auth] rejecting non-local mutating request to ${req.method} ${req.url} from ${remote}`);
    return res.status(403).json({ error: 'Forbidden: mutating UI endpoints are localhost-only' });
  };
}

function mountWebUiRoutes(app, deps) {
  const { chromeManager, extensionBridge, pairedKeys, setNetworkMode, port, broadcastUiEvent } = deps;
  // Web UI is localhost-only — no API key involved. See makeUiAuth().
  const auth = makeUiAuth();
  // Extra localhost gate layered onto every mutating admin endpoint. See
  // makeMutatingUiAuth() for the rationale.
  const mutatingAuth = makeMutatingUiAuth();

  app.get('/api/ui/status', auth, async (req, res) => {
    try {
      const chromeStatus = await chromeManager.getStatus();
      const rawProfiles = chromeStatus.knownProfiles || [];
      const connectedProfiles = extensionBridge.getConnectedProfiles();
      const connectedSet = new Set(connectedProfiles);

      // Compute the set of profileIds that have at least one installId mapped
      // to them in extension-installs.json. Presence here proves the extension
      // completed a hello handshake in that profile at least once.
      let registeredProfileIds = new Set();
      try {
        const installs = extensionInstalls.loadInstalls();
        registeredProfileIds = new Set(
          Object.values(installs)
            .map((e) => e && e.profileId)
            .filter((p) => typeof p === 'string' && p.length > 0)
        );
      } catch (e) {
        console.log(`[ui-api:status] failed to load extension installs: ${e.message}`);
      }

      // Tag each profile with its per-profile webPilotStatus. Mutually
      // exclusive: active > ready > needs_setup.
      let activeCount = 0;
      let readyCount = 0;
      let needsSetupCount = 0;
      const profiles = rawProfiles.map((p) => {
        let webPilotStatus;
        if (connectedSet.has(p.directoryName)) {
          webPilotStatus = 'active';
          activeCount += 1;
        } else if (registeredProfileIds.has(p.directoryName)) {
          webPilotStatus = 'ready';
          readyCount += 1;
        } else {
          webPilotStatus = 'needs_setup';
          needsSetupCount += 1;
        }
        return { ...p, webPilotStatus };
      });

      console.log(
        `[ui-api:status] ${profiles.length} profiles: ${activeCount} active, ` +
          `${readyCount} ready, ${needsSetupCount} needs_setup`
      );

      // Collect unhealthy formatters as dashboard action items. Each entry is
      // tagged `type: 'formatter_error'` so the UI can discriminate it from
      // pairing rows (which are surfaced via `pendingPairings` and rendered
      // with PairingPromptCard). The UI consumes both lists in its Action
      // Items section. See P1 #1.
      let formatterActionItems = [];
      try {
        const statusMap = formatterLogs.listAll();
        for (const [name, status] of statusMap.entries()) {
          if (status && status.health === 'unhealthy') {
            formatterActionItems.push({
              type: 'formatter_error',
              name,
              health: status.health,
              lastError: status.lastError,
              lastErrorAt: status.lastErrorAt,
              lastSuccessAt: status.lastSuccessAt,
              errorCount: status.errorCount,
              successCount: status.successCount,
              dismissedAt: status.dismissedAt || null,
            });
          }
        }
        // Newest error first (matches the ring-buffer view ordering).
        formatterActionItems.sort((a, b) => {
          const ax = a.lastErrorAt || '';
          const bx = b.lastErrorAt || '';
          if (ax === bx) return 0;
          return ax < bx ? 1 : -1;
        });
      } catch (e) {
        console.log(`[ui-api:status] formatter action items collection failed: ${e.message}`);
        formatterActionItems = [];
      }

      res.json({
        // Exposed so the UI can render .mcp.json snippets with the live port
        // (no hardcoded default). See Wave 6 H6.
        port: port || null,
        chrome: chromeStatus,
        profiles,
        // Kept for backward compatibility. New consumers should use the
        // per-profile `webPilotStatus` field on each entry in `profiles`.
        connectedProfiles,
        pendingPairings: pairedKeys.listPendingPairings(),
        // New (P1 #1): formatter errors surface as discriminated action items
        // alongside pending pairings on the dashboard.
        actionItems: formatterActionItems,
        pairedAgents: pairedKeys.listKeys(),
        networkMode: (() => {
          // P2 phase 7: prefer DB row; fall back to legacy flag file only if
          // the row is absent (first-boot-before-migration path). The DB
          // becomes the source of truth once migration runs.
          try {
            const row = require('./db/connection').getDb()
              .prepare('SELECT value FROM config WHERE key = ?')
              .get('network_enabled');
            if (row && typeof row.value === 'string') {
              return row.value === 'true' || row.value === '1';
            }
          } catch (_e) { /* fall through to flag file */ }
          try {
            const fp = path.join(getDataDir(), 'network.enabled');
            return fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').trim() === '1';
          } catch (e) { return false; }
        })(),
        // Surfaces the canonical filesystem locations the Settings page and
        // ProfileSetupModal need to render copyable absolute paths. See Phase 3 C.
        paths: {
          dataDir: getDataDir(),
          logPath: getLogPath(),
          extensionPath: resolveExtensionPath(),
        },
        // Server-persisted notification preferences. Source of truth for the
        // Settings page; the daemon also consults this when firing pairing
        // notifications. See Phase 3 B.
        notifications: notificationsSettings.getSettings(),
        // Baseline blocklist summary (P2 phase 4). The webapp Sites page
        // (Phase 5) reads from this. Shape: { enabled, version, lastFetchedAt,
        // domainCount }.
        baselineBlocklist: (() => {
          try { return blocklistUpdater.getStatus(); }
          catch (e) {
            console.log(`[ui-api:status] baselineBlocklist getStatus failed: ${e.message}`);
            return { enabled: true, version: null, lastFetchedAt: null, domainCount: 0 };
          }
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
      const body = req.body || {};
      const profileIdRaw = body.profileId;
      console.log(`[ui-api] approve pairing id=${id} profileId=${JSON.stringify(profileIdRaw)}`);

      if (profileIdRaw === undefined || profileIdRaw === null || profileIdRaw === '') {
        return res.status(400).json({ error: 'profileId required', reason: 'profileId required' });
      }
      if (typeof profileIdRaw !== 'string') {
        return res.status(400).json({ error: 'profileId must be a string', reason: 'profileId must be a string' });
      }

      let resolvedProfileId = null;

      if (profileIdRaw === '__new__') {
        // Caller is creating a fresh sandbox profile.
        const v = validateProfileName(body.newProfileName, chromeManager.userDataDir);
        if (!v.ok) {
          console.log(`[ui-api:profiles] rejected profile name: ${v.reason}`);
          return res.status(400).json({ error: 'invalid newProfileName', reason: v.reason });
        }
        try {
          const { launchChromeProfile } = require('./chrome');
          launchChromeProfile({
            userDataDir: chromeManager.userDataDir,
            profileDirectory: v.name,
            withFlag: true,
          });
        } catch (e) {
          console.error('[ui-api] approve: failed to launch new profile:', e.message);
          return res.status(500).json({ error: 'failed to launch new profile: ' + e.message });
        }
        resolvedProfileId = v.name;
      } else {
        // Verify the chosen profileId matches a known profile in Local State.
        let known = [];
        try {
          known = readProfiles(chromeManager.userDataDir);
        } catch (e) {
          console.log(`[ui-api] approve: readProfiles failed: ${e.message}`);
        }
        const match = known.find((p) => p.directoryName === profileIdRaw);
        if (!match) {
          return res.status(400).json({
            error: 'unknown profileId',
            reason: "profileId did not match a known profile and is not '__new__'",
          });
        }
        resolvedProfileId = match.directoryName;
      }

      const entry = pairedKeys.approvePairing(id, { profileId: resolvedProfileId });
      if (!entry) {
        const exists = pairedKeys.listAllPairings().some((p) => p.pairingId === id);
        if (!exists) return res.status(404).json({ error: 'pairing not found' });
        return res.status(409).json({
          error: 'pairing is in a terminal state (denied/expired) or does not exist',
        });
      }
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
      if (!entry) {
        const exists = pairedKeys.listAllPairings().some((p) => p.pairingId === id);
        if (!exists) return res.status(404).json({ error: 'pairing not found' });
        return res.status(409).json({
          error: 'pairing is in a terminal state (approved/expired) or does not exist',
        });
      }
      res.json({ pairing: entry });
    } catch (e) {
      console.error('[ui-api] deny failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/profiles', auth, mutatingAuth, express.json(), (req, res) => {
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

  // POST /api/ui/agents
  //
  // Direct UI pre-provision: mint a paired-keys entry without the
  // request_pairing → approval round-trip. Used by the pair-agent modal's
  // "Include API key" toggle so the operator can hand an AI agent both URL
  // and key in a single copy.
  //
  // Body: { agentName: string, profileId: string }
  //   - agentName: non-empty after trim, ≤ 60 chars (mirrors the
  //     validateProfileName cap — there is no existing dedicated cap on agent
  //     names; this keeps it predictable and prevents abuse).
  //   - profileId: must match a known profile from Local State (same lookup
  //     the approve and PATCH handlers use).
  //
  // Returns 201 with { apiKey, agentName, profileId, createdAt }. Broadcasts
  // `agents_changed` so any open Agents/Pairings tabs refresh.
  app.post('/api/ui/agents', auth, mutatingAuth, express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const rawName = body.agentName;
      const profileIdRaw = body.profileId;
      console.log(
        `[ui-api] POST /agents agentName=${JSON.stringify(rawName)} ` +
          `profileId=${JSON.stringify(profileIdRaw)}`
      );

      if (typeof rawName !== 'string') {
        return res.status(400).json({
          error: 'agentName required',
          reason: 'agentName must be a string',
        });
      }
      const agentName = rawName.trim();
      if (agentName.length === 0) {
        return res.status(400).json({
          error: 'agentName required',
          reason: 'agentName must be non-empty after trim',
        });
      }
      if (agentName.length > 60) {
        return res.status(400).json({
          error: 'agentName too long',
          reason: 'agentName must be 60 characters or fewer',
        });
      }

      if (typeof profileIdRaw !== 'string' || profileIdRaw.length === 0) {
        return res.status(400).json({
          error: 'profileId required',
          reason: 'profileId must be a non-empty string',
        });
      }

      let known = [];
      try {
        known = readProfiles(chromeManager.userDataDir);
      } catch (e) {
        console.log(`[ui-api] POST /agents: readProfiles failed: ${e.message}`);
      }
      const match = known.find((p) => p.directoryName === profileIdRaw);
      if (!match) {
        return res.status(400).json({
          error: 'unknown profileId',
          reason: `profileId "${profileIdRaw}" did not match a known Chrome profile`,
        });
      }

      const minted = pairedKeys.createPairedAgent({
        agentName,
        profileId: match.directoryName,
      });

      try {
        broadcastUiEvent && broadcastUiEvent({
          type: 'agents_changed',
          agents: pairedKeys.listKeys(),
        });
      } catch (_e) { /* ignore */ }

      res.status(201).json(minted);
    } catch (e) {
      console.error('[ui-api] POST /agents failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/agents/:key/rename', auth, mutatingAuth, express.json(), (req, res) => {
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

  // PATCH /api/ui/agents/:key
  //
  // Re-bind an existing agent (API key) to a different Chrome profile. Tool
  // calls from this agent will route to the new profile on the next call —
  // no socket teardown needed because routing is a per-call lookup of the
  // agent's profileId in mcp-handler.resolveTargetProfile.
  //
  // Body: { profileId: "<directoryName>" } — must match a known profile.
  app.patch('/api/ui/agents/:key', auth, mutatingAuth, express.json(), (req, res) => {
    try {
      const key = req.params.key;
      const body = req.body || {};
      const profileIdRaw = body.profileId;
      console.log(`[ui-api] PATCH agent ${key.slice(0, 8)}... profileId=${JSON.stringify(profileIdRaw)}`);

      if (typeof profileIdRaw !== 'string' || profileIdRaw.length === 0) {
        return res.status(400).json({
          error: 'profileId required',
          reason: 'profileId must be a non-empty string',
        });
      }

      // Validate against known profiles from Local State — same source the
      // approve handler uses for verification.
      let known = [];
      try {
        known = readProfiles(chromeManager.userDataDir);
      } catch (e) {
        console.log(`[ui-api] PATCH agent: readProfiles failed: ${e.message}`);
      }
      const match = known.find((p) => p.directoryName === profileIdRaw);
      if (!match) {
        return res.status(400).json({
          error: 'unknown profileId',
          reason: `profileId "${profileIdRaw}" did not match a known Chrome profile`,
        });
      }

      const ok = pairedKeys.updateProfileBinding(key, match.directoryName);
      if (!ok) return res.status(404).json({ error: 'agent not found' });

      const updated = pairedKeys.listKeys().find((a) => a.key === key) || null;
      // Broadcast so the Agents and Pairings tabs both refresh.
      try {
        broadcastUiEvent && broadcastUiEvent({
          type: 'agents_changed',
          agents: pairedKeys.listKeys(),
        });
      } catch (_e) { /* ignore */ }
      res.json({ ok: true, agent: updated, agents: pairedKeys.listKeys() });
    } catch (e) {
      console.error('[ui-api] PATCH agent failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/ui/agents/:key', auth, mutatingAuth, (req, res) => {
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

  // ---- Pairings history (Phase 3 A) ----
  // GET /api/ui/pairings/history?cursor=<isoTimestamp>&limit=<n>
  // GET /api/ui/pairings/history?before=<isoTimestamp>&limit=<n>  (alias)
  //
  // Returns terminal-state pairings (approved/denied/expired) sorted by
  // decidedAt DESC, cursor-paginated. Pending entries are not "history" — they
  // live on /api/ui/status under `pendingPairings`.
  //
  // `cursor` and `before` are accepted interchangeably; both mean "return
  // entries strictly older than this timestamp". `cursor` is the original
  // name (still used by lib/api.js#getPairingHistory); `before` is the
  // industry-standard name and is supported for new callers.
  //
  // Response shape: { entries, hasMore, nextCursor } where `hasMore` is true
  // iff more terminal entries exist beyond the returned page, and
  // `nextCursor` is the timestamp to pass back to fetch the next page (null
  // when there's nothing more).
  app.get('/api/ui/pairings/history', auth, (req, res) => {
    try {
      const rawCursor = typeof req.query.cursor === 'string' && req.query.cursor.length > 0
        ? req.query.cursor
        : null;
      const rawBefore = typeof req.query.before === 'string' && req.query.before.length > 0
        ? req.query.before
        : null;
      const cursor = rawCursor || rawBefore;
      const rawLimit = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 200)
        : 50;

      const all = pairedKeys.listAllPairings();
      const terminal = all.filter((p) =>
        p.status === 'approved' || p.status === 'denied' || p.status === 'expired'
      );

      // Sort by decidedAt (fall back to createdAt) DESC
      terminal.sort((a, b) => {
        const ax = a.decidedAt || a.createdAt || '';
        const bx = b.decidedAt || b.createdAt || '';
        if (ax === bx) return 0;
        return ax < bx ? 1 : -1;
      });

      let filtered = terminal;
      if (cursor) {
        filtered = filtered.filter((p) => {
          const ts = p.decidedAt || p.createdAt || '';
          return ts < cursor;
        });
      }

      const page = filtered.slice(0, limit);
      const hasMore = filtered.length > page.length;
      const nextCursor = hasMore && page.length > 0
        ? (page[page.length - 1].decidedAt || page[page.length - 1].createdAt || null)
        : null;

      console.log(
        `[ui-api:pairings:history] cursor=${cursor || '(none)'} limit=${limit} ` +
          `returned=${page.length} hasMore=${hasMore} nextCursor=${nextCursor || '(end)'}`
      );

      res.json({ entries: page, hasMore, nextCursor });
    } catch (e) {
      console.error('[ui-api] /pairings/history failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Formatters observability (Wave B) ----
  //
  // Returns the list of registered formatters with their per-formatter
  // manifest metadata fused with the runtime health/log status from
  // formatter-logs. Powers the upcoming Web UI Formatters tab.
  //
  // Localhost-only via `auth`; no API key required (project policy for
  // /api/ui/*).
  app.get('/api/ui/formatters', auth, (req, res) => {
    try {
      const manifests = formatterManager.getPerFormatterManifests();
      const statusMap = formatterLogs.listAll();
      const out = Object.entries(manifests).map(([name, pm]) => {
        const status = statusMap.get(name) || {
          health: 'unknown',
          lastError: null,
          lastSuccessAt: null,
          lastErrorAt: null,
          successCount: 0,
          errorCount: 0
        };
        return {
          name,
          version: pm.version,
          source: pm.source,
          description: pm.description,
          notes: pm.notes || '',
          match: pm.match || '',
          errorHandling: pm.errorHandling || { fallbackToRawTree: true },
          workflows: Array.isArray(pm.workflows) ? pm.workflows : [],
          health: status.health,
          lastError: status.lastError,
          lastSuccessAt: status.lastSuccessAt,
          lastErrorAt: status.lastErrorAt,
          successCount: status.successCount,
          errorCount: status.errorCount
        };
      });
      res.json({ formatters: out });
    } catch (e) {
      console.error('[ui-api] GET /formatters failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/ui/incidents/:id/dismiss
  //
  // Per-incident dismiss (P2 phase 3). Each formatter_incidents row gets its
  // own dismiss; the legacy "dismiss the whole formatter" semantic is gone.
  // Sets dismissed_at on the row and emits a `changed` event so the
  // dashboard WebSocket subscriber re-renders.
  app.post('/api/ui/incidents/:id/dismiss', auth, express.json(), (req, res) => {
    try {
      const idRaw = req.params.id;
      const id = Number(idRaw);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: 'incident id must be numeric', id: idRaw });
      }
      const result = formatterLogs.recordDismiss(id, 'user');
      if (!result.ok) {
        const status = result.error === 'incident not found' ? 404 : 400;
        return res.status(status).json({ error: result.error, incidentId: id });
      }
      console.log(`[ui-api] dismiss incident id=${id} formatter="${result.formatter}"`);
      res.json({ ok: true, incidentId: id, formatter: result.formatter, status: result.status });
    } catch (e) {
      console.error('[ui-api] dismiss incident failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/ui/formatters/:name/dismiss-all
  //
  // Bulk dismiss for the dashboard Action Items header's "Dismiss all" button.
  // Marks every undismissed incident for `name` as dismissed; returns the
  // affected row count so the UI can show a toast.
  app.post('/api/ui/formatters/:name/dismiss-all', auth, express.json(), (req, res) => {
    try {
      const name = req.params.name;
      const result = formatterLogs.recordDismissAll(name, 'user');
      if (!result.ok) {
        return res.status(400).json({ error: result.error, name });
      }
      console.log(`[ui-api] dismiss-all formatter="${name}" affected=${result.affected}`);
      res.json({ ok: true, name, affected: result.affected, status: result.status });
    } catch (e) {
      console.error('[ui-api] dismiss-all formatter failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/ui/formatters/:name/logs', auth, (req, res) => {
    try {
      const limitRaw = req.query.limit;
      let limit = 50;
      if (typeof limitRaw === 'string') {
        const parsed = parseInt(limitRaw, 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, 500);
      }
      const logs = formatterLogs.getLogs(req.params.name, limit);
      const status = formatterLogs.getStatus(req.params.name);
      res.json({ name: req.params.name, status, logs });
    } catch (e) {
      console.error('[ui-api] GET /formatters/:name/logs failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Notification settings (Phase 3 B) ----
  app.get('/api/ui/settings/notifications', auth, (req, res) => {
    try {
      const settings = notificationsSettings.loadSettings();
      res.json(settings);
    } catch (e) {
      console.error('[ui-api] GET /settings/notifications failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/settings/notifications', auth, express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const partial = {};
      if (typeof body.systemNotifications === 'boolean') {
        partial.systemNotifications = body.systemNotifications;
      }
      if (typeof body.sound === 'boolean') {
        partial.sound = body.sound;
      }
      console.log(`[ui-api] POST /settings/notifications partial=${JSON.stringify(partial)}`);
      const updated = notificationsSettings.saveSettings(partial);
      res.json(updated);
    } catch (e) {
      console.error('[ui-api] POST /settings/notifications failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Chrome restart / launch (Phase 3 D1+D2) ----
  // POST /api/ui/chrome/restart
  //
  // Calls chromeManager.ensureReady — handles all three cases (running with
  // flag → noop; running without flag → kill+relaunch; not running → launch).
  app.post('/api/ui/chrome/restart', auth, express.json(), async (req, res) => {
    try {
      // Pick a sensible profile set to require:
      //   1) Connected profiles (so we don't kill+relaunch fewer windows than
      //      the user had).
      //   2) `managedProfile` from server config as a fallback.
      //   3) "Default" as the ultimate fallback.
      const connected = extensionBridge.getConnectedProfiles();
      let requiredProfiles = connected.slice();
      if (requiredProfiles.length === 0) {
        let managed = 'Default';
        try {
          const { loadConfig } = require('./service/paths');
          const cfg = loadConfig() || {};
          if (typeof cfg.managedProfile === 'string' && cfg.managedProfile.length > 0) {
            managed = cfg.managedProfile;
          }
        } catch (_) { /* ignore */ }
        requiredProfiles = [managed];
      }
      console.log(
        `[ui-api:chrome:restart] requiredProfiles=${JSON.stringify(requiredProfiles)}`
      );
      const result = await chromeManager.ensureReady(requiredProfiles);
      const status = await chromeManager.getStatus();
      res.json({
        success: true,
        action: result.action,
        reason: result.reason,
        browserPid: status.browserPid,
        hasFlag: status.hasFlag,
        profilesLaunched: result.launched || [],
      });
    } catch (e) {
      console.error('[ui-api] /chrome/restart failed:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ---- Server restart (Phase 3 D3) ----
  // Identical spawn-and-exit semantics as POST /api/ui/settings/network-mode.
  app.post('/api/ui/server/restart', auth, express.json(), (req, res) => {
    try {
      console.log('[ui-api] /server/restart received — spawning replacement and exiting');
      res.json({ ok: true, restarting: true });
      setImmediate(() => {
        try {
          const { spawn } = require('child_process');
          const args = process.argv.slice(1);
          const env = { ...process.env, WEBPILOT_FOREGROUND: '1' };
          const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env });
          child.unref();
        } catch (e) {
          console.error('[ui-api:server:restart] Failed to spawn replacement daemon:', e.message);
        }
        setTimeout(() => {
          try { cleanupPidAndPortFiles(); } catch (_e) { /* ignore */ }
          process.exit(0);
        }, 500);
      });
    } catch (e) {
      console.error('[ui-api] /server/restart failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/ui/settings/network-mode', auth, mutatingAuth, express.json(), (req, res) => {
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

  // --- Sites admin routes (P2 phase 5) ---
  //
  // Webapp Sites page CRUD over the site-policy tables. Reads + writes are
  // localhost-only (auth) and writes go through mutatingAuth for the same
  // defense-in-depth gate the other admin endpoints use. Every successful
  // write broadcasts a `sites_changed` UI event so any open Sites tab
  // refetches.
  const sitePolicy = require('./site-policy');

  // Resolve the numeric agents.id row from the `key` parameter passed by the
  // webapp (which is the api_key_hash, since that's what listKeys() exposes
  // as `key`). Returns null when no active agent matches.
  function _agentIdFromKey(key) {
    if (typeof key !== 'string' || key.length === 0) return null;
    try {
      const db = require('./db/connection').getDb();
      const row = db
        .prepare("SELECT id FROM agents WHERE api_key_hash = ? AND state = 'active'")
        .get(key);
      return row ? row.id : null;
    } catch (e) {
      console.log(`[ui-api:sites] _agentIdFromKey failed: ${e.message}`);
      return null;
    }
  }

  function _broadcastSitesChanged(reason) {
    try {
      broadcastUiEvent && broadcastUiEvent({ type: 'sites_changed', reason: reason || null });
    } catch (_e) { /* ignore */ }
  }

  // GET /api/ui/sites
  // Returns the full global_site_rules list (user + baseline) plus a small
  // summary of the baseline pack.
  app.get('/api/ui/sites', auth, (req, res) => {
    try {
      const db = require('./db/connection').getDb();
      const rows = db
        .prepare(
          'SELECT domain, decision, source, created_at, updated_at FROM global_site_rules ORDER BY source ASC, domain ASC'
        )
        .all();
      const globalRules = rows.map((r) => ({
        domain: r.domain,
        decision: r.decision,
        source: r.source,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
      let baseline;
      try {
        baseline = blocklistUpdater.getStatus();
      } catch (e) {
        baseline = { enabled: true, version: null, lastFetchedAt: null, domainCount: 0 };
      }
      res.json({ globalRules, baseline });
    } catch (e) {
      console.error('[ui-api] GET /sites failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/ui/sites
  // Body: { domain, decision: 'allow'|'block' }. Adds (or upserts) a
  // source='user' global rule.
  app.post('/api/ui/sites', auth, mutatingAuth, express.json(), (req, res) => {
    try {
      const body = req.body || {};
      const rawDomain = body.domain;
      const decision = body.decision;
      const normalized = sitePolicy.normalizeDomain(rawDomain);
      if (!normalized) {
        return res.status(400).json({
          error: 'invalid domain',
          reason: `domain ${JSON.stringify(rawDomain)} did not normalize to a usable hostname`,
        });
      }
      if (decision !== 'allow' && decision !== 'block') {
        return res.status(400).json({
          error: 'invalid decision',
          reason: "decision must be 'allow' or 'block'",
        });
      }
      const result = sitePolicy.setGlobalRule(normalized, decision, 'user');
      // Read back the persisted row so we include created_at / updated_at.
      const db = require('./db/connection').getDb();
      const row = db
        .prepare(
          'SELECT domain, decision, source, created_at, updated_at FROM global_site_rules WHERE domain = ?'
        )
        .get(result.domain);
      console.log(`[ui-api:sites] upsert global rule domain=${result.domain} decision=${result.decision}`);
      _broadcastSitesChanged('global_rule_upsert');
      res.status(201).json({
        domain: row ? row.domain : result.domain,
        decision: row ? row.decision : result.decision,
        source: row ? row.source : 'user',
        createdAt: row ? row.created_at : null,
        updatedAt: row ? row.updated_at : null,
      });
    } catch (e) {
      console.error('[ui-api] POST /sites failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/ui/sites/:domain
  // Only removes source='user' rows. Refuses baseline rows with a 400 and a
  // message that nudges the user toward the baseline toggle in Settings.
  app.delete('/api/ui/sites/:domain', auth, mutatingAuth, (req, res) => {
    try {
      const rawDomain = req.params.domain;
      const normalized = sitePolicy.normalizeDomain(rawDomain);
      if (!normalized) {
        return res.status(400).json({
          error: 'invalid domain',
          reason: `domain ${JSON.stringify(rawDomain)} did not normalize to a usable hostname`,
        });
      }
      const db = require('./db/connection').getDb();
      const existing = db
        .prepare('SELECT source FROM global_site_rules WHERE domain = ?')
        .get(normalized);
      if (!existing) {
        return res.status(404).json({ error: 'rule not found', domain: normalized });
      }
      if (existing.source !== 'user') {
        return res.status(400).json({
          error: 'cannot delete baseline rule',
          reason:
            "this rule comes from the baseline blocklist pack — toggle the pack off in Settings to remove all baseline rules",
          domain: normalized,
          source: existing.source,
        });
      }
      const removed = sitePolicy.removeGlobalRule(normalized);
      if (!removed) {
        return res.status(404).json({ error: 'rule not found', domain: normalized });
      }
      console.log(`[ui-api:sites] delete global rule domain=${normalized}`);
      _broadcastSitesChanged('global_rule_delete');
      res.json({ ok: true, domain: normalized });
    } catch (e) {
      console.error('[ui-api] DELETE /sites/:domain failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/ui/agents/:agentId/site-overrides
  // The :agentId param here is the api_key_hash exposed by listKeys() as
  // `key`. We resolve it to the numeric agents.id for the lookup.
  app.get('/api/ui/agents/:agentId/site-overrides', auth, (req, res) => {
    try {
      const agentId = _agentIdFromKey(req.params.agentId);
      if (!agentId) {
        return res.status(404).json({ error: 'agent not found' });
      }
      const db = require('./db/connection').getDb();
      const rows = db
        .prepare(
          'SELECT domain, decision, created_at FROM agent_site_overrides WHERE agent_id = ? ORDER BY domain ASC'
        )
        .all(agentId);
      res.json(
        rows.map((r) => ({
          domain: r.domain,
          decision: r.decision,
          createdAt: r.created_at,
        }))
      );
    } catch (e) {
      console.error('[ui-api] GET /agents/:agentId/site-overrides failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/ui/agents/:agentId/site-overrides
  // Body: { domain, decision }
  app.post('/api/ui/agents/:agentId/site-overrides', auth, mutatingAuth, express.json(), (req, res) => {
    try {
      const agentId = _agentIdFromKey(req.params.agentId);
      if (!agentId) {
        return res.status(404).json({ error: 'agent not found' });
      }
      const body = req.body || {};
      const normalized = sitePolicy.normalizeDomain(body.domain);
      if (!normalized) {
        return res.status(400).json({
          error: 'invalid domain',
          reason: `domain ${JSON.stringify(body.domain)} did not normalize to a usable hostname`,
        });
      }
      if (body.decision !== 'allow' && body.decision !== 'block') {
        return res.status(400).json({
          error: 'invalid decision',
          reason: "decision must be 'allow' or 'block'",
        });
      }
      sitePolicy.setAgentOverride(agentId, normalized, body.decision);
      const db = require('./db/connection').getDb();
      const row = db
        .prepare(
          'SELECT domain, decision, created_at FROM agent_site_overrides WHERE agent_id = ? AND domain = ?'
        )
        .get(agentId, normalized);
      console.log(
        `[ui-api:sites] upsert agent override agentId=${agentId} domain=${normalized} decision=${body.decision}`
      );
      _broadcastSitesChanged('agent_override_upsert');
      res.status(201).json({
        domain: row ? row.domain : normalized,
        decision: row ? row.decision : body.decision,
        createdAt: row ? row.created_at : null,
      });
    } catch (e) {
      console.error('[ui-api] POST /agents/:agentId/site-overrides failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/ui/agents/:agentId/site-overrides/:domain
  app.delete('/api/ui/agents/:agentId/site-overrides/:domain', auth, mutatingAuth, (req, res) => {
    try {
      const agentId = _agentIdFromKey(req.params.agentId);
      if (!agentId) {
        return res.status(404).json({ error: 'agent not found' });
      }
      const normalized = sitePolicy.normalizeDomain(req.params.domain);
      if (!normalized) {
        return res.status(400).json({
          error: 'invalid domain',
          reason: `domain ${JSON.stringify(req.params.domain)} did not normalize`,
        });
      }
      const removed = sitePolicy.removeAgentOverride(agentId, normalized);
      if (!removed) {
        return res.status(404).json({ error: 'override not found', domain: normalized });
      }
      console.log(
        `[ui-api:sites] delete agent override agentId=${agentId} domain=${normalized}`
      );
      _broadcastSitesChanged('agent_override_delete');
      res.json({ ok: true, domain: normalized });
    } catch (e) {
      console.error('[ui-api] DELETE /agents/:agentId/site-overrides/:domain failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/ui/sites/baseline/toggle
  // Body: { enabled: bool }. Updates the config table key
  // `baseline_blocklist_enabled`. Note: the auto-update interval still runs
  // in the background regardless — flipping this off means the next fetch
  // skips DB writes, but existing baseline rows remain until a fetch lands
  // (or the server is restarted). The webapp surfaces that subtlety in the
  // baseline summary card.
  app.post('/api/ui/sites/baseline/toggle', auth, mutatingAuth, express.json(), (req, res) => {
    try {
      const enabled = !!(req.body && req.body.enabled);
      const db = require('./db/connection').getDb();
      const nowIso = new Date().toISOString();
      db.prepare(
        `INSERT INTO config (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).run('baseline_blocklist_enabled', enabled ? 'true' : 'false', nowIso);
      console.log(`[ui-api:sites] baseline toggle enabled=${enabled}`);
      _broadcastSitesChanged('baseline_toggle');
      let status;
      try {
        status = blocklistUpdater.getStatus();
      } catch (_e) {
        status = { enabled, version: null, lastFetchedAt: null, domainCount: 0 };
      }
      res.json({ enabled, baseline: status });
    } catch (e) {
      console.error('[ui-api] POST /sites/baseline/toggle failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

function createServer({ port, apiKey, host: initialHost = '127.0.0.1', publicHost: initialPublicHost = 'localhost' }) {
  let host = initialHost;
  let publicHost = initialPublicHost;
  let pairingRequired = true; // default: pairing required

  // SQLite foundation (P2 — phase 1). Stand up the DB BEFORE any stateful
  // module loads, so later phases can swap their JSON reads/writes for DB
  // queries without re-ordering boot. The migration call is a Phase-1 stub
  // that only logs what it would import — see src/db/migration.js.
  try {
    console.log('[server] initializing SQLite (P2 phase 1)…');
    require('./db/connection').init();
    require('./db/migration').runImportFromJsonStores();
  } catch (e) {
    console.error('[server] SQLite init failed:', e && e.message);
    // Non-fatal for phase 1 — no module uses the DB yet. Once Phase 2 lands
    // and paired-keys depends on the DB, this should rethrow.
  }

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
      if (!isLocal && !IS_DEV_MODE) {
        console.log(`[ui-ws] rejecting non-local UI WS upgrade from ${remoteAddr}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!isLocal && IS_DEV_MODE) {
        console.log(`[ui-ws] DEV MODE — allowing non-local UI WS upgrade from ${remoteAddr}`);
      }
      uiWss.handleUpgrade(request, socket, head, (ws) => {
        uiWss.emit('connection', ws, request);
      });
      return;
    }

    // Extension WebSocket (default path). Constant-time compare against the
    // transport apiKey so a string-compare short-circuit on the first
    // differing byte cannot be measured to recover the secret.
    const clientApiKey = url.searchParams.get('apiKey');
    if (!pairedKeys.constantTimeEqual(clientApiKey, apiKey)) {
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
          // Resolution order:
          //   1) direct profileId echoed from extension storage
          //   2) installId -> profileId mapping from extension-installs store
          //      (survives extension storage being cleared)
          //   3) gaiaEmail match against Local State
          //   4) inference by exclusion
          //   5) identify_required (picker fallback)
          let resolvedProfileId = message.profileId || null;
          if (
            !resolvedProfileId &&
            typeof message.installId === 'string' &&
            message.installId.length > 0
          ) {
            try {
              const candidate = extensionInstalls.getProfileForInstall(message.installId);
              if (candidate) {
                // Validate it still corresponds to a real profile — a stale
                // mapping for a deleted profile would mis-route everything.
                const profiles = readProfiles(chromeManager.userDataDir);
                const stillExists = profiles.some((p) => p.directoryName === candidate);
                if (stillExists) {
                  resolvedProfileId = candidate;
                  console.log(
                    `[extension-bridge] resolved profileId="${resolvedProfileId}" from ` +
                      `installId="${message.installId.slice(0, 8)}..."`
                  );
                } else {
                  console.log(
                    `[extension-bridge] installId="${message.installId.slice(0, 8)}..." ` +
                      `mapped to profileId="${candidate}" but that profile no longer exists; ` +
                      `falling through`
                  );
                }
              }
            } catch (e) {
              console.log(`[extension-bridge] installId resolution failed: ${e.message}`);
            }
          }
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
            // Inference-by-exclusion: if every other known profile is either
            // already connected or has a gaiaEmail (i.e. would have resolved
            // via the gaiaEmail path), then the connecting extension must be
            // the single remaining profile without those traits.
            try {
              const profiles = readProfiles(chromeManager.userDataDir);
              const connectedProfileIds = new Set(extensionBridge.getConnectedProfiles());
              const candidates = profiles.filter(
                (p) => !connectedProfileIds.has(p.directoryName) && !p.gaiaEmail
              );
              if (candidates.length === 1) {
                resolvedProfileId = candidates[0].directoryName;
                console.log(
                  `[extension-bridge] inferred profileId="${resolvedProfileId}" by exclusion ` +
                    `(displayName="${candidates[0].displayName || ''}"; ` +
                    `${profiles.length} total profile(s), ` +
                    `${connectedProfileIds.size} already connected)`
                );
              } else if (candidates.length === 0) {
                console.log(
                  `[extension-bridge] inference-by-exclusion found 0 candidates ` +
                    `(${profiles.length} total profile(s), ` +
                    `${connectedProfileIds.size} already connected) — unexpected state, ` +
                    `falling through to identify_required`
                );
              } else {
                console.log(
                  `[extension-bridge] inference-by-exclusion found ${candidates.length} candidates ` +
                    `(${candidates.map((c) => c.directoryName).join(', ')}) — ambiguous, ` +
                    `falling through to identify_required`
                );
              }
            } catch (e) {
              console.log(`[extension-bridge] inference-by-exclusion failed: ${e.message}`);
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
          // Persist the installId -> profileId mapping regardless of which
          // resolution path got us here. This is the moment the server
          // "learns" the binding for this install; future connects can use
          // the installId path even if extension storage gets wiped.
          if (typeof message.installId === 'string' && message.installId.length > 0) {
            try {
              extensionInstalls.setProfileForInstall(message.installId, resolvedProfileId);
            } catch (e) {
              console.log(`[extension-bridge] persist installId mapping failed: ${e.message}`);
            }
          }
          extensionBridge.setConnection(resolvedProfileId, ws);
          console.log(
            `[extension-bridge] hello accepted profileId="${resolvedProfileId}"`
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
          // DEPRECATED: this in-process rebind path was replaced by the
          // POST /api/ui/settings/network-mode REST endpoint which uses a
          // spawn-then-exit restart. Keeping the WS handler alive would race
          // with that flow. The WebPilot extension no longer sends this
          // message — log and ignore so any stragglers are visible.
          console.log(
            '[network] received deprecated set_network_mode WS message — ignored; ' +
              'use POST /api/ui/settings/network-mode'
          );
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

  // Bridge formatter-logs `changed` events to the UI WebSocket so the
  // dashboard's Action Items list updates in realtime when an error is
  // recorded or a user dismisses a formatter. See P1 #1; formatter-logs.js
  // exports `events` (an EventEmitter) for this purpose — chose EventEmitter
  // over a constructor-time callback because it lets the module stay
  // stateless w.r.t. its subscribers.
  try {
    formatterLogs.events.on('changed', (payload) => {
      try {
        broadcastUiEvent({
          type: 'formatter_status_changed',
          name: payload && payload.name,
          health: payload && payload.status && payload.status.health,
          lastError: payload && payload.status && payload.status.lastError,
        });
      } catch (e) {
        console.log(`[ui-ws] formatter_status_changed broadcast failed: ${e.message}`);
      }
    });
  } catch (e) {
    console.log(`[ui-ws] failed to attach formatter-logs listener: ${e.message}`);
  }

  // Eagerly load notification preferences so the in-memory cache is warm
  // before the first pairing request notification fires.
  try {
    const s = notificationsSettings.loadSettings();
    console.log(
      `[notifications-settings] startup load systemNotifications=${s.systemNotifications} sound=${s.sound}`
    );
  } catch (e) {
    console.log(`[notifications-settings] startup load failed: ${e.message}`);
  }

  formatterUpdater.init(formatterManager);
  formatterUpdater.checkForUpdates().catch(err => console.error('[server] Formatter update check failed:', err));
  setInterval(
    () => formatterUpdater.checkForUpdates().catch(err => console.error('[server] Periodic formatter update check failed:', err)),
    3600000
  );

  // Baseline-blocklist auto-updater (P2 phase 4). Fetches the curated
  // financial-institutions list from the WebPilot repo, replaces every
  // `source='baseline'` row in `global_site_rules` if the manifest version
  // bumped. User-set rules are never touched. Boot fetch is delayed a few
  // seconds so a slow/unreachable GitHub doesn't drag out cold-start; daily
  // interval runs the same check.
  blocklistUpdater.init({});
  setTimeout(
    () => blocklistUpdater.checkForUpdates()
      .catch(err => console.error('[server] Boot baseline blocklist check failed:', err)),
    5000
  ).unref();
  setInterval(
    () => blocklistUpdater.checkForUpdates()
      .catch(err => console.error('[server] Periodic baseline blocklist check failed:', err)),
    24 * 60 * 60 * 1000
  ).unref();

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

  // Terminal-state pruning: drop denied / expired pairings older than 7 days.
  // Complements cleanupExpiredPairings (which only hard-drops by createdAt
  // age, not by decision-time). Runs once at startup and then daily.
  try {
    const oldInitial = pairedKeys.cleanupOldPairings();
    if (oldInitial.removed > 0) {
      console.log(
        `[pairing:cleanupOldPairings] startup pass: removed=${oldInitial.removed} kept=${oldInitial.kept}`
      );
    }
  } catch (e) {
    console.log(`[pairing:cleanupOldPairings] startup pass failed: ${e.message}`);
  }

  // Unused-keys housekeeping: revoke paired-keys entries that were minted
  // (typically by the pair-agent modal Copy click) but never used for a
  // single tool call within 48h. Runs at startup and hourly. If anything
  // is revoked, fire `agents_changed` so the web UI refreshes.
  try {
    const revokedAtStartup = pairedKeys.cleanupUnusedKeys();
    if (revokedAtStartup > 0) {
      console.log(
        `[paired-keys:cleanup] startup pass: revoked ${revokedAtStartup} unused key(s)`
      );
      broadcastUiEvent({ type: 'agents_changed', agents: pairedKeys.listKeys() });
    }
  } catch (e) {
    console.log(`[paired-keys:cleanup] startup pass failed: ${e.message}`);
  }

  // Extension-installs housekeeping: drop install->profile mappings whose
  // `lastResolved` is older than 90 days so the file doesn't grow unbounded.
  try {
    extensionInstalls.cleanupStaleInstalls(90);
  } catch (e) {
    console.log(`[extension-installs:cleanup] startup pass failed: ${e.message}`);
  }
  const hourlyCleanupInterval = setInterval(() => {
    try {
      pairedKeys.cleanupExpiredPairings();
    } catch (e) {
      console.log(`[pairing:cleanup] hourly pass failed: ${e.message}`);
    }
    try {
      const revoked = pairedKeys.cleanupUnusedKeys();
      if (revoked > 0) {
        console.log(
          `[paired-keys:cleanup] hourly pass: revoked ${revoked} unused key(s)`
        );
        broadcastUiEvent({ type: 'agents_changed', agents: pairedKeys.listKeys() });
      }
    } catch (e) {
      console.log(`[paired-keys:cleanup] hourly pass failed: ${e.message}`);
    }
  }, 3600 * 1000);

  // Daily terminal-state prune. Hourly is overkill for entries that are at
  // least 7 days old; once a day is enough. Stored so shutdown can clearInterval.
  const dailyOldPairingsInterval = setInterval(() => {
    try {
      const r = pairedKeys.cleanupOldPairings();
      if (r.removed > 0) {
        console.log(
          `[pairing:cleanupOldPairings] daily pass: removed=${r.removed} kept=${r.kept}`
        );
      }
    } catch (e) {
      console.log(`[pairing:cleanupOldPairings] daily pass failed: ${e.message}`);
    }
  }, 24 * 60 * 60 * 1000);

  // Dismissed-incident pruning (P2 phase 3). Drop rows where
  // dismissed_at < now() - 90d so the audit table doesn't grow without
  // bound. Mirrors the cleanupOldPairings cadence: one boot pass + a daily
  // setInterval. Undismissed rows are NEVER pruned.
  try {
    formatterLogs.cleanupDismissedIncidents();
  } catch (e) {
    console.log(`[formatter-logs:cleanup] startup pass failed: ${e.message}`);
  }
  const dailyFormatterIncidentsInterval = setInterval(() => {
    try {
      formatterLogs.cleanupDismissedIncidents();
    } catch (e) {
      console.log(`[formatter-logs:cleanup] daily pass failed: ${e.message}`);
    }
  }, 24 * 60 * 60 * 1000);
  // Don't keep the event loop alive just for this housekeeping timer.
  if (dailyFormatterIncidentsInterval.unref) dailyFormatterIncidentsInterval.unref();

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

  // --- Extension popup state route ---
  //
  // P2 phase 6. The minimal popup hits these two endpoints to render its
  // four-component layout (connection dot, current-tab state, Block/Allow
  // toggle, dashboard link). Auth uses the paired API key the extension
  // already holds in chrome.storage; no separate token. Kept in a
  // visually-distinct block so the parallel Sites-admin webapp routes
  // (mounted inside mountWebUiRoutes above) do not collide here.
  {
    const sitePolicyPopup = require('./site-policy');

    // Extract an API key from the request and resolve it to either a paired
    // agent OR the server-wide transport key. Supports X-API-Key header
    // (preferred) or `apiKey` query param.
    //
    // Two valid auth shapes:
    //   1. PAIRED-AGENT key — `entry` and `agentId` are populated; popup
    //      shows per-agent overrides + the agent name.
    //   2. SERVER TRANSPORT key — `entry: null`, `agentId: null`; popup is
    //      authenticated for read-only state but has no agent context.
    //      Lets the popup work on profiles where no agent has paired yet
    //      (e.g. a fresh Chrome profile that's only running auto-connect).
    //      The extension always has the transport key in chrome.storage
    //      via /connect, even before any agent pairs.
    //
    // Returns the resolved shape or null on auth failure.
    function _authPopup(req) {
      const key =
        req.headers['x-api-key'] ||
        req.headers['X-API-Key'] ||
        (req.query && req.query.apiKey) ||
        null;
      if (!key || typeof key !== 'string') return null;
      // Try paired-agent first — most callers will be on a paired profile.
      const entry = pairedKeys.validateKey(key);
      if (entry) {
        const agentId = sitePolicyPopup.resolveAgentIdFromApiKey(key);
        return { key, entry, agentId };
      }
      // Fall back to the server transport key. Constant-time compare against
      // the legacy server-wide apiKey so a profile without a paired agent
      // still gets a functional popup (connection status, global site
      // policy view, dashboard link).
      if (pairedKeys.constantTimeEqual(key, apiKey)) {
        return { key, entry: null, agentId: null };
      }
      return null;
    }

    // Map (decision, source) into a single state-pill key consumed by the
    // popup UI: 'allowed' | 'blocked_baseline' | 'blocked_user'
    // | 'allowed_override' | 'blocked_override'.
    function _statePillFromPolicy(policy) {
      if (policy.source === 'agent_override') {
        return policy.decision === 'allow' ? 'allowed_override' : 'blocked_override';
      }
      if (policy.decision === 'allow') return 'allowed';
      if (policy.source === 'baseline') return 'blocked_baseline';
      return 'blocked_user';
    }

    // GET /api/popup/state?tabUrl=<url>
    // Returns connection + agent + current-tab policy state + dashboard URL.
    app.get('/api/popup/state', (req, res) => {
      const auth = _authPopup(req);
      if (!auth) return res.status(401).json({ error: 'unauthorized' });
      const { entry, agentId } = auth;
      // entry may be null when we authenticated via the server transport key
      // (no paired agent for this profile). In that case profileId is unknown
      // to the server — best-effort: any connected profile counts as 'connected'
      // for the indicator (the extension is connected via WS regardless of
      // which profile if it has the transport key working).
      const profileId = entry ? (entry.profileId || null) : null;
      const connection = entry
        ? (profileId && extensionBridge.isConnected(profileId) ? 'connected' : 'disconnected')
        : (extensionBridge.getConnectedProfiles().length > 0 ? 'connected' : 'disconnected');

      const tabUrlRaw = (req.query && req.query.tabUrl) || null;
      let currentTab = null;
      if (typeof tabUrlRaw === 'string' && tabUrlRaw.length > 0) {
        const domain = sitePolicyPopup.normalizeDomain(tabUrlRaw);
        if (domain) {
          const policy = sitePolicyPopup.isAllowed(agentId, tabUrlRaw);
          currentTab = {
            url: tabUrlRaw,
            domain,
            state: _statePillFromPolicy(policy),
            source: policy.source,
            decision: policy.decision,
          };
        }
      }

      const proto = (req.headers && req.headers['x-forwarded-proto']) || 'http';
      const hostHdr = (req.headers && req.headers.host) || `localhost:${port}`;
      const serverUrl = `${proto}://${hostHdr}`;

      const body = {
        connection,
        profileId,
        agent: agentId && entry ? { id: agentId, name: entry.agentName } : null,
        serverUrl,
      };
      if (currentTab) body.currentTab = currentTab;
      return res.json(body);
    });

    // POST /api/popup/site-toggle  { domain, action: 'block' | 'allow' }
    // Sets a GLOBAL user rule for the domain (per the locked design decision —
    // the popup's toggle is the "no AI touches this site" fast button; per-
    // agent overrides live on the webapp Sites page).
    app.post('/api/popup/site-toggle', express.json(), (req, res) => {
      const auth = _authPopup(req);
      if (!auth) return res.status(401).json({ error: 'unauthorized' });
      const { agentId } = auth;
      const body = req.body || {};
      const action = body.action;
      const domainRaw = body.domain;
      if (action !== 'block' && action !== 'allow') {
        return res.status(400).json({ error: "action must be 'block' or 'allow'" });
      }
      const normalized = sitePolicyPopup.normalizeDomain(domainRaw);
      if (!normalized) {
        return res.status(400).json({ error: 'invalid domain' });
      }
      try {
        sitePolicyPopup.setGlobalRule(normalized, action, 'user');
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      // Compute new pill state for this agent + domain (a per-agent override
      // could still win — same shape as /state above).
      const policy = sitePolicyPopup.isAllowed(agentId, normalized);
      const newState = _statePillFromPolicy(policy);
      // Tell the webapp Sites page (and any other UI consumer) the rule list
      // changed. Same event name Phase 5's Sites admin routes emit.
      try {
        broadcastUiEvent({ type: 'sites_changed', reason: 'popup_toggle' });
      } catch (_e) { /* non-fatal */ }
      return res.json({ ok: true, domain: normalized, decision: action, newState });
    });
  }
  // --- end Extension popup state route ---

  // ---- Web UI static mount + REST ----
  mountWebUiStatic(app);
  mountWebUiRoutes(app, {
    // NOTE: apiKey intentionally omitted — web UI is localhost-only (no key).
    chromeManager,
    extensionBridge,
    pairedKeys,
    server,
    port,
    broadcastUiEvent,
    setNetworkMode: ({ enabled }) => {
      // Persist + restart-spawn approach (Section 4.6).
      // P2 phase 7: write to the DB (`config.network_enabled`) instead of the
      // legacy flag file. The replacement daemon boots and reads the DB row
      // in index.js, so the new binding takes effect across the restart.
      try {
        const nowIso = new Date().toISOString();
        require('./db/connection').getDb().prepare(
          `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        ).run('network_enabled', enabled ? 'true' : 'false', nowIso);
      } catch (e) {
        console.error('[network] Failed to persist network_enabled to DB:', e.message);
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

  // Clear maintenance intervals during graceful shutdown so they don't keep
  // the event loop alive past server.close().
  function clearMaintenanceIntervals() {
    try { clearInterval(hourlyCleanupInterval); } catch (_e) { /* ignore */ }
    try { clearInterval(dailyOldPairingsInterval); } catch (_e) { /* ignore */ }
  }

  // Clean up PID/port files on shutdown
  process.on('SIGTERM', () => {
    clearMaintenanceIntervals();
    cleanupPidAndPortFiles();
    server.close(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    clearMaintenanceIntervals();
    cleanupPidAndPortFiles();
    server.close(() => process.exit(0));
  });
  process.on('exit', () => {
    clearMaintenanceIntervals();
    cleanupPidAndPortFiles();
  });

  return { app, server, wss: extensionWss, uiWss, chromeManager, extensionBridge, broadcastUiEvent };
}

module.exports = { createServer };
