'use strict';

/**
 * Site policy resolver.
 *
 * Decides whether a given (agent, URL/domain) pair is allowed to be touched
 * by an MCP browser_* tool call. Backed by three tables in the shared SQLite
 * DB (see src/db/schema.sql):
 *
 *   - `agent_site_overrides`  per-agent (agent_id, domain) allow/block rows
 *   - `global_site_rules`     user-set OR baseline-blocked (domain, decision, source)
 *   - `baseline_blocklist_meta`  single-row meta about the auto-updated list
 *
 * Resolution order (highest precedence first):
 *
 *   1. agent_site_overrides   — exact match on the resolved domain
 *   2. agent_site_overrides   — suffix match on a parent registrable domain
 *   3. global_site_rules      — exact match (source: 'user' or 'baseline')
 *   4. global_site_rules      — suffix match (source: 'user' or 'baseline')
 *   5. default                — allow
 *
 * Suffix matching uses the public suffix list via `psl`, so a rule on
 * `chase.com` correctly covers `www.chase.com`, `secure.chase.com`, etc.,
 * but a rule on `secure.chase.com` only covers exactly that subdomain and
 * its descendants.
 *
 * The exported helpers are intentionally synchronous (better-sqlite3 is
 * sync). They're cheap enough to call in the hot path of every browser_*
 * MCP tool dispatch.
 */

const psl = require('psl');
const dbModule = require('./db/connection');

/**
 * Normalize a URL or bare-hostname string into a canonical lowercased
 * domain with no scheme, no port, and no leading `www.`. Returns null if
 * the input doesn't parse to a usable hostname.
 *
 * Examples:
 *   normalizeDomain('https://www.chase.com/login?x=1') → 'chase.com'
 *   normalizeDomain('CHASE.COM:443')                   → 'chase.com'
 *   normalizeDomain('secure.chase.com')                → 'secure.chase.com'
 *   normalizeDomain('about:blank')                     → null
 *
 * @param {string} urlOrDomain
 * @returns {string|null}
 */
