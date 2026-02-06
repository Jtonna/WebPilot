document.addEventListener('DOMContentLoaded', () => {
  // Set version from manifest
  const manifest = chrome.runtime.getManifest();
  document.getElementById('versionDisplay').textContent = `v${manifest.version}`;

  const setupView = document.getElementById('setupView');
  const connectedView = document.getElementById('connectedView');
  const connectingView = document.getElementById('connectingView');
  const disconnectedView = document.getElementById('disconnectedView');
  const connectionStringInput = document.getElementById('connectionString');
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const reconnectBtn = document.getElementById('reconnectBtn');
  const forgetBtn = document.getElementById('forgetBtn');
  const setupError = document.getElementById('setupError');
  const connectingError = document.getElementById('connectingError');
  const serverUrlDisplay = document.getElementById('serverUrlDisplay');
  const connectingUrlDisplay = document.getElementById('connectingUrlDisplay');
  const disconnectedUrlDisplay = document.getElementById('disconnectedUrlDisplay');

  loadStateAndShow();

  connectBtn.addEventListener('click', handleConnect);
  disconnectBtn.addEventListener('click', handleDisconnect);
  reconnectBtn.addEventListener('click', handleReconnect);
  forgetBtn.addEventListener('click', handleForget);

  connectionStringInput.addEventListener('input', () => {
    hideError(setupError);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONNECTION_STATUS_CHANGED') {
      handleConnectionStatusChange(msg.status, msg.errorType, msg.error);
    }
  });

  function loadStateAndShow() {
    chrome.storage.local.get(['apiKey', 'serverUrl'], (result) => {
      if (result.apiKey && result.serverUrl) {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
          if (response && response.connectionStatus === 'connected') {
            showView('connected');
            serverUrlDisplay.textContent = result.serverUrl;
          } else if (response && response.connectionStatus === 'connecting') {
            showView('connecting');
            connectingUrlDisplay.textContent = result.serverUrl;
          } else {
            showView('disconnected');
            disconnectedUrlDisplay.textContent = result.serverUrl;
          }
        });
      } else {
        showView('setup');
      }
    });
  }

  function handleConnect() {
    const connectionString = connectionStringInput.value.trim();

    if (!connectionString) {
      showError(setupError, 'Please paste a connection string');
      return;
    }

    const parsed = parseConnectionString(connectionString);

    if (!parsed) {
      showError(setupError, 'Invalid connection string format');
      return;
    }

    if (!parsed.serverUrl || !parsed.apiKey) {
      showError(setupError, 'Connection string missing server URL or API key');
      return;
    }

    connectBtn.disabled = true;
    connectBtn.querySelector('span').textContent = 'Connecting...';

    chrome.storage.local.set({
      apiKey: parsed.apiKey,
      serverUrl: parsed.serverUrl,
      enabled: true
    }, () => {
      showView('connecting');
      connectingUrlDisplay.textContent = parsed.serverUrl;

      chrome.runtime.sendMessage({
        type: 'CONFIG_UPDATED',
        config: { apiKey: parsed.apiKey, serverUrl: parsed.serverUrl }
      });

      chrome.runtime.sendMessage({
        type: 'SERVICE_STATUS_CHANGED',
        enabled: true
      });

      connectBtn.disabled = false;
      connectBtn.querySelector('span').textContent = 'Connect';
      connectionStringInput.value = '';
    });
  }

  function handleDisconnect() {
    chrome.storage.local.set({ enabled: false }, () => {
      chrome.runtime.sendMessage({
        type: 'SERVICE_STATUS_CHANGED',
        enabled: false
      });

      chrome.storage.local.get(['serverUrl'], (result) => {
        showView('disconnected');
        disconnectedUrlDisplay.textContent = result.serverUrl || 'unknown';
      });
    });
  }

  function handleReconnect() {
    reconnectBtn.disabled = true;
    reconnectBtn.textContent = 'Connecting...';

    chrome.storage.local.get(['serverUrl'], (result) => {
      showView('connecting');
      connectingUrlDisplay.textContent = result.serverUrl || 'unknown';
    });

    chrome.runtime.sendMessage({ type: 'CONNECT_REQUEST' }, (response) => {
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = 'Reconnect';

      if (!response || !response.success) {
        showView('setup');
        showError(setupError, response?.error || 'Failed to reconnect - please enter connection string');
      }
    });
  }

  function handleForget() {
    chrome.runtime.sendMessage({ type: 'FORGET_CONFIG' }, () => {
      showView('setup');
      hideError(setupError);
    });
  }

  function handleConnectionStatusChange(status, errorType, errorMsg) {
    chrome.storage.local.get(['serverUrl', 'apiKey'], (result) => {
      const serverUrl = result.serverUrl || 'unknown';
      const hasConfig = result.apiKey && result.serverUrl;

      if (status === 'connected') {
        showView('connected');
        serverUrlDisplay.textContent = serverUrl;
        hideError(connectingError);
      } else if (status === 'connecting') {
        showView('connecting');
        connectingUrlDisplay.textContent = serverUrl;
        hideError(connectingError);
      } else if (status === 'error') {
        if (errorType === 'auth_failed') {
          showView('setup');
          showError(setupError, errorMsg || 'Authentication failed - check your connection string');
        } else if (errorType === 'server_unreachable') {
          showView('connecting');
          connectingUrlDisplay.textContent = serverUrl;
          showError(connectingError, errorMsg || `Server not reachable at ${serverUrl}`);
        } else {
          showView('connecting');
          connectingUrlDisplay.textContent = serverUrl;
          showError(connectingError, errorMsg || 'Connection failed');
        }
      } else {
        if (hasConfig) {
          showView('disconnected');
          disconnectedUrlDisplay.textContent = serverUrl;
        } else {
          showView('setup');
        }
      }
    });
  }

  function parseConnectionString(str) {
    try {
      if (!str.startsWith('vf://')) {
        return null;
      }

      const base64Part = str.slice(5);

      let base64Standard = base64Part.replace(/-/g, '+').replace(/_/g, '/');
      while (base64Standard.length % 4) {
        base64Standard += '=';
      }

      const json = atob(base64Standard);
      const data = JSON.parse(json);

      if (!data.v || !data.s || !data.k) {
        return null;
      }

      return {
        version: data.v,
        serverUrl: data.s,
        apiKey: data.k
      };
    } catch (e) {
      console.error('Failed to parse connection string:', e);
      return null;
    }
  }

  function showView(viewName) {
    setupView.classList.add('hidden');
    connectedView.classList.add('hidden');
    connectingView.classList.add('hidden');
    disconnectedView.classList.add('hidden');

    if (viewName === 'setup') {
      setupView.classList.remove('hidden');
    } else if (viewName === 'connected') {
      connectedView.classList.remove('hidden');
    } else if (viewName === 'connecting') {
      connectingView.classList.remove('hidden');
    } else if (viewName === 'disconnected') {
      disconnectedView.classList.remove('hidden');
    }
  }

  function showError(element, message) {
    element.textContent = message;
    element.classList.add('visible');
  }

  function hideError(element) {
    element.classList.remove('visible');
    element.textContent = '';
  }
});
