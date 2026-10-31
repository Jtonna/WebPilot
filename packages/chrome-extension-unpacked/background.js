/**
 * Background service worker - thin orchestrator.
 * Handles WebSocket connection and routes commands to handlers.
 */

import { clearRefs, storeRefs, storeRefContext } from './accessibility-storage.js';
import { clearPosition } from './utils/mouse-state.js';
import { cleanup as cleanupDebugger } from './utils/debugger.js';
import { createTab, closeTab, getTabs, organizeTab, getWebPilotWindowId } from './handlers/tabs.js';
import { getAccessibilityTree } from './handlers/accessibility.js';
import { injectScript, executeJs, handleNavigationComplete, handleTabClosed } from './handlers/scripts.js';
import { click } from './handlers/click.js';
import { scroll } from './handlers/scroll.js';
import { type as typeText } from './handlers/keyboard.js';

// Auto-connect defaults
const DEFAULT_SERVER_URL = 'ws://localhost:3456';
const DEFAULT_HTTP_URL = 'http://localhost:3456';
const AUTO_CONNECT_INTERVAL_MS = 5000;
// Slower retry when the server refuses us because another connection holds this profile.
const CONNECTION_IN_USE_RETRY_MS = 30000;
const DEFAULT_RETRY_MS = 5000;
// chrome.alarms heartbeat. MV3 suspends the service worker after ~30s idle and
// the setTimeout/setInterval retries die with it; alarms survive and wake it.
const RECONNECT_ALARM_NAME = 'webpilot-reconnect';
const RECONNECT_ALARM_PERIOD_MIN = 0.5;
// Extension-specific close code: identification retries were exhausted.
// Must stay in 4000-4999, and distinct from 4000 (replaced) and 4409 (in use).
const CLOSE_CODE_IDENTIFY_FAILED = 4001;
// Backoff between hello resends while the server answers identify_required.
const IDENTIFY_RETRY_DELAYS_MS = [3000, 10000, 30000];

// WebSocket connection state
let wsConnection = null;
let isEnabled = false;
let connectionStatus = 'disconnected';
let connectionError = null;
let connectionErrorType = null;
let manuallyDisconnected = false;
let keepaliveInterval = null;
let autoConnectInterval = null;
const KEEPALIVE_INTERVAL_MS = 15000;
// Tracks whether the current WebSocket has completed the hello handshake.
// Reset to false on every (re)connect; flipped true on `hello_ack`. Used to
// gate the popup "Connected" affordance so the user sees "Identifying..."
// during the brief window between TCP open and server-side profile bind.
let helloAcked = false;
const HELLO_TIMEOUT_MS = 8000;
let helloTimeoutTimer = null;
// Identify retry state (reset on hello_ack and on every socket close).
let identifyAttempt = 0;
let identifyRetryTimer = null;
// Set when identify_timeout closes the socket itself, so onclose skips its own
// retry scheduling (the identify backoff already scheduled one).
let identifyReconnectPending = false;
// Reconnect scheduling: one pending timer, plus a timestamp the alarm heartbeat
// honors so it never connects ahead of a backoff (e.g. the 4409 refusal).
let reconnectTimer = null;
let nextRetryAt = 0;
let config = {
  installId: null,
  serverUrl: null
};

// Vestigial keys from a removed client-side whitelist gate (issue #80); site policy is enforced server-side.
chrome.storage.local.remove(['restrictedModeEnabled', 'whitelistedDomains']);

// Extension lifecycle
chrome.runtime.onInstalled.addListener(() => {
  console.log('WebPilot extension installed');
  ensureReconnectAlarm();
  // Mint a persistent installId on first install so the server can map this
  // extension install to a Chrome profileId independently of
  // extension-storage state. Idempotent — only set if not already present.
  ensureInstallId();
  loadConfig();
});

chrome.runtime.onStartup.addListener(() => {
  ensureReconnectAlarm();
  // Migration path: an extension installed before installIds shipped will
  // not have one. If we already know a profileId (i.e. the user has paired
  // before) backfill an installId now so subsequent connects benefit from
  // the new resolution path without forcing the user through the picker.
  ensureInstallId();
  loadConfig();
});

/**
 * Create the reconnect heartbeat alarm if it does not exist yet. Idempotent:
 * safe to call at every worker load, install and startup.
 */
function ensureReconnectAlarm() {
  try {
    chrome.alarms.get(RECONNECT_ALARM_NAME, (alarm) => {
      if (!alarm) {
        chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: RECONNECT_ALARM_PERIOD_MIN });
      }
    });
  } catch (e) {
    console.log('[alarm] failed to ensure reconnect alarm: ' + (e && e.message));
  }
}

