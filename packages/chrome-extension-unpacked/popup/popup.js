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
  const settingsSection = document.getElementById('settingsSection');
  const focusNewTabsToggle = document.getElementById('focusNewTabs');
  const tabModeSelect = document.getElementById('tabMode');
  const restrictedModeToggle = document.getElementById('restrictedMode');
  const whitelistPanel = document.getElementById('whitelistPanel');
  const whitelistCurrentBtn = document.getElementById('whitelistCurrentBtn');
  const domainInput = document.getElementById('domainInput');
  const addDomainBtn = document.getElementById('addDomainBtn');
  const domainList = document.getElementById('domainList');
  const pairingRequestsSection = document.getElementById('pairingRequestsSection');
  const pairingRequestsList = document.getElementById('pairingRequestsList');
  const pairedAgentsSection = document.getElementById('pairedAgentsSection');
  const pairedAgentsList = document.getElementById('pairedAgentsList');
  const noAgentsMessage = document.getElementById('noAgentsMessage');

  loadStateAndShow();

  connectBtn.addEventListener('click', handleConnect);
  disconnectBtn.addEventListener('click', handleDisconnect);
  reconnectBtn.addEventListener('click', handleReconnect);
  forgetBtn.addEventListener('click', handleForget);

  connectionStringInput.addEventListener('input', () => {
    hideError(setupError);
  });

  focusNewTabsToggle.addEventListener('change', () => {
    chrome.storage.local.set({ focusNewTabs: focusNewTabsToggle.checked });
  });

  tabModeSelect.addEventListener('change', () => {
    chrome.storage.local.set({ tabMode: tabModeSelect.value });
  });

  restrictedModeToggle.addEventListener('change', () => {
    const enabled = restrictedModeToggle.checked;
    chrome.storage.local.set({ restrictedModeEnabled: enabled });
    if (enabled) {
      whitelistPanel.classList.remove('hidden');
      updateWhitelistUI();
    } else {
      whitelistPanel.classList.add('hidden');
    }
  });

  whitelistCurrentBtn.addEventListener('click', handleWhitelistCurrentSite);
  addDomainBtn.addEventListener('click', handleAddDomain);
  domainInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      handleAddDomain();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CONNECTION_STATUS_CHANGED') {
      handleConnectionStatusChange(msg.status, msg.errorType, msg.error);
    } else if (msg.type === 'PAIRING_REQUEST') {
      addPairingRequest(msg.request);
    } else if (msg.type === 'PAIRED_AGENTS_UPDATED') {
      renderPairedAgents(msg.agents || []);
    }
  });

  function loadStateAndShow() {
    chrome.storage.local.get(['apiKey', 'serverUrl'], (result) => {
      if (result.apiKey && result.serverUrl) {
        chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
          if (response && response.connectionStatus === 'connected') {
            showView('connected');
            serverUrlDisplay.textContent = result.serverUrl;
            loadPairingData();
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
        loadPairingData();
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

  function loadSettings() {
    chrome.storage.local.get(['focusNewTabs', 'tabMode', 'restrictedModeEnabled', 'whitelistedDomains'], (result) => {
      focusNewTabsToggle.checked = result.focusNewTabs === true; // default false
      tabModeSelect.value = result.tabMode || 'group'; // default 'group'

      // Default restrictedModeEnabled to true if undefined
      const restrictedEnabled = result.restrictedModeEnabled !== undefined ? result.restrictedModeEnabled : true;
      restrictedModeToggle.checked = restrictedEnabled;

      if (restrictedEnabled) {
        whitelistPanel.classList.remove('hidden');
        updateWhitelistUI();
      } else {
        whitelistPanel.classList.add('hidden');
      }
    });
  }

  function normalizeDomain(input) {
    let domain = input.trim().toLowerCase();
    // Strip protocol
    domain = domain.replace(/^https?:\/\//, '');
    // Strip www.
    domain = domain.replace(/^www\./, '');
    // Strip path/query/hash
    domain = domain.split('/')[0].split('?')[0].split('#')[0];
    return domain;
  }

  async function getCurrentTabDomain() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].url) {
          try {
            const url = new URL(tabs[0].url);
            const domain = normalizeDomain(url.hostname);
            resolve(domain);
          } catch (e) {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });
  }

  async function handleWhitelistCurrentSite() {
    const domain = await getCurrentTabDomain();
    if (!domain) {
      return;
    }

    chrome.storage.local.get(['whitelistedDomains'], (result) => {
      let domains = result.whitelistedDomains || [];
      const index = domains.indexOf(domain);

      if (index >= 0) {
        // Remove domain
        domains.splice(index, 1);
      } else {
        // Add domain
        domains.push(domain);
      }

      chrome.storage.local.set({ whitelistedDomains: domains }, () => {
        updateWhitelistUI();
      });
    });
  }

  function handleAddDomain() {
    const input = domainInput.value.trim();
    if (!input) {
      return;
    }

    const domain = normalizeDomain(input);
    if (!domain) {
      return;
    }

    chrome.storage.local.get(['whitelistedDomains'], (result) => {
      let domains = result.whitelistedDomains || [];

      // Reject duplicates silently
      if (domains.includes(domain)) {
        domainInput.value = '';
        return;
      }

      domains.push(domain);
      chrome.storage.local.set({ whitelistedDomains: domains }, () => {
        domainInput.value = '';
        updateWhitelistUI();
      });
    });
  }

  function removeDomain(domain) {
    chrome.storage.local.get(['whitelistedDomains'], (result) => {
      let domains = result.whitelistedDomains || [];
      const index = domains.indexOf(domain);

      if (index >= 0) {
        domains.splice(index, 1);
        chrome.storage.local.set({ whitelistedDomains: domains }, () => {
          updateWhitelistUI();
        });
      }
    });
  }

  async function updateWhitelistUI() {
    const currentDomain = await getCurrentTabDomain();

    chrome.storage.local.get(['whitelistedDomains'], (result) => {
      const domains = result.whitelistedDomains || [];

      // Update current site button
      if (currentDomain) {
        const isWhitelisted = domains.includes(currentDomain);
        whitelistCurrentBtn.textContent = isWhitelisted ? 'Remove this site' : 'Whitelist this site';
        if (isWhitelisted) {
          whitelistCurrentBtn.classList.add('remove');
        } else {
          whitelistCurrentBtn.classList.remove('remove');
        }
        whitelistCurrentBtn.style.display = 'block';
      } else {
        whitelistCurrentBtn.style.display = 'none';
      }

      // Render domain list
      domainList.innerHTML = '';
      domains.forEach((domain) => {
        const item = document.createElement('div');
        item.className = 'domain-item';

        const name = document.createElement('span');
        name.className = 'domain-name';
        name.textContent = domain;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-domain-btn';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => removeDomain(domain));

        item.appendChild(name);
        item.appendChild(removeBtn);
        domainList.appendChild(item);
      });
    });
  }

  function loadPairingData() {
    chrome.runtime.sendMessage({ type: 'GET_PENDING_PAIRING' }, (response) => {
      renderPairingRequests(response?.requests || []);
    });
    chrome.runtime.sendMessage({ type: 'GET_PAIRED_AGENTS' }, (response) => {
      renderPairedAgents(response?.agents || []);
    });
  }

  function renderPairingRequests(requests) {
    pairingRequestsList.innerHTML = '';

    if (requests.length === 0) {
      pairingRequestsSection.style.display = 'none';
      return;
    }

    pairingRequestsSection.style.display = 'block';

    requests.forEach((request) => {
      const card = createPairingRequestCard(request);
      pairingRequestsList.appendChild(card);
    });
  }

  function addPairingRequest(request) {
    if (!request) return;
    pairingRequestsSection.style.display = 'block';
    const card = createPairingRequestCard(request);
    pairingRequestsList.appendChild(card);
  }

  function createPairingRequestCard(request) {
    const card = document.createElement('div');
    card.className = 'pairing-request-card';
    card.dataset.commandId = request.commandId;

    const info = document.createElement('div');
    info.className = 'pairing-request-info';

    const name = document.createElement('span');
    name.className = 'pairing-request-name';
    name.textContent = request.agentName || 'Unknown Agent';

    const desc = document.createElement('span');
    desc.className = 'pairing-request-desc';
    desc.textContent = 'wants to connect';

    info.appendChild(name);
    info.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'pairing-request-actions';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'approve-btn';
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'PAIRING_RESPONSE',
        commandId: request.commandId,
        approved: true
      });
      card.remove();
      if (pairingRequestsList.children.length === 0) {
        pairingRequestsSection.style.display = 'none';
      }
    });

    const denyBtn = document.createElement('button');
    denyBtn.className = 'deny-btn';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'PAIRING_RESPONSE',
        commandId: request.commandId,
        approved: false
      });
      card.remove();
      if (pairingRequestsList.children.length === 0) {
        pairingRequestsSection.style.display = 'none';
      }
    });

    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);

    card.appendChild(info);
    card.appendChild(actions);

    return card;
  }

  function renderPairedAgents(agents) {
    pairedAgentsList.innerHTML = '';

    if (agents.length === 0) {
      pairedAgentsSection.style.display = 'none';
      noAgentsMessage.style.display = 'block';
      return;
    }

    pairedAgentsSection.style.display = 'block';
    noAgentsMessage.style.display = 'none';

    agents.forEach((agent) => {
      const item = document.createElement('div');
      item.className = 'paired-agent-item';

      const info = document.createElement('div');
      info.className = 'paired-agent-info';

      const name = document.createElement('span');
      name.className = 'paired-agent-name';
      name.textContent = agent.name || 'Unknown Agent';

      const date = document.createElement('span');
      date.className = 'paired-agent-date';
      date.textContent = agent.pairedAt ? formatDate(agent.pairedAt) : '';

      info.appendChild(name);
      info.appendChild(date);

      const revokeBtn = document.createElement('button');
      revokeBtn.className = 'revoke-btn';
      revokeBtn.textContent = 'Revoke';
      revokeBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'REVOKE_KEY', apiKey: agent.key }, () => {
          item.remove();
          if (pairedAgentsList.children.length === 0) {
            noAgentsMessage.style.display = 'block';
          }
        });
      });

      item.appendChild(info);
      item.appendChild(revokeBtn);
      pairedAgentsList.appendChild(item);
    });
  }

  function formatDate(dateStr) {
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      return dateStr;
    }
  }

  function showView(viewName) {
    setupView.classList.add('hidden');
    connectedView.classList.add('hidden');
    connectingView.classList.add('hidden');
    disconnectedView.classList.add('hidden');

    // Show settings when connected or disconnected (has config)
    if (viewName === 'connected' || viewName === 'disconnected') {
      settingsSection.classList.remove('hidden');
      loadSettings();
    } else {
      settingsSection.classList.add('hidden');
    }

    // Hide pairing sections when not connected
    if (viewName !== 'connected') {
      pairingRequestsSection.style.display = 'none';
      pairedAgentsSection.style.display = 'none';
    }

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
