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
 * When /api/popup/state answers 401 (the server has not matched this Chrome
 * profile yet) the tab section is replaced by a profile picker built from
 * chrome.storage.local `webpilot.knownProfiles`. A pick is sent to the
 * background as { type: 'reidentify', profileId }; the background is the only
 * writer of `webpilot.profileId`, the popup stays read-only on storage.
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

// Server-side _statePillFromPolicy emits exactly these three keys. Anything
// else triggers the fallback path (skip section, no pill). Human-readable
// labels are derived from state + source in labelForTab() below — this map
// only defines the valid state set.
const STATE_LABEL = {
  allowed: 'Allowed',
  blocked_global_site_blocklist: 'Blocked (global block list)',
  blocked_user: 'Blocked (user)',
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
  activeTab: null,
  // 'picker' while /api/popup/state is 401 (profile not matched yet), else 'main'.
  view: 'main',
  // True from a pick until the poll resolves; the picker is inert meanwhile.
  pickerBusy: false,
};

const REGISTERED_CONFIRM_COPY =
  'This profile already has an extension registered. Only pick it if you are using WebPilot from that profile right now.';
const NOT_REGISTERED_COPY =
  "WebPilot hasn't matched this Chrome profile yet. Choose it below, or open the WebPilot dashboard to finish setup.";
const IN_USE_COPY =
  'Another WebPilot connection is active for that profile. Pick a different one, or close the other WebPilot window.';
const PICK_TIMEOUT_COPY =
  'Still waiting — the profile may be in use or the server is busy. Try again.';
const PICK_POLL_INTERVAL_MS = 500;
const PICK_POLL_TIMEOUT_MS = 8000;

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

// Human-readable pill label for a given state + source. The dot color still
// comes from data-state (success/danger) in CSS; this only picks the text.
function labelForTab(state, source) {
  if (state === 'allowed') {
    return source === 'global_user' ? 'Allowed (your rule)' : 'Allowed';
  }
  if (state === 'blocked_user') return 'Blocked (your rule)';
  if (state === 'blocked_global_site_blocklist') return 'Blocked (global block list)';
  return STATE_LABEL[state] || state;
}

const TIER_OFF_NOTE =
  "Global rules are off — this toggle won't apply until they're turned back on in the dashboard.";

function renderTab(data) {
  const currentTab = data.currentTab;
  hideSkip();
  $('tab-section').hidden = false;

  $('tab-domain').textContent = currentTab.domain;
  $('tab-domain').title = currentTab.url || currentTab.domain;

  const pill = $('tab-state-pill');
  const pillLabel = $('tab-state-label');
  pill.setAttribute('data-state', currentTab.state);
  pillLabel.textContent = labelForTab(currentTab.state, currentTab.source);

  // "Rule on <matchedDomain>" — only when the server tells us the matching
  // rule lives on a different (usually parent) domain than the tab itself.
  const matchedEl = $('tab-matched-domain');
  if (
    typeof currentTab.matchedDomain === 'string' &&
    currentTab.matchedDomain &&
    currentTab.matchedDomain !== currentTab.domain
  ) {
    matchedEl.textContent = 'Rule on ' + currentTab.matchedDomain;
    matchedEl.hidden = false;
  } else {
    matchedEl.hidden = true;
    matchedEl.textContent = '';
  }

  // Missing globalTierEnabled (older server) defaults to enabled.
  const globalTierEnabled = data.globalTierEnabled !== false;
  const tierNote = $('tab-tier-note');
  if (!globalTierEnabled) {
    tierNote.textContent = TIER_OFF_NOTE;
    tierNote.hidden = false;
  } else {
    tierNote.hidden = true;
    tierNote.textContent = '';
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
  btn.disabled = !globalTierEnabled;
  btn.title = globalTierEnabled ? '' : TIER_OFF_NOTE;
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
  if (resp.status === 401) {
    // The server has no install -> profile mapping yet; the popup offers a picker.
    const err = new Error(NOT_REGISTERED_COPY);
    err.code = 'not_registered';
    throw err;
  }
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
    throw new Error(body.reason || body.error || 'Toggle failed (' + resp.status + ')');
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

  state.activeTab = tab;

  let data;
  try {
    data = await fetchPopupState();
  } catch (e) {
    setConnection('disconnected', null);
    if (e && e.code === 'not_registered') {
      // The policy section stays hidden until the profile is matched.
      await renderPicker();
      return;
    }
    hidePicker();
    showSkip(e.message || 'Could not reach the WebPilot server.');
    return;
  }

  renderLoaded(data);
}

// Render a successful /api/popup/state response (the normal, registered view).
function renderLoaded(data) {
  const tab = state.activeTab;
  hidePicker();
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

  renderTab(data);
}

// ────────────────────────── Profile picker ──────────────────────────

function setPickerMessage(text, kind) {
  const el = $('picker-msg');
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.setAttribute('data-kind', kind || 'info');
  el.hidden = false;
}

function hidePicker() {
  state.view = 'main';
  state.pickerBusy = false;
  $('picker-section').hidden = true;
  $('picker-list').textContent = '';
  setPickerMessage(null);
}

// Suggested (nobody connected, never registered) first, then registered-but-
// idle (reinstall case), then connected profiles (disabled, "in use").
function pickerRank(p) {
  if (p.connected) return 2;
  return p.registered ? 1 : 0;
}

function normalizeProfiles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p.directoryName === 'string' && p.directoryName.length > 0)
    .map((p, i) => ({
      directoryName: p.directoryName,
      displayName:
        typeof p.displayName === 'string' && p.displayName ? p.displayName : p.directoryName,
      connected: p.connected === true,
      registered: p.registered === true,
      order: i,
    }))
    .sort((a, b) => pickerRank(a) - pickerRank(b) || a.order - b.order);
}