function normalizeDomain(urlOrDomain) {
  if (typeof urlOrDomain !== 'string' || urlOrDomain.length === 0) return null;
  let raw = urlOrDomain.trim();
  if (raw.length === 0) return null;

  // If it parses as a URL, take the hostname. Else treat the whole thing as
  // a bare hostname (possibly with port).
  let host = null;
  try {
    // Tolerate strings without a scheme by prefixing http:// when needed.
    const hasScheme = /^[a-z][a-z0-9+.\-]*:/i.test(raw);
    const u = new URL(hasScheme ? raw : `http://${raw}`);
    host = u.hostname;
  } catch (_e) {
    host = raw.split('/')[0].split(':')[0];
  }
  if (!host) return null;
  host = host.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  // Reject ip-literals and clearly-non-hostname things — we don't have
  // sensible rules for them and matching against a public-suffix list is
  // meaningless.
  if (!host.includes('.')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return host;
}

/**
 * Produce the chain of "candidate" domains to match against, in
 * most-specific → least-specific order. The first is the input domain
 * itself; the rest are progressively-shorter suffixes down to the
 * registrable domain (the result of psl.get).
 *
 * For `mail.example.co.uk` this yields:
 *   ['mail.example.co.uk', 'example.co.uk']
 *
 * For `example.com` it yields:
 *   ['example.com']
 *
 * Used by the rule lookup: a global rule on `chase.com` covers
 * `www.chase.com` because `chase.com` appears as the registrable suffix
 * candidate when resolving `www.chase.com`.
 */
function _suffixCandidates(domain) {
  if (!domain) return [];
  const candidates = [domain];
  let registrable = null;
  try {
    registrable = psl.get(domain);
  } catch (_e) {
    registrable = null;
  }
  // Walk subdomain components from left to right, dropping one at a time,
  // stopping at the registrable suffix. This produces the full chain of
  // intermediate suffixes (e.g. for a.b.c.example.com: a.b.c.example.com,
  // b.c.example.com, c.example.com, example.com).
  let cur = domain;
  while (cur && cur !== registrable && cur.includes('.')) {
    const dot = cur.indexOf('.');
    const next = cur.slice(dot + 1);
    if (!next || !next.includes('.')) break;
    cur = next;
    if (!candidates.includes(cur)) candidates.push(cur);
    if (registrable && cur === registrable) break;
  }
  if (registrable && !candidates.includes(registrable)) {
    candidates.push(registrable);
  }
  return candidates;
}

/**
 * Look up an agent_site_overrides row covering this domain (exact or
 * suffix). Returns the matching DB row or null.
 *
 * @param {number} agentId
 * @param {string} domain  normalized
 */
function _findAgentOverride(agentId, domain) {
  if (!agentId || !domain) return null;
  const db = dbModule.getDb();
  const stmt = db.prepare(
    'SELECT * FROM agent_site_overrides WHERE agent_id = ? AND domain = ?'
  );
  for (const candidate of _suffixCandidates(domain)) {
    const row = stmt.get(agentId, candidate);
    if (row) return row;
  }
  return null;
}

/**
 * Look up a global_site_rules row covering this domain (exact or suffix).
 * Returns the matching DB row or null. Rows with source='baseline' are
 * omitted when baseline_blocklist_enabled is false.
 */
function _findGlobalRule(domain) {
  if (!domain) return null;
  const includeBaseline = require('./blocklist-updater').isBaselineEnabled();
  const db = dbModule.getDb();
  const stmtAll = db.prepare('SELECT * FROM global_site_rules WHERE domain = ?');
  const stmtNoBaseline = db.prepare(
    "SELECT * FROM global_site_rules WHERE domain = ? AND source != 'baseline'"
  );
  const stmt = includeBaseline ? stmtAll : stmtNoBaseline;
  for (const candidate of _suffixCandidates(domain)) {
    const row = stmt.get(candidate);
    if (row) return row;
  }
  return null;
}

/**
 * Resolve the effective policy for a given (agentId, url/domain). Returns:
 *
 *   {
 *     allowed: boolean,
 *     decision: 'allow' | 'block',
 *     source: 'agent_override' | 'global_user' | 'baseline' | 'default',
 *     domain: string | null,         // normalized
 *     matchedDomain: string | null,  // the exact rule.domain that matched (null for default)
 *   }
 *
 * If the input doesn't parse to a usable hostname (e.g. `about:blank`,
 * `chrome://newtab/`), returns `{ allowed: true, source: 'default', ... }`
 * — non-HTTP URLs are not policy-managed.
 *
 * @param {number|null} agentId  may be null for unauthenticated callers — the
 *                               override lookup is then skipped.
 * @param {string} urlOrDomain
 */
function isAllowed(agentId, urlOrDomain) {
  const domain = normalizeDomain(urlOrDomain);
  if (!domain) {
    return {
      allowed: true,
      decision: 'allow',
      source: 'default',
      domain: null,
      matchedDomain: null,
    };
  }

  // 1+2. Agent override (exact then suffix).
  if (agentId) {
    const ovr = _findAgentOverride(agentId, domain);
    if (ovr) {
      return {
        allowed: ovr.decision === 'allow',
        decision: ovr.decision,
        source: 'agent_override',
        domain,
        matchedDomain: ovr.domain,
      };
    }
  }

  // 3+4. Global rule (exact then suffix). Distinguish user vs baseline.
  const global = _findGlobalRule(domain);
  if (global) {
    return {
      allowed: global.decision === 'allow',
      decision: global.decision,
      source: global.source === 'baseline' ? 'baseline' : 'global_user',
      domain,
      matchedDomain: global.domain,
    };
  }

  // 5. Default.
  return {
    allowed: true,
    decision: 'allow',
    source: 'default',
    domain,
    matchedDomain: null,
  };
}

/**
 * Same logic as `isAllowed` but returns the raw DB row that matched (or
 * null if none did). Useful for the webapp Sites page when it needs the
 * full row shape (created_at etc.).
 */
function getEffectiveRule(agentId, urlOrDomain) {
  const domain = normalizeDomain(urlOrDomain);
  if (!domain) return null;
  if (agentId) {
    const ovr = _findAgentOverride(agentId, domain);
    if (ovr) return { type: 'agent_override', row: ovr };
  }
  const global = _findGlobalRule(domain);
  if (global) return { type: 'global', row: global };
  return null;
}

/**
 * Return the merged view of rules visible to a specific agent — every
 * global rule plus every per-agent override (overrides win on the same
 * domain). Used by the webapp Sites page.
 *
 * Output shape (newest matter least):
 *   [{ domain, decision, source, scope: 'agent'|'global', createdAt, updatedAt? }]
 */
function getRulesForAgent(agentId) {
  const db = dbModule.getDb();
  const globalRows = db
    .prepare('SELECT * FROM global_site_rules ORDER BY domain ASC')
    .all();
  const overrideRows = agentId
    ? db
        .prepare(
          'SELECT * FROM agent_site_overrides WHERE agent_id = ? ORDER BY domain ASC'
        )
        .all(agentId)
    : [];

  const byDomain = new Map();
  for (const r of globalRows) {
    byDomain.set(r.domain, {
      domain: r.domain,
      decision: r.decision,
      source: r.source, // 'user' | 'baseline'
      scope: 'global',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  for (const r of overrideRows) {
    byDomain.set(r.domain, {
      domain: r.domain,
      decision: r.decision,
      source: 'agent',
      scope: 'agent',
      createdAt: r.created_at,
    });
  }
  return Array.from(byDomain.values()).sort((a, b) =>
    a.domain.localeCompare(b.domain)
  );
}

// ───────────────────────────────────────────────────────────────────────────
// CRUD helpers — thin wrappers around the writes. The Sites page in the
// webapp calls these via REST handlers in server.js.

function setGlobalRule(domain, decision, source = 'user') {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error(`Invalid domain: ${domain}`);
  if (decision !== 'allow' && decision !== 'block') {
    throw new Error(`Invalid decision: ${decision}`);
  }
  if (source !== 'user' && source !== 'baseline') {
    throw new Error(`Invalid source: ${source}`);
  }
  const db = dbModule.getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO global_site_rules (domain, decision, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       decision=excluded.decision,
       source=excluded.source,
       updated_at=excluded.updated_at`
  ).run(normalized, decision, source, nowIso, nowIso);
  return { domain: normalized, decision, source };
}

function removeGlobalRule(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  const db = dbModule.getDb();
  const res = db
    .prepare('DELETE FROM global_site_rules WHERE domain = ?')
    .run(normalized);
  return res.changes > 0;
}

function setAgentOverride(agentId, domain, decision) {
  if (!agentId) throw new Error('agentId required');
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error(`Invalid domain: ${domain}`);
  if (decision !== 'allow' && decision !== 'block') {
    throw new Error(`Invalid decision: ${decision}`);
  }
  const db = dbModule.getDb();
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_site_overrides (agent_id, domain, decision, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_id, domain) DO UPDATE SET decision=excluded.decision`
  ).run(agentId, normalized, decision, nowIso);
  return { agentId, domain: normalized, decision };
}

function removeAgentOverride(agentId, domain) {
  if (!agentId) return false;
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  const db = dbModule.getDb();
  const res = db
    .prepare(
      'DELETE FROM agent_site_overrides WHERE agent_id = ? AND domain = ?'
    )
    .run(agentId, normalized);
  return res.changes > 0;
}

/**
 * Resolve agent_id from an API key. Wraps paired-keys.validateKey + a row
 * lookup by api_key_hash. Returns null if the key is invalid or revoked.
 *
 * Kept here (rather than in paired-keys.js) so mcp-handler.js can fetch the
 * numeric agent_id without paired-keys.js needing a new public field on its
 * entry shape.
 */
function resolveAgentIdFromApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return null;
  let pairedKeys;
  try {
    pairedKeys = require('./paired-keys');
  } catch (_e) {
    return null;
  }
  const entry = pairedKeys.validateKey(apiKey);
  if (!entry) return null;
  // validateKey's `entry.key` is the api_key_hash (paired-keys.js comment
  // "rowToAgentEntry" explains this). Look up the agent row by that.
  const db = dbModule.getDb();
  const row = db
    .prepare("SELECT id FROM agents WHERE api_key_hash = ? AND state = 'active'")
    .get(entry.key);
  return row ? row.id : null;
}

module.exports = {
  // resolution
  isAllowed,
  getEffectiveRule,
  getRulesForAgent,
  normalizeDomain,
  // CRUD
  setGlobalRule,
  removeGlobalRule,
  setAgentOverride,
  removeAgentOverride,
  // helpers
  resolveAgentIdFromApiKey,
  // internal — exported for tests
  _suffixCandidates,
};
