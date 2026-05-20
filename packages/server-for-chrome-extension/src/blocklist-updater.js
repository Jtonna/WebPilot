'use strict';

/**
 * Baseline blocklist auto-updater (P2 — phase 4).
 *
 * Mirrors `formatter-updater.js`. Fetches a small JSON manifest from this
 * repo's `baseline-blocklists/` directory via GitHub raw, compares its
 * `version` against the row in `baseline_blocklist_meta`, and, if newer,
 * fetches each referenced hosts.txt-style list and replaces every
 * `global_site_rules` row with `source='baseline'` in a single transaction.
 * User-set rows (`source='user'`) are never touched.
 *
 * Resilience tier (per the user's request, smoke-test 2026-05-17):
 *   - Try remote fetch first.
 *   - On success, write the parsed content to a LOCAL CACHE under
 *     `<dataDir>/baseline-blocklists/` (manifest.json + each list file).
 *   - On remote failure (network down, GitHub 404 because the branch
 *     hasn't merged to main, etc.), READ FROM THE LOCAL CACHE and proceed.
 *   - If neither remote nor local cache is available, write an empty
 *     placeholder manifest so subsequent boots see a predictable state
 *     (instead of repeatedly thrashing the network on every restart). The
 *     baseline_blocklist_meta row is updated to reflect the empty state.
 *
 * Hosts.txt parse rules:
 *   - Lines beginning with `#` (after trim) are comments — skip.
 *   - Blank lines — skip.
 *   - Otherwise, split on whitespace; the LAST non-empty token on the line
 *     is the domain (so `0.0.0.0 chase.com` → `chase.com`).
 *   - Lowercase + run through `normalizeDomain()` so we drop www. and reject
 *     ip-literals.
 *
 * The user can disable the baseline pack entirely via the
 * `config.baseline_blocklist_enabled` key — when `false`, the fetch still
 * happens (so we can show "next update would have added/removed N rows" in
 * the UI later if we want), but no DB writes occur.
 */

const fs = require('fs');
const path = require('path');

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/Jtonna/WebPilot/main/baseline-blocklists';

let _options = {
  baselineBlocklistEnabledKey: 'baseline_blocklist_enabled',
  baseUrl: GITHUB_RAW_BASE,
};

function init(options = {}) {
  if (options.baselineBlocklistEnabledKey) {
    _options.baselineBlocklistEnabledKey = options.baselineBlocklistEnabledKey;
  }
  if (options.baseUrl) {
    _options.baseUrl = options.baseUrl;
  }
}

function _getDb() {
  // Lazy-require so tests can mock the connection module.
  return require('./db/connection').getDb();
}

function _isBaselineEnabled() {
  try {
    const db = _getDb();
    const row = db
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(_options.baselineBlocklistEnabledKey);
    if (!row || typeof row.value !== 'string') return true; // default ON
    return row.value !== 'false' && row.value !== '0';
  } catch (e) {
    console.log(`[blocklist-updater] _isBaselineEnabled lookup failed: ${e.message}`);
    return true;
  }
}

