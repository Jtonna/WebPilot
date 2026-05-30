'use strict';

/**
 * DB-backed formatter incident log + in-memory hot cache.
 *
 * Every error becomes a row in the `formatter_incidents` SQLite table
 * (durable across server restart). A per-formatter in-memory cache holds
 * the 10 most recent incidents, hydrated lazily from the DB, for fast
 * reads from the dashboard's Action Items list and the
 * `webpilot_dev_get_formatter_logs` MCP tool.
 *
 * Design notes:
 *   - Write-through pattern: recordError → INSERT row → prepend to cache.
 *   - Cache capacity per formatter: CACHE_CAPACITY_PER_FORMATTER (=10).
 *   - Reads up to capacity hit the cache only. Reads above capacity fall
 *     through to a direct DB query (`webpilot_dev_get_formatter_logs` caps
 *     at 50 so this fires for limit > 10).
 *   - Per-incident dismiss: recordDismiss(incidentId, dismissedBy) sets
 *     dismissed_at on a single row. recordDismissAll(formatterName) is the
 *     bulk version for the dashboard's "Dismiss all" button.
 *   - Success counts stay in-memory only. The DB audit trail is for errors
 *     specifically; recording every successful invocation would be
 *     high-volume noise.
 *   - Health rule: HEALTHY if total invocations < 3, OR if the last 10
 *     invocations are all-success. UNHEALTHY otherwise. A formatter whose
 *     recent incidents are ALL dismissed counts as healthy too, so
 *     dismissing makes it drop off the dashboard until the next error.
 *
 * Exports:
 *   - recordSuccess, recordError, hasFormatter, getStatus, getLogs,
 *     listAll, flush (no-op), _resetForTests, events (EventEmitter).
 *   - recordDismiss(incidentId, dismissedBy = 'user') — single-row dismiss.
 *   - recordDismissAll(formatterName, dismissedBy = 'user') — bulk dismiss
 *     for the dashboard header's "Dismiss all" action.
 *
 * Pruning: cleanupDismissedIncidents(maxAgeDays = 90) mirrors paired-keys'
 * cleanupOldPairings — server.js calls it at boot and daily.
 */

const { EventEmitter } = require('events');

const CACHE_CAPACITY_PER_FORMATTER = 10;
const STACK_MAX = 1024;

// formatterName -> { successCount, errorCount, lastSuccessAt, lastErrorAt,
//                    recentOutcomes: ['ok'|'err', ...] cap 10,
//                    cache: Incident[] (newest first, cap 10) }
//
// An Incident row matches the row shape we hand to callers:
//   { id, formatter, timestamp, phase, workflow, message, stack, params,
//     tabId, dismissedAt, dismissedBy }
// (timestamp / dismissedAt are ISO strings; id is the DB rowid.)
const state = new Map();

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

let hydrated = false;

function getDb() {
  // Lazy-require to avoid pulling the DB module in at top level — keeps
  // _resetForTests() viable and lets the unit test harness stub the module.
  return require('./db/connection').getDb();
}

function truncateStack(stack) {
  if (typeof stack !== 'string') return '';
  if (stack.length <= STACK_MAX) return stack;
  return stack.slice(0, STACK_MAX) + '\n[truncated]';
}

function extractTopFrame(stack) {
  if (!stack || typeof stack !== 'string') return null;
  const match = stack.match(/at\s+([^(]+)\s+\(([^)]+):(\d+):\d+\)/);
  if (!match) return null;
  const fn = match[1].trim();
  const file = require('path').basename(match[2]);
  const line = match[3];
  return `${file}:${line} (${fn})`;
}

function ensureFormatter(name) {
  let entry = state.get(name);
  if (!entry) {
    entry = {
      successCount: 0,
      errorCount: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      recentOutcomes: [],
      cache: [],
    };
    state.set(name, entry);
  }
  return entry;
}

function pushOutcome(entry, outcome) {
  entry.recentOutcomes.push(outcome);
  if (entry.recentOutcomes.length > 10) {
    entry.recentOutcomes.shift();
  }
}

