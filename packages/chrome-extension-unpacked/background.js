/**
 * Background service worker - thin orchestrator.
 * Handles WebSocket connection and routes commands to handlers.
 */

import { clearRefs } from './accessibility-storage.js';
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
let config = {
  apiKey: null,
  serverUrl: null
};

// Restricted mode whitelist cache
let restrictedModeCache = {
  enabled: true,  // default ON
  domains: []     // default empty = block all
};

// Initialize cache from storage
chrome.storage.local.get(['restrictedModeEnabled', 'whitelistedDomains'], (result) => {
  restrictedModeCache.enabled = result.restrictedModeEnabled !== false; // default true
  restrictedModeCache.domains = result.whitelistedDomains || [];
});

// Extension lifecycle
chrome.runtime.onInstalled.addListener(() => {
  console.log('WebPilot extension installed');
  // Explicitly initialize restricted mode to ON if not already set by user
  chrome.storage.local.get(['restrictedModeEnabled'], (result) => {
    if (result.restrictedModeEnabled === undefined) {
      chrome.storage.local.set({ restrictedModeEnabled: true });
    }
  });
  loadConfig();
});

chrome.runtime.onStartup.addListener(() => {
  loadConfig();
});

function loadConfig() {
  chrome.storage.local.get(['enabled', 'apiKey', 'serverUrl'], (result) => {
    isEnabled = result.enabled || false;
    config.apiKey = result.apiKey || null;
    config.serverUrl = result.serverUrl || null;

    if (isEnabled && config.apiKey && config.serverUrl) {
      // Already have config, reconnect
      console.log('Auto-reconnecting on service worker startup...');
      connectWebSocket();
    } else {
      // No config stored — attempt auto-connect to local server
      console.log('No config found, attempting auto-connect...');
      attemptAutoConnect();
    }
  });
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
    if (!data.apiKey || !data.serverUrl) return false;

    config.apiKey = data.apiKey;
    config.serverUrl = data.serverUrl;
    isEnabled = true;

    await chrome.storage.local.set({
      apiKey: data.apiKey,
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

    case 'GET_STATUS':
      chrome.storage.local.get(['enabled', 'apiKey', 'serverUrl'], (result) => {
        sendResponse({
          enabled: result.enabled || false,
          connected: connectionStatus === 'connected',
          connectionStatus: connectionStatus,
          connectionError: connectionError,
          errorType: connectionErrorType,
          manuallyDisconnected: manuallyDisconnected,
          config: {
            hasApiKey: !!result.apiKey,
            serverUrl: result.serverUrl
          }
        });
      });
      break;

    case 'CONNECT_REQUEST':
      chrome.storage.local.get(['apiKey', 'serverUrl'], (result) => {
        if (result.apiKey && result.serverUrl) {
          config.apiKey = result.apiKey;
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

    case 'DISCONNECT':
      manuallyDisconnected = true;
      disconnectWebSocket();
      sendResponse({ success: true });
      break;

    case 'RECONNECT':
      manuallyDisconnected = false;
      isEnabled = true;
      chrome.storage.local.set({ enabled: true });
      connectWebSocket();
      sendResponse({ success: true });
      break;

    case 'FORGET_CONFIG':
      manuallyDisconnected = false;
      disconnectWebSocket();
      chrome.storage.local.remove(['apiKey', 'serverUrl', 'enabled']);
      config.apiKey = null;
      config.serverUrl = null;
      isEnabled = false;
      // Restart auto-connect to pick up server again
      attemptAutoConnect();
      sendResponse({ success: true });
      break;

    case 'RETRY_AUTO_CONNECT':
      attemptAutoConnect();
      sendResponse({ success: true });
      break;

    case 'PAIRING_RESPONSE':
      sendResult(message.commandId, true, { approved: message.approved });
      chrome.storage.local.get('pendingPairingRequests', (result) => {
        const pending = (result.pendingPairingRequests || []).filter(
          r => r.commandId !== message.commandId
        );
        chrome.storage.local.set({ pendingPairingRequests: pending });
      });
      sendResponse({ success: true });
      break;

    case 'RENAME_AGENT':
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({ type: 'rename_agent', apiKey: message.apiKey, newName: message.newName }));
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected to server' });
      }
      break;

    case 'REVOKE_KEY':
      console.log('REVOKE_KEY received, apiKey:', message.apiKey, 'wsConnected:', wsConnection && wsConnection.readyState === WebSocket.OPEN);
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({ type: 'revoke_key', apiKey: message.apiKey }));
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected to server' });
      }
      break;

    case 'GET_PAIRED_AGENTS':
      chrome.storage.local.get('pairedAgents', (data) => {
        sendResponse({ agents: data.pairedAgents || [] });
      });
      break;

    case 'GET_PENDING_PAIRING':
      chrome.storage.local.get('pendingPairingRequests', (data) => {
        sendResponse({ requests: data.pendingPairingRequests || [] });
      });
      break;

    case 'SET_NETWORK_MODE':
      if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({
          type: 'set_network_mode',
          enabled: message.enabled
        }));
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Not connected' });
      }
      break;
  }
  return true;
});

