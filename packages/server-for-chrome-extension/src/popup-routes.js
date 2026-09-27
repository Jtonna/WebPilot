'use strict';

/**
 * Extension popup routes.
 *
 *   GET  /api/popup/state?tabUrl=<url>
 *        Connection status + current-tab policy state + dashboard URL.
 *   POST /api/popup/site-toggle   { domain, action: 'block' | 'allow' }
 *        (`decision` is accepted as an alias for `action`; `action` wins
 *        when both are present.) Upserts a GLOBAL user rule through the
 *        same shared write path the Sites page uses (global-user-rules.js),
 *        so validation, error strings and rule semantics are identical.
 *
 * Auth: the popup identifies itself with `X-Install-Id` — the same
 * installId the extension sent on its WS upgrade. The server resolves
 * installId -> profileId via the `extension_installs` table. No paired
 * agent is required for popup operations; the popup is profile-scoped
 * (global site policy + connection status), not agent-scoped.
 */

const express = require('express');
const sitePolicy = require('./site-policy');
const { upsertGlobalUserRule } = require('./global-user-rules');

// Map a global-only policy verdict into the single state-pill key consumed
// by the popup UI: 'allowed' | 'blocked_global_site_blocklist' |
// 'blocked_user'. The popup resolves policy with no agent context, so the
// agent tier never contributes here.
function _statePillFromPolicy(policy) {
  if (policy.decision === 'allow') return 'allowed';
  if (policy.source === 'global_site_blocklist') return 'blocked_global_site_blocklist';
  return 'blocked_user';
}

function mountPopupRoutes(app, { extensionInstalls, extensionBridge, broadcastUiEvent, port }) {
  // Extract installId from the request and resolve it to a profileId.
  // Returns { installId, profileId } on success, or null on failure.
  // Supports X-Install-Id header (preferred) or `installId` query param.
  //
  // Origin gate: the popup endpoints are designed
  // to be called from the extension popup (origin chrome-extension://…).
  // If a request carries a webpage Origin (http(s)://…), refuse it — that
  // would be a malicious site running in any Chrome profile trying to
  // reach the loopback API. Server-side callers (no Origin header) and
  // chrome-extension:// origins are allowed through.
  function _authPopup(req) {
    const origin = (req.headers && req.headers.origin) || '';
    if (origin && /^https?:\/\//i.test(origin)) {
      console.log(`[popup-auth] rejecting — disallowed web Origin "${origin}"`);
      return null;
    }
    const installId =
      req.headers['x-install-id'] ||
      req.headers['X-Install-Id'] ||
      (req.query && req.query.installId) ||
      null;
    if (typeof installId !== 'string' || installId.length === 0) return null;
    // Cap installId length defensively.
    if (installId.length > 256) {
      console.log(`[popup-auth] rejecting — installId exceeds max length (${installId.length})`);
      return null;
    }
    let profileId = null;
    try {
      profileId = extensionInstalls.getProfileForInstall(installId);
    } catch (e) {
      console.log(`[popup-auth] getProfileForInstall threw: ${e && e.message}`);
      return null;
    }
    if (!profileId) {
      console.log(
        `[popup-auth] rejecting — unknown installId="${installId.slice(0, 8)}..."`
      );
      return null;
    }
    return { installId, profileId };
  }

  // GET /api/popup/state?tabUrl=<url>
  // The popup operates in profile-context (no agent identity) — global
  // site rules apply; per-agent rules do not. `agent` is always null.
  app.get('/api/popup/state', (req, res) => {
    const auth = _authPopup(req);
    if (!auth) return res.status(401).json({ error: 'unauthorized' });
    const { profileId } = auth;
    const connection = extensionBridge.isConnected(profileId)
      ? 'connected'
      : 'disconnected';

    const tabUrlRaw = (req.query && req.query.tabUrl) || null;
    let currentTab = null;
    // 8 KB is well above any real URL; reject anything longer rather than
    // pushing oversized inputs through URL/normalizeDomain.
    if (typeof tabUrlRaw === 'string' && tabUrlRaw.length > 8192) {
      console.log(`[popup:state] rejecting oversized tabUrl (${tabUrlRaw.length} bytes)`);
      return res.status(400).json({ error: 'tabUrl too long' });
    }
    if (typeof tabUrlRaw === 'string' && tabUrlRaw.length > 0) {
      const domain = sitePolicy.normalizeDomain(tabUrlRaw);
      if (domain) {
        // No agent context — pass null so the policy resolves global-only
        // (no agent_site_rules applied).
        const policy = sitePolicy.isAllowed(null, tabUrlRaw);
        currentTab = {
          url: tabUrlRaw,
          domain,
          state: _statePillFromPolicy(policy),
          source: policy.source,
          decision: policy.decision,
          matchedDomain: policy.matchedDomain ?? null,
        };
      }
    }

    const proto = (req.headers && req.headers['x-forwarded-proto']) || 'http';
    const hostHdr = (req.headers && req.headers.host) || `localhost:${port}`;
    const serverUrl = `${proto}://${hostHdr}`;

    const body = {
      connection,
      profileId,
      agent: null,
      serverUrl,
      globalTierEnabled: sitePolicy.isGlobalTierEnabled(),
    };
    if (currentTab) body.currentTab = currentTab;
    return res.json(body);
  });

  // POST /api/popup/site-toggle  { domain, action: 'block' | 'allow' }
  // Sets a GLOBAL user rule for the domain (per the locked design decision —
  // the popup's toggle is the "no AI touches this site" fast button; per-
  // agent rules live on the webapp Sites page).
  app.post('/api/popup/site-toggle', express.json(), (req, res) => {
    try {
      const auth = _authPopup(req);
      if (!auth) return res.status(401).json({ error: 'unauthorized' });
      const { installId, profileId } = auth;
      const body = req.body || {};
      const action = body.action ?? body.decision;
      const domainRaw = body.domain;
      // Cap raw domain length before normalization — domain RFC max is 253;
      // 512 leaves plenty of slack for URL-shaped inputs without exposing
      // the URL parser to multi-megabyte strings.
      if (typeof domainRaw === 'string' && domainRaw.length > 512) {
        return res.status(400).json({ error: 'domain too long' });
      }
      const r = upsertGlobalUserRule({ domain: domainRaw, decision: action });
      if (!r.ok) return res.status(r.status).json(r.body);
      const domain = r.rule.domain;
      // Audit attribution: log the originating installId + bound profileId
      // (no agentId — popup is not in agent context).
      console.log(
        `[popup:site-toggle] domain="${domain}" action="${action}" ` +
          `installId="${installId.slice(0, 8)}..." profileId="${profileId}"`
      );
      // Compute new pill state (global-only, no agent rule).
      const policy = sitePolicy.isAllowed(null, domain);
      const newState = _statePillFromPolicy(policy);
      // Tell the webapp Sites page (and any other UI consumer) the rule list
      // changed. Same event name the Sites admin routes emit.
      try {
        broadcastUiEvent && broadcastUiEvent({ type: 'sites_changed', reason: 'popup_toggle' });
      } catch (_e) { /* non-fatal */ }
      return res.json({
        ok: true,
        domain,
        decision: action,
        newState,
        globalTierEnabled: sitePolicy.isGlobalTierEnabled(),
        source: policy.source,
        policyDecision: policy.decision,
      });
    } catch (e) {
      console.error('[popup] POST /api/popup/site-toggle failed:', e);
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  mountPopupRoutes,
  _statePillFromPolicy,
};
