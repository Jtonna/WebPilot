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
 *   - Phase 3: formatter-logs.json → `formatter_incidents`.
 *   - Phase 7 (THIS COMMIT): extension-installs.json → `extension_installs`;
 *                            network.enabled flag file → `config.network_enabled`.
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
 *
 * Used ONLY as a fallback when an import partially failed and we want to
 * keep a recovery copy. Successful full imports delete the source instead
 * (see `deleteImported`) — leaving plaintext API keys on disk in a
 * `.imported.<TS>` archive is an unnecessary risk.
 */
function archiveImported(sourcePath) {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = sourcePath + '.imported.' + ts;
    fs.renameSync(sourcePath, dest);
    // SECURITY: paired-keys.json contains plaintext API keys (legacy format).
    // After import the .imported.<TS> archive still holds those plaintext
    // keys at rest. Tighten perms so other local users cannot read them.
    // Best-effort on Windows where fs.chmodSync only maps the read-only bit.
    try { fs.chmodSync(dest, 0o600); } catch (_e) { /* non-fatal */ }
    console.log(`[migration] archived ${sourcePath} → ${dest} (partial import — kept as safety net)`);
    return dest;
  } catch (e) {
    console.error(`[migration] failed to archive ${sourcePath}: ${e && e.message}`);
    return null;
  }
}

/**
 * Delete a successfully-imported source file. Preferred over archiving for
 * files that contained plaintext credentials (paired-keys.json) — there is
 * no reason to keep secrets on disk once the DB has them in hashed form.
 */