// Top-level so the listener is registered when the alarm wakes a suspended worker.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === RECONNECT_ALARM_NAME) {
    reconnectTick().catch((e) => console.log('[alarm] reconnect tick failed: ' + (e && e.message)));
  }
});
ensureReconnectAlarm();

function isSocketLive() {
  return !!wsConnection &&
    (wsConnection.readyState === WebSocket.OPEN || wsConnection.readyState === WebSocket.CONNECTING);
}

/**
 * Heartbeat: a freshly woken worker has default in-memory state, so re-read
 * storage before deciding whether to reconnect.
 */
async function reconnectTick() {
  if (isSocketLive()) return;
  if (Date.now() < nextRetryAt) return; // backoff active (e.g. 4409)

  const result = await new Promise((resolve) => {
    chrome.storage.local.get(
      ['enabled', 'serverUrl', 'manuallyDisconnected', 'webpilot.installId'],
      (r) => resolve(r || {})
    );
  });
  // Re-check: state may have changed while storage was read.
  if (isSocketLive() || Date.now() < nextRetryAt) return;

  isEnabled = result.enabled || false;
  config.installId = result['webpilot.installId'] || null;
  config.serverUrl = result.serverUrl || null;
  manuallyDisconnected = result.manuallyDisconnected === true;

  if (manuallyDisconnected) return;

  if (config.installId && config.serverUrl) {
    if (!isEnabled) return;
    console.log('[alarm] heartbeat: not connected, reconnecting');
    connectWebSocket();
  } else if (!autoConnectInterval) {
    console.log('[alarm] heartbeat: no config, attempting auto-connect');
    attemptAutoConnect();
  }
}

/**
 * Schedule a single reconnect attempt, replacing any pending one, and record
 * nextRetryAt so the alarm heartbeat respects the same backoff.
 */
function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  nextRetryAt = Date.now() + delayMs;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isEnabled && !manuallyDisconnected) {
      connectWebSocket();
    }
  }, delayMs);
}

function clearReconnectSchedule() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  nextRetryAt = 0;
}

function resetIdentifyState() {
  identifyAttempt = 0;
  if (identifyRetryTimer) {
    clearTimeout(identifyRetryTimer);
    identifyRetryTimer = null;
  }
}

/**
 * Ensure chrome.storage.local has a `webpilot.installId`. Generates one with
 * crypto.randomUUID() (available globally in MV3 service workers) if missing.
 * Safe to call repeatedly — the write is gated on absence.
 */
function ensureInstallId() {
  chrome.storage.local.get(['webpilot.installId', 'webpilot.profileId'], (data) => {
    if (data && typeof data['webpilot.installId'] === 'string' && data['webpilot.installId'].length > 0) {
      return;
    }
    let installId;
    try {
      installId = crypto.randomUUID();
    } catch (e) {
      console.log('[hello] crypto.randomUUID() failed: ' + (e && e.message));
      return;
    }
    chrome.storage.local.set({ 'webpilot.installId': installId }, () => {
      const hadProfile = !!(data && data['webpilot.profileId']);
      console.log(
        '[hello] minted installId=' + installId.slice(0, 8) + '... ' +
        (hadProfile ? '(backfilled for pre-existing install)' : '(fresh install)')
      );
    });
  });
}

function loadConfig() {
  // Read identity + server addresses. `apiKey` is intentionally NOT read
  // here: the legacy shared transport key has been retired. The extension
  // identifies itself via `webpilot.installId`; the server resolves it to a
  // profileId. Any stale `apiKey` in storage from a pre-1.2.0 build is
  // cleaned up below as a one-time migration so it doesn't sit around
  // forever.
  chrome.storage.local.get(
    ['enabled', 'serverUrl', 'manuallyDisconnected', 'webpilot.installId', 'apiKey'],
    (result) => {
      isEnabled = result.enabled || false;
      config.installId = result['webpilot.installId'] || null;
      config.serverUrl = result.serverUrl || null;
      manuallyDisconnected = result.manuallyDisconnected === true;

      // One-time cleanup of the legacy transport key. Safe to call repeatedly
      // (remove() is idempotent once the key is gone).
      if (typeof result.apiKey !== 'undefined') {
        chrome.storage.local.remove(['apiKey'], () => {
          console.log('[migration] removed legacy chrome.storage.apiKey (transport key retired)');
        });
      }

      if (manuallyDisconnected) {
        // User explicitly disconnected before Chrome closed. Stay disconnected
        // until they click Retry/Reconnect in the popup.
        console.log('Skipping auto-connect: user manually disconnected.');
        updateConnectionStatus('disconnected', null, null);
        return;
      }

      if (isEnabled && config.installId && config.serverUrl) {
        // Already have config, reconnect
        console.log('Auto-reconnecting on service worker startup...');
        connectWebSocket();
      } else {
        // No config stored — attempt auto-connect to local server
        console.log('No config found, attempting auto-connect...');
        attemptAutoConnect();
      }
    }
  );
}

