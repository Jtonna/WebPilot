'use strict';

/**
 * First-boot JSON-store import.
 *
 * On the first boot after upgrading to the SQLite version, the server walks
 * the legacy JSON stores under `<dataDir>` and imports them into the new
 * DB tables. After a successful per-file import, the source is renamed to
 * `<name>.json.imported.<ISO-timestamp>` so we never re-import on the next
 * boot and the user keeps a recovery copy.
 *
 * Phase coverage:
 *   - Phase 2: paired-keys.json → `agents`; pending-pairings.json → `pairings`.
 *   - Phase 3 (THIS COMMIT): formatter-logs.json → `formatter_incidents`.
 *   - Phase 4 (later): server.json / network.enabled / extension-installs.json → `config`.
 *
 * Idempotency: each branch checks whether its destination table is already
 * populated and skips the import if so, unless `--reimport` was passed on the
 * CLI (`process.env.WEBPILOT_REIMPORT === '1'` or `process.argv` contains
 * `--reimport`). The rename-to-`.imported` step happens AFTER the DB writes
 * succeed, so a partial failure leaves the originals on disk for retry.
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
      return parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Detect each legacy JSON store under `<dataDir>`. Pure read; no DB writes.
 */
function detectLegacyStores() {
  const dataDir = getDataDir();
  const candidates = [
    { kind: 'paired-keys',        rel: path.join('config', 'paired-keys.json'),        shape: 'array' },
    { kind: 'pending-pairings',   rel: path.join('config', 'pending-pairings.json'),   shape: 'array' },
    { kind: 'formatter-logs',     rel: 'formatter-logs.json',                          shape: 'object-map' },
    { kind: 'extension-installs', rel: path.join('config', 'extension-installs.json'), shape: 'object-keys' },
    { kind: 'server-config',      rel: path.join('config', 'server.json'),             shape: 'object-map' },
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
 * Rename a successfully-imported source file to `<name>.imported.<ISO>`.
 * Returns the new path on success, or null on failure (logs the reason).
 */
function archiveImported(sourcePath) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = sourcePath + '.imported.' + ts;
    fs.renameSync(sourcePath, dest);
    console.log(`[migration] archived ${sourcePath} → ${dest}`);
    return dest;
  } catch (e) {
    console.error(`[migration] failed to archive ${sourcePath}: ${e && e.message}`);
    return null;
  }
}

/**
 * Should we force a re-import even if destination tables are populated?
 * Used in dev to retry an import after fixing a bug.
 */
function reimportRequested() {
  if (process.env.WEBPILOT_REIMPORT === '1') return true;
  try {
    if (Array.isArray(process.argv) && process.argv.includes('--reimport')) return true;
  } catch (_e) { /* ignore */ }
  return false;
}

/**
 * Import paired-keys.json + pending-pairings.json into `agents` + `pairings`.
 *
 * Ordering matters: agents must be inserted BEFORE the pairings rows that
 * reference them via `approved_agent_id`. So we read both files up front,
 * insert all agents first, then insert the pairings.
 *
 * Hashing: API keys (the plaintext UUIDs in paired-keys.json + the apiKey
 * field on approved pending-pairings.json entries) are hashed before
 * insertion. See `paired-keys.js` for the hashing rationale (HMAC-SHA-256
 * with a server-side pepper read from the `config` table).
 *
 * @returns {{ agents: number, pairings: number, skippedReason?: string }}
 */
