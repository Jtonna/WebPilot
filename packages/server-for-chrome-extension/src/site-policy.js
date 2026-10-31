'use strict';

/**
 * Site policy resolver.
 *
 * Decides whether a given (agent, URL/domain) pair may be touched by an MCP
 * browser_* tool call. Backed by per-tier tables in the shared SQLite DB
 * (see src/db/schema.sql); each tier owns its own table, so a row in one
 * tier can never mask or overwrite a row in another:
 *
 *   - `agent_site_rules`             per-agent rules tier. `domain` is a normalized
 *                                    domain or the literal '*' (the agent's
 *                                    default decision for every site).
 *   - `global_user_site_rules`       global tier, rules the user set by hand
 *                                    (allow or block, exact domains only).
 *   - `global_site_blocklist_rules`  global tier, domains from the signed
 *                                    global site blocklist (block-only).
 *
 * Resolution order in `isAllowed` (first match wins; tiers beat
 * specificity, so a broad rule in a higher tier beats a narrow rule in a
 * lower one):
 *
 *   1. Agent tier (only when an agentId is known): named rows walked from
 *      most to least specific suffix, then the agent's '*' row. A named
 *      rule beats '*' regardless of decision.
 *   2. Global user tier   - `global_user_site_rules`, suffix walk.
 *   3. Signed tier        - `global_site_blocklist_rules`, suffix walk -> block.
 *   4. Default            - allow.
 *
 * Toggle: the config key `global_tier_enabled` switches tiers 2 AND 3 off
 * together. A missing key means enabled; a config read error also means
 * enabled (fail-open to "global tier on", preserving pre-#102 behavior).
 * The agent tier is never affected by the toggle.
 *
 * Hosts that are not a registrable domain (IP literals, `localhost`,
 * other dotless hosts) cannot match named rules, but a network URL
 * (http/https/ws/wss or scheme-less) with such a host still matches the
 * agent's '*' row. Non-network URLs (`about:`, `chrome:`, `data:`,
 * `file:`, empty) are never policy-managed and always default-allow.
 * Hosts containing '*' never match anything, including '*' rows.
 *
 * Suffix matching uses the public suffix list via `psl`, so a rule on
 * `chase.com` covers `www.chase.com`, `secure.chase.com`, etc., while a
 * rule on `secure.chase.com` covers only that subdomain and its
 * descendants.
 *
 * Return contract of `isAllowed` (frozen):
 *   { allowed, decision: 'allow'|'block',
 *     source: 'agent_rule'|'global_user'|'global_site_blocklist'|'default',
 *     domain: string|null, matchedDomain: string|null }
 * `matchedDomain` is the stored domain of the matching rule ('*' for a
 * wildcard match), null for default.
 *
 * All helpers are synchronous (better-sqlite3 is sync) and cheap enough for
 * the hot path of every browser_* MCP tool dispatch.
 */

const psl = require('psl');
const dbModule = require('./db/connection');

const WILDCARD = '*';
const GLOBAL_TIER_ENABLED_KEY = 'global_tier_enabled';
const NETWORK_SCHEMES = new Set(['http', 'https', 'ws', 'wss']);

/**
 * Parse input into { host, scheme } where scheme is null for scheme-less
 * input. `host` is lowercased with IPv6 brackets stripped; may be ''.
 * Returns null for unusable input.
 */