function attemptAutoConnect() {
  clearAutoConnectInterval();

  doAutoConnectFetch().then((success) => {
    if (!success) {
      // Server not reachable, retry on interval
      console.log('Auto-connect failed, retrying every', AUTO_CONNECT_INTERVAL_MS, 'ms');
      updateConnectionStatus('connecting', 'Waiting for server...', null);
      autoConnectInterval = setInterval(() => {
        doAutoConnectFetch().then((ok) => {
          if (ok) clearAutoConnectInterval();
        });
      }, AUTO_CONNECT_INTERVAL_MS);
    }
  });
}

async function doAutoConnectFetch() {
  try {
    const response = await fetch(`${DEFAULT_HTTP_URL}/connect`);
    if (!response.ok) return false;

    const data = await response.json();
    // Post-1.2.0 the server no longer returns `apiKey` from /connect — the
    // extension's installId is its identity. We only need the addresses.
    if (!data.serverUrl) return false;

    // Make sure we have an installId before we attempt to connect; mint one
    // if missing (defensive — `ensureInstallId` already ran in onInstalled /
    // onStartup, but this covers any edge case where storage was cleared
    // between events).
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(['webpilot.installId'], (d) => resolve(d || {}));
    });
    let installId = stored['webpilot.installId'] || null;
    if (!installId) {
      try {
        installId = crypto.randomUUID();
        await chrome.storage.local.set({ 'webpilot.installId': installId });
        console.log('[hello] minted installId on /connect path: ' + installId.slice(0, 8) + '...');
      } catch (e) {
        console.log('[hello] failed to mint installId in /connect: ' + (e && e.message));
        return false;
      }
    }

    config.installId = installId;
    config.serverUrl = data.serverUrl;
    isEnabled = true;

    await chrome.storage.local.set({
      serverUrl: data.serverUrl,
      sseUrl: data.sseUrl || `http://localhost:3456/sse`,
      networkMode: data.networkMode || false,
      enabled: true
    });

    console.log('Auto-connect succeeded, connecting WebSocket...');
    connectWebSocket();
    return true;
  } catch (e) {
    // Server not running or unreachable
    return false;
  }
}

function clearAutoConnectInterval() {
  if (autoConnectInterval) {
    clearInterval(autoConnectInterval);
    autoConnectInterval = null;
  }
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'SERVICE_STATUS_CHANGED':
      handleServiceStatusChange(message.enabled);
      break;

    case 'CONFIG_UPDATED':
      handleConfigUpdate(message.config);
      break;

    case 'CONNECT_REQUEST':
      chrome.storage.local.get(['webpilot.installId', 'serverUrl'], (result) => {
        const installId = result['webpilot.installId'];
        if (installId && result.serverUrl) {
          config.installId = installId;
          config.serverUrl = result.serverUrl;
          isEnabled = true;
          chrome.storage.local.set({ enabled: true });
          connectWebSocket();
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'No config available' });
        }
      });
      break;

    case 'RECONNECT':
      manuallyDisconnected = false;
      isEnabled = true;
      chrome.storage.local.set({ enabled: true, manuallyDisconnected: false });
      connectWebSocket();
      sendResponse({ success: true });
      break;

    case 'reidentify':
      // User picked a Chrome profile in the popup. This handler is the ONLY
      // writer of `webpilot.profileId`; the popup stays read-only on storage.
      handleReidentify(message.profileId).then(
        (res) => sendResponse(res),
        (e) => sendResponse({ success: false, error: (e && e.message) || 'reidentify failed' })
      );
      break;

    case 'FORGET_CONFIG':
      manuallyDisconnected = false;
      disconnectWebSocket();
      // Also clear the stored profile identification so the user is forced
      // back through the identify flow on next connect.
      // NOTE: `webpilot.installId` is intentionally NOT cleared — it is bound
      // to the extension installation, not the pairing config, and persists
      // across config resets so the server's installId->profileId mapping
      // can still re-identify this install automatically.
      // `apiKey` is also included for one-time cleanup of pre-1.2.0 storage.
      chrome.storage.local.remove([
        'apiKey',
        'serverUrl',
        'enabled',
        'manuallyDisconnected',
        'webpilot.profileId',
        'webpilot.knownProfiles'
      ]);
      config.installId = null;
      config.serverUrl = null;
      isEnabled = false;
      // Restart auto-connect to pick up server again
      attemptAutoConnect();
      sendResponse({ success: true });
      break;

  }
  return true;
});

