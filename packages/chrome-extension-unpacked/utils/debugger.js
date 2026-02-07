/**
 * Persistent debugger session management.
 * Sessions stay attached until tab is closed.
 */

const activeSessions = new Map(); // tabId → target

/**
 * Get or create a debugger session for a tab.
 *
 * @param {number} tabId - The tab ID
 * @returns {Promise<{tabId: number}>} The debugger target
 */
export async function getSession(tabId) {
  if (activeSessions.has(tabId)) {
    return activeSessions.get(tabId);
  }

  const target = { tabId };

  // Force-detach any stale session (defensive)
  try {
    await chrome.debugger.detach(target);
  } catch {
    // Ignore - wasn't attached
  }

  await chrome.debugger.attach(target, '1.3');

  // Enable focus emulation so CDP commands work on background tabs
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch (e) {
    console.warn('Failed to enable focus emulation:', e);
  }

  activeSessions.set(tabId, target);
  return target;
}

/**
 * Cleanup session for a tab.
 *
 * @param {number} tabId - The tab ID to cleanup
 */
export function cleanup(tabId) {
  const target = activeSessions.get(tabId);
  if (target) {
    chrome.debugger.detach(target).catch(() => {});
    activeSessions.delete(tabId);
  }
}

/**
 * Check if URL is a protected page that cannot be debugged.
 *
 * @param {string} url - The tab URL
 * @returns {boolean} True if protected
 */
export function isProtectedPage(url) {
  if (!url) return false;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:')
  );
}
