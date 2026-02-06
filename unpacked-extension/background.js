/**
 * Background service worker - thin orchestrator.
 * Handles WebSocket connection and routes commands to handlers.
 */

import { clearRefs } from './accessibility-storage.js';
import { clearPosition } from './utils/mouse-state.js';
import { cleanup as cleanupDebugger } from './utils/debugger.js';
import { createTab, closeTab, getTabs, addTabToGroup } from './handlers/tabs.js';
import { getAccessibilityTree } from './handlers/accessibility.js';
import { injectScript, executeJs, handleNavigationComplete, handleTabClosed } from './handlers/scripts.js';
import { click } from './handlers/click.js';
import { scroll } from './handlers/scroll.js';
import { type as typeText } from './handlers/keyboard.js';

// WebSocket connection state
let wsConnection = null;
let isEnabled = false;
let connectionStatus = 'disconnected';
let connectionError = null;
let connectionErrorType = null;
let keepaliveInterval = null;
const KEEPALIVE_INTERVAL_MS = 15000;
let config = {
  apiKey: null,
  serverUrl: null
};

// Extension lifecycle
chrome.runtime.onInstalled.addListener(() => {
  console.log('WebPilot extension installed');
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

    // Auto-connect if previously enabled with valid config
    if (isEnabled && config.apiKey && config.serverUrl) {
      console.log('Auto-reconnecting on service worker startup...');
      connectWebSocket();
    }
  });
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

    case 'FORGET_CONFIG':
      disconnectWebSocket();
      chrome.storage.local.remove(['apiKey', 'serverUrl', 'enabled']);
      config.apiKey = null;
      config.serverUrl = null;
      isEnabled = false;
      sendResponse({ success: true });
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
    };

    wsConnection.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') return;
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

      if (shouldRetry && isEnabled && config.serverUrl) {
        setTimeout(() => {
          if (isEnabled) {
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
        addTabToGroup(params.tab_id);
        break;
      case 'inject_script':
        result = await injectScript(params);
        addTabToGroup(params.tab_id);
        break;
      case 'execute_js':
        result = await executeJs(params);
        addTabToGroup(params.tab_id);
        break;
      case 'click':
        result = await click(params);
        addTabToGroup(params.tab_id);
        break;
      case 'scroll':
        result = await scroll(params);
        addTabToGroup(params.tab_id);
        break;
      case 'type':
        result = await typeText(params);
        addTabToGroup(params.tab_id);
        break;
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
    if (changes.apiKey) {
      config.apiKey = changes.apiKey.newValue;
    }
    if (changes.serverUrl) {
      config.serverUrl = changes.serverUrl.newValue;
    }
  }
});