/**
 * Apply a profile the user picked in the popup (identify_required picker):
 * persist it, restart the identify cycle, and re-send hello (or reconnect).
 * Resolves { success: true } or { success: false, error }.
 */
async function handleReidentify(profileId) {
  if (typeof profileId !== 'string' || profileId.length === 0) {
    return { success: false, error: 'No profile selected' };
  }

  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(
      ['webpilot.knownProfiles', 'enabled', 'serverUrl', 'manuallyDisconnected', 'webpilot.installId'],
      (r) => resolve(r || {})
    );
  });

  const known = stored['webpilot.knownProfiles'];
  if (Array.isArray(known)) {
    if (!known.some((p) => p && p.directoryName === profileId)) {
      return { success: false, error: 'Unknown profile' };
    }
  } else {
    console.log('[reidentify] no stored knownProfiles; accepting profileId without validation');
  }

  // A worker woken by the popup message has default in-memory state: refresh it.
  isEnabled = stored.enabled || false;
  manuallyDisconnected = stored.manuallyDisconnected === true;
  config.installId = stored['webpilot.installId'] || config.installId;
  config.serverUrl = stored.serverUrl || config.serverUrl;

  const socketOpen = !!wsConnection && wsConnection.readyState === WebSocket.OPEN;
  if (!socketOpen && (!isEnabled || manuallyDisconnected)) {
    return { success: false, error: 'WebPilot is disconnected. Reconnect from the popup first.' };
  }

  // Reset BEFORE the write so a stale identify_required arriving during the
  // await restarts the 3s/10s/30s cycle instead of tripping failIdentification
  // (which would clear the profileId we are about to store).
  resetIdentifyState();
  await chrome.storage.local.set({ 'webpilot.profileId': profileId });
  resetIdentifyState();
  console.log('[reidentify] profile selected: ' + profileId);

  if (socketOpen && wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    await sendHelloHandshake();
  } else if (!isSocketLive()) {
    // User-initiated: clearReconnectSchedule also zeroes nextRetryAt, which
    // bypasses any 4409 backoff.
    clearReconnectSchedule();
    connectWebSocket();
  }
  // else CONNECTING: ws.onopen reads the stored profileId when it sends hello.
  return { success: true };
}

function handleServiceStatusChange(enabled) {
  isEnabled = enabled;

  if (enabled) {
    chrome.storage.local.get(['webpilot.installId', 'serverUrl'], (result) => {
      const installId = result['webpilot.installId'];
      if (installId && result.serverUrl) {
        config.installId = installId;
        config.serverUrl = result.serverUrl;
        connectWebSocket();
      }
    });
  } else {
    disconnectWebSocket();
  }
}

function handleConfigUpdate(newConfig) {
  // `newConfig.installId` is preferred; fall back to legacy `apiKey` shape
  // if a caller is still sending the old payload (will be removed when no
  // such caller remains).
  if (newConfig && typeof newConfig.installId === 'string') {
    config.installId = newConfig.installId;
  }
  config.serverUrl = newConfig.serverUrl;

  if (isEnabled && config.installId && config.serverUrl) {
    disconnectWebSocket();
    connectWebSocket();
  }
}

