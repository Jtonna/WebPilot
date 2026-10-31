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
 * Read saved WebPilot window bounds from chrome.storage.local.
 * @returns {Promise<Object|null>}
 */
async function getSavedWindowBounds() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['webPilotWindowBounds'], (result) => {
      resolve(result.webPilotWindowBounds || null);
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
 * Validate and normalize a URL before anything is created, so a bad URL fails
 * with a clear error instead of leaving a blank window/tab behind.
 * Only http(s) and about:blank are accepted: Chrome refuses (or silently
 * replaces with about:blank / the new-tab page) chrome://, file://, javascript:,
 * data: and similar when opened from an extension.
 * A scheme-less value such as "example.com" or "localhost:3000" gets https://.
 *
 * @param {*} raw
 * @returns {string} Normalized absolute URL
 */
function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('URL is required');
  }
  let candidate = raw.trim();
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(?!\d+(\/|$))/i.exec(candidate);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'about') {
      if (candidate.toLowerCase() !== 'about:blank') {
        throw new Error(`Unsupported URL "${raw}": only http(s) URLs and about:blank can be opened`);
      }
      return 'about:blank';
    }
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(
        `Unsupported URL scheme "${scheme}:" in "${raw}": only http(s) URLs can be opened`
      );
    }
  } else {
    candidate = candidate.replace(/^\/\//, '');
    candidate = 'https://' + candidate;
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid URL "${raw}"`);
  }
  if (!parsed.hostname) {
    throw new Error(`Invalid URL "${raw}": missing host`);
  }
  return parsed.href;
}

/**
 * Create a new browser tab.
 *
 * The URL is validated up front and always passed at creation time (never a
 * separate navigate step). If a step after creation fails: grouping/focus are
 * best-effort (tab already exists with its URL, so succeed with a warning);
 * anything else closes the just-created window/tab before the error is thrown,
 * so a failed call never leaves an orphan empty window.
 *
 * @param {Object} params
 * @param {string} params.url - URL to open
 * @returns {Promise<Object>} Tab info with id, url, title (plus warning if a non-fatal step failed)
 */
export async function createTab(params) {
  const url = normalizeUrl(params && params.url);

  const { tabMode, focusNewTabs } = await getSettings();
  const warnings = [];
  const result = (tab) => {
    const out = {
      tab_id: tab.id,
      url: tab.url || tab.pendingUrl || url,
      title: tab.title || ''
    };
    if (warnings.length > 0) out.warning = warnings.join('; ');
    return out;
  };
  const group = async (tabId) => {
    const r = await addTabToGroup(tabId);
    if (!r.success) warnings.push(`tab not grouped: ${r.error}`);
  };

  if (tabMode === 'window') {
    let windowId = await ensureWebPilotWindow();

    if (windowId === null) {
      // Create new WebPilot window with this URL
      const bounds = await getSavedWindowBounds();
      const createOpts = { url, focused: true };
      if (bounds) {
        createOpts.width = bounds.width;
        createOpts.height = bounds.height;
        createOpts.top = bounds.top;
        createOpts.left = bounds.left;
      }
      let win;
      try {
        win = await chrome.windows.create(createOpts);
      } catch (error) {
        if (!bounds) throw error;
        // Saved bounds can be invalid (e.g. monitor gone). Retry without them,
        // still with the URL.
        console.warn('windows.create with saved bounds failed, retrying without:', error.message);
        win = await chrome.windows.create({ url, focused: true });
      }
      try {
        webPilotWindowId = win.id;
        let tab = win.tabs && win.tabs[0];
        if (!tab) {
          [tab] = await chrome.tabs.query({ windowId: win.id });
        }
        if (!tab) {
          throw new Error('New window has no tab');
        }
        await group(tab.id);
        return result(tab);
      } catch (error) {
        // Never leave an orphan window behind an error.
        webPilotWindowId = null;
        await chrome.windows.remove(win.id).catch(() => {});
        throw error;
      }
    }

    // Add tab to existing WebPilot window
    const tab = await chrome.tabs.create({ url, windowId, active: focusNewTabs });
    if (focusNewTabs) {
      try {
        await chrome.windows.update(windowId, { focused: true });
      } catch (error) {
        warnings.push(`window not focused: ${error.message}`);
      }
    }
    await group(tab.id);
    return result(tab);
  }

  // Default: tab group mode
  const tab = await chrome.tabs.create({ url, active: focusNewTabs });
  await group(tab.id);
  return result(tab);
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
    // URL the tab is navigating to before it commits (undefined once loaded).
    // Lets the server match a tab Chrome opened from its command line while
    // it is still loading.
    pendingUrl: tab.pendingUrl,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
    groupId: tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE ? tab.groupId : null
  }));
}

/**
 * Get the WebPilot window ID for external use.
 * @returns {number|null}
 */
export function getWebPilotWindowId() {
  return webPilotWindowId;
}
