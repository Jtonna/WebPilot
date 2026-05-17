/* WebPilot popup — minimal four-component layout.
 *
 * P2 phase 6. The popup is a status-and-escape-hatch panel:
 *   1. Connection dot + label
 *   2. Current tab domain + state pill
 *   3. Block/Allow toggle (global rule for the domain)
 *   4. Open dashboard link
 *
 * All admin lives in the webapp (`/ui/`). The popup reads the paired API
 * key + server URL from chrome.storage (written by the existing pairing
 * flow in background.js) and hits two server endpoints:
 *
 *   GET  /api/popup/state?tabUrl=<url>      — connection + current tab pill
 *   POST /api/popup/site-toggle             — flip the global rule
 */

'use strict';

// ────────────────────────── Helpers ──────────────────────────

function $(id) { return document.getElementById(id); }

const STATE_LABEL = {
  allowed: 'Allowed',
  blocked_baseline: 'Blocked (baseline)',
  blocked_user: 'Blocked (user)',
  allowed_override: 'Override: Allowed',
  blocked_override: 'Override: Blocked',
};

const CONN_LABEL = {
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

// Read chrome.storage.local as a promise. Used for apiKey, serverUrl, etc.
function readStorage(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (data) => resolve(data || {}));
    } catch (e) {
      resolve({});
    }
  });
}

// Query the currently-active tab. Returns the tab object or null.
function getActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// True if a URL is a normal http/https page we can have policy on. We skip
// chrome://, file://, about:, etc.
function isPolicyManagedUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  return /^https?:\/\//i.test(url);
}

// Derive an HTTP base URL from whatever the extension has stored as serverUrl
// (which may be ws://… from the WebSocket connect flow).
function deriveHttpBase(serverUrl) {
  if (typeof serverUrl !== 'string' || serverUrl.length === 0) {
    return 'http://localhost:3456';
  }
  return serverUrl
    .replace(/^ws:\/\//i, 'http://')
    .replace(/^wss:\/\//i, 'https://')
    .replace(/\/+$/, '');
}

// ────────────────────────── State + render ──────────────────────────

const state = {
  apiKey: null,
  serverUrl: null,
  httpBase: null,
  activeTabUrl: null,
  // Last server response.
  lastState: null,
};

function setConnection(connection, profileId, serverUrl) {
  const dot = $('conn-dot');
  const label = $('conn-label');
  const meta = $('conn-meta');
  const c = connection || 'disconnected';
  dot.setAttribute('data-state', c);
  label.textContent = CONN_LABEL[c] || 'Unknown';
  const parts = [];
  if (profileId) parts.push(profileId);
  if (serverUrl) parts.push(serverUrl);
  if (parts.length > 0) {
    meta.textContent = parts.join(' • ');
    meta.hidden = false;
  } else {
    meta.hidden = true;
    meta.textContent = '';
  }
}

function renderNoPolicyTab() {
  $('tab-section').hidden = true;
  $('tab-skip').hidden = false;
}

function renderTab(currentTab, agent) {
  $('tab-skip').hidden = true;
  $('tab-section').hidden = false;

  $('tab-domain').textContent = currentTab.domain;
  $('tab-domain').title = currentTab.url;

  const pill = $('tab-state-pill');
  const pillLabel = $('tab-state-label');
  pill.setAttribute('data-state', currentTab.state);
  pillLabel.textContent = STATE_LABEL[currentTab.state] || currentTab.state;

  const agentLine = $('tab-agent-line');
  if (agent && agent.name) {
    agentLine.textContent = 'Agent: ' + agent.name;
    agentLine.hidden = false;
  } else {
    agentLine.hidden = true;
  }

  // Button label: inverse of the current decision. Per the design doc, the
  // popup toggle ALWAYS sets a global user rule — per-agent overrides live
  // in the webapp.
  const btn = $('toggle-btn');
  const btnLabel = $('toggle-btn-label');
  const isAllowed = currentTab.decision === 'allow';
  btnLabel.textContent = isAllowed
    ? 'Block on this site (all agents)'
    : 'Allow on this site (all agents)';
  btn.dataset.nextAction = isAllowed ? 'block' : 'allow';
  btn.dataset.domain = currentTab.domain;
  btn.disabled = false;
  setTabError(null);
}

function setTabError(msg) {
  const el = $('tab-error');
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
  } else {
    el.hidden = false;
    el.textContent = msg;
  }
}

// ────────────────────────── Fetch wrappers ──────────────────────────

async function fetchPopupState() {
  if (!state.apiKey || !state.httpBase) {
    throw new Error('Not paired with WebPilot server. Pair an agent first.');
  }
  const url =
    state.httpBase +
    '/api/popup/state' +
    (state.activeTabUrl
      ? '?tabUrl=' + encodeURIComponent(state.activeTabUrl)
      : '');
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'X-API-Key': state.apiKey },
  });
  if (resp.status === 401) throw new Error('API key rejected.');
  if (!resp.ok) throw new Error('Server error ' + resp.status);
  return resp.json();
}

