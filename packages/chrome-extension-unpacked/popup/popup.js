document.addEventListener('DOMContentLoaded', () => {
  // Set version from manifest
  const manifest = chrome.runtime.getManifest();
  document.getElementById('versionDisplay').textContent = `v${manifest.version}`;

  const connectedView = document.getElementById('connectedView');
  const connectingView = document.getElementById('connectingView');
  const disconnectedView = document.getElementById('disconnectedView');
  const profileIdentifyView = document.getElementById('profileIdentifyView');
  const profileIdSelect = document.getElementById('profileIdSelect');
  const profileIdConfirmBtn = document.getElementById('profileIdConfirmBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const retryBtn = document.getElementById('retryBtn');
  const connectingError = document.getElementById('connectingError');
  const serverUrlDisplay = document.getElementById('serverUrlDisplay');
  const connectingUrlDisplay = document.getElementById('connectingUrlDisplay');
  const disconnectedUrlDisplay = document.getElementById('disconnectedUrlDisplay');
  const wsUrlDisplay = document.getElementById('wsUrlDisplay');
  const sseUrlDisplay = document.getElementById('sseUrlDisplay');
  const networkModeDisplay = document.getElementById('networkModeDisplay');
  const focusNewTabsToggle = document.getElementById('focusNewTabs');
  const tabModeSelect = document.getElementById('tabMode');
  const restrictedModeToggle = document.getElementById('restrictedMode');
  const whitelistPanel = document.getElementById('whitelistPanel');
  const whitelistCurrentBtn = document.getElementById('whitelistCurrentBtn');
  const domainInput = document.getElementById('domainInput');
  const addDomainBtn = document.getElementById('addDomainBtn');
  const domainList = document.getElementById('domainList');
  const checkFormatterUpdatesBtn = document.getElementById('checkFormatterUpdates');
  const formatterUpdateStatus = document.getElementById('formatterUpdateStatus');

  // Tab switching
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  function switchTab(tabName) {
    tabBtns.forEach((btn) => {
      if (btn.dataset.tab === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    tabContents.forEach((content) => {
      if (content.id === `tab-${tabName}`) {
        content.classList.add('active');
      } else {
        content.classList.remove('active');
      }
    });

    if (tabName === 'settings') {
      loadSettings();
    }
  }

  loadStateAndShow();

  disconnectBtn.addEventListener('click', handleDisconnect);
  retryBtn.addEventListener('click', handleRetry);
  checkFormatterUpdatesBtn.addEventListener('click', handleCheckFormatterUpdates);

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
    } else if (msg.type === 'IDENTIFY_REQUIRED') {
      renderProfilePicker(msg.knownProfiles || []);
    }
  });

  // React to storage changes from background (e.g. refreshConnectionMetadata after reconnect)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
      if (changes.networkMode || changes.serverUrl || changes.sseUrl) {
        updateEndpointDisplay();
      }
    }
  });

  function updateEndpointDisplay() {
    chrome.storage.local.get(['serverUrl', 'sseUrl', 'networkMode'], (result) => {
      const wsUrl = result.serverUrl || 'ws://localhost:3456';
      const sseUrl = result.sseUrl || wsUrl.replace('ws://', 'http://').replace('wss://', 'https://') + '/sse';
      wsUrlDisplay.textContent = wsUrl;
      sseUrlDisplay.textContent = sseUrl;
      networkModeDisplay.textContent = result.networkMode ? 'Network (LAN)' : 'Local only';
      if (result.networkMode) {
        networkModeDisplay.classList.add('network-enabled');
      } else {
        networkModeDisplay.classList.remove('network-enabled');
      }
    });
  }

  function loadStateAndShow() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (response && response.connectionStatus === 'connected') {
        showView('connected');
        chrome.storage.local.get(['serverUrl'], (result) => {
          serverUrlDisplay.textContent = result.serverUrl || 'ws://localhost:3456';
        });
        updateEndpointDisplay();
        loadRestrictedModeSettings();
      } else if (response && response.manuallyDisconnected) {
        showView('disconnected');
        chrome.storage.local.get(['serverUrl'], (result) => {
          disconnectedUrlDisplay.textContent = result.serverUrl || 'ws://localhost:3456';
        });
      } else if (response && (response.connectionStatus === 'connecting' || response.connectionStatus === 'error')) {
        showView('connecting');
        chrome.storage.local.get(['serverUrl'], (result) => {
          connectingUrlDisplay.textContent = result.serverUrl || 'ws://localhost:3456';
        });
        if (response.connectionError) {
          showError(connectingError, response.connectionError);
        }
      } else {
        showView('connecting');
        connectingUrlDisplay.textContent = 'ws://localhost:3456';
      }
    });
  }

  function handleDisconnect() {
    chrome.runtime.sendMessage({ type: 'DISCONNECT' }, () => {
      chrome.storage.local.get(['serverUrl'], (result) => {
        showView('disconnected');
        disconnectedUrlDisplay.textContent = result.serverUrl || 'unknown';
      });
    });
  }

  function handleRetry() {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying...';

    showView('connecting');
    connectingUrlDisplay.textContent = 'ws://localhost:3456';
    hideError(connectingError);

    chrome.runtime.sendMessage({ type: 'RETRY_AUTO_CONNECT' }, () => {
      retryBtn.disabled = false;
      retryBtn.textContent = 'Retry';
    });
  }

  function handleCheckFormatterUpdates() {
    const btn = checkFormatterUpdatesBtn;
    const status = formatterUpdateStatus;

    btn.disabled = true;
    btn.textContent = 'Checking...';
    status.style.display = 'none';

    chrome.runtime.sendMessage({ type: 'CHECK_FORMATTER_UPDATES' }, (response) => {
      btn.disabled = false;
      btn.textContent = 'Check for formatter updates';
      status.style.display = 'block';

      if (response && response.updated) {
        status.textContent = `Updated to version ${response.toVersion}`;
        status.style.color = '#4CAF50';
      } else if (response && !response.error) {
        status.textContent = `Already up to date (version ${response.currentVersion})`;
        status.style.color = '#666';
      } else {
        status.textContent = 'Update check failed';
        status.style.color = '#f44336';
      }

      setTimeout(() => { status.style.display = 'none'; }, 5000);
    });
  }

  function handleConnectionStatusChange(status, errorType, errorMsg) {
    chrome.storage.local.get(['serverUrl'], (result) => {
      const serverUrl = result.serverUrl || 'ws://localhost:3456';

      if (status === 'connected') {
        showView('connected');
        serverUrlDisplay.textContent = serverUrl;
        hideError(connectingError);
        updateEndpointDisplay();
        loadRestrictedModeSettings();
      } else if (status === 'connecting') {
        showView('connecting');
        connectingUrlDisplay.textContent = serverUrl;
        hideError(connectingError);
      } else if (status === 'error') {
        showView('connecting');
        connectingUrlDisplay.textContent = serverUrl;
        showError(connectingError, errorMsg || 'Connection failed');
      } else {
        showView('disconnected');
        disconnectedUrlDisplay.textContent = serverUrl;
      }
    });
  }

  function loadSettings() {
    chrome.storage.local.get(['focusNewTabs', 'tabMode'], (result) => {
      focusNewTabsToggle.checked = result.focusNewTabs === true;
      tabModeSelect.value = result.tabMode || 'group';
    });
  }

  function loadRestrictedModeSettings() {
    chrome.storage.local.get(['restrictedModeEnabled', 'whitelistedDomains'], (result) => {
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
    domain = domain.replace(/^https?:\/\//, '');
    domain = domain.replace(/^www\./, '');
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
        domains.splice(index, 1);
      } else {
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

  // ---- Profile self-identification picker ----

  function renderProfilePicker(knownProfiles) {
    if (!profileIdSelect) return;
    profileIdSelect.innerHTML = '';
    (knownProfiles || []).forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.directoryName;
      const label = p.displayName ? p.displayName + ' (' + p.directoryName + ')' : p.directoryName;
      opt.textContent = p.gaiaEmail ? label + ' — ' + p.gaiaEmail : label;
      profileIdSelect.appendChild(opt);
    });
    showView('identify');
  }

  if (profileIdConfirmBtn) {
    profileIdConfirmBtn.addEventListener('click', () => {
      const chosen = profileIdSelect && profileIdSelect.value;
      if (!chosen) return;
      profileIdConfirmBtn.disabled = true;
      profileIdConfirmBtn.textContent = 'Saving...';
      chrome.runtime.sendMessage({ type: 'SET_PROFILE_ID', profileId: chosen }, (response) => {
        profileIdConfirmBtn.disabled = false;
        profileIdConfirmBtn.textContent = 'I am this profile';
        if (response && response.success) {
          showView('connecting');
        }
      });
    });
  }

  chrome.runtime.sendMessage({ type: 'GET_PROFILE_IDENTITY' }, (resp) => {
    if (resp && !resp.profileId && resp.knownProfiles && resp.knownProfiles.length > 0) {
      renderProfilePicker(resp.knownProfiles);
    }
  });

  function showView(viewName) {
    connectedView.classList.add('hidden');
    connectingView.classList.add('hidden');
    disconnectedView.classList.add('hidden');
    if (profileIdentifyView) profileIdentifyView.classList.add('hidden');

    if (viewName === 'connected') {
      connectedView.classList.remove('hidden');
    } else if (viewName === 'connecting') {
      connectingView.classList.remove('hidden');
    } else if (viewName === 'disconnected') {
      disconnectedView.classList.remove('hidden');
    } else if (viewName === 'identify' && profileIdentifyView) {
      profileIdentifyView.classList.remove('hidden');
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
