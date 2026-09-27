'use strict';

/**
 * Web UI routes for the site policy event log.
 *
 *   GET  /api/ui/sites/events                          (auth)
 *        Query: agentId (api_key_hash), decision ('allow'|'block'),
 *        limit, cursor. Returns site-policy-events.list() as-is.
 *   POST /api/ui/agents/:agentId/site-events/allow     (auth, mutatingAuth)
 *   POST /api/ui/agents/:agentId/site-events/revoke    (auth, mutatingAuth)
 *        Body {domain}. Upserts a per-agent rule ('allow' / 'block')
 *        for the exact domain. Revoke always writes 'block' (overwriting a
 *        same-domain allow in place); it never deletes. The actions never
 *        touch site_policy_events rows, and no event row is required.
 *
 * `agentIdFromKey(key)` maps the webapp's agent key (api_key_hash) to the
 * numeric agents.id of an ACTIVE agent, or a falsy value.
 */

const express = require('express');
const sitePolicy = require('./site-policy');
const sitePolicyEvents = require('./site-policy-events');
const dbModule = require('./db/connection');

function _invalidDomainReason(domain) {
  return (
    `${JSON.stringify(domain)} cannot be the target of a per-agent rule ` +
    '(IP addresses and single-label hosts such as localhost are only covered by a "*" rule)'
  );
}

function mountSiteEventRoutes(app, { auth, mutatingAuth, broadcastUiEvent, agentIdFromKey }) {
  function _broadcast(reason) {
    try {
      broadcastUiEvent && broadcastUiEvent({ type: 'sites_changed', reason });
    } catch (_e) { /* ignore */ }
  }

  // GET /api/ui/sites/events
  app.get('/api/ui/sites/events', auth, (req, res) => {
    try {
      const q = req.query || {};
      let agentId = null;
      if (q.agentId !== undefined && q.agentId !== '') {
        agentId = agentIdFromKey(String(q.agentId));
        if (!agentId) return res.status(404).json({ error: 'agent not found' });
      }
      let decision = null;
      if (q.decision !== undefined && q.decision !== '') {
        if (q.decision !== 'allow' && q.decision !== 'block') {
          return res.status(400).json({
            error: 'invalid decision',
            reason: `decision must be "allow" or "block", got ${JSON.stringify(q.decision)}`,
          });
        }
        decision = q.decision;
      }
      const cursor = q.cursor !== undefined && q.cursor !== '' ? String(q.cursor) : null;
      const limit = q.limit !== undefined ? q.limit : undefined;
      let result;
      try {
        result = sitePolicyEvents.list({ agentId, decision, limit, cursor });
      } catch (e) {
        if (e && e.code === 'INVALID_CURSOR') {
          return res.status(400).json({ error: 'invalid cursor', reason: e.message });
        }
        if (e && e.code === 'INVALID_DECISION') {
          return res.status(400).json({ error: 'invalid decision', reason: e.message });
        }
        throw e;
      }
      res.json(result);
    } catch (e) {
      console.error('[ui-api] GET /sites/events failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  function _mountAction(action, decision) {
    const route = `/api/ui/agents/:agentId/site-events/${action}`;
    app.post(route, auth, mutatingAuth, express.json(), (req, res) => {
      try {
        const agentId = agentIdFromKey(req.params.agentId);
        if (!agentId) return res.status(404).json({ error: 'agent not found' });
        const rawDomain = req.body ? req.body.domain : undefined;
        const normalized =
          typeof rawDomain === 'string' ? sitePolicy.normalizeRuleDomain(rawDomain) : null;
        if (!normalized) {
          return res.status(400).json({
            error: 'invalid domain',
            reason: _invalidDomainReason(rawDomain),
          });
        }
        sitePolicy.setAgentRule(agentId, normalized, decision);
        const row = dbModule
          .getDb()
          .prepare('SELECT created_at FROM agent_site_rules WHERE agent_id = ? AND domain = ?')
          .get(agentId, normalized);
        console.log(
          `[ui-api:sites] site-event ${action} agentId=${agentId} domain=${normalized}`
        );
        _broadcast(`site_event_${action}`);
        res.status(201).json({
          agentKey: req.params.agentId,
          domain: normalized,
          decision,
          createdAt: row ? row.created_at : null,
        });
      } catch (e) {
        console.error(`[ui-api] POST /agents/:agentId/site-events/${action} failed:`, e.message);
        res.status(500).json({ error: e.message });
      }
    });
  }

  _mountAction('allow', 'allow');
  _mountAction('revoke', 'block');
}

module.exports = { mountSiteEventRoutes };