/**
 * Convert a `formatter_incidents` DB row to the shape callers expect.
 * Field names align with the legacy ring-buffer entry shape so callers
 * (mcp-handler, server.js UI routes, FormatterErrorCard) keep working
 * with no changes: { id, timestamp, phase, workflow, message, stack,
 * params, tabId, dismissedAt, dismissedBy, formatter }.
 */
function rowToIncident(row) {
  if (!row) return null;
  let params = null;
  if (row.params_json) {
    try { params = JSON.parse(row.params_json); } catch (_e) { params = null; }
  }
  return {
    id: row.id,
    formatter: row.formatter,
    timestamp: row.occurred_at,
    phase: row.phase,
    workflow: row.workflow || null,
    message: row.message || '',
    stack: row.stack_truncated || '',
    params,
    tabId: row.tab_id == null ? null : row.tab_id,
    dismissedAt: row.dismissed_at || null,
    dismissedBy: row.dismissed_by || null,
  };
}

/**
 * Hydrate per-formatter caches from the DB. One-shot, lazy. On first call
 * after boot, queries every distinct formatter that has ever logged an
 * incident and loads the 10 most recent rows into its cache. Counts
 * (successCount / errorCount / recentOutcomes) start fresh — those are
 * in-memory only and reset on every server restart, which matches the
 * "process-uptime stats" semantic dashboards expect.
 */
function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  let db;
  try {
    db = getDb();
  } catch (e) {
    // DB not initialized — happens in tests that skip connection.init().
    // Stay in pure-memory mode; next call will retry.
    hydrated = false;
    return;
  }
  try {
    const formatters = db
      .prepare('SELECT formatter, COUNT(*) AS c, MAX(occurred_at) AS last_at FROM formatter_incidents GROUP BY formatter')
      .all();
    const recentStmt = db.prepare(
      `SELECT id, formatter, occurred_at, phase, workflow, message,
              stack_truncated, params_json, tab_id, dismissed_at, dismissed_by
         FROM formatter_incidents
        WHERE formatter = ?
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?`
    );
    for (const f of formatters) {
      const entry = ensureFormatter(f.formatter);
      const rows = recentStmt.all(f.formatter, CACHE_CAPACITY_PER_FORMATTER);
      entry.cache = rows.map(rowToIncident);
      entry.errorCount = f.c;
      entry.lastErrorAt = f.last_at || null;
      // Seed recentOutcomes from the cached rows so health is meaningful
      // immediately after boot (no false "healthy" reads before the next
      // error lands).
      entry.recentOutcomes = entry.cache.slice(0, 10).map(() => 'err').reverse();
    }
  } catch (e) {
    console.log(`[formatter-logs] hydrate failed: ${e && e.message}`);
  }
}

function recordSuccess(formatterName) {
  if (!formatterName) return;
  hydrateOnce();
  const entry = ensureFormatter(formatterName);
  entry.successCount += 1;
  entry.lastSuccessAt = new Date().toISOString();
  pushOutcome(entry, 'ok');
  try {
    emitter.emit('changed', { name: formatterName, status: statusForEntry(entry) });
  } catch (_e) { /* ignore */ }
}