function importPairedKeysAndPairings(detected) {
  const pairedKeys = require('../paired-keys');
  const dbModule = require('./connection');
  const db = dbModule.getDb();

  const pairedKeysEntry  = detected.find((d) => d.kind === 'paired-keys');
  const pendingEntry     = detected.find((d) => d.kind === 'pending-pairings');

  // Skip if both source files are absent — nothing to do.
  if ((!pairedKeysEntry || !pairedKeysEntry.exists) &&
      (!pendingEntry || !pendingEntry.exists)) {
    return { agents: 0, pairings: 0, skippedReason: 'no legacy paired-keys / pending-pairings files' };
  }

  // Skip if destination tables already have rows (a previous boot imported
  // them) unless the operator asked for a forced re-import.
  const existingAgents   = db.prepare('SELECT COUNT(*) AS c FROM agents').get().c;
  const existingPairings = db.prepare('SELECT COUNT(*) AS c FROM pairings').get().c;
  if ((existingAgents > 0 || existingPairings > 0) && !reimportRequested()) {
    return {
      agents: 0,
      pairings: 0,
      skippedReason:
        `destination tables already populated (agents=${existingAgents}, pairings=${existingPairings}); ` +
        'pass --reimport to force',
    };
  }

  // Parse both files defensively.
  function readArray(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error(`[migration] failed to parse ${filePath}: ${e && e.message}`);
      return [];
    }
  }

  const keys     = pairedKeysEntry && pairedKeysEntry.exists ? readArray(pairedKeysEntry.path) : [];
  const pairings = pendingEntry    && pendingEntry.exists    ? readArray(pendingEntry.path)    : [];

  // Build a quick plaintext-key → agent_id map by hashing each key with the
  // current pepper. This lets us link approved pairings back to the agent row
  // we're about to insert.
  const insertAgent = db.prepare(
    `INSERT INTO agents (name, api_key_hash, profile_id, created_at, last_seen_at, state)
     VALUES (?, ?, ?, ?, ?, 'active')`
  );

  const insertPairing = db.prepare(
    `INSERT INTO pairings
       (pairing_id, agent_name, requested_at, expires_at, decided_at, state,
        approved_agent_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // We use a single transaction so a mid-flight failure rolls back cleanly.
  const importTx = db.transaction(() => {
    // If --reimport is active and tables had rows, clear them first so the
    // import is deterministic. Foreign keys: pairings.approved_agent_id
    // references agents.id, so wipe pairings first.
    if (reimportRequested() && (existingAgents > 0 || existingPairings > 0)) {
      db.prepare('DELETE FROM pairings').run();
      db.prepare('DELETE FROM agents').run();
      console.log('[migration] --reimport: cleared existing agents + pairings rows before import');
    }

    // 1) Agents
    const keyHashToAgentId = new Map();
    let agentsInserted = 0;
    for (const entry of keys) {
      if (!entry || typeof entry.key !== 'string' || typeof entry.agentName !== 'string') {
        console.warn(`[migration] paired-keys: skipping malformed entry: ${JSON.stringify(entry)}`);
        continue;
      }
      const hash = pairedKeys.hashApiKey(entry.key);
      try {
        const res = insertAgent.run(
          entry.agentName,
          hash,
          entry.profileId || null,
          entry.createdAt || new Date().toISOString(),
          entry.lastAccessed || null
        );
        keyHashToAgentId.set(hash, res.lastInsertRowid);
        agentsInserted += 1;
      } catch (e) {
        // UNIQUE constraint on api_key_hash — the same plaintext appears in
        // the JSON twice. Look up the existing row and keep going.
        const existing = db.prepare('SELECT id FROM agents WHERE api_key_hash = ?').get(hash);
        if (existing) {
          keyHashToAgentId.set(hash, existing.id);
          console.warn(`[migration] paired-keys: duplicate api_key_hash for "${entry.agentName}", reusing agent_id=${existing.id}`);
        } else {
          throw e;
        }
      }
    }

    // 2) Pairings
    let pairingsInserted = 0;
    for (const pairing of pairings) {
      if (!pairing || typeof pairing.pairingId !== 'string' || typeof pairing.agentName !== 'string') {
        console.warn(`[migration] pending-pairings: skipping malformed entry: ${JSON.stringify(pairing)}`);
        continue;
      }
      const state = pairing.status || 'pending';
      const validStates = ['pending', 'approved', 'denied', 'expired'];
      if (!validStates.includes(state)) {
        console.warn(`[migration] pending-pairings: invalid status "${state}" on pairingId=${pairing.pairingId} — defaulting to expired`);
      }
      const finalState = validStates.includes(state) ? state : 'expired';

      let approvedAgentId = null;
      const meta = {};

      if (finalState === 'approved' && typeof pairing.apiKey === 'string') {
        meta.apiKey = pairing.apiKey;
        const hash = pairedKeys.hashApiKey(pairing.apiKey);
        let agentId = keyHashToAgentId.get(hash);
        if (!agentId) {
          // The approved pairing references an api_key that wasn't in
          // paired-keys.json (unusual but possible: paired-keys.json was
          // edited or trimmed separately). Synthesize an agent row so the
          // FK is valid and the credential continues to work.
          try {
            const res = insertAgent.run(
              pairing.agentName,
              hash,
              pairing.profileId || null,
              pairing.createdAt || new Date().toISOString(),
              null
            );
            agentId = res.lastInsertRowid;
            keyHashToAgentId.set(hash, agentId);
            agentsInserted += 1;
            console.warn(
              `[migration] pending-pairings: approved pairingId=${pairing.pairingId} ` +
                `had no matching paired-keys entry; synthesized agents row id=${agentId}`
            );
          } catch (e) {
            console.warn(
              `[migration] pending-pairings: failed to synthesize agent for approved pairingId=${pairing.pairingId}: ${e && e.message}`
            );
          }
        }
        approvedAgentId = agentId || null;
      }
      if (pairing.profileId !== undefined) meta.profileId = pairing.profileId || null;
      if (pairing.source) meta.source = pairing.source;

      // expires_at in JSON is epoch-ms number; we store the number directly.
      const expiresAt = Number(pairing.expiresAt) || (Date.now() + 24 * 60 * 60 * 1000);

      try {
        insertPairing.run(
          pairing.pairingId,
          pairing.agentName,
          pairing.createdAt || new Date().toISOString(),
          expiresAt,
          pairing.decidedAt || null,
          finalState,
          approvedAgentId,
          Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
        );
        pairingsInserted += 1;
      } catch (e) {
        // UNIQUE on pairing_id — duplicate; skip.
        console.warn(`[migration] pending-pairings: skipping duplicate pairingId=${pairing.pairingId}: ${e && e.message}`);
      }
    }

    return { agentsInserted, pairingsInserted };
  });

  const { agentsInserted, pairingsInserted } = importTx();

  // Archive the source files AFTER successful commit. If either rename fails,
  // we leave the original alone — the destination tables are populated so the
  // next boot will skip-on-already-populated and a manual cleanup is fine.
  if (pairedKeysEntry && pairedKeysEntry.exists) archiveImported(pairedKeysEntry.path);
  if (pendingEntry    && pendingEntry.exists)    archiveImported(pendingEntry.path);

  return { agents: agentsInserted, pairings: pairingsInserted };
}

/**
 * Import formatter-logs.json into the `formatter_incidents` table.
 *
 * JSON shape (the legacy ring-buffer flush format — see the pre-Phase-3
 * formatter-logs.js):
 *   {
 *     writtenAt: '<ISO>',
 *     formatters: {
 *       '<formatterName>': {
 *         successCount, errorCount, lastSuccessAt, lastErrorAt,
 *         recentOutcomes, dismissedAt,
 *         logs: [
 *           { timestamp, phase, workflow?, message, stack, params?, tabId? },
 *           ...newest first...
 *         ]
 *       }
 *     }
 *   }
 *
 * We unfurl `formatters[*].logs[*]` into individual `formatter_incidents`
 * rows. Per-row fields preserved: timestamp → occurred_at, phase, workflow,
 * message, stack → stack_truncated, params (JSON-stringified) → params_json,
 * tabId → tab_id. The legacy whole-formatter `dismissedAt` doesn't map
 * cleanly to per-incident dismiss (the design intentionally changed) — we
 * propagate it to every imported row for that formatter so historical
 * dismisses don't re-surface as fresh action items on the dashboard.
 *
 * Success/error counters and recentOutcomes are NOT migrated — those are
 * in-memory uptime stats post-Phase-3.
 *
 * @returns {{ incidents: number, skippedReason?: string }}
 */
function importFormatterIncidents(detected) {
  const dbModule = require('./connection');
  const db = dbModule.getDb();

  const entry = detected.find((d) => d.kind === 'formatter-logs');
  if (!entry || !entry.exists) {
    return { incidents: 0, skippedReason: 'no legacy formatter-logs.json file' };
  }

  const existingRows = db.prepare('SELECT COUNT(*) AS c FROM formatter_incidents').get().c;
  if (existingRows > 0 && !reimportRequested()) {
    return {
      incidents: 0,
      skippedReason:
        `destination table already populated (formatter_incidents=${existingRows}); ` +
        'pass --reimport to force',
    };
  }

  let parsed;
  try {
    const raw = fs.readFileSync(entry.path, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[migration] failed to parse ${entry.path}: ${e && e.message}`);
    return { incidents: 0, skippedReason: `parse error: ${e && e.message}` };
  }

  const formatters = parsed && parsed.formatters && typeof parsed.formatters === 'object'
    ? parsed.formatters
    : {};

  const insertIncident = db.prepare(
    `INSERT INTO formatter_incidents
       (formatter, occurred_at, phase, workflow, message, stack_truncated,
        params_json, tab_id, dismissed_at, dismissed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const importTx = db.transaction(() => {
    if (reimportRequested() && existingRows > 0) {
      db.prepare('DELETE FROM formatter_incidents').run();
      console.log('[migration] --reimport: cleared existing formatter_incidents rows before import');
    }

    let inserted = 0;
    for (const [formatterName, snap] of Object.entries(formatters)) {
      if (!formatterName || !snap || typeof snap !== 'object') continue;
      const wholeFormatterDismissedAt = typeof snap.dismissedAt === 'string' ? snap.dismissedAt : null;
      const logs = Array.isArray(snap.logs) ? snap.logs : [];
      for (const log of logs) {
        if (!log || typeof log !== 'object') continue;
        const occurredAt = typeof log.timestamp === 'string' ? log.timestamp : null;
        if (!occurredAt) continue;
        let phase = log.phase === 'workflow' ? 'workflow' : 'format';
        const workflow = typeof log.workflow === 'string' ? log.workflow : null;
        const message = typeof log.message === 'string' ? log.message : 'Unknown error';
        const stack = typeof log.stack === 'string' ? log.stack : null;
        let paramsJson = null;
        if (log.params != null) {
          try { paramsJson = JSON.stringify(log.params); } catch (_e) { paramsJson = null; }
        }
        const tabId = (log.tabId == null || !Number.isFinite(Number(log.tabId))) ? null : Number(log.tabId);
        // If the whole formatter was dismissed AFTER this log, carry that
        // dismiss forward so we don't resurface old errors as fresh action
        // items. The dismiss timestamp on each row is just the formatter-level
        // dismissedAt the user already chose.
        let dismissedAt = null;
        let dismissedBy = null;
        if (wholeFormatterDismissedAt) {
          const d = Date.parse(wholeFormatterDismissedAt);
          const e = Date.parse(occurredAt);
          if (Number.isFinite(d) && Number.isFinite(e) && d >= e) {
            dismissedAt = wholeFormatterDismissedAt;
            dismissedBy = 'user';
          }
        }
        try {
          insertIncident.run(
            formatterName,
            occurredAt,
            phase,
            workflow,
            message,
            stack,
            paramsJson,
            tabId,
            dismissedAt,
            dismissedBy
          );
          inserted += 1;
        } catch (e) {
          console.warn(
            `[migration] formatter-logs: skipping unparseable row for "${formatterName}": ${e && e.message}`
          );
        }
      }
    }
    return inserted;
  });

  const inserted = importTx();

  // Archive only after a successful commit. If 0 rows were imported we still
  // archive — the file is consumed; leaving it would cause a confusing
  // "would re-import on --reimport but the source is empty" state.
  archiveImported(entry.path);

  return { incidents: inserted };
}

/**
 * Walk the legacy JSON stores and import them into the DB. Returns a summary
 * of what was detected and what was imported. Each branch is independently
 * idempotent — re-running this on a populated DB is a no-op (unless the
 * operator asked for `--reimport`).
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
    console.log(`[migration] detected ${entry.kind} at ${entry.path} (${rowsLabel} rows)`);
  }

  let importedAgents = 0;
  let importedPairings = 0;

  // ─── Phase 2: paired-keys + pending-pairings ────────────────────────────
  try {
    const result = importPairedKeysAndPairings(detected);
    importedAgents = result.agents;
    importedPairings = result.pairings;
    if (result.skippedReason) {
      console.log(`[migration] paired-keys/pending-pairings skipped: ${result.skippedReason}`);
    } else {
      console.log(
        `[migration] imported ${result.pairings} pairings, ${result.agents} agents ` +
          'from paired-keys.json + pending-pairings.json → SQLite.'
      );
    }
  } catch (e) {
    console.error(`[migration] paired-keys/pending-pairings import FAILED: ${e && e.message}`);
    if (e && e.stack) console.error(e.stack);
    // Do NOT rename source files on failure — leave them for retry.
  }

  // ─── Phase 3: formatter incidents ───────────────────────────────────────
  let importedIncidents = 0;
  try {
    const result = importFormatterIncidents(detected);
    importedIncidents = result.incidents;
    if (result.skippedReason) {
      console.log(`[migration] formatter-logs skipped: ${result.skippedReason}`);
    } else {
      console.log(
        `[migration] imported ${result.incidents} incidents ` +
          'from formatter-logs.json → SQLite.'
      );
    }
  } catch (e) {
    console.error(`[migration] formatter-logs import FAILED: ${e && e.message}`);
    if (e && e.stack) console.error(e.stack);
  }

  // ─── Phase 4 (config / network.enabled / extension-installs) — TODO ─────
  // for (const entry of present) { switch (entry.kind) { ... } }

  const totalImported = importedAgents + importedPairings + importedIncidents;
  console.log(
    `[migration] complete — detected=${present.length}, imported_agents=${importedAgents}, ` +
      `imported_pairings=${importedPairings}, imported_incidents=${importedIncidents}`
  );
  return {
    detected,
    imported: totalImported,
    agents: importedAgents,
    pairings: importedPairings,
    incidents: importedIncidents,
  };
}

module.exports = {
  detectLegacyStores,
  runImportFromJsonStores,
  // Exposed for tests / dev tooling.
  importPairedKeysAndPairings,
  importFormatterIncidents,
  reimportRequested,
};
