'use strict';

/**
 * Single write path for global user site rules (the `global_user_site_rules`
 * table via site-policy.js). Both the Site Policy page routes
 * (POST/DELETE /api/ui/site-policy/global-rules) and the extension popup route call through
 * here so validation, error strings, and response shapes stay identical no
 * matter which surface triggers the write.
 */

const sitePolicy = require('./site-policy');

/**
 * Upsert a rule in the global user tier.
 *
 * @param {{domain: any, decision: any}} params
 * @returns {{ok: true, effect: 'upsert', rule: object} | {ok: false, status: number, body: object}}
 */
function upsertGlobalUserRule({ domain: rawDomain, decision } = {}) {
  if (typeof rawDomain === 'string' && rawDomain.trim() === sitePolicy.WILDCARD) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid domain',
        reason: "wildcard ('*') rules are per-agent only — add them under Per-agent rules on the Site Policy page",
      },
    };
  }

  const normalized = sitePolicy.normalizeDomain(rawDomain);
  if (!normalized) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid domain',
        reason: `domain ${JSON.stringify(rawDomain)} did not normalize to a usable hostname`,
      },
    };
  }

  if (decision !== 'allow' && decision !== 'block') {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid decision',
        reason: "decision must be 'allow' or 'block'",
      },
    };
  }

  const result = sitePolicy.setGlobalRule(normalized, decision);
  // Read back the persisted row so we include created_at / updated_at.
  const row = sitePolicy.getGlobalUserRule(result.domain);
  return {
    ok: true,
    effect: 'upsert',
    rule: {
      domain: row ? row.domain : result.domain,
      decision: row ? row.decision : result.decision,
      source: 'user',
      createdAt: row ? row.createdAt : null,
      updatedAt: row ? row.updatedAt : null,
    },
  };
}

/**
 * Remove a rule from the global user tier.
 *
 * Only removes rows in the global user tier (`global_user_site_rules`).
 * Refuses signed-blocklist entries with a 400 and a message that nudges
 * the caller toward the global tier toggle in Settings.
 *
 * @param {any} rawDomain
 * @returns {{ok: true, effect: 'delete', domain: string} | {ok: false, status: number, body: object}}
 */
function clearGlobalUserRule(rawDomain) {
  const normalized = sitePolicy.normalizeDomain(rawDomain);
  if (!normalized) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid domain',
        reason: `domain ${JSON.stringify(rawDomain)} did not normalize to a usable hostname`,
      },
    };
  }

  if (sitePolicy.getGlobalUserRule(normalized)) {
    sitePolicy.removeGlobalRule(normalized);
    return { ok: true, effect: 'delete', domain: normalized };
  }

  if (sitePolicy.isSignedBlocklisted(normalized)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'cannot delete signed blocklist rule',
        reason:
          "signed block list entries can't be deleted; turn off the global block list on the Site Policy page",
        domain: normalized,
        source: 'global_site_blocklist',
      },
    };
  }

  return { ok: false, status: 404, body: { error: 'rule not found', domain: normalized } };
}

module.exports = {
  upsertGlobalUserRule,
  clearGlobalUserRule,
};