// WebSocket connection
function connectWebSocket() {
  if (isSocketLive()) {
    return;
  }
  clearReconnectSchedule();

  if (!config.serverUrl) {
    console.log('Server URL not configured');
    updateConnectionStatus('disconnected', null, null);
    return;
  }

  console.log('Connecting to WebSocket:', config.serverUrl);
  updateConnectionStatus('connecting', null, null);

  try {
    const wsUrl = new URL(config.serverUrl);
    // Always dial loopback. The server + Chrome + extension always run on the
    // same machine, and the server loopback-gates the extension WS even in
    // network mode (only the MCP surface is LAN-reachable). A stale LAN
    // `serverUrl` from an older build (or a pre-fix /connect) must never be
    // adopted as the dial target — coerce the host back to localhost, keeping
    // the port. (Root cause of #110 / #125.)
    if (wsUrl.hostname !== '127.0.0.1' && wsUrl.hostname !== 'localhost') {
      console.log(
        `[ws] coercing non-loopback dial host "${wsUrl.hostname}" -> localhost (same-machine only)`
      );
      wsUrl.hostname = 'localhost';
    }
    // Identify this install to the server. The server records (installId ->
    // profileId) in `extension_installs` and uses it purely for routing. The
    // server's auth boundary is at the agent layer (paired keys); the
    // installId carries no agent power.
    wsUrl.searchParams.set('installId', config.installId || '');

    const ws = new WebSocket(wsUrl.toString());
    wsConnection = ws;

    ws.onopen = () => {
      if (ws !== wsConnection) return; // stale socket
      console.log('[ws:open] WebSocket TCP/WS handshake complete — sending hello FIRST');
      // Per server protocol, the server gates ALL non-hello messages until
      // identification completes. The very first frame on this WS MUST be
      // `hello`. Any state-pushes (pairing config, etc.) belong AFTER
      // `hello_ack` arrives. The popup connection-status stays in an
      // "identifying" sub-state until then so users do not see a misleading
      // green "Connected" during a hello that may still fail/timeout.
      helloAcked = false;
      if (helloTimeoutTimer) {
        clearTimeout(helloTimeoutTimer);
        helloTimeoutTimer = null;
      }
      // Only the pending resend timer is cleared here; the attempt counter
      // persists across identify_timeout reconnects (reset on hello_ack/close).
      if (identifyRetryTimer) {
        clearTimeout(identifyRetryTimer);
        identifyRetryTimer = null;
      }
      updateConnectionStatus('connecting', 'Identifying...', null);
      startKeepalive();
      refreshConnectionMetadata();
      // Fire-and-forget — sendHelloHandshake handles its own send failure.
      sendHelloHandshake().catch((err) =>
        console.log('[hello] handshake failed:', err && err.message)
      );
      // Watchdog: if hello_ack never arrives, surface to popup.
      helloTimeoutTimer = setTimeout(() => {
        helloTimeoutTimer = null;
        if (ws !== wsConnection) return;
        if (!helloAcked && ws.readyState === WebSocket.OPEN) {
          console.log(
            `[hello] timeout: hello_ack not received within ${HELLO_TIMEOUT_MS}ms`
          );
          updateConnectionStatus('error', 'Identification failed', 'identify_timeout');
          // The server never registered this socket: drop it and reconnect,
          // sharing the identify backoff counter.
          const delay = nextIdentifyDelay();
          if (delay === null) {
            failIdentification(ws);
          } else {
            console.log(`[hello] identify_timeout: reconnecting in ${delay}ms`);
            // Normal-code close; onclose must not also schedule its own retry.
            // onclose keeps identifyAttempt in this case so the backoff advances.
            identifyReconnectPending = true;
            ws.close(1000, 'identify_timeout');
            scheduleReconnect(delay);
          }
        }
      }, HELLO_TIMEOUT_MS);
    };

    ws.onmessage = (event) => {
      if (ws !== wsConnection) return; // stale socket
      try {
        // Defensive: cap frame size and reject non-object payloads before
        // dispatch. Even though the WS is gated server-side to localhost
        // (or LAN in --network), a misbehaving / hijacked server should not
        // be able to crash the service worker with a malformed frame.
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!raw || raw.length > 8 * 1024 * 1024) {
          console.log('[ws:msg] dropping oversized or empty frame');
          return;
        }
        const message = JSON.parse(raw);
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          console.log('[ws:msg] dropping non-object frame');
          return;
        }
        if (typeof message.type !== 'string' || message.type.length === 0) {
          console.log('[ws:msg] dropping frame with missing/invalid type');
          return;
        }
        if (message.type === 'pong') return;

        // Handle non-command messages from server.
        // NOTE: the server no longer pushes `paired_agents_list` to the
        // extension (#129). Agent administration is a web-UI-only concern and
        // the extension never needs the agent roster, so there is nothing to
        // cache here.

        if (message.type === 'identify_required') {
          // Server cannot determine which profile this extension belongs to.
          // Store the known-profiles list and notify the popup to show a picker.
          // The stored profileId is KEPT while we retry hello (the server may
          // resolve it once gaiaEmail / profile state is ready); it is only
          // cleared when the retries are exhausted.
          const knownProfiles = message.knownProfiles || [];
          chrome.storage.local.set({ 'webpilot.knownProfiles': knownProfiles });
          // The popup renders the profile picker from this list (shown when
          // /api/popup/state is 401) and answers with a `reidentify` message.
          console.log('[hello] identify_required received, ' + knownProfiles.length + ' known profile(s)');
          scheduleIdentifyRetry(ws);
          return;
        }

        if (message.type === 'hello_ack') {
          console.log('[hello] handshake acknowledged, profileId=' + message.profileId);
          helloAcked = true;
          if (helloTimeoutTimer) {
            clearTimeout(helloTimeoutTimer);
            helloTimeoutTimer = null;
          }
          resetIdentifyState();
          // Persist the resolved profileId for future connects
          chrome.storage.local.set({ 'webpilot.profileId': message.profileId });
          // Now (and only now) is the WS safe to consider fully connected.
          updateConnectionStatus('connected', null, null);
          return;
        }

        // When the server sends ref mappings after server-side formatting
        if (message.type === 'store_refs') {
          const { tabId, refs, refContexts } = message;
          if (refs) {
            storeRefs(tabId, refs);
          }
          if (refContexts) {
            for (const [ref, context] of Object.entries(refContexts)) {
              storeRefContext(tabId, ref, context);
            }
          }
          return;
        }

        handleServerCommand(message);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    ws.onerror = (error) => {
      if (ws !== wsConnection) return; // stale socket
      console.error('WebSocket error:', error);
    };

    ws.onclose = (event) => {
      console.log('[ws:close] WebSocket closed:', event.code, event.reason);
      // A replaced/old socket closing must not null the current one or touch
      // its timers (the server closes the previous socket with 4000 on replace).
      if (ws !== wsConnection) return;
      wsConnection = null;
      helloAcked = false;
      if (helloTimeoutTimer) {
        clearTimeout(helloTimeoutTimer);
        helloTimeoutTimer = null;
      }
      stopKeepalive();

      // identify_timeout closed this socket itself and already scheduled the
      // backoff reconnect; keep the attempt counter, just drop the resend timer.
      if (identifyReconnectPending) {
        identifyReconnectPending = false;
        if (identifyRetryTimer) {
          clearTimeout(identifyRetryTimer);
          identifyRetryTimer = null;
        }
        return;
      }
      resetIdentifyState();

      let errorMsg = null;
      let errorType = null;
      let shouldRetry = true;
      let retryDelayMs = DEFAULT_RETRY_MS;

      if (event.code === 4409) {
        // Server refused: another live connection (different install) already
        // holds this profile. Keep config intact and back off.
        errorMsg = 'Another WebPilot connection is active for this browser profile';
        errorType = 'connection_in_use';
        shouldRetry = true;
        retryDelayMs = CONNECTION_IN_USE_RETRY_MS;
      } else if (event.code === 1006) {
        errorMsg = `Server not reachable at ${config.serverUrl}`;
        errorType = 'server_unreachable';
        shouldRetry = true;
        // Self-heal a stale LAN `serverUrl`: the extension must always dial
        // loopback. If the stored dial target is a non-loopback host, a
        // 1006 (never reached / handshake failed) is exactly the symptom of
        // having adopted a LAN IP that the server now loopback-rejects. Reset
        // the dial target to the localhost default before the retry fires.
        try {
          const u = new URL(config.serverUrl);
          if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
            console.log(
              `[ws] stale non-loopback serverUrl "${config.serverUrl}" — resetting dial target to ${DEFAULT_SERVER_URL}`
            );
            config.serverUrl = DEFAULT_SERVER_URL;
            chrome.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
          }
        } catch (_e) {
          // Unparseable stored URL — fall back to the localhost default.
          config.serverUrl = DEFAULT_SERVER_URL;
          chrome.storage.local.set({ serverUrl: DEFAULT_SERVER_URL });
        }
      } else if (event.code === CLOSE_CODE_IDENTIFY_FAILED) {
        // We closed this ourselves after exhausting identify retries.
        errorMsg = 'Identification failed';
        errorType = 'identify_failed';
        shouldRetry = true;
        retryDelayMs = DEFAULT_RETRY_MS;
      } else if (event.code === 1008 || event.reason === 'Unauthorized') {
        // Post-1.2.0 a 1008 from the extension WS endpoint means our installId
        // was missing or malformed on the upgrade URL — typically a stale
        // service-worker memory state. Clear cached server addresses and let
        // the auto-connect path re-fetch from /connect and re-emit the
        // installId-bearing WS URL. installId itself is preserved.
        errorMsg = 'Authentication failed - reconnecting';
        errorType = 'auth_failed';
        shouldRetry = false;
        chrome.storage.local.remove(['serverUrl', 'enabled', 'apiKey']);
        config.serverUrl = null;
        isEnabled = false;
        // Re-fetch addresses from server
        attemptAutoConnect();
      } else if (event.code === 1011) {
        errorMsg = 'Server error';
        errorType = 'server_error';
        shouldRetry = true;
      } else if (event.code !== 1000 && event.code !== 1001) {
        errorMsg = event.reason || 'Connection lost';
        errorType = 'connection_lost';
        shouldRetry = true;
      }

      if (errorMsg) {
        updateConnectionStatus('error', errorMsg, errorType);
      } else {
        updateConnectionStatus('disconnected', null, null);
      }

      if (shouldRetry && isEnabled && !manuallyDisconnected && config.serverUrl) {
        scheduleReconnect(retryDelayMs);
      }
    };
  } catch (e) {
    console.error('Failed to connect:', e);
    updateConnectionStatus('error', e.message || 'Failed to connect', 'connection_failed');
  }
}