function buildPickerRow(p) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wp-picker-row';
  btn.dataset.inUse = p.connected ? '1' : '';
  btn.disabled = p.connected;
  btn.title = p.displayName + ' (' + p.directoryName + ')';

  const text = document.createElement('span');
  text.className = 'wp-picker-text';
  const name = document.createElement('span');
  name.className = 'wp-picker-name';
  name.textContent = p.displayName;
  // Display names can repeat; the directory name is what disambiguates.
  const dir = document.createElement('span');
  dir.className = 'wp-picker-dir';
  dir.textContent = p.directoryName;
  text.appendChild(name);
  text.appendChild(dir);
  btn.appendChild(text);

  // Older servers omit `registered`; normalizeProfiles maps that to false, so
  // those rows stay one-click.
  const needsConfirm = !p.connected && p.registered;
  {
    const tag = document.createElement('span');
    tag.className = 'wp-picker-tag';
    tag.dataset.kind = p.connected ? 'in-use' : needsConfirm ? 'registered' : 'suggested';
    tag.textContent = p.connected ? 'in use' : needsConfirm ? 'Already registered' : 'Suggested';
    btn.appendChild(tag);
  }
  li.appendChild(btn);

  if (needsConfirm) {
    // Picking an already-registered profile from the wrong Chrome profile binds
    // this install to it, so ask first (inline; window.confirm is unreliable in popups).
    const confirm = document.createElement('div');
    confirm.className = 'wp-picker-confirm';
    confirm.hidden = true;
    const msg = document.createElement('p');
    msg.className = 'wp-picker-confirm-text';
    msg.textContent = REGISTERED_CONFIRM_COPY;
    const actions = document.createElement('div');
    actions.className = 'wp-picker-confirm-actions';
    const replace = document.createElement('button');
    replace.type = 'button';
    replace.className = 'wp-picker-confirm-btn';
    replace.dataset.kind = 'replace';
    replace.textContent = 'Replace';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'wp-picker-confirm-btn';
    cancel.textContent = 'Cancel';
    actions.appendChild(replace);
    actions.appendChild(cancel);
    confirm.appendChild(msg);
    confirm.appendChild(actions);
    li.appendChild(confirm);

    btn.addEventListener('click', () => {
      if (state.pickerBusy) return;
      collapsePickerConfirms();
      confirm.hidden = false;
    });
    cancel.addEventListener('click', () => { confirm.hidden = true; });
    replace.addEventListener('click', () => {
      collapsePickerConfirms();
      onPickProfile(p.directoryName);
    });
  } else {
    btn.addEventListener('click', () => onPickProfile(p.directoryName));
  }
  return li;
}

function collapsePickerConfirms() {
  document.querySelectorAll('#picker-list .wp-picker-confirm').forEach((el) => {
    el.hidden = true;
  });
}