function _readMetaVersion() {
  try {
    const db = _getDb();
    const row = db.prepare('SELECT version FROM baseline_blocklist_meta WHERE id = 1').get();
    return row && row.version ? String(row.version) : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve the on-disk cache directory used as the fallback when the remote
 * fetch fails. Mirrors the shape of the remote source — a `manifest.json`
 * plus each referenced list file alongside it.
 *
 * Path: `<dataDir>/baseline-blocklists/`. Lazy-required to dodge a top-level
 * dep on `service/paths` (tests stub the module).
 */
function _getLocalCacheDir() {
  const { getDataDir } = require('./service/paths');
  return path.join(getDataDir(), 'baseline-blocklists');
}

function _ensureCacheDir() {
  const dir = _getLocalCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist the just-fetched manifest + list-file bodies to the local cache.
 * Best-effort — a write failure is logged but does not abort the update.
 */
function _writeLocalCache(manifestText, listBodiesByFile) {
  try {
    const dir = _ensureCacheDir();
    fs.writeFileSync(path.join(dir, 'manifest.json'), manifestText, 'utf8');
    for (const [file, body] of Object.entries(listBodiesByFile || {})) {
      // file can contain a `subdir/name.txt`-style path; mkdir the parent.
      const dest = path.join(dir, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body, 'utf8');
    }
  } catch (err) {
    console.warn(`[blocklist-updater] local cache write failed: ${err.message}`);
  }
}

/**
 * Read the local cache, if present. Returns `{manifestText, listBodiesByFile}`
 * or `null` if the cache is empty / missing / unreadable.
 */
function _readLocalCache() {
  try {
    const dir = _getLocalCacheDir();
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const manifestText = fs.readFileSync(manifestPath, 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (e) {
      console.warn(`[blocklist-updater] local cache manifest is unparseable: ${e.message}`);
      return null;
    }
    const lists = Array.isArray(manifest.lists) ? manifest.lists : [];
    const listBodiesByFile = {};
    for (const list of lists) {
      if (!list || typeof list.file !== 'string') continue;
      const filePath = path.join(dir, list.file);
      if (!fs.existsSync(filePath)) {
        console.warn(`[blocklist-updater] local cache missing list file: ${list.file}`);
        continue;
      }
      listBodiesByFile[list.file] = fs.readFileSync(filePath, 'utf8');
    }
    return { manifestText, listBodiesByFile };
  } catch (err) {
    console.warn(`[blocklist-updater] local cache read failed: ${err.message}`);
    return null;
  }
}

/**
 * Write a deliberate empty placeholder when both remote and local cache are
 * unavailable. Keeps boot behavior predictable across restarts (we know the
 * cache exists; subsequent boots don't retry-thrash if the network's down).
 */
function _writeEmptyPlaceholder() {
  try {
    const dir = _ensureCacheDir();
    const empty = {
      version: '0',
      lists: [],
      _note:
        'Empty placeholder written because both remote fetch and local cache were unavailable. ' +
        'Will be overwritten on the next successful remote fetch.',
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(empty, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[blocklist-updater] empty-placeholder write failed: ${err.message}`);
  }
}

/**
 * Fetch helper with timeout. Returns the response body as text or throws.
 */
async function _fetchText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return await res.text();
  } catch (err) {
    clearTimeout(t);
    if (err && err.name === 'AbortError') {
      throw new Error(`Timeout fetching ${url}`);
    }
    throw err;
  }
}

/**
 * Parse a hosts.txt-style file into an array of normalized domains.
 * Duplicates are de-duped; invalid lines are skipped silently.
 */
function _parseHostsFile(text) {
  // Lazy-require — site-policy pulls in psl, which we want to avoid loading
  // for any consumer that just wants the updater module surface.
  const { normalizeDomain } = require('./site-policy');
  const out = new Set();
  if (typeof text !== 'string') return [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    // Take the last whitespace-separated token. This handles both bare
    // `chase.com` and `0.0.0.0 chase.com` (and any `127.0.0.1 chase.com`).
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const candidate = parts[parts.length - 1];
    const normalized = normalizeDomain(candidate);
    if (normalized) out.add(normalized);
  }
  return Array.from(out);
}

/**
 * Run a single update cycle. Idempotent and safe to call repeatedly:
 *
 *   1. Fetch manifest.json from baseUrl.
 *   2. Compare manifest.version to baseline_blocklist_meta.version (if any).
 *   3. If different (or no meta row), fetch each list, parse, and within a
 *      single transaction: delete all `source='baseline'` rows, insert the
 *      new ones, upsert the meta row.
 *
 * Returns one of:
 *   { updated: true,  fromVersion, toVersion, domainCount }
 *   { updated: false, currentVersion }            (already up-to-date)
 *   { updated: false, skipped: 'disabled' }       (baseline pack disabled)
 *   { updated: false, error: <message> }          (network / parse failure)
 */
async function checkForUpdates() {
  const baseUrl = _options.baseUrl;
  console.log(`[blocklist-updater] checking ${baseUrl}/manifest.json`);

  // Resolution chain: try remote first, fall back to local cache, fall back
  // to an empty placeholder. Track where the data ultimately came from so we
  // can log + record it on baseline_blocklist_meta.source_url.
  let manifest = null;
  let manifestText = null;
  let listBodiesByFile = {};
  let sourceLabel = baseUrl;   // 'github' fetch URL by default
  let fromCache = false;
  let fromEmpty = false;

  // --- Step 1: try remote fetch ---
  try {
    manifestText = await _fetchText(`${baseUrl}/manifest.json`);
    manifest = JSON.parse(manifestText);
  } catch (err) {
    console.warn(
      `[blocklist-updater] remote manifest fetch failed (${err.message}) — falling back to local cache`
    );
    manifest = null;
    manifestText = null;
  }

  // If remote manifest came back, fetch each list file too.
  if (manifest) {
    const lists = Array.isArray(manifest.lists) ? manifest.lists : [];
    let allListsOk = true;
    for (const list of lists) {
      if (!list || typeof list.file !== 'string') continue;
      try {
        listBodiesByFile[list.file] = await _fetchText(`${baseUrl}/${list.file}`);
      } catch (err) {
        console.warn(
          `[blocklist-updater] remote fetch failed for list "${list.file}" (${err.message}) — falling back to local cache`
        );
        allListsOk = false;
        break;
      }
    }
    if (!allListsOk) {
      manifest = null;
      manifestText = null;
      listBodiesByFile = {};
    } else {
      // Remote fetch fully successful — persist to the local cache for next time.
      _writeLocalCache(manifestText, listBodiesByFile);
    }
  }

  // --- Step 2: fall back to local cache ---
  if (!manifest) {
    const cached = _readLocalCache();
    if (cached) {
      try {
        manifest = JSON.parse(cached.manifestText);
        manifestText = cached.manifestText;
        listBodiesByFile = cached.listBodiesByFile;
        fromCache = true;
        sourceLabel = `cache:${_getLocalCacheDir()}`;
        console.log(`[blocklist-updater] using local cache (manifest version=${manifest.version})`);
      } catch (e) {
        console.warn(`[blocklist-updater] local cache manifest parse failed: ${e.message}`);
        manifest = null;
      }
    }
  }

  // --- Step 3: empty placeholder ---
  if (!manifest) {
    console.warn(
      '[blocklist-updater] neither remote nor local cache available — writing empty placeholder'
    );
    _writeEmptyPlaceholder();
    fromEmpty = true;
    sourceLabel = 'empty';
    manifest = { version: '0', lists: [] };
    manifestText = null;
    listBodiesByFile = {};
  }

  const remoteVersion = manifest && manifest.version ? String(manifest.version) : null;
  if (!remoteVersion) {
    const msg = 'Manifest missing required "version" field (from ' + sourceLabel + ')';
    console.error(`[blocklist-updater] ${msg}`);
    return { updated: false, error: msg };
  }

  const localVersion = _readMetaVersion();
  // If we're using the cache or empty, AND the version matches what's already
  // in the DB, treat as no-op. (For remote fetches that fail and we fall
  // back to cache, we DO want to re-apply on first boot — but the version
  // check naturally short-circuits subsequent boots.)
  if (localVersion === remoteVersion) {
    console.log(
      `[blocklist-updater] already up to date (version=${localVersion}, source=${sourceLabel})`
    );
    return { updated: false, currentVersion: localVersion, source: sourceLabel };
  }

  // Parse all list files (from whichever source they came from) into the
  // unified domain set.
  const lists = Array.isArray(manifest.lists) ? manifest.lists : [];
  if (lists.length === 0 && !fromEmpty) {
    console.warn('[blocklist-updater] manifest has no "lists" entries');
  }
  const allDomains = new Set();
  for (const list of lists) {
    if (!list || typeof list.file !== 'string') continue;
    const text = listBodiesByFile[list.file];
    if (typeof text !== 'string') {
      console.warn(`[blocklist-updater] list "${list.file}" body missing — skipping`);
      continue;
    }
    const domains = _parseHostsFile(text);
    console.log(
      `[blocklist-updater] parsed ${domains.length} domains from "${list.file}" ` +
        `(${list.name || 'unnamed'}, source=${sourceLabel})`
    );
    for (const d of domains) allDomains.add(d);
  }

  const domainList = Array.from(allDomains);
  console.log(
    `[blocklist-updater] total baseline domains in remote v${remoteVersion}: ${domainList.length}`
  );

  if (!_isBaselineEnabled()) {
    console.log(
      `[blocklist-updater] baseline pack disabled via config — fetched ${domainList.length} domains but NOT writing to DB`
    );
    return { updated: false, skipped: 'disabled', remoteVersion, domainCount: domainList.length };
  }

  // Atomic swap: delete every source='baseline' row, insert the new set,
  // upsert the meta row. Wrap in a transaction so any failure rolls back.
  let writeResult;
  try {
    const db = _getDb();
    const nowIso = new Date().toISOString();
    const deleteStmt = db.prepare(
      "DELETE FROM global_site_rules WHERE source = 'baseline'"
    );
    // INSERT OR IGNORE: if a user-set row already exists for the same
    // domain, leave it alone. The preceding DELETE has already cleared
    // every prior baseline row, so collisions only happen against
    // source='user' rules and the user always wins.
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO global_site_rules
         (domain, decision, source, created_at, updated_at)
       VALUES (?, 'block', 'baseline', ?, ?)`
    );
    const upsertMetaStmt = db.prepare(
      `INSERT INTO baseline_blocklist_meta (id, version, last_fetched_at, source_url, domain_count)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version=excluded.version,
         last_fetched_at=excluded.last_fetched_at,
         source_url=excluded.source_url,
         domain_count=excluded.domain_count`
    );

    const txn = db.transaction((domains) => {
      const deleted = deleteStmt.run().changes;
      let inserted = 0;
      for (const d of domains) {
        // The ON CONFLICT … WHERE source='baseline' clause means user rows
        // for the same domain are preserved (run() reports 0 changes for
        // those). We don't want to ever clobber a user rule with a
        // baseline rule.
        const res = insertStmt.run(d, nowIso, nowIso);
        if (res.changes > 0) inserted += 1;
      }
      upsertMetaStmt.run(remoteVersion, nowIso, sourceLabel, domains.length);
      return { deleted, inserted };
    });

    writeResult = txn(domainList);
  } catch (err) {
    console.error(`[blocklist-updater] DB write failed: ${err.message}`);
    return { updated: false, error: err.message };
  }

  console.log(
    `[blocklist-updater] updated baseline ${localVersion || '(none)'} → ${remoteVersion} ` +
      `(deleted=${writeResult.deleted}, inserted=${writeResult.inserted}, total=${domainList.length})`
  );
  return {
    updated: true,
    fromVersion: localVersion,
    toVersion: remoteVersion,
    domainCount: domainList.length,
    source: sourceLabel,
    fromCache,
    fromEmpty,
  };
}

/**
 * Read the meta row plus the live count of source='baseline' rows. Used by
 * /api/ui/status to render a small summary on the dashboard.
 */
function getStatus() {
  let enabled = true;
  let version = null;
  let lastFetchedAt = null;
  let domainCount = 0;
  try {
    const db = _getDb();
    enabled = _isBaselineEnabled();
    const meta = db
      .prepare('SELECT * FROM baseline_blocklist_meta WHERE id = 1')
      .get();
    if (meta) {
      version = String(meta.version || '');
      lastFetchedAt = meta.last_fetched_at || null;
    }
    const cnt = db
      .prepare("SELECT COUNT(*) AS c FROM global_site_rules WHERE source = 'baseline'")
      .get();
    domainCount = cnt ? cnt.c : 0;
  } catch (e) {
    console.log(`[blocklist-updater] getStatus failed: ${e.message}`);
  }
  return { enabled, version, lastFetchedAt, domainCount };
}

module.exports = {
  init,
  checkForUpdates,
  getStatus,
  // exposed for tests
  _parseHostsFile,
};