/**
 * Send the hello handshake to the server so it can route commands by Chrome
 * profile directory name. We prefer a previously-stored profileId; otherwise
 * we try chrome.identity.getProfileUserInfo() to surface an email the server
 * can match against `Local State`. If neither is available, the server will
 * reply with `identify_required`, the popup shows a profile picker, and the
 * user's choice arrives via the `reidentify` message.
 */
async function sendHelloHandshake() {
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;

  const stored = await new Promise((resolve) => {
    chrome.storage.local.get(
      ['webpilot.profileId', 'webpilot.installId'],
      (data) => resolve(data)
    );
  });

  const profileId = stored['webpilot.profileId'] || null;
  const installId = stored['webpilot.installId'] || null;

  let gaiaEmail = null;
  if (!profileId) {
    try {
      gaiaEmail = await new Promise((resolve) => {
        if (chrome.identity && chrome.identity.getProfileUserInfo) {
          chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
            resolve(info && info.email ? info.email : null);
          });
        } else {
          resolve(null);
        }
      });
    } catch (e) {
      console.log('[hello] getProfileUserInfo failed: ' + (e && e.message));
    }
  }

  const helloMsg = {
    type: 'hello',
    profileId,
    gaiaEmail,
    installId,
    // Lets the server locate this install's storage on disk to infer the profile.
    extensionId: chrome.runtime.id,
  };
  console.log('[hello] sending handshake', helloMsg);
  try {
    wsConnection.send(JSON.stringify(helloMsg));
  } catch (e) {
    console.log('[hello] send failed: ' + (e && e.message));
  }
}