function recordError(formatterName, info = {}) {
  if (!formatterName) return;
  hydrateOnce();
  const entry = ensureFormatter(formatterName);
  entry.errorCount += 1;
  entry.lastErrorAt = new Date().toISOString();
  pushOutcome(entry, 'err');

  const err = info.error || {};
  const message = typeof err === 'string' ? err : (err.message || 'Unknown error');
  const stack = truncateStack(err && err.stack);
  const phase = info.phase || (info.workflow ? 'workflow' : 'format');
  const workflow = info.workflow || null;
  const params = info.params != null ? info.params : null;
  const tabId = info.tabId != null ? info.tabId : null;
  const occurredAt = entry.lastErrorAt;

  let incident;
  try {
    const db = getDb();
    const res = db
      .prepare(
        `INSERT INTO formatter_incidents
           (formatter, occurred_at, phase, workflow, message, stack_truncated,
            params_json, tab_id, dismissed_at, dismissed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(
        formatterName,
        occurredAt,
        phase,
        workflow,
        message,
        stack,
        params == null ? null : JSON.stringify(params),
        tabId
      );
    incident = {
      id: res.lastInsertRowid,
      formatter: formatterName,
      timestamp: occurredAt,
      phase,
      workflow,
      message,
      stack,
      params,
      tabId,
      dismissedAt: null,
      dismissedBy: null,
    };
  } catch (e) {
    console.log(`[formatter-logs] DB insert failed (continuing in-memory): ${e && e.message}`);
    // Fallback so the dashboard still shows something when the DB is broken.
    // No id — caller can still display the row, but per-incident dismiss
    // won't work for it (dismiss looks up by id).
    incident = {
      id: null,
      formatter: formatterName,
      timestamp: occurredAt,
      phase,
      workflow,
      message,
      stack,
      params,
      tabId,
      dismissedAt: null,
      dismissedBy: null,
    };
  }

  // Prepend to cache; trim to CACHE_CAPACITY_PER_FORMATTER.
  entry.cache.unshift(incident);
  if (entry.cache.length > CACHE_CAPACITY_PER_FORMATTER) {
    entry.cache.length = CACHE_CAPACITY_PER_FORMATTER;
  }

  try {
    emitter.emit('changed', { name: formatterName, status: statusForEntry(entry) });
  } catch (_e) { /* listener errors are not our problem */ }

  return incident;
}

// New recordError call sites must also be wired into the inline-diagnostics augmentation path (see buildDiagnostics).

/**
 * Per-incident dismiss. Updates the DB row and, if the row is in any
 * formatter's cache, updates the cached copy in place.
 *
 * @param {number|string} incidentId — DB rowid of the `formatter_incidents` row.
 * @param {string} [dismissedBy='user'] — actor; 'user' for UI dismiss, an
 *   agent name for tool-call dismiss.
 * @returns {{ ok: boolean, incidentId: number, formatter?: string, status?: object, error?: string }}
 */
function recordDismiss(incidentId, dismissedBy = 'user') {
  if (incidentId == null || incidentId === '') {
    return { ok: false, incidentId, error: 'incidentId required' };
  }
  const id = Number(incidentId);
  if (!Number.isFinite(id)) {
    return { ok: false, incidentId, error: 'incidentId must be numeric' };
  }
  hydrateOnce();

  let row;
  try {
    const db = getDb();
    row = db.prepare('SELECT formatter, dismissed_at FROM formatter_incidents WHERE id = ?').get(id);
  } catch (e) {
    return { ok: false, incidentId: id, error: e && e.message };
  }
  if (!row) {
    return { ok: false, incidentId: id, error: 'incident not found' };
  }

  const dismissedAt = new Date().toISOString();
  try {
    const db = getDb();
    // Only set the dismiss timestamp if it's still NULL. Re-dismissing is a
    // no-op (we don't overwrite an earlier dismissed_at).
    db.prepare(
      `UPDATE formatter_incidents
         SET dismissed_at = COALESCE(dismissed_at, ?),
             dismissed_by = COALESCE(dismissed_by, ?)
       WHERE id = ?`
    ).run(dismissedAt, dismissedBy, id);
  } catch (e) {
    return { ok: false, incidentId: id, error: e && e.message };
  }

  // Update the cached copy if present.
  const formatterName = row.formatter;
  const entry = state.get(formatterName);
  if (entry) {
    const cached = entry.cache.find((c) => c && c.id === id);
    if (cached) {
      if (!cached.dismissedAt) {
        cached.dismissedAt = dismissedAt;
        cached.dismissedBy = dismissedBy;
      }
    }
  }

  const status = entry ? statusForEntry(entry) : null;
  try {
    emitter.emit('changed', { name: formatterName, status });
  } catch (_e) { /* ignore */ }
  return { ok: true, incidentId: id, formatter: formatterName, status };
}

/**
 * Bulk dismiss every undismissed incident for a formatter. Used by the
 * dashboard Action Items header's "Dismiss all" button. Updates the cache
 * for the affected formatter so subsequent reads reflect the change without
 * a DB roundtrip.
 *
 * @param {string} formatterName
 * @param {string} [dismissedBy='user']
 * @returns {{ ok: boolean, formatter: string, affected: number, status?: object, error?: string }}
 */
function recordDismissAll(formatterName, dismissedBy = 'user') {
  if (!formatterName) {
    return { ok: false, formatter: formatterName, affected: 0, error: 'formatter required' };
  }
  hydrateOnce();
  const dismissedAt = new Date().toISOString();
  let affected = 0;
  try {
    const db = getDb();
    const res = db
      .prepare(
        `UPDATE formatter_incidents
            SET dismissed_at = ?, dismissed_by = ?
          WHERE formatter = ? AND dismissed_at IS NULL`
      )
      .run(dismissedAt, dismissedBy, formatterName);
    affected = res.changes;
  } catch (e) {
    return { ok: false, formatter: formatterName, affected: 0, error: e && e.message };
  }

  // Mirror the dismiss into the cache.
  const entry = state.get(formatterName);
  if (entry) {
    for (const inc of entry.cache) {
      if (inc && !inc.dismissedAt) {
        inc.dismissedAt = dismissedAt;
        inc.dismissedBy = dismissedBy;
      }
    }
  }

  const status = entry ? statusForEntry(entry) : null;
  try {
    emitter.emit('changed', { name: formatterName, status });
  } catch (_e) { /* ignore */ }
  return { ok: true, formatter: formatterName, affected, status };
}

function hasFormatter(formatterName) {
  if (!formatterName) return false;
  hydrateOnce();
  return state.has(formatterName);
}

function computeHealth(entry) {
  if (!entry) return 'unknown';
  // If every cached recent incident is dismissed AND we have no fresh
  // post-dismiss error, treat as healthy — the user has explicitly
  // acknowledged the open items.
  if (entry.cache.length > 0 && entry.cache.every((inc) => inc && inc.dismissedAt)) {
    // Yet we still want to fall through to the regular rule for formatters
    // that have a healthy success rate. So this is just one path to healthy.
    return 'healthy';
  }
  const total = entry.successCount + entry.errorCount;
  if (total < 3) return 'healthy';
  const hasRecentError = entry.recentOutcomes.some((o) => o === 'err');
  return hasRecentError ? 'unhealthy' : 'healthy';
}

function lastErrorFromCache(entry) {
  if (!entry || entry.cache.length === 0) return null;
  // Newest first; pick the first undismissed for the dashboard preview, but
  // fall back to the absolute newest if everything is dismissed (so the
  // "Last error" line still has content on the per-formatter logs page).
  const newest = entry.cache.find((c) => c && !c.dismissedAt) || entry.cache[0];
  if (!newest) return null;
  return {
    id: newest.id,
    timestamp: newest.timestamp,
    message: newest.message,
    phase: newest.phase,
    workflow: newest.workflow || null,
    stack: newest.stack || '',
  };
}

function statusForEntry(entry) {
  if (!entry) {
    return {
      health: 'unknown',
      lastError: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      successCount: 0,
      errorCount: 0,
      dismissedAt: null,
    };
  }
  // `dismissedAt` on the status payload kept for backward compat with the
  // old "whole-formatter dismiss" UI. We surface the newest cached incident's
  // dismiss timestamp (or null) — close enough for the existing readers,
  // and the dashboard already moved to per-incident dismiss anyway.
  const newest = entry.cache[0] || null;
  return {
    health: computeHealth(entry),
    lastError: lastErrorFromCache(entry),
    lastSuccessAt: entry.lastSuccessAt,
    lastErrorAt: entry.lastErrorAt,
    successCount: entry.successCount,
    errorCount: entry.errorCount,
    dismissedAt: newest && newest.dismissedAt ? newest.dismissedAt : null,
  };
}

function getStatus(formatterName) {
  hydrateOnce();
  return statusForEntry(state.get(formatterName));
}

/**
 * Recent incidents for a formatter. Reads from the cache when `limit` is
 * small enough; otherwise falls through to the DB. Newest first.
 */
function getLogs(formatterName, limit = CACHE_CAPACITY_PER_FORMATTER) {
  hydrateOnce();
  const safeLimit = Math.max(0, Number(limit) || 0);
  if (safeLimit === 0) return [];

  const entry = state.get(formatterName);

  // Hot path: cache covers the request.
  if (safeLimit <= CACHE_CAPACITY_PER_FORMATTER) {
    if (!entry) return [];
    return entry.cache.slice(0, safeLimit);
  }

  // Cold path: caller wants more history than the cache holds. Hit the DB.
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, formatter, occurred_at, phase, workflow, message,
                stack_truncated, params_json, tab_id, dismissed_at, dismissed_by
           FROM formatter_incidents
          WHERE formatter = ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?`
      )
      .all(formatterName, safeLimit);
    return rows.map(rowToIncident);
  } catch (e) {
    console.log(`[formatter-logs] getLogs DB query failed: ${e && e.message}`);
    return entry ? entry.cache.slice(0, safeLimit) : [];
  }
}

