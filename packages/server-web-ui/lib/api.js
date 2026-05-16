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

export function setNetworkMode(enabled) {
  return apiFetch('/api/ui/settings/network-mode', {
    method: 'POST',
    body: { enabled },
  });
}

// Pairings history (Phase 3 A). Cursor-paginated.
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

// Notification settings (Phase 3 B).
export function getNotificationSettings() {
  return apiFetch('/api/ui/settings/notifications');
}

export function setNotificationSettings(partial) {
  return apiFetch('/api/ui/settings/notifications', {
    method: 'POST',
    body: partial || {},
  });
}

// Chrome action (Phase 3 D). One endpoint handles "restart with flag" and
// "launch fresh" via chromeManager.ensureReady.
export function restartChrome() {
  return apiFetch('/api/ui/chrome/restart', {
    method: 'POST',
    body: {},
  });
}

// Server restart (Phase 3 D3). Fire-and-forget — the response may arrive
// before the daemon exits, or the connection may drop mid-request. Callers
// should not rely on the resolved value.
export function restartServer() {
  return apiFetch('/api/ui/server/restart', {
    method: 'POST',
    body: {},
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
// should discard `data` and NOT commit it to state. See QOL Wave 6 H2.
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