/** Next identify backoff delay (advances the shared counter), or null when exhausted. */
function nextIdentifyDelay() {
  if (identifyAttempt >= IDENTIFY_RETRY_DELAYS_MS.length) return null;
  return IDENTIFY_RETRY_DELAYS_MS[identifyAttempt++];
}

/** Resend hello after the backoff delay; never stacks timers. */
function scheduleIdentifyRetry(ws) {
  // The server answered (identify_required), so the 8s no-reply watchdog no
  // longer applies; the backoff below drives the rest.
  if (helloTimeoutTimer) {
    clearTimeout(helloTimeoutTimer);
    helloTimeoutTimer = null;
  }
  if (identifyRetryTimer) {
    clearTimeout(identifyRetryTimer);
    identifyRetryTimer = null;
  }
  const delay = nextIdentifyDelay();
  if (delay === null) {
    failIdentification(ws);
    return;
  }
  console.log(`[hello] resending hello in ${delay}ms (attempt ${identifyAttempt}/${IDENTIFY_RETRY_DELAYS_MS.length})`);
  identifyRetryTimer = setTimeout(() => {
    identifyRetryTimer = null;
    if (ws !== wsConnection || helloAcked || ws.readyState !== WebSocket.OPEN) return;
    sendHelloHandshake().catch((err) =>
      console.log('[hello] handshake retry failed:', err && err.message)
    );
  }, delay);
}

/** Retries exhausted: clear the stored profileId and close so the normal reconnect path runs. */
function failIdentification(ws) {
  console.log('[hello] identify retries exhausted, clearing stored profileId and reconnecting');
  chrome.storage.local.set({ 'webpilot.profileId': null });
  resetIdentifyState();
  if (ws === wsConnection && ws.readyState === WebSocket.OPEN) {
    ws.close(CLOSE_CODE_IDENTIFY_FAILED, 'identify_failed');
  }
}

function disconnectWebSocket() {
  stopKeepalive();
  resetIdentifyState();
  clearReconnectSchedule();
  identifyReconnectPending = false;
  if (helloTimeoutTimer) {
    clearTimeout(helloTimeoutTimer);
    helloTimeoutTimer = null;
  }
  if (wsConnection) {
    console.log('Disconnecting WebSocket');
    wsConnection.onclose = null;
    wsConnection.close();
    wsConnection = null;
  }
  updateConnectionStatus('disconnected', null, null);
}