async function postSiteToggle(domain, action) {
  const resp = await fetch(state.httpBase + '/api/popup/site-toggle', {
    method: 'POST',
    headers: {
      'X-API-Key': state.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ domain, action }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || 'Toggle failed (' + resp.status + ')');
  }
  return resp.json();
}

// ────────────────────────── Top-level flow ──────────────────────────

async function loadAndRender() {
  // Pull paired identity + server URL from chrome.storage. These keys are
  // written by background.js' pairing/auto-connect flow — see CLAUDE.md
  // "Backwards compat" — and we are explicitly READ-ONLY here.
  const stored = await readStorage(['apiKey', 'serverUrl']);
  state.apiKey = stored.apiKey || null;
  state.serverUrl = stored.serverUrl || null;
  state.httpBase = deriveHttpBase(state.serverUrl);

  // Wire the dashboard link as soon as we know the base URL.
  $('dashboard-link').href = state.httpBase + '/ui/';

  // If we don't have an API key at all, the popup can't do its job — show a
  // disconnected dot, hide the tab section, point the user at the dashboard.
  if (!state.apiKey) {
    setConnection('disconnected', null, state.serverUrl);
    $('tab-section').hidden = true;
    $('tab-skip').hidden = false;
    $('tab-skip').querySelector('.wp-skip-text').textContent =
      'Not paired. Open dashboard to pair an agent.';
    return;
  }

  // Resolve the current tab URL. If it's not http(s), skip the per-tab UI.
  const tab = await getActiveTab();
  if (tab && tab.url && isPolicyManagedUrl(tab.url)) {
    state.activeTabUrl = tab.url;
  } else {
    state.activeTabUrl = null;
  }

  let data;
  try {
    data = await fetchPopupState();
  } catch (e) {
    setConnection('disconnected', null, state.serverUrl);
    $('tab-section').hidden = true;
    $('tab-skip').hidden = false;
    $('tab-skip').querySelector('.wp-skip-text').textContent = e.message;
    return;
  }

  state.lastState = data;
  setConnection(data.connection, data.profileId, state.serverUrl);

  if (!state.activeTabUrl) {
    renderNoPolicyTab();
    return;
  }
  if (!data.currentTab) {
    renderNoPolicyTab();
    return;
  }
  renderTab(data.currentTab, data.agent);
}

async function onToggleClick() {
  const btn = $('toggle-btn');
  const domain = btn.dataset.domain;
  const action = btn.dataset.nextAction;
  if (!domain || !action) return;
  btn.disabled = true;
  const prevLabel = $('toggle-btn-label').textContent;
  $('toggle-btn-label').textContent = 'Saving…';
  setTabError(null);
  try {
    await postSiteToggle(domain, action);
    await loadAndRender();
  } catch (e) {
    setTabError(e.message || 'Toggle failed');
    $('toggle-btn-label').textContent = prevLabel;
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('toggle-btn').addEventListener('click', onToggleClick);
  // Initial render. Errors inside loadAndRender are surfaced inline.
  loadAndRender().catch((e) => {
    setConnection('disconnected', null, null);
    setTabError(e && e.message ? e.message : String(e));
  });
});
