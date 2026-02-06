/**
 * Tab handlers - create, close, and list browser tabs.
 * Includes automatic tab group organization for WebPilot.
 */

// Track the WebPilot group ID (null if not yet created)
let webPilotGroupId = null;

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

  const tab = await chrome.tabs.create({ url, active: true });

  // Add to WebPilot group (non-blocking, non-fatal)
  addTabToGroup(tab.id);

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