function startKeepalive() {
  stopKeepalive();
  keepaliveInterval = setInterval(() => {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
      wsConnection.send(JSON.stringify({ type: 'ping' }));
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

async function refreshConnectionMetadata() {
  try {
    // Derive HTTP URL from stored WS URL (ws://host:port -> http://host:port)
    const wsUrl = config.serverUrl;
    if (!wsUrl) return;
    const httpUrl = wsUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
    const response = await fetch(`${httpUrl}/connect`);
    if (!response.ok) return;
    const data = await response.json();
    await chrome.storage.local.set({
      serverUrl: data.serverUrl,
      sseUrl: data.sseUrl || `http://localhost:3456/sse`,
      networkMode: data.networkMode || false
    });
  } catch (e) {
    // Non-fatal — metadata refresh is best-effort
  }
}

function updateConnectionStatus(status, error = null, errorType = null) {
  connectionStatus = status;
  connectionError = error;
  connectionErrorType = errorType;
  // No broadcast: the popup polls the server for connection state. It reads
  // this session-storage mirror only to explain a failed profile pick
  // (e.g. connection_in_use), which the server cannot report over HTTP.
  try {
    chrome.storage.session
      .set({
        'webpilot.connectionState': { status, error, errorType, updatedAt: Date.now() }
      })
      .catch((e) => console.log('[status] session mirror failed: ' + (e && e.message)));
  } catch (e) {
    console.log('[status] session mirror unavailable: ' + (e && e.message));
  }
}

// Command routing
async function handleServerCommand(message) {
  const { id, type, params } = message;

  // Coerce tab_id to integer — MCP clients may send it as a string
  if (params && params.tab_id !== undefined) {
    params.tab_id = parseInt(params.tab_id, 10);
  }

  try {
    let result;

    switch (type) {
      case 'create_tab':
        result = await createTab(params);
        break;
      case 'close_tab':
        result = await closeTab(params);
        break;
      case 'get_tabs':
        result = await getTabs();
        break;
      case 'get_accessibility_tree':
        result = await getAccessibilityTree(params);
        organizeTab(params.tab_id);
        break;
      case 'inject_script':
        result = await injectScript(params);
        organizeTab(params.tab_id);
        break;
      case 'execute_js':
        result = await executeJs(params);
        organizeTab(params.tab_id);
        break;
      case 'click':
        result = await click(params);
        organizeTab(params.tab_id);
        break;
      case 'scroll':
        result = await scroll(params);
        organizeTab(params.tab_id);
        break;
      case 'type':
        result = await typeText(params);
        organizeTab(params.tab_id);
        break;
      case 'reload_extension':
        // Developer hot-reload: ack first, then schedule chrome.runtime.reload
        // ~100ms later so the response makes it back over the WS before the
        // worker restarts. After reload, the worker re-runs background.js which
        // re-opens the WS to the server; the paired API key persists in
        // chrome.storage so no re-pairing is required.
        result = { reloading: true, scheduledInMs: 100 };
        sendResult(id, true, result);
        setTimeout(() => {
          try {
            chrome.runtime.reload();
          } catch (e) {
            // Nothing to do — the worker is about to die anyway.
            console.warn('[handlers] chrome.runtime.reload failed:', e);
          }
        }, 100);
        return; // Skip the trailing sendResult below — we already sent.
      default:
        throw new Error(`Unknown command type: ${type}`);
    }

    sendResult(id, true, result);
  } catch (error) {
    console.error('Command error:', error);
    sendResult(id, false, null, error.message);
  }
}

function sendResult(id, success, result, error = null) {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    const response = { id, success };
    if (success) {
      response.result = result;
    } else {
      response.error = error;
    }
    wsConnection.send(JSON.stringify(response));
  }
}

// Event listeners for cleanup
chrome.webNavigation.onCompleted.addListener(handleNavigationComplete);

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupDebugger(tabId);
  handleTabClosed(tabId);
  clearRefs(tabId);
  clearPosition(tabId);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local') {
    if (changes.enabled) {
      isEnabled = changes.enabled.newValue;
    }
    if (changes['webpilot.installId']) {
      config.installId = changes['webpilot.installId'].newValue;
    }
    if (changes.serverUrl) {
      config.serverUrl = changes.serverUrl.newValue;
    }
  }
});

// Save WebPilot window bounds when resized or moved
chrome.windows.onBoundsChanged.addListener((window) => {
  const wpWindowId = getWebPilotWindowId();
  if (wpWindowId !== null && window.id === wpWindowId) {
    chrome.storage.local.set({
      webPilotWindowBounds: {
        width: window.width,
        height: window.height,
        top: window.top,
        left: window.left
      }
    });
  }
});