// Show the picker built from chrome.storage.local `webpilot.knownProfiles`.
// `message` (optional) is a { text, kind } shown under the list.
async function renderPicker(message) {
  state.view = 'picker';
  $('tab-section').hidden = true;
  hideSkip();
  $('picker-section').hidden = false;
  $('picker-copy').textContent = NOT_REGISTERED_COPY;

  const stored = await readStorage(['webpilot.knownProfiles']);
  const profiles = normalizeProfiles(stored['webpilot.knownProfiles']);
  const list = $('picker-list');
  list.textContent = '';
  profiles.forEach((p) => list.appendChild(buildPickerRow(p)));
  // Until the server lists profiles, say so; storage.onChanged re-renders.
  $('picker-waiting').hidden = profiles.length > 0;
  setPickerMessage(message ? message.text : null, message ? message.kind : null);
  setPickerDisabled(state.pickerBusy);
}

// Disable every row while a pick is in flight; otherwise only in-use rows stay off.
function setPickerDisabled(busy) {
  document.querySelectorAll('#picker-list .wp-picker-row').forEach((btn) => {
    btn.disabled = busy || btn.dataset.inUse === '1';
  });
  document.querySelectorAll('#picker-list .wp-picker-confirm-btn').forEach((btn) => {
    btn.disabled = busy;
  });
}

// Best-effort read of the background's connection-state mirror.
function readConnectionState() {
  return new Promise((resolve) => {
    try {
      chrome.storage.session.get('webpilot.connectionState', (data) =>
        resolve((data && data['webpilot.connectionState']) || null)
      );
    } catch (e) {
      resolve(null);
    }
  });
}

// Ask the background to adopt a profile (it is the only writer of profileId).
function sendReidentify(profileId) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'reidentify', profileId }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { success: false, error: 'No response from the extension.' });
        }
      });
    } catch (e) {
      resolve({ success: false, error: (e && e.message) || 'Could not reach the extension.' });
    }
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function onPickProfile(profileId) {
  if (state.pickerBusy) return;
  state.pickerBusy = true;
  setPickerDisabled(true);
  setPickerMessage('Connecting…', 'info');
  const startedAt = Date.now();

  const reply = await sendReidentify(profileId);
  if (!reply.success) {
    state.pickerBusy = false;
    setPickerDisabled(false);
    setPickerMessage(reply.error || 'Could not select that profile.', 'error');
    return;
  }

  // The popup endpoint turns 200 once the server maps this install to the
  // picked profile (after hello_ack). Poll it; watch the background's
  // connection state to explain a refusal.
  while (Date.now() - startedAt < PICK_POLL_TIMEOUT_MS) {
    await sleep(PICK_POLL_INTERVAL_MS);
    try {
      const data = await fetchPopupState();
      state.pickerBusy = false;
      renderLoaded(data);
      return;
    } catch (e) {
      if (!e || e.code !== 'not_registered') {
        state.pickerBusy = false;
        await renderPicker({ text: (e && e.message) || 'Could not reach the WebPilot server.', kind: 'error' });
        return;
      }
    }
    const conn = await readConnectionState();
    // Ignore a mirror written before this pick (e.g. an older refusal).
    if (conn && conn.updatedAt >= startedAt) {
      if (conn.errorType === 'connection_in_use') {
        state.pickerBusy = false;
        await renderPicker({ text: IN_USE_COPY, kind: 'error' });
        return;
      }
      if (conn.status === 'error' && conn.error) {
        setPickerMessage(conn.error, 'error');
      }
    }
  }

  state.pickerBusy = false;
  await renderPicker({ text: PICK_TIMEOUT_COPY, kind: 'error' });
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
  // Keep the picker live: knownProfiles can arrive (or change) after the popup
  // opens, and the background may resolve the profile on its own via its
  // identify retries. Read-only: the popup never writes these keys.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || state.view !== 'picker' || state.pickerBusy) return;
      if (changes['webpilot.knownProfiles']) {
        renderPicker().catch(() => {});
      } else if (changes['webpilot.profileId'] && changes['webpilot.profileId'].newValue) {
        loadAndRender().catch(() => {});
      }
    });
  } catch (e) {
    // storage events unavailable; the picker still works on reopen.
  }
  // Initial render. Errors inside loadAndRender are surfaced inline.
  loadAndRender().catch((e) => {
    setConnection('disconnected', null);
    setTabError(e && e.message ? e.message : String(e));
  });
});
