// Minimal fetch wrapper for the WebPilot UI API.
//
// All UI endpoints are mounted under `/api/ui/*` on the WebPilot server.
// In production the web UI is served by the same server (same origin) so
// the default base URL is empty. For local Next.js dev (`npm run dev`)
// callers can override via `setApiBaseUrl()`.

let API_BASE_URL = '';

export function setApiBaseUrl(url) {
  API_BASE_URL = url || '';
}

export function getApiBaseUrl() {
  return API_BASE_URL;
}

export async function apiFetch(path, options = {}) {
  const url = `${API_BASE_URL}${path}`;
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob)) {
    body = JSON.stringify(body);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  const res = await fetch(url, { ...options, headers, body });

  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const err = new Error(
      `apiFetch ${res.status} ${res.statusText} for ${path}`
    );
    err.status = res.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

// Convenience wrappers used by pages

export function getStatus() {
  return apiFetch('/api/ui/status');
}

// Build provenance — { ref, channel, version, builtAt }.
// Returns dev fallback when release-info.json is absent (local dev checkout).
export function getReleaseInfo() {
  return apiFetch('/api/ui/release');
}

export function approvePairing(pairingId, profileId, newProfileName) {
  const body = { profileId: profileId || null };
  if (profileId === '__new__' && newProfileName) {
    body.newProfileName = newProfileName;
  }
  return apiFetch(`/api/ui/pairings/${encodeURIComponent(pairingId)}/approve`, {
    method: 'POST',
    body,
  });
}

export function denyPairing(pairingId) {
  return apiFetch(`/api/ui/pairings/${encodeURIComponent(pairingId)}/deny`, {
    method: 'POST',
    body: {},
  });
}

export function createProfile(name) {
  return apiFetch('/api/ui/profiles', {
    method: 'POST',
    body: { name },
  });
}

// Direct UI agent creation: mints a paired-keys entry server-side without
// the request_pairing → approval round-trip. The server returns the freshly
// generated apiKey in the response body so the modal can substitute it into
// the copy-text. See POST /api/ui/agents in server.js.
export function createAgent(agentName, profileId) {
  return apiFetch('/api/ui/agents', {
    method: 'POST',
    body: { agentName, profileId },
  });
}

export function renameAgent(key, newName) {
  return apiFetch(`/api/ui/agents/${encodeURIComponent(key)}/rename`, {
    method: 'POST',
    body: { newName },
  });
}

export function revokeAgent(key) {
  return apiFetch(`/api/ui/agents/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

// Re-bind an existing agent to a different Chrome profile. The server flips
// the entry's profileId field; tool-call routing picks up the change on the
// next call (no socket teardown — see PATCH /api/ui/agents/:key in server.js).
export function updateAgentProfile(key, profileId) {
  return apiFetch(`/api/ui/agents/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    body: { profileId },
  });
}

export function setNetworkMode(enabled) {
  return apiFetch('/api/ui/settings/network-mode', {
    method: 'POST',
    body: { enabled },
  });
}

// Pairings history. Cursor-paginated.
//
//   getPairingHistory({ cursor, limit }) -> { entries, nextCursor }
//
// Pass `cursor` from the previous response to fetch the next page; pass null
// or omit for the first page. `limit` defaults to 50, max 200.
export function getPairingHistory({ cursor = null, limit = 50 } = {}) {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  return apiFetch(`/api/ui/pairings/history${qs ? `?${qs}` : ''}`);
}

// Notification settings.
export function getNotificationSettings() {
  return apiFetch('/api/ui/settings/notifications');
}

export function setNotificationSettings(partial) {
  return apiFetch('/api/ui/settings/notifications', {
    method: 'POST',
    body: partial || {},
  });
}

// Chrome action. One endpoint handles "restart with flag" and "launch fresh"
// via chromeManager.ensureReady.
export function restartChrome() {
  return apiFetch('/api/ui/chrome/restart', {
    method: 'POST',
    body: {},
  });
}

// Server restart. Fire-and-forget — the response may arrive before the daemon
// exits, or the connection may drop mid-request. Callers should not rely on
// the resolved value.
export function restartServer() {
  return apiFetch('/api/ui/server/restart', {
    method: 'POST',
    body: {},
  });
}

// Formatters observability.
//
// `getFormatters()` returns `{ formatters: [...] }` where each item fuses the
// per-formatter manifest (name, version, source, match, workflows) with the
// runtime health summary (health, successCount, errorCount, lastSuccessAt,
// lastErrorAt, lastError). Powers the Formatters tab list.
//
// `getFormatterLogs(name, limit)` returns the recent ring-buffer entries for
// a single formatter:
//   { name, status: { health, lastSuccessAt, lastErrorAt, ... }, logs: [...] }
export function getFormatters() {
  return apiFetch('/api/ui/formatters');
}

