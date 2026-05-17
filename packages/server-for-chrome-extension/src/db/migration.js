'use strict';

/**
 * First-boot JSON-store import (P2 — phase 1 STUB).
 *
 * On the first boot after upgrading to the SQLite version, the server walks
 * the legacy JSON stores under `<dataDir>` and imports them into the new
 * DB tables. After a successful per-file import, the source is renamed to
 * `<name>.json.imported.<ISO-timestamp>` so we never re-import on the next
 * boot and the user keeps a recovery copy.
 *
 * Phase 1 (THIS FILE) only stands up the contract:
 *   - Detects which legacy stores exist.
 *   - Logs "would import N rows" for each.
 *   - Returns the detection summary so server.js can log it.
 *
 * Phase 2 fills in the agents/pairings branch.
 * Phase 3 fills in the formatter_incidents branch.
 * Phase 4 fills in config (`network.enabled`, server.json migrations).
 *
 * Each branch below already has the right file-existence guard and a TODO
 * marker — later phases just drop their import logic into the marked spot
 * and add a rename-to-`.imported` after a successful insert.
 */

const path = require('node:path');
const fs = require('node:fs');

const { getDataDir } = require('../service/paths');

/**
 * Best-effort row count for a JSON file. Used only for the log line; if
 * parsing fails we just log unknown and keep moving.
 */
function safeCountRows(filePath, shape) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (shape === 'array') {
      return Array.isArray(parsed) ? parsed.length : 0;
    }
    if (shape === 'object-map') {
      return parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0;
    }
    if (shape === 'object-keys') {
      // For things like extension-installs.json: a top-level object whose
      // keys are install ids.
      return parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Detect each legacy JSON store under `<dataDir>`. Returns the list of
 * detected files plus a count for each. Pure read; no DB writes.
 *
 * Returns:
 * [
 *   { kind: 'paired-keys',       path, exists, rows },
 *   { kind: 'pending-pairings',  path, exists, rows },
 *   { kind: 'formatter-logs',    path, exists, rows },
 *   { kind: 'extension-installs',path, exists, rows },
 *   { kind: 'server-config',     path, exists, rows },
 *   { kind: 'network-enabled',   path, exists, rows },
 * ]
 */
function detectLegacyStores() {
  const dataDir = getDataDir();
  const candidates = [
    { kind: 'paired-keys',        rel: path.join('config', 'paired-keys.json'),        shape: 'array' },
    { kind: 'pending-pairings',   rel: path.join('config', 'pending-pairings.json'),   shape: 'array' },
    { kind: 'formatter-logs',     rel: 'formatter-logs.json',                          shape: 'object-map' },
    { kind: 'extension-installs', rel: path.join('config', 'extension-installs.json'), shape: 'object-keys' },
    { kind: 'server-config',      rel: path.join('config', 'server.json'),             shape: 'object-map' },
    // network.enabled is a flag file, not JSON. Row count is 0 or 1.
    { kind: 'network-enabled',    rel: 'network.enabled',                              shape: 'flag' },
  ];

  return candidates.map((c) => {
    const fullPath = path.join(dataDir, c.rel);
    let exists = false;
    try { exists = fs.existsSync(fullPath); } catch (_e) { exists = false; }
    let rows = null;
    if (exists) {
      rows = c.shape === 'flag' ? 1 : safeCountRows(fullPath, c.shape);
    }
    return { kind: c.kind, path: fullPath, exists, rows };
  });
}

/**
 * STUB: walk the legacy JSON stores and (eventually) import them into the DB.
 *
 * Phase 1 only logs what it would do. Returns { detected, imported: 0 }.
 *
 * @returns {{ detected: Array<{kind:string,path:string,exists:boolean,rows:number|null}>, imported: number }}
 */
function runImportFromJsonStores() {
  const dataDir = getDataDir();
  console.log(`[migration] checking for legacy JSON stores under ${dataDir}...`);

  const detected = detectLegacyStores();
  const present = detected.filter((d) => d.exists);

  if (present.length === 0) {
    console.log('[migration] no legacy JSON stores detected — nothing to import.');
    return { detected, imported: 0 };
  }

  for (const entry of present) {
    const rowsLabel = entry.rows == null ? 'unknown' : String(entry.rows);
    console.log(`[migration] detected ${entry.kind} at ${entry.path} — would import ${rowsLabel} rows`);

    switch (entry.kind) {
      case 'paired-keys':
        // TODO (phase 2): parse paired-keys.json, hash each `key` field
        // (argon2id/scrypt), upsert into `agents` with state='active'. After
        // success, rename source file to `<name>.imported.<ISO>`.
        break;

      case 'pending-pairings':
        // TODO (phase 2): parse pending-pairings.json and insert each entry
        // into `pairings` preserving state ('pending'/'approved'/'denied'/
        // 'expired') and timestamps. Map approved entries to the matching
        // agent row via approved_agent_id.
        break;

      case 'formatter-logs':
        // TODO (phase 3): parse formatter-logs.json (object keyed by
        // formatter name, each value carrying a `lastError` + history). For
        // each historical entry, insert a `formatter_incidents` row.
        break;

      case 'extension-installs':
        // TODO (phase 3 or 7): parse extension-installs.json and upsert into
        // `extension_installs`.
        break;

      case 'server-config':
        // TODO (phase 4 or 7): translate config/server.json fields into rows
        // in the `config` KV table (port, apiKey, managedProfile, etc.).
        break;

      case 'network-enabled':
        // TODO (phase 4 or 7): read the `network.enabled` flag file ('0' or
        // '1') and upsert it as a single row in `config`
        // (key='network_enabled', value='true'/'false').
        break;

      default:
        // Unknown — leave it alone.
        break;
    }
  }

  console.log(`[migration] phase-1 stub complete — detected=${present.length}, imported=0 (Phases 2/3/4 will fill in)`);
  return { detected, imported: 0 };
}

module.exports = {
  detectLegacyStores,
  runImportFromJsonStores,
};
