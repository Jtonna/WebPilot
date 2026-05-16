'use strict';

/**
 * formatter-logs.js — in-memory ring buffer + health tracking for each
 * registered formatter, with periodic disk persistence.
 *
 * Scope:
 *   - Records success and error invocations of formatter `format()` calls.
 *   - Records workflow runtime errors raised inside `webpilot_run_workflow`.
 *   - Surfaces aggregate health + the most recent N entries to the
 *     `/api/ui/formatters` and `/api/ui/formatters/:name/logs` endpoints.
 *
 * Design notes:
 *   - Per-formatter ring buffer, capacity = RING_CAPACITY (default 50).
 *   - Health rule: HEALTHY if total invocations < 3, OR if the last 10
 *     invocations contain no errors. UNHEALTHY otherwise.
 *   - Persistence: write to <dataDir>/formatter-logs.json every 60s + on
 *     process exit / SIGINT / SIGTERM. Entries older than 7 days are dropped
 *     on read (hydrate).
 *   - Stack traces truncated to ~1024 chars.
 */

const fs = require('fs');
const path = require('path');

const RING_CAPACITY = 50;
const FLUSH_INTERVAL_MS = 60 * 1000;
const TTL_MS = 7 * 24 * 3600 * 1000;
const STACK_MAX = 1024;

// formatterName -> { logs: [{ timestamp, phase, workflow?, message, stack, params?, tabId? }],
//                    successCount, errorCount, lastSuccessAt, lastErrorAt,
//                    recentOutcomes: ['ok'|'err', ...] (capacity 10) }
const state = new Map();

let flushTimer = null;
let exitHandlersInstalled = false;
let hydrated = false;

function getLogPath() {
  // Lazy-require to avoid a top-level dependency on paths during tests that
  // stub the module.
  const { getDataDir } = require('./service/paths');
  return path.join(getDataDir(), 'formatter-logs.json');
}

function ensureFormatter(name) {
  let entry = state.get(name);
  if (!entry) {
    entry = {
      logs: [],
      successCount: 0,
      errorCount: 0,
      lastSuccessAt: null,
      lastErrorAt: null,
      recentOutcomes: []
    };
    state.set(name, entry);
  }
  return entry;
}

function truncateStack(stack) {
  if (typeof stack !== 'string') return '';
  if (stack.length <= STACK_MAX) return stack;
  return stack.slice(0, STACK_MAX) + '\n[truncated]';
}

function pushOutcome(entry, outcome) {
  entry.recentOutcomes.push(outcome);
  if (entry.recentOutcomes.length > 10) {
    entry.recentOutcomes.shift();
  }
}

function pushLog(entry, log) {
  entry.logs.unshift(log); // newest first
  if (entry.logs.length > RING_CAPACITY) {
    entry.logs.length = RING_CAPACITY;
  }
}

function recordSuccess(formatterName) {
  if (!formatterName) return;
  hydrateOnce();
  const entry = ensureFormatter(formatterName);
  entry.successCount += 1;
  entry.lastSuccessAt = new Date().toISOString();
  pushOutcome(entry, 'ok');
  scheduleFlush();
}

function recordError(formatterName, info = {}) {
  if (!formatterName) return;
  hydrateOnce();
  const entry = ensureFormatter(formatterName);
  entry.errorCount += 1;
  entry.lastErrorAt = new Date().toISOString();
  pushOutcome(entry, 'err');

  const err = info.error || {};
  const log = {
    timestamp: entry.lastErrorAt,
    phase: info.phase || (info.workflow ? 'workflow' : 'format'),
    workflow: info.workflow || null,
    message: typeof err === 'string' ? err : (err.message || 'Unknown error'),
    stack: truncateStack(err && err.stack),
    params: info.params || null,
    tabId: info.tabId != null ? info.tabId : null
  };
  pushLog(entry, log);
  scheduleFlush();
}

function computeHealth(entry) {
  if (!entry) return 'unknown';
  const total = entry.successCount + entry.errorCount;
  if (total < 3) return 'healthy';
  const hasRecentError = entry.recentOutcomes.some((o) => o === 'err');
  return hasRecentError ? 'unhealthy' : 'healthy';
}

