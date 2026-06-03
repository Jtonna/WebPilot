/* WebPilot popup — status-and-escape-hatch panel.
 *
 * Four components:
 *   1. Connection dot + label
 *   2. Current tab domain + state pill
 *   3. Block/Allow toggle (global rule for the domain)
 *   4. Open dashboard link
 *
 * All admin lives in the webapp (`/ui/`). The popup reads installId +
 * server URL from chrome.storage (written by background.js' auto-connect
 * flow) and hits two server endpoints:
 *
 *   GET  /api/popup/state?tabUrl=<url>      — connection + current tab pill
 *   POST /api/popup/site-toggle             — flip the global rule
 *
 * Defensive rendering rule: never show a partially-bound row. Either we
 * have everything we need to draw the pill + toggle button (`currentTab`
 * with a known `state` and a `decision`), or the entire tab section stays
 * hidden and the skip surface carries a human-readable reason. No dashes,
 * no ellipses, no half-bound buttons.
 */

'use strict';

// ────────────────────────── Helpers ──────────────────────────

function $(id) { return document.getElementById(id); }

// Server-side _statePillFromPolicy emits exactly these five keys. Anything
// else triggers the fallback path (skip section, no pill).
const STATE_LABEL = {
  allowed: 'Allowed',
  blocked_global_site_blocklist: 'Blocked (global blocklist)',
  blocked_user: 'Blocked (user)',
  allowed_override: 'Override · Allowed',
  blocked_override: 'Override · Blocked',
};

const CONN_LABEL = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
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
// chrome://, file://, about:, etc. Loopback hosts (localhost, 127.0.0.1) are
// also skipped — the agent can never be asked to drive the dashboard itself,
// so showing a policy pill there is misleading.
function isPolicyManagedUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
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

// True if currentTab from the server is fully-formed: it has a known state
// label and a decision we can invert into the toggle action. Anything less
// than that, we treat as missing and hide the row entirely.
function isRenderableTab(currentTab) {
  if (!currentTab || typeof currentTab !== 'object') return false;
  if (typeof currentTab.domain !== 'string' || !currentTab.domain) return false;
  if (typeof currentTab.state !== 'string' || !(currentTab.state in STATE_LABEL)) {
    return false;
  }
  if (currentTab.decision !== 'allow' && currentTab.decision !== 'block') {
    return false;
  }
  return true;
}

// ────────────────────────── State + render ──────────────────────────

const state = {
  installId: null,
  serverUrl: null,
  httpBase: null,
  activeTabUrl: null,
  // Last server response.
  lastState: null,
};

function setConnection(connection, profileId) {
  const dot = $('conn-dot');
  const label = $('conn-label');
  const meta = $('conn-meta');
  const c = (connection in CONN_LABEL) ? connection : 'disconnected';
  dot.setAttribute('data-state', c);
  label.textContent = CONN_LABEL[c];
  // Secondary line: profile name only. Server URL is intentionally NOT shown
  // here — it would crowd the 320px popup and adds no actionable info; the
  // dashboard link in the footer is the canonical "where is this server?".
  if (typeof profileId === 'string' && profileId.length > 0) {
    meta.textContent = profileId;
    meta.hidden = false;
  } else {
    meta.hidden = true;
    meta.textContent = '';
  }
}

function showSkip(text) {
  $('tab-section').hidden = true;
  $('tab-skip').hidden = false;
  $('tab-skip-text').textContent = text;
}

function hideSkip() {
  $('tab-skip').hidden = true;
  $('tab-skip-text').textContent = '';
}

function renderTab(currentTab, agent) {
  hideSkip();
  $('tab-section').hidden = false;

  $('tab-domain').textContent = currentTab.domain;
  $('tab-domain').title = currentTab.url || currentTab.domain;

  const pill = $('tab-state-pill');
  const pillLabel = $('tab-state-label');
  pill.setAttribute('data-state', currentTab.state);
  pillLabel.textContent = STATE_LABEL[currentTab.state];

  const agentLine = $('tab-agent-line');
  if (agent && agent.name) {
    agentLine.textContent = 'Agent: ' + agent.name;
    agentLine.hidden = false;
  } else {
    agentLine.hidden = true;
    agentLine.textContent = '';
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
  btn.hidden = false;
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
  if (!state.installId || !state.httpBase) {
    throw new Error('Extension has no installId yet — reload the extension.');
  }
  const url =
    state.httpBase +
    '/api/popup/state' +
    (state.activeTabUrl
      ? '?tabUrl=' + encodeURIComponent(state.activeTabUrl)
      : '');
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'X-Install-Id': state.installId },
  });
  if (resp.status === 401) throw new Error('Install ID not recognized by server.');
  if (!resp.ok) throw new Error('Server error ' + resp.status);
  return resp.json();
}

async function postSiteToggle(domain, action) {
  const resp = await fetch(state.httpBase + '/api/popup/site-toggle', {
    method: 'POST',
    headers: {
      'X-Install-Id': state.installId,
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
  // Pull installId + server URL from chrome.storage. These keys are written
  // by background.js' auto-connect flow — and we are explicitly READ-ONLY
  // here. The installId is the extension's per-profile identity (used as
  // `X-Install-Id` for popup endpoint auth).
  const stored = await readStorage(['webpilot.installId', 'serverUrl']);
  state.installId = stored['webpilot.installId'] || null;
  state.serverUrl = stored.serverUrl || null;
  state.httpBase = deriveHttpBase(state.serverUrl);

  // Wire the dashboard link as soon as we know the base URL.
  $('dashboard-link').href = state.httpBase + '/ui/';

  // No installId → the popup can't talk to the server. Show a disconnected
  // dot and point the user at the dashboard.
  if (!state.installId) {
    setConnection('disconnected', null);
    showSkip('Extension has no installId. Reload the extension in chrome://extensions/.');
    return;
  }

  // Resolve the current tab URL. If it's not http(s) or it's a loopback
  // host, we won't ask the server for a per-tab policy.
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
    setConnection('disconnected', null);
    showSkip(e.message || 'Could not reach the WebPilot server.');
    return;
  }

  state.lastState = data;
  setConnection(data.connection, data.profileId);

  if (!state.activeTabUrl) {
    // Tab is unsupported (chrome://, file://, localhost, etc.). Explain
    // briefly so the user knows it's expected, not broken.
    showSkip(
      tab && typeof tab.url === 'string' && tab.url.length > 0
        ? 'Site policy doesn’t apply to this page.'
        : 'No active tab.'
    );
    return;
  }

  if (!isRenderableTab(data.currentTab)) {
    // Server didn't return a usable currentTab (no agent paired, unknown
    // state value, malformed payload). Fall back to a clean skip surface
    // rather than rendering a half-bound button.
    showSkip('No policy data for this page yet.');
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
  $('toggle-btn-label').textContent = 'Saving';
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
    setConnection('disconnected', null);
    setTabError(e && e.message ? e.message : String(e));
  });
});