function listAll() {
  hydrateOnce();
  const out = new Map();
  for (const [name, entry] of state.entries()) {
    out.set(name, statusForEntry(entry));
  }
  return out;
}

/**
 * No-op in the DB-backed implementation — writes are synchronous via
 * better-sqlite3, there's no buffer to flush. Kept on the public surface
 * so any leftover callers (e.g. shutdown hooks) don't break.
 */
function flush() {
  /* intentionally empty — see module docstring */
}

/**
 * Daily prune: drop dismissed incidents older than `maxAgeDays` days.
 * Mirrors paired-keys.cleanupOldPairings — server.js wires this into the
 * boot pass + a daily setInterval.
 *
 * Undismissed rows are NEVER pruned: those are the durable audit trail for
 * "errors the user hasn't acknowledged yet." Only the dismissed tail is
 * trimmed to keep the DB tidy.
 *
 * @param {number} [maxAgeDays=90]
 * @returns {{ removed: number, kept: number }}
 */
function cleanupDismissedIncidents(maxAgeDays = 90) {
  let db;
  try {
    db = getDb();
  } catch (e) {
    return { removed: 0, kept: 0 };
  }
  const cutoffIso = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const res = db
    .prepare(
      `DELETE FROM formatter_incidents
         WHERE dismissed_at IS NOT NULL
           AND dismissed_at < ?`
    )
    .run(cutoffIso);
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM formatter_incidents').get().c;
  if (res.changes > 0) {
    console.log(
      `[formatter-logs:cleanup] removed=${res.changes} kept=${remaining} ` +
        `(maxAgeDays=${maxAgeDays}, dismissed-only)`
    );
  }
  return { removed: res.changes, kept: remaining };
}