function statusForEntry(entry) {
  if (!entry) {
    return {
      health: 'unknown',
      lastError: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      successCount: 0,
      errorCount: 0
    };
  }
  const lastErrorLog = entry.logs.find((l) => l.phase === 'format' || l.phase === 'workflow') || null;
  return {
    health: computeHealth(entry),
    lastError: lastErrorLog
      ? { timestamp: lastErrorLog.timestamp, message: lastErrorLog.message, phase: lastErrorLog.phase, workflow: lastErrorLog.workflow }
      : null,
    lastSuccessAt: entry.lastSuccessAt,
    lastErrorAt: entry.lastErrorAt,
    successCount: entry.successCount,
    errorCount: entry.errorCount
  };
}

function getStatus(formatterName) {
  hydrateOnce();
  return statusForEntry(state.get(formatterName));
}

function getLogs(formatterName, limit = RING_CAPACITY) {
  hydrateOnce();
  const entry = state.get(formatterName);
  if (!entry) return [];
  return entry.logs.slice(0, Math.max(0, limit));
}

function listAll() {
  hydrateOnce();
  const out = new Map();
  for (const [name, entry] of state.entries()) {
    out.set(name, statusForEntry(entry));
  }
  return out;
}

function hydrateOnce() {
  if (hydrated) return;
  hydrated = true;
  try {
    const logPath = getLogPath();
    if (!fs.existsSync(logPath)) return;
    const raw = fs.readFileSync(logPath, 'utf8');
    const parsed = JSON.parse(raw);
    const cutoff = Date.now() - TTL_MS;
    for (const [name, snap] of Object.entries(parsed.formatters || {})) {
      const entry = ensureFormatter(name);
      entry.successCount = snap.successCount || 0;
      entry.errorCount = snap.errorCount || 0;
      entry.lastSuccessAt = snap.lastSuccessAt || null;
      entry.lastErrorAt = snap.lastErrorAt || null;
      entry.recentOutcomes = Array.isArray(snap.recentOutcomes) ? snap.recentOutcomes.slice(-10) : [];
      const logs = Array.isArray(snap.logs) ? snap.logs : [];
      entry.logs = logs.filter((l) => {
        if (!l || !l.timestamp) return false;
        const t = Date.parse(l.timestamp);
        return Number.isFinite(t) && t >= cutoff;
      }).slice(0, RING_CAPACITY);
    }
  } catch (e) {
    // Non-fatal — fall back to empty state and let the next flush overwrite.
    console.log(`[formatter-logs] hydrate failed: ${e.message}`);
  }
  installExitHandlers();
}

function scheduleFlush() {
  installExitHandlers();
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try { flush(); } catch (e) {
      console.log(`[formatter-logs] periodic flush failed: ${e.message}`);
    }
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive for this timer.
  if (flushTimer.unref) flushTimer.unref();
}

function flush() {
  hydrateOnce();
  try {
    const logPath = getLogPath();
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const cutoff = Date.now() - TTL_MS;
    const snapshot = { writtenAt: new Date().toISOString(), formatters: {} };
    for (const [name, entry] of state.entries()) {
      snapshot.formatters[name] = {
        successCount: entry.successCount,
        errorCount: entry.errorCount,
        lastSuccessAt: entry.lastSuccessAt,
        lastErrorAt: entry.lastErrorAt,
        recentOutcomes: entry.recentOutcomes,
        logs: entry.logs.filter((l) => {
          if (!l || !l.timestamp) return false;
          const t = Date.parse(l.timestamp);
          return Number.isFinite(t) && t >= cutoff;
        })
      };
    }
    fs.writeFileSync(logPath, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (e) {
    console.log(`[formatter-logs] flush failed: ${e.message}`);
  }
}

function installExitHandlers() {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  const handler = () => {
    try { flush(); } catch (e) { /* ignore on exit */ }
  };
  process.on('exit', handler);
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

// Test seam: clear in-memory state. Not exported on the public API.
function _resetForTests() {
  state.clear();
  hydrated = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

module.exports = {
  recordSuccess,
  recordError,
  getStatus,
  getLogs,
  listAll,
  flush,
  _resetForTests
};
