'use strict';

/**
 * Site policy event log.
 *
 * Records one deduplicated row per (agent, domain) that an agent's browser_*
 * calls were checked against (see `site_policy_events` in src/db/schema.sql).
 * A repeat check bumps `hit_count` / `last_seen_at` and overwrites the
 * verdict fields in place; there are no history rows.
 *
 *   record(agentId, verdict, {now})  upsert from a site-policy verdict
 *                                    ({allowed, decision, source, domain,
 *                                    matchedDomain}). Never throws.
 *   list({agentId, decision, limit, cursor})
 *                                    newest-first page, keyset-paginated by
 *                                    (last_seen_at, id). Revoked agents are
 *                                    excluded; numeric ids are never exposed.
 *   cleanup({maxAgeDays, maxRows, now})
 *                                    prune by age, then by row cap.
 *   events                           EventEmitter; emits 'changed' with
 *                                    {reason: 'created'|'decision_changed'|
 *                                    'verdict_changed'|'retention', ...}.
 *                                    A plain hit bump never emits.
 */

const { EventEmitter } = require('events');
const dbModule = require('./db/connection');
const sitePolicy = require('./site-policy');

const LOG_PREFIX = '[site-policy-events]';
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_ROWS = 5000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const DECISIONS = new Set(['allow', 'block']);
const SOURCES = new Set(['agent_rule', 'global_user', 'global_site_blocklist', 'default']);

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

// Prepared statements, keyed on the DB handle they were prepared against so
// swapping the connection (tests) never reuses a stale statement.
let stmtCache = null; // { db, stmts }

