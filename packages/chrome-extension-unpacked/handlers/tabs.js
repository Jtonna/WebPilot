/**
 * Tab handlers - create, close, and list browser tabs.
 * Includes automatic tab group organization for WebPilot.
 */

// Track the WebPilot group ID (null if not yet created)
let webPilotGroupId = null;

// Track the WebPilot window ID for window mode (null if not yet created)
let webPilotWindowId = null;

/**
 * Ensure the WebPilot tab group exists, creating if needed.
 * Returns the group ID or null if no group exists yet.
 */
async function ensureTabGroup() {
  // If we have a cached ID, verify it still exists
  if (webPilotGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(webPilotGroupId);
      if (group) return webPilotGroupId;
    } catch {
      // Group no longer exists, reset
      webPilotGroupId = null;
    }
  }

  // Search for existing WebPilot group
  const groups = await chrome.tabGroups.query({ title: 'WebPilot' });
  if (groups.length > 0) {
    webPilotGroupId = groups[0].id;
    return webPilotGroupId;
  }

  // No existing group - return null (will be created on first tab add)
  return null;
}

/**
 * Read tab settings from chrome.storage.local.
 * @returns {Promise<{tabMode: string, focusNewTabs: boolean}>}
 */
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['tabMode', 'focusNewTabs'], (result) => {
      resolve({
        tabMode: result.tabMode || 'group',
        focusNewTabs: result.focusNewTabs === true // default false
      });
    });
  });
}

/**
 * Ensure the WebPilot window exists, returning its ID or null.
 * @returns {Promise<number|null>}
 */
async function ensureWebPilotWindow() {
  if (webPilotWindowId !== null) {
    try {
      const win = await chrome.windows.get(webPilotWindowId);
      if (win) return webPilotWindowId;
    } catch {
      webPilotWindowId = null;
    }
  }
  return null;
}

/**
 * Move a tab into the WebPilot window.
 * @param {number} tabId - Tab ID to move
 * @returns {Promise<Object>} Result with success status and windowId
 */
export async function addTabToWindow(tabId) {
  try {
    let windowId = await ensureWebPilotWindow();
    if (windowId !== null) {
      await chrome.tabs.move(tabId, { windowId, index: -1 });
      return { success: true, windowId };
    }
    // No WebPilot window yet - don't create one just for organizing
    return { success: false, error: 'No WebPilot window exists' };
  } catch (error) {
    console.warn('Failed to move tab to WebPilot window:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Organize a tab based on the current tabMode setting.
 * In 'window' mode, moves tab to the WebPilot window.
 * In 'group' mode (default), adds tab to the WebPilot tab group.
 *
 * @param {number} tabId - Tab ID to organize
 * @returns {Promise<Object>} Result with success status
 */
export async function organizeTab(tabId) {
  const { tabMode } = await getSettings();
  if (tabMode === 'window') {
    return addTabToWindow(tabId);
  }
  return addTabToGroup(tabId);
}

/**
 * Add a tab to the WebPilot group.
 * Creates the group if it doesn't exist.
 *
 * @param {number} tabId - Tab ID to add to group
 * @returns {Promise<Object>} Result with success status and groupId
 */
export async function addTabToGroup(tabId) {
  try {
    let groupId = await ensureTabGroup();

    if (groupId === null) {
      // Create new group with this tab
      groupId = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(groupId, {
        title: 'WebPilot',
        color: 'cyan'
      });
      webPilotGroupId = groupId;
    } else {
      // Add to existing group
      await chrome.tabs.group({ tabIds: tabId, groupId });
    }

    return { success: true, groupId };
  } catch (error) {
    // Non-fatal - log but don't throw
    console.warn('Failed to add tab to group:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Create a new browser tab.
 *
 * @param {Object} params
 * @param {string} params.url - URL to open
 * @returns {Promise<Object>} Tab info with id, url, title
 */
export async function createTab(params) {
  const { url } = params;

  if (!url) {
    throw new Error('URL is required');
  }

  const { tabMode, focusNewTabs } = await getSettings();

  if (tabMode === 'window') {
    let windowId = await ensureWebPilotWindow();

    if (windowId === null) {
      // Create new WebPilot window with this URL
      const win = await chrome.windows.create({ url, focused: true });
      webPilotWindowId = win.id;
      const tab = win.tabs[0];
      await addTabToGroup(tab.id);
      return {
        tab_id: tab.id,
        url: tab.url || url,
        title: tab.title || ''
      };
    }

    // Add tab to existing WebPilot window
    const tab = await chrome.tabs.create({ url, windowId, active: focusNewTabs });
    if (focusNewTabs) {
      await chrome.windows.update(windowId, { focused: true });
    }
    await addTabToGroup(tab.id);
    return {
      tab_id: tab.id,
      url: tab.url || url,
      title: tab.title || ''
    };
  }

  // Default: tab group mode
  const tab = await chrome.tabs.create({ url, active: focusNewTabs });
  await addTabToGroup(tab.id);
  return {
    tab_id: tab.id,
    url: tab.url || url,
    title: tab.title || ''
  };
}

/**
 * Close a browser tab.
 *
 * @param {Object} params
 * @param {number} params.tab_id - Tab ID to close
 * @returns {Promise<Object>} Success status
 */
export async function closeTab(params) {
  const { tab_id } = params;

  if (!tab_id) {
    throw new Error('tab_id is required');
  }

  await chrome.tabs.remove(tab_id);

  return { success: true };
}

/**
 * Get all open browser tabs.
 *
 * @returns {Promise<Array>} Array of tab info objects
 */
export async function getTabs() {
  const tabs = await chrome.tabs.query({});

  return tabs.map(tab => ({
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
    groupId: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null
  }));
}
