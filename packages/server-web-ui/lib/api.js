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

export function approvePairing(pairingId, profileId) {
  return apiFetch(`/api/ui/pairings/${encodeURIComponent(pairingId)}/approve`, {
    method: 'POST',
    body: { profileId: profileId || null },
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