export function getFormatterLogs(name, limit = 50) {
  return apiFetch(
    `/api/ui/formatters/${encodeURIComponent(name)}/logs?limit=${limit}`
  );
}

// Dismiss a single formatter incident from the dashboard's action-items list.
// Dismiss is per-incident — each row in `formatter_incidents` gets its own
// dismiss timestamp. The Action Items entry exposes the latest undismissed
// incident's id under `lastError.id`; pass that here.
export function dismissIncident(incidentId) {
  return apiFetch(`/api/ui/incidents/${encodeURIComponent(incidentId)}/dismiss`, {
    method: 'POST',
    body: {},
  });
}

// Bulk-dismiss every undismissed incident for a formatter. Wired to the
// Action Items header's "Dismiss all from <formatter>" button.
export function dismissAllForFormatter(name) {
  return apiFetch(`/api/ui/formatters/${encodeURIComponent(name)}/dismiss-all`, {
    method: 'POST',
    body: {},
  });
}

// ────────────────────────────────────────────────────────────────────────
// Sites
//
// CRUD over the site-policy tables (global_site_rules and
// agent_site_overrides) plus the baseline-pack on/off toggle.
//
// All helpers follow the existing convention: throw on non-2xx, return the
// parsed JSON body otherwise. The Sites page subscribes to the
// `sites_changed` WebSocket event to refetch after any write.

// GET /api/ui/sites — returns { globalRules: [...], baseline: {...} }.
export function getSites() {
  return apiFetch('/api/ui/sites');
}

// POST /api/ui/sites — body { domain, decision: 'allow'|'block' }. Returns
// the new (or upserted) row { domain, decision, source, createdAt, updatedAt }.
export function createSiteRule({ domain, decision }) {
  return apiFetch('/api/ui/sites', {
    method: 'POST',
    body: { domain, decision },
  });
}

// DELETE /api/ui/sites/:domain — removes a user-source rule. Server refuses
// baseline rows with a 400; the caller should treat the error message as
// authoritative for the toast text.
export function deleteSiteRule(domain) {
  return apiFetch(`/api/ui/sites/${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  });
}

// GET /api/ui/agents/:agentId/site-overrides — agentId is the api_key_hash
// returned by getStatus().pairedAgents[i].key. Returns an array of
// { domain, decision, createdAt }.
export function getAgentSiteOverrides(agentId) {
  return apiFetch(`/api/ui/agents/${encodeURIComponent(agentId)}/site-overrides`);
}

// POST /api/ui/agents/:agentId/site-overrides — body { domain, decision }.
export function setAgentSiteOverride(agentId, { domain, decision }) {
  return apiFetch(
    `/api/ui/agents/${encodeURIComponent(agentId)}/site-overrides`,
    { method: 'POST', body: { domain, decision } }
  );
}

// DELETE /api/ui/agents/:agentId/site-overrides/:domain
export function deleteAgentSiteOverride(agentId, domain) {
  return apiFetch(
    `/api/ui/agents/${encodeURIComponent(agentId)}/site-overrides/${encodeURIComponent(domain)}`,
    { method: 'DELETE' }
  );
}

// POST /api/ui/sites/baseline/toggle — body { enabled: bool }. Returns
// { enabled, baseline: { enabled, version, lastFetchedAt, domainCount } }.
export function toggleBaselineBlocklist(enabled) {
  return apiFetch('/api/ui/sites/baseline/toggle', {
    method: 'POST',
    body: { enabled: !!enabled },
  });
}

// Race guard for pages that refresh from BOTH REST and WS events.
//
// Without this, a slow REST `refresh()` issued before a WS event lands can
// resolve AFTER the WS-triggered `refresh()` and clobber the fresher state
// with stale data. The fix is a per-fetcher monotonically-increasing
// sequence number: each `fetch` call gets the next id, and the caller
// discards the response if a newer call has been issued in the meantime.
//
// Usage:
//   const f = createSequencedFetcher();
//   async function refresh() {
//     const { data, isStale } = await f.fetch(() => getStatus());
//     if (isStale) return;
//     setState(data);
//   }
//
// The fetcher returns `{ data, isStale, seq }`. `isStale === true` means
// another `fetch()` was started while this one was in flight; the caller
// should discard `data` and NOT commit it to state.
export function createSequencedFetcher() {
  let nextSeq = 0;
  let latestStartedSeq = 0;

  async function fetchSeq(fn) {
    const seq = ++nextSeq;
    latestStartedSeq = seq;
    const data = await fn();
    const isStale = seq !== latestStartedSeq;
    return { data, isStale, seq };
  }

  return {
    fetch: fetchSeq,
    latest: () => latestStartedSeq,
  };
}