function deleteImported(sourcePath) {
  try {
    fs.unlinkSync(sourcePath);
    console.log(`[migration] deleted ${sourcePath} after successful import (no plaintext copy retained)`);
    return true;
  } catch (e) {
    console.error(`[migration] failed to delete ${sourcePath}: ${e && e.message}`);
    return false;
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

  // Track whether the paired-keys side had ANY skipped/lost key. Used to
  // decide between deleting (full success) and archiving (partial — keep a
  // safety net) the legacy paired-keys.json.
  let pairedKeysHadFailures = false;

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
        pairedKeysHadFailures = true;
        continue;
      }
      let hash;
      try {
        hash = pairedKeys.hashApiKey(entry.key);
      } catch (e) {
        console.warn(`[migration] paired-keys: failed to hash key for "${entry.agentName}": ${e && e.message}`);
        pairedKeysHadFailures = true;
        continue;
      }
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
        // the JSON twice. Look up the existing row and keep going. Duplicate
        // rows are not a partial-failure: every distinct key is still
        // represented in the DB.
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

  // Clean up source files AFTER successful commit.
  //
  // paired-keys.json: contains plaintext API keys. On a CLEAN import (every
  // key hashed + inserted) we DELETE — there's no reason to keep secrets on
  // disk once the DB has hashed equivalents. If anything was skipped (a
  // malformed entry, an un-hashable key, etc.) we ARCHIVE instead so the
  // operator has a recovery copy. The archive is chmod 0o600.
  //
  // pending-pairings.json: not a credential store (ephemeral approval-flow
  // state). Archived to give the operator a recovery copy without urgency.
  if (pairedKeysEntry && pairedKeysEntry.exists) {
    if (pairedKeysHadFailures) {
      archiveImported(pairedKeysEntry.path);
    } else {
      deleteImported(pairedKeysEntry.path);
    }
  }
  if (pendingEntry && pendingEntry.exists) {
    archiveImported(pendingEntry.path);
  }

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
 * Import extension-installs.json into the `extension_installs` table.
 *
 * JSON shape (object-map keyed by installId UUID):
 *   {
 *     "<uuid>": {
 *       "profileId":    "<chrome profile directory name>",
 *       "firstSeen":    "<iso-8601>",
 *       "lastResolved": "<iso-8601>"
 *     },
 *     ...
 *   }
 *
 * @returns {{ installs: number, skippedReason?: string }}
 */
function importExtensionInstalls(detected) {
  const dbModule = require('./connection');
  const db = dbModule.getDb();

  const entry = detected.find((d) => d.kind === 'extension-installs');
  if (!entry || !entry.exists) {
    return { installs: 0, skippedReason: 'no legacy extension-installs.json file' };
  }

  const existingRows = db.prepare('SELECT COUNT(*) AS c FROM extension_installs').get().c;
  if (existingRows > 0 && !reimportRequested()) {
    return {
      installs: 0,
      skippedReason:
        `destination table already populated (extension_installs=${existingRows}); ` +
        'pass --reimport to force',
    };
  }

  let parsed;
  try {
    const raw = fs.readFileSync(entry.path, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[migration] failed to parse ${entry.path}: ${e && e.message}`);
    return { installs: 0, skippedReason: `parse error: ${e && e.message}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { installs: 0, skippedReason: 'extension-installs.json content was not a plain object' };
  }

  const insertInstall = db.prepare(
    `INSERT INTO extension_installs (install_id, profile_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?)`
  );

  const importTx = db.transaction(() => {
    if (reimportRequested() && existingRows > 0) {
      db.prepare('DELETE FROM extension_installs').run();
      console.log('[migration] --reimport: cleared existing extension_installs rows before import');
    }

    let inserted = 0;
    const nowIso = new Date().toISOString();
    for (const [installId, rec] of Object.entries(parsed)) {
      if (!installId || typeof installId !== 'string') continue;
      if (!rec || typeof rec !== 'object') continue;
      const profileId = typeof rec.profileId === 'string' && rec.profileId.length > 0
        ? rec.profileId
        : null;
      if (!profileId) {
        console.warn(
          `[migration] extension-installs: skipping installId="${installId.slice(0, 8)}..." ` +
            'with empty profileId'
        );
        continue;
      }
      const firstSeen = typeof rec.firstSeen === 'string' && rec.firstSeen.length > 0
        ? rec.firstSeen
        : nowIso;
      const lastResolved = typeof rec.lastResolved === 'string' && rec.lastResolved.length > 0
        ? rec.lastResolved
        : firstSeen;
      try {
        insertInstall.run(installId, profileId, firstSeen, lastResolved);
        inserted += 1;
      } catch (e) {
        console.warn(
          `[migration] extension-installs: skipping installId="${installId.slice(0, 8)}...": ${e && e.message}`
        );
      }
    }
    return inserted;
  });

  const inserted = importTx();

  // Archive the source file after a successful commit so subsequent boots
  // don't re-import. Idempotent — if rename fails the destination table is
  // already populated and the next boot will skip-on-already-populated.
  archiveImported(entry.path);

  return { installs: inserted };
}

/**
 * Import the `<dataDir>/network.enabled` flag file into the `config` table
 * under key `network_enabled`. The flag is a 1-byte file: present + content
 * `'1'` means enabled, anything else (or absent) means disabled.
 *
 * @returns {{ imported: boolean, value?: string, skippedReason?: string }}
 */
function importNetworkEnabledFlag(detected) {
  const dbModule = require('./connection');
  const db = dbModule.getDb();

  const entry = detected.find((d) => d.kind === 'network-enabled');
  if (!entry || !entry.exists) {
    return { imported: false, skippedReason: 'no legacy network.enabled flag file' };
  }

  const existingRow = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('network_enabled');
  if (existingRow && !reimportRequested()) {
    return {
      imported: false,
      skippedReason: `config.network_enabled already set to "${existingRow.value}"; pass --reimport to force`,
    };
  }

  let value = 'false';
  try {
    const raw = fs.readFileSync(entry.path, 'utf8').trim();
    value = raw === '1' ? 'true' : 'false';
  } catch (e) {
    console.warn(`[migration] network.enabled: failed to read flag file: ${e && e.message}`);
    return { imported: false, skippedReason: `read error: ${e && e.message}` };
  }

  const nowIso = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run('network_enabled', value, nowIso);
  } catch (e) {
    console.error(`[migration] network.enabled: DB write failed: ${e && e.message}`);
    return { imported: false, skippedReason: `db write failed: ${e && e.message}` };
  }

  archiveImported(entry.path);

  return { imported: true, value };
}

/**
 * One-shot startup purge for legacy `paired-keys.json.imported.<TS>` archives
 * left over from earlier migration runs. Earlier versions kept the archive
 * indefinitely (with chmod 0o600) "for recovery", which left plaintext API
 * keys on disk forever. This task runs on next daemon boot, zero-overwrites
 * every archive it finds, unlinks it, and drops a sentinel so it never runs
 * again.
 *
 * Safety: we only run the purge if the DB already has agents (i.e. the
 * import has already happened). If the DB is empty we leave the archives
 * alone — they may still be the only copy of the keys.
 *
 * See QOL security audit Fix 4.
 */
function purgeLegacyPairedKeysArchives() {
  const dataDir = getDataDir();
  const sentinel = path.join(dataDir, '.archives-purged');
  if (fs.existsSync(sentinel)) return { purged: 0, skippedReason: 'sentinel present' };

  // Only purge once the DB is populated. If it isn't, the archive may still
  // be the only copy of the keys — leave it for manual recovery.
  let agentCount = 0;
  try {
    const db = require('./connection').getDb();
    agentCount = db.prepare('SELECT COUNT(*) AS c FROM agents').get().c;
  } catch (e) {
    console.warn(`[migration:purge] could not read agents table — skipping purge: ${e && e.message}`);
    return { purged: 0, skippedReason: 'agents table not readable' };
  }
  if (agentCount === 0) {
    return { purged: 0, skippedReason: 'agents table empty — archives may be only copy' };
  }

  const configDir = path.join(dataDir, 'config');
  if (!fs.existsSync(configDir)) {
    // No archives possible — drop the sentinel so we don't keep looking.
    try { fs.writeFileSync(sentinel, new Date().toISOString() + '\n'); } catch (_e) { /* non-fatal */ }
    return { purged: 0, skippedReason: 'no config dir' };
  }

  let entries;
  try {
    entries = fs.readdirSync(configDir);
  } catch (e) {
    console.warn(`[migration:purge] could not list ${configDir}: ${e && e.message}`);
    return { purged: 0, skippedReason: `readdir failed: ${e && e.message}` };
  }

  const archives = entries.filter((n) => n.startsWith('paired-keys.json.imported.'));
  if (archives.length === 0) {
    try { fs.writeFileSync(sentinel, new Date().toISOString() + '\n'); } catch (_e) { /* non-fatal */ }
    return { purged: 0, skippedReason: 'no archives present' };
  }

  let purged = 0;
  for (const name of archives) {
    const full = path.join(configDir, name);
    try {
      const stat = fs.statSync(full);
      // Zero-overwrite the file contents, then unlink. On Windows this still
      // beats leaving secrets at rest; on Linux/macOS it makes a casual
      // forensic recovery harder (no claim of secure-delete on COW or SSDs).
      const size = Math.max(0, Number(stat.size) || 0);
      if (size > 0) {
        const fd = fs.openSync(full, 'r+');
        try {
          const zero = Buffer.alloc(size, 0);
          fs.writeSync(fd, zero, 0, size, 0);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      fs.unlinkSync(full);
      purged += 1;
      console.log(`[migration:purge] zero-overwrote + unlinked legacy archive ${full}`);
    } catch (e) {
      console.warn(`[migration:purge] failed to purge ${full}: ${e && e.message}`);
    }
  }

  try {
    fs.writeFileSync(sentinel, new Date().toISOString() + '\n');
  } catch (e) {
    console.warn(`[migration:purge] failed to write sentinel ${sentinel}: ${e && e.message}`);
  }

  console.log(`[migration:purge] complete — purged ${purged}/${archives.length} legacy paired-keys archives`);
  return { purged, total: archives.length };
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

  // Best-effort one-shot purge of legacy paired-keys archives left behind by
  // earlier migration runs. Safe to call on every boot: sentinel-gated, and
  // refuses to act unless the DB has already absorbed the keys.
  try {
    purgeLegacyPairedKeysArchives();
  } catch (e) {
    console.warn(`[migration] legacy archive purge errored (non-fatal): ${e && e.message}`);
  }

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

  // ─── Phase 7: extension-installs ────────────────────────────────────────
  let importedInstalls = 0;
  try {
    const result = importExtensionInstalls(detected);
    importedInstalls = result.installs;
    if (result.skippedReason) {
      console.log(`[migration] extension-installs skipped: ${result.skippedReason}`);
    } else {
      console.log(
        `[migration] imported ${result.installs} installs ` +
          'from extension-installs.json → SQLite.'
      );
    }
  } catch (e) {
    console.error(`[migration] extension-installs import FAILED: ${e && e.message}`);
    if (e && e.stack) console.error(e.stack);
  }

  // ─── Phase 7: network.enabled flag file → config row ────────────────────
  let importedNetworkFlag = false;
  try {
    const result = importNetworkEnabledFlag(detected);
    importedNetworkFlag = !!result.imported;
    if (result.skippedReason) {
      console.log(`[migration] network.enabled skipped: ${result.skippedReason}`);
    } else if (result.imported) {
      console.log(
        `[migration] imported network.enabled flag → config.network_enabled="${result.value}"`
      );
    }
  } catch (e) {
    console.error(`[migration] network.enabled import FAILED: ${e && e.message}`);
    if (e && e.stack) console.error(e.stack);
  }

  const totalImported =
    importedAgents + importedPairings + importedIncidents + importedInstalls +
    (importedNetworkFlag ? 1 : 0);
  console.log(
    `[migration] complete — detected=${present.length}, imported_agents=${importedAgents}, ` +
      `imported_pairings=${importedPairings}, imported_incidents=${importedIncidents}, ` +
      `imported_installs=${importedInstalls}, network_flag_imported=${importedNetworkFlag}`
  );
  return {
    detected,
    imported: totalImported,
    agents: importedAgents,
    pairings: importedPairings,
    incidents: importedIncidents,
    installs: importedInstalls,
    networkFlagImported: importedNetworkFlag,
  };
}

module.exports = {
  detectLegacyStores,
  runImportFromJsonStores,
  // Exposed for tests / dev tooling.
  importPairedKeysAndPairings,
  importFormatterIncidents,
  importExtensionInstalls,
  importNetworkEnabledFlag,
  purgeLegacyPairedKeysArchives,
  reimportRequested,
};