// Build a compact diagnostic payload from a recorded incident for inline MCP error responses.
function buildDiagnostics(incident, platform) {
  return {
    phase: incident.phase,
    workflow: incident.workflow ?? null,
    platform,
    tabId: incident.tabId ?? null,
    topFrame: extractTopFrame(incident.stack),
    more: `Call webpilot_dev_get_formatter_logs({platform: '${platform}'}) for full error history.`
  };
}

/**
 * Test seam: clears the in-memory state + counters and resets the
 * hydration flag so the next call re-reads from the DB. Does NOT touch
 * the DB — tests that want full isolation should point connection.init()
 * at a temp file (or use a sandbox dataDir) before calling this.
 */
function _resetForTests() {
  state.clear();
  hydrated = false;
}

module.exports = {
  recordSuccess,
  recordError,
  recordDismiss,
  recordDismissAll,
  hasFormatter,
  getStatus,
  getLogs,
  listAll,
  flush,
  cleanupDismissedIncidents,
  extractTopFrame,
  buildDiagnostics,
  // EventEmitter used by server.js to bridge incident updates to the UI
  // WebSocket. Emits `'changed'` with `{ name, status }` after recordError,
  // recordSuccess, recordDismiss, and recordDismissAll. See server.js
  // mountWebUiRoutes for the subscriber.
  events: emitter,
  _resetForTests,
};