function _parseHost(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0) return null;

  // `host:port` (e.g. `localhost:3000`, `chase.com:443`) looks like a
  // scheme to the URL parser; treat a purely numeric "path" as a port.
  const m = /^([a-z][a-z0-9+.\-]*):(.*)$/i.exec(raw);
  const hasScheme = !!m && !/^\d+(?:[/?#]|$)/.test(m[2]);
  const scheme = hasScheme ? m[1].toLowerCase() : null;

  let host;
  try {
    const u = new URL(hasScheme ? raw : `http://${raw}`);
    host = u.hostname;
  } catch (_e) {
    if (hasScheme) return null;
    host = raw.split(/[/?#]/)[0];
    if (host.startsWith('[')) host = host.slice(0, host.indexOf(']') + 1);
    else host = host.split(':')[0];
  }
  host = (host || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { host, scheme };
}

/**
 * Normalize a URL or bare-hostname string into a canonical lowercased
 * domain with no scheme, no port, and no leading `www.`. Returns null if
 * the input doesn't parse to a registrable-looking hostname: IP literals,
 * dotless hosts (`localhost`), and any host containing '*'.
 *
 * Examples:
 *   normalizeDomain('https://www.chase.com/login?x=1') -> 'chase.com'
 *   normalizeDomain('CHASE.COM:443')                   -> 'chase.com'
 *   normalizeDomain('secure.chase.com')                -> 'secure.chase.com'
 *   normalizeDomain('about:blank')                     -> null
 *   normalizeDomain('*.foo.com')                       -> null
 *
 * @param {string} urlOrDomain
 * @returns {string|null}
 */
function normalizeDomain(urlOrDomain) {
  const parsed = _parseHost(urlOrDomain);
  if (!parsed) return null;
  let host = parsed.host;
  if (!host) return null;
  if (host.includes('*')) return null;
  if (host.includes(':')) return null; // IPv6 literal
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host.includes('.')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return host;
}

/**
 * Normalize a domain for storage as a rule. With `allowWildcard`, the
 * exact input '*' (after trim) yields '*'; everything else goes through
 * normalizeDomain.
 *
 * @param {string} input
 * @param {{allowWildcard?: boolean}} [opts]
 * @returns {string|null}
 */
function normalizeRuleDomain(input, { allowWildcard = false } = {}) {
  if (allowWildcard && typeof input === 'string' && input.trim() === WILDCARD) {
    return WILDCARD;
  }
  return normalizeDomain(input);
}

/**
 * Lowercased hostname for network URLs whose host normalizeDomain rejects
 * (IP literals, `localhost`, ...). Only http/https/ws/wss or scheme-less
 * input qualifies; returns null for other schemes, empty hosts, and hosts
 * containing '*'.
 */
function _networkHost(input) {
  const parsed = _parseHost(input);
  if (!parsed || !parsed.host) return null;
  if (parsed.scheme !== null && !NETWORK_SCHEMES.has(parsed.scheme)) return null;
  if (parsed.host.includes('*')) return null;
  return parsed.host;
}

/**
 * Produce the chain of "candidate" domains to match against, in
 * most-specific -> least-specific order, down to the registrable domain
 * (psl.get).
 *
 *   'mail.example.co.uk' -> ['mail.example.co.uk', 'example.co.uk']
 *   'example.com'        -> ['example.com']
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

function _firstMatch(stmt, prefixArgs, domain) {
  for (const candidate of _suffixCandidates(domain)) {
    const row = stmt.get(...prefixArgs, candidate);
    if (row) return row;
  }
  return null;
}

function _agentWildcardRow(db, agentId) {
  return db
    .prepare('SELECT * FROM agent_site_rules WHERE agent_id = ? AND domain = ?')
    .get(agentId, WILDCARD);
}

function _verdict(decision, source, domain, matchedDomain) {
  return { allowed: decision === 'allow', decision, source, domain, matchedDomain };
}

function _default(domain) {
  return _verdict('allow', 'default', domain, null);
}

// ---------------------------------------------------------------------------
// Global tier toggle

function isGlobalTierEnabled() {
  try {
    const row = dbModule
      .getDb()
      .prepare('SELECT value FROM config WHERE key = ?')
      .get(GLOBAL_TIER_ENABLED_KEY);
    if (!row || typeof row.value !== 'string') return true;
    return row.value !== 'false' && row.value !== '0';
  } catch (e) {
    console.log(`[site-policy] isGlobalTierEnabled lookup failed: ${e.message}`);
    return true;
  }
}

function setGlobalTierEnabled(enabled) {
  const value = enabled ? 'true' : 'false';
  dbModule
    .getDb()
    .prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    )
    .run(GLOBAL_TIER_ENABLED_KEY, value, new Date().toISOString());
  return value === 'true';
}

// ---------------------------------------------------------------------------
// Resolution

/**
 * Resolve the effective policy for (agentId, url/domain). See the header
 * comment for precedence and the return contract.
 *
 * @param {number|null} agentId  null for unauthenticated callers; the
 *                               agent tier is then skipped.
 * @param {string} urlOrDomain
 */
function isAllowed(agentId, urlOrDomain) {
  const db = dbModule.getDb();
  const domain = normalizeDomain(urlOrDomain);

  if (!domain) {
    const host = _networkHost(urlOrDomain);
    if (host && agentId) {
      const wc = _agentWildcardRow(db, agentId);
      if (wc) return _verdict(wc.decision, 'agent_rule', host, WILDCARD);
    }
    return _default(host || null);
  }

  // Agent tier: named (most -> least specific), then '*'.
  if (agentId) {
    const named = _firstMatch(
      db.prepare('SELECT * FROM agent_site_rules WHERE agent_id = ? AND domain = ?'),
      [agentId],
      domain
    );
    const row = named || _agentWildcardRow(db, agentId);
    if (row) return _verdict(row.decision, 'agent_rule', domain, row.domain);
  }

  if (!isGlobalTierEnabled()) return _default(domain);

  // Global user tier.
  const user = _firstMatch(
    db.prepare('SELECT * FROM global_user_site_rules WHERE domain = ?'),
    [],
    domain
  );
  if (user) return _verdict(user.decision, 'global_user', domain, user.domain);

  // Signed tier (block-only).
  const signed = _firstMatch(
    db.prepare('SELECT * FROM global_site_blocklist_rules WHERE domain = ?'),
    [],
    domain
  );
  if (signed) return _verdict('block', 'global_site_blocklist', domain, signed.domain);

  return _default(domain);
}

// ---------------------------------------------------------------------------
// Global tier reads

/**
 * Every global rule from both tables, ordered by source then domain.
 * The same domain may appear once per source.
 *
 * @returns {Array<{domain, decision, source: 'user'|'global_site_blocklist', createdAt, updatedAt}>}
 */
function listGlobalRules() {
  const rows = dbModule
    .getDb()
    .prepare(
      `SELECT domain, decision, 'user' AS source, created_at, updated_at
         FROM global_user_site_rules
       UNION ALL
       SELECT domain, 'block' AS decision, 'global_site_blocklist' AS source,
              created_at, created_at AS updated_at
         FROM global_site_blocklist_rules
       ORDER BY source ASC, domain ASC`
    )
    .all();
  return rows.map((r) => ({
    domain: r.domain,
    decision: r.decision,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Exact-match lookup in the global user tier. Returns null when absent. */
function getGlobalUserRule(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;
  const r = dbModule
    .getDb()
    .prepare('SELECT * FROM global_user_site_rules WHERE domain = ?')
    .get(normalized);
  if (!r) return null;
  return {
    domain: r.domain,
    decision: r.decision,
    source: 'user',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Exact-match check against the signed blocklist tier. */
function isSignedBlocklisted(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  return !!dbModule
    .getDb()
    .prepare('SELECT 1 FROM global_site_blocklist_rules WHERE domain = ?')
    .get(normalized);
}

// ---------------------------------------------------------------------------
// CRUD helpers. The signed tier is written only by the blocklist updater.

function _checkDecision(decision) {
  if (decision !== 'allow' && decision !== 'block') {
    throw new Error(`Invalid decision: ${decision}`);
  }
}

/** Upsert a rule in the global user tier. Wildcards are rejected. */
function setGlobalRule(domain, decision) {
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error(`Invalid domain: ${domain}`);
  _checkDecision(decision);
  const nowIso = new Date().toISOString();
  dbModule
    .getDb()
    .prepare(
      `INSERT INTO global_user_site_rules (domain, decision, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         decision=excluded.decision,
         updated_at=excluded.updated_at`
    )
    .run(normalized, decision, nowIso, nowIso);
  return { domain: normalized, decision, source: 'user' };
}

/** Delete a global user rule. Returns whether a row was deleted. */
function removeGlobalRule(domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized) return false;
  const res = dbModule
    .getDb()
    .prepare('DELETE FROM global_user_site_rules WHERE domain = ?')
    .run(normalized);
  return res.changes > 0;
}

/** Upsert a per-agent rule. `domain` may be '*'. */
function setAgentRule(agentId, domain, decision) {
  if (!agentId) throw new Error('agentId required');
  const normalized = normalizeRuleDomain(domain, { allowWildcard: true });
  if (!normalized) throw new Error(`Invalid domain: ${domain}`);
  _checkDecision(decision);
  dbModule
    .getDb()
    .prepare(
      `INSERT INTO agent_site_rules (agent_id, domain, decision, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id, domain) DO UPDATE SET decision=excluded.decision`
    )
    .run(agentId, normalized, decision, new Date().toISOString());
  return { agentId, domain: normalized, decision };
}

/** Delete a per-agent rule. `domain` may be '*'. */
function removeAgentRule(agentId, domain) {
  if (!agentId) return false;
  const normalized = normalizeRuleDomain(domain, { allowWildcard: true });
  if (!normalized) return false;
  const res = dbModule
    .getDb()
    .prepare('DELETE FROM agent_site_rules WHERE agent_id = ? AND domain = ?')
    .run(agentId, normalized);
  return res.changes > 0;
}

/**
 * Resolve agent_id from a plaintext API key via paired-keys.validateKey.
 * Returns null if the key is invalid or revoked.
 *
 * validateKey returns the agent's non-secret row `id` directly (since #129),
 * so no secondary hash lookup is needed.
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
  return entry && entry.id !== undefined && entry.id !== null ? entry.id : null;
}

module.exports = {
  // resolution
  isAllowed,
  normalizeDomain,
  normalizeRuleDomain,
  WILDCARD,
  // global tier toggle
  GLOBAL_TIER_ENABLED_KEY,
  isGlobalTierEnabled,
  setGlobalTierEnabled,
  // global tier reads
  listGlobalRules,
  getGlobalUserRule,
  isSignedBlocklisted,
  // CRUD
  setGlobalRule,
  removeGlobalRule,
  setAgentRule,
  removeAgentRule,
  // helpers
  resolveAgentIdFromApiKey,
  // internal, exported for tests
  _suffixCandidates,
};
