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
let config = {
  installId: null,
  serverUrl: null
};

// Restricted mode whitelist cache
let restrictedModeCache = {
  enabled: true,  // default ON
  domains: [],    // default empty = block all
  loaded: false   // true once storage has been read
};

// Initialize cache from storage
let _whitelistReady = new Promise((resolve) => {
  chrome.storage.local.get(['restrictedModeEnabled', 'whitelistedDomains'], (result) => {
    restrictedModeCache.enabled = result.restrictedModeEnabled !== false; // default true
    restrictedModeCache.domains = result.whitelistedDomains || [];
    restrictedModeCache.loaded = true;
    resolve();
  });
});

// NOTE: `pairingRequiredCache` and the related SET/GET_PAIRING_REQUIRED
// messaging used to live here. With pairing config owned by the web UI it
// became a zombie — the extension was sending `set_pairing_required` on
// every reconnect from a stale local cache (the popup no longer has any UI
// to mutate it). Removed entirely. See QOL review extension/C1.

// Extension lifecycle
chrome.runtime.onInstalled.addListener(() => {
  console.log('WebPilot extension installed');
  // Explicitly initialize restricted mode to ON if not already set by user
  chrome.storage.local.get(['restrictedModeEnabled'], (result) => {
    if (result.restrictedModeEnabled === undefined) {
      chrome.storage.local.set({ restrictedModeEnabled: true });
    }
  });
  // Mint a persistent installId on first install so the server can map this
  // extension install to a Chrome profileId independently of
  // extension-storage state. Idempotent — only set if not already present.
  ensureInstallId();
  loadConfig();
});