function _stmts(db) {
  if (stmtCache && stmtCache.db === db) return stmtCache.stmts;
  const stmts = {
    select: db.prepare(
      `SELECT id, decision, source, matched_domain
         FROM site_policy_events
        WHERE agent_id = ? AND domain = ?`
    ),
    insert: db.prepare(
      `INSERT INTO site_policy_events
         (agent_id, domain, decision, source, matched_domain,
          first_seen_at, last_seen_at, decision_changed_at, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ),
    updateSame: db.prepare(
      `UPDATE site_policy_events
          SET last_seen_at = ?, hit_count = hit_count + 1,
              decision = ?, source = ?, matched_domain = ?
        WHERE id = ?`
    ),
    updateFlip: db.prepare(
      `UPDATE site_policy_events
          SET last_seen_at = ?, hit_count = hit_count + 1,
              decision = ?, source = ?, matched_domain = ?,
              decision_changed_at = ?
        WHERE id = ?`
    ),
  };
  stmtCache = { db, stmts };
  return stmts;
}

function _resolveDecision(verdict) {
  if (typeof verdict.decision === 'string') return verdict.decision;
  if (typeof verdict.allowed === 'boolean') return verdict.allowed ? 'allow' : 'block';
  return null;
}

/**
 * Upsert the event row for (agentId, verdict.domain).
 *
 * @param {number} agentId
 * @param {{allowed?: boolean, decision?: string, source: string,
 *          domain: string, matchedDomain?: string|null}} verdict
 * @param {{now?: Date}} [opts]
 * @returns {{created: boolean, decisionChanged: boolean, verdictChanged: boolean}|null}
 *          null when nothing was recorded (guard or error). Never throws.
 */
function record(agentId, verdict, { now = new Date() } = {}) {
  try {
    if (!agentId || !verdict) return null;
    const domain = verdict.domain;
    if (typeof domain !== 'string' || domain.length === 0) return null;
    const decision = _resolveDecision(verdict);
    if (!DECISIONS.has(decision)) return null;
    const source = verdict.source;
    if (!SOURCES.has(source)) {
      console.warn(`${LOG_PREFIX} record skipped: unknown source ${JSON.stringify(source)}`);
      return null;
    }
    const matchedDomain = verdict.matchedDomain == null ? null : String(verdict.matchedDomain);
    const nowIso = now.toISOString();

    const db = dbModule.getDb();
    const stmts = _stmts(db);

    const result = db.transaction(() => {
      const existing = stmts.select.get(agentId, domain);
      if (!existing) {
        stmts.insert.run(agentId, domain, decision, source, matchedDomain, nowIso, nowIso, nowIso);
        return { created: true, decisionChanged: false, verdictChanged: false };
      }
      if (existing.decision !== decision) {
        stmts.updateFlip.run(nowIso, decision, source, matchedDomain, nowIso, existing.id);
        return { created: false, decisionChanged: true, verdictChanged: true };
      }
      stmts.updateSame.run(nowIso, decision, source, matchedDomain, existing.id);
      const verdictChanged =
        existing.source !== source || (existing.matched_domain ?? null) !== matchedDomain;
      return { created: false, decisionChanged: false, verdictChanged };
    })();

    if (result.created) {
      emitter.emit('changed', { reason: 'created', agentId, domain });
    } else if (result.decisionChanged) {
      emitter.emit('changed', { reason: 'decision_changed', agentId, domain });
    } else if (result.verdictChanged) {
      emitter.emit('changed', { reason: 'verdict_changed', agentId, domain });
    }
    return result;
  } catch (e) {
    console.warn(`${LOG_PREFIX} record failed: ${e && e.message}`);
    return null;
  }
}

/**
 * Prune rows older than `maxAgeDays` (by last_seen_at), then trim to the
 * newest `maxRows` (ordered by last_seen_at DESC, id DESC).
 *
 * @returns {{removedByAge: number, removedByCap: number, removed: number, kept: number}}
 */
function cleanup({
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  maxRows = DEFAULT_MAX_ROWS,
  now = new Date(),
} = {}) {
  let db;
  try {
    db = dbModule.getDb();
  } catch (_e) {
    return { removedByAge: 0, removedByCap: 0, removed: 0, kept: 0 };
  }
  const cutoffIso = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const removedByAge = db
    .prepare('DELETE FROM site_policy_events WHERE last_seen_at < ?')
    .run(cutoffIso).changes;
  const removedByCap = db
    .prepare(
      `DELETE FROM site_policy_events
        WHERE id IN (SELECT id FROM site_policy_events
                      ORDER BY last_seen_at DESC, id DESC
                      LIMIT -1 OFFSET ?)`
    )
    .run(Math.max(0, Math.floor(maxRows))).changes;
  const kept = db.prepare('SELECT COUNT(*) AS c FROM site_policy_events').get().c;
  const removed = removedByAge + removedByCap;
  if (removed > 0) {
    console.log(
      `${LOG_PREFIX} cleanup removed=${removed} (age=${removedByAge}, cap=${removedByCap}) ` +
        `kept=${kept} (maxAgeDays=${maxAgeDays}, maxRows=${maxRows})`
    );
    emitter.emit('changed', { reason: 'retention' });
  }
  return { removedByAge, removedByCap, removed, kept };
}

function _codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function _parseCursor(cursor) {
  const bad = () => _codedError('invalid cursor', 'INVALID_CURSOR');
  if (typeof cursor !== 'string') throw bad();
  const sep = cursor.lastIndexOf('|');
  if (sep <= 0) throw bad();
  const ts = cursor.slice(0, sep);
  const idStr = cursor.slice(sep + 1);
  if (!/^\d+$/.test(idStr)) throw bad();
  const id = Number(idStr);
  if (!Number.isSafeInteger(id) || id <= 0) throw bad();
  return { ts, id };
}

/**
 * Newest-first page of events for active agents.
 *
 * @param {{agentId?: number|null, decision?: 'allow'|'block'|null,
 *          limit?: number, cursor?: string|null}} [opts]
 * @returns {{entries: object[], hasMore: boolean, nextCursor: string|null}}
 * @throws {Error} with .code 'INVALID_CURSOR' or 'INVALID_DECISION'
 */
function list({ agentId = null, decision = null, limit = DEFAULT_LIST_LIMIT, cursor = null } = {}) {
  let lim = Math.floor(Number(limit));
  if (!Number.isFinite(lim) || lim <= 0) lim = DEFAULT_LIST_LIMIT;
  lim = Math.min(lim, MAX_LIST_LIMIT);

  if (decision !== null && decision !== undefined && !DECISIONS.has(decision)) {
    throw _codedError(`invalid decision: ${decision}`, 'INVALID_DECISION');
  }
  const parsedCursor = cursor === null || cursor === undefined ? null : _parseCursor(cursor);

  const where = [];
  const params = [];
  if (agentId !== null && agentId !== undefined) {
    where.push('e.agent_id = ?');
    params.push(agentId);
  }
  if (decision) {
    where.push('e.decision = ?');
    params.push(decision);
  }
  if (parsedCursor) {
    where.push('(e.last_seen_at < ? OR (e.last_seen_at = ? AND e.id < ?))');
    params.push(parsedCursor.ts, parsedCursor.ts, parsedCursor.id);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const sql = `
    SELECT e.id, e.domain, e.decision, e.source, e.matched_domain,
           e.first_seen_at, e.last_seen_at, e.decision_changed_at, e.hit_count,
           e.agent_id AS agent_id, a.name AS agent_name,
           r.decision AS agent_rule_decision
      FROM site_policy_events e
      JOIN agents a ON a.id = e.agent_id AND a.state = 'active'
      LEFT JOIN agent_site_rules r ON r.agent_id = e.agent_id AND r.domain = e.domain
     ${whereSql}
     ORDER BY e.last_seen_at DESC, e.id DESC
     LIMIT ?`;
  params.push(lim + 1);

  const rows = dbModule.getDb().prepare(sql).all(...params);
  const hasMore = rows.length > lim;
  const page = hasMore ? rows.slice(0, lim) : rows;
  const last = page[page.length - 1];

  const entries = page.map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    domain: r.domain,
    decision: r.decision,
    source: r.source,
    matchedDomain: r.matched_domain ?? null,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    decisionChangedAt: r.decision_changed_at,
    hitCount: r.hit_count,
    actionable: sitePolicy.normalizeRuleDomain(r.domain) !== null,
    agentRuleDecision: r.agent_rule_decision ?? null,
  }));

  return {
    entries,
    hasMore,
    nextCursor: hasMore && last ? `${last.last_seen_at}|${last.id}` : null,
  };
}

/** Test seam: drop cached prepared statements and all 'changed' listeners. */
function _resetForTests() {
  stmtCache = null;
  emitter.removeAllListeners();
}

module.exports = {
  record,
  list,
  cleanup,
  events: emitter,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MAX_ROWS,
  _resetForTests,
};