function handleServiceStatusChange(enabled) {
  isEnabled = enabled;

  if (enabled) {
    chrome.storage.local.get(['apiKey', 'serverUrl'], (result) => {
      if (result.apiKey && result.serverUrl) {
        config.apiKey = result.apiKey;
        config.serverUrl = result.serverUrl;
        connectWebSocket();
      }
    });
  } else {
    disconnectWebSocket();
  }
}

function handleConfigUpdate(newConfig) {
  config.apiKey = newConfig.apiKey;
  config.serverUrl = newConfig.serverUrl;

  if (isEnabled && config.apiKey && config.serverUrl) {
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
    wsUrl.searchParams.set('apiKey', config.apiKey || '');

    wsConnection = new WebSocket(wsUrl.toString());

    wsConnection.onopen = () => {
      console.log('WebSocket connected');
      updateConnectionStatus('connected', null, null);
      startKeepalive();
      refreshConnectionMetadata();
    };

    wsConnection.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') return;

        // Handle non-command messages from server
        if (message.type === 'paired_agents_list') {
          chrome.storage.local.set({ pairedAgents: message.agents });
          try {
            chrome.runtime.sendMessage({ type: 'PAIRED_AGENTS_UPDATED', agents: message.agents });
          } catch (_) { /* popup may not be open */ }
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
      console.log('WebSocket closed:', event.code, event.reason);
      wsConnection = null;
      stopKeepalive();

      let errorMsg = null;
      let errorType = null;
      let shouldRetry = true;

      if (event.code === 1006) {
        errorMsg = `Server not reachable at ${config.serverUrl}`;
        errorType = 'server_unreachable';
        shouldRetry = true;
      } else if (event.code === 1008 || event.reason === 'Unauthorized') {
        errorMsg = 'Authentication failed - invalid API key';
        errorType = 'auth_failed';
        shouldRetry = false;
        chrome.storage.local.remove(['apiKey', 'serverUrl', 'enabled']);
        config.apiKey = null;
        config.serverUrl = null;
        isEnabled = false;
        // Re-fetch credentials from server
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
  chrome.runtime.sendMessage({
    type: 'CONNECTION_STATUS_CHANGED',
    status: status,
    error: error,
    errorType: errorType
  }).catch(() => {});
}

// Command routing
async function handleServerCommand(message) {
  const { id, type, params } = message;

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
      case 'pairing_request': {
        const pairingEntry = { commandId: id, agentName: params.agentName, timestamp: Date.now() };
        const stored = await chrome.storage.local.get('pendingPairingRequests');
        const pending = stored.pendingPairingRequests || [];
        pending.push(pairingEntry);
        await chrome.storage.local.set({ pendingPairingRequests: pending });
        try {
          chrome.runtime.sendMessage({ type: 'PAIRING_REQUEST', commandId: id, agentName: params.agentName });
        } catch (_) { /* popup may not be open */ }
        // Do NOT call sendResult — human must approve/deny via popup
        return;
      }
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
  if (!restrictedModeCache.enabled) return; // restricted mode off, allow all
  if (type === 'get_tabs') return; // get_tabs is always allowed

  let url;
  if (type === 'create_tab') {
    url = params.url;
  } else if (params.tab_id) {
    try {
      const tab = await chrome.tabs.get(params.tab_id);
      url = tab.url;
    } catch {
      // Tab doesn't exist or can't be accessed — fail-closed
      throw new Error('Blocked: Unable to verify tab domain. The human must manually add this site to the whitelist in the WebPilot extension before automation can proceed.');
    }
  } else {
    return; // no tab context to check
  }

  if (!url || !isDomainWhitelisted(url)) {
    let domain = 'unknown';
    try { domain = new URL(url).hostname; } catch {}
    throw new Error(`Blocked: ${domain} is not whitelisted. The human must manually add this site to the whitelist in the WebPilot extension before automation can proceed.`);
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
    if (changes.apiKey) {
      config.apiKey = changes.apiKey.newValue;
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