chrome.runtime.onStartup.addListener(() => {
  // Migration path: an extension installed before installIds shipped will
  // not have one. If we already know a profileId (i.e. the user has paired
  // before) backfill an installId now so subsequent connects benefit from
  // the new resolution path without forcing the user through the picker.
  ensureInstallId();
  loadConfig();
});

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

    // GET_STATUS removed in P2 phase 7: the new minimal popup polls the
    // server's REST surface directly for connection state; it no longer asks
    // the service worker for it. No remaining caller in the extension.

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

    // DISCONNECT removed in P2 phase 7: the new minimal popup has no
    // disconnect affordance. The old popup's user-initiated disconnect path
    // is gone — connection lifecycle is automatic from the user's POV.

    case 'RECONNECT':
      manuallyDisconnected = false;
      isEnabled = true;
      chrome.storage.local.set({ enabled: true, manuallyDisconnected: false });
      connectWebSocket();
      sendResponse({ success: true });
      break;

    case 'FORGET_CONFIG':
      manuallyDisconnected = false;
      disconnectWebSocket();
      // Also clear the stored profile identification so the user is forced
      // back through the identify flow on next connect. See QOL extension C2/C3.
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

    // The following handlers were removed in P2 phase 7. The new minimal
    // popup (Phase 6) does not send any of these messages — profile re-bind
    // happens in the webapp, the formatter-update check moved to the
    // server-side hourly auto-updater + UI button, and there is no popup UI
    // for retry-auto-connect anymore (the worker handles reconnect itself):
    //   - RESET_PROFILE_ID
    //   - RETRY_AUTO_CONNECT
    //   - GET_PROFILE_IDENTITY
    //   - SET_PROFILE_ID
    //   - CHECK_FORMATTER_UPDATES
    // SET_PAIRING_REQUIRED / GET_PAIRING_REQUIRED were removed earlier (web
    // UI owns this) — see QOL review extension/C1.
  }
  return true;
});

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
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    return;
  }

  if (!config.serverUrl) {
    console.log('Server URL not configured');
    updateConnectionStatus('disconnected', null, null);
    return;
  }

  console.log('Connecting to WebSocket:', config.serverUrl);
  updateConnectionStatus('connecting', null, null);

  try {
    const wsUrl = new URL(config.serverUrl);
    // Identify this install to the server. The server records (installId ->
    // profileId) in `extension_installs` and uses it purely for routing. The
    // server's auth boundary is at the agent layer (paired keys); the
    // installId carries no agent power.
    wsUrl.searchParams.set('installId', config.installId || '');

    wsConnection = new WebSocket(wsUrl.toString());

    wsConnection.onopen = () => {
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
      updateConnectionStatus('connecting', 'Identifying...', null);
      startKeepalive();
      refreshConnectionMetadata();
      // Fire-and-forget — sendHelloHandshake handles its own send failure.
      sendHelloHandshake().catch((err) =>
        console.log('[hello] handshake failed:', err && err.message)
      );
      // Watchdog: if hello_ack never arrives, surface to popup.
      helloTimeoutTimer = setTimeout(() => {
        if (!helloAcked && wsConnection && wsConnection.readyState === WebSocket.OPEN) {
          console.log(
            `[hello] timeout: hello_ack not received within ${HELLO_TIMEOUT_MS}ms`
          );
          updateConnectionStatus('error', 'Identification failed', 'identify_timeout');
        }
      }, HELLO_TIMEOUT_MS);
    };

    wsConnection.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') return;

        // Handle non-command messages from server
        if (message.type === 'paired_agents_list') {
          // Pairing is now web-UI-only; the popup no longer renders this list,
          // but we still stash it in storage in case future tooling consumes it.
          chrome.storage.local.set({ pairedAgents: message.agents });
          return;
        }

        if (message.type === 'identify_required') {
          // Server cannot determine which profile this extension belongs to.
          // Store the known-profiles list and notify the popup to show a picker.
          const knownProfiles = message.knownProfiles || [];
          chrome.storage.local.set({
            'webpilot.knownProfiles': knownProfiles,
            'webpilot.profileId': null
          });
          // The popup picker has moved to the webapp's /pairings flow in
          // Phase 6 — the IDENTIFY_REQUIRED broadcast had no remaining
          // listener and was removed in P2 phase 7.
          console.log('[hello] identify_required received, ' + knownProfiles.length + ' known profile(s)');
          return;
        }

        if (message.type === 'hello_ack') {
          console.log('[hello] handshake acknowledged, profileId=' + message.profileId);
          helloAcked = true;
          if (helloTimeoutTimer) {
            clearTimeout(helloTimeoutTimer);
            helloTimeoutTimer = null;
          }
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

    wsConnection.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsConnection.onclose = (event) => {
      console.log('[ws:close] WebSocket closed:', event.code, event.reason);
      wsConnection = null;
      helloAcked = false;
      if (helloTimeoutTimer) {
        clearTimeout(helloTimeoutTimer);
        helloTimeoutTimer = null;
      }
      stopKeepalive();

      let errorMsg = null;
      let errorType = null;
      let shouldRetry = true;

      if (event.code === 1006) {
        errorMsg = `Server not reachable at ${config.serverUrl}`;
        errorType = 'server_unreachable';
        shouldRetry = true;
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
        setTimeout(() => {
          if (isEnabled && !manuallyDisconnected) {
            connectWebSocket();
          }
        }, 5000);
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
 * reply with `identify_required` and the user picks via popup.
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
  };
  console.log('[hello] sending handshake', helloMsg);
  try {
    wsConnection.send(JSON.stringify(helloMsg));
  } catch (e) {
    console.log('[hello] send failed: ' + (e && e.message));
  }
}

function disconnectWebSocket() {
  stopKeepalive();
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
  // The CONNECTION_STATUS_CHANGED broadcast was removed in P2 phase 7. The
  // new minimal popup polls the server for connection state and does not
  // subscribe to chrome.runtime messages from the service worker.
}

// Command routing
async function handleServerCommand(message) {
  const { id, type, params } = message;

  // Coerce tab_id to integer — MCP clients may send it as a string
  if (params && params.tab_id !== undefined) {
    params.tab_id = parseInt(params.tab_id, 10);
  }

  try {
    await checkWhitelist(type, params);

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

// Whitelist helper functions
function isDomainWhitelisted(url) {
  if (!restrictedModeCache.enabled) return true;

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return restrictedModeCache.domains.some(entry =>
      hostname === entry || hostname.endsWith('.' + entry)
    );
  } catch {
    return false; // fail-closed: invalid URLs are blocked
  }
}

async function checkWhitelist(type, params) {
  // Wait for cache to be populated from storage on service worker startup
  if (!restrictedModeCache.loaded) {
    await _whitelistReady;
  }

  if (!restrictedModeCache.enabled) return; // restricted mode off, allow all
  if (type === 'get_tabs') return; // get_tabs is always allowed

  let url;
  if (type === 'create_tab') {
    url = params.url;
  } else if (params.tab_id) {
    try {
      const tab = await chrome.tabs.get(params.tab_id);
      url = tab.url;
    } catch (err) {
      // Tab doesn't exist or can't be accessed — fail-closed
      throw new Error(`Blocked: Unable to verify tab domain (tab_id=${params.tab_id}, reason=${err.message}). The human must manually add this site to the whitelist in the WebPilot extension before automation can proceed.`);
    }
  } else {
    return; // no tab context to check
  }

  if (!url || !isDomainWhitelisted(url)) {
    let domain = 'unknown';
    try { domain = new URL(url).hostname; } catch {}
    throw new Error(`Blocked: ${domain} is not whitelisted. Whitelist contains: [${restrictedModeCache.domains.join(', ')}]. The human must manually add this site to the whitelist in the WebPilot extension before automation can proceed.`);
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
    if (changes.restrictedModeEnabled) {
      restrictedModeCache.enabled = changes.restrictedModeEnabled.newValue !== false;
    }
    if (changes.whitelistedDomains) {
      restrictedModeCache.domains = changes.whitelistedDomains.newValue || [];
    }
    // pairingRequired key intentionally not mirrored — see F3 removal note.
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
