/**
 * Accessibility handlers - fetch raw accessibility tree nodes.
 */

import { getSession } from '../utils/debugger.js';

/**
 * Get the accessibility tree for a tab.
 *
 * @param {Object} params
 * @param {number} params.tab_id - Target tab ID
 * @param {boolean} [params.usePlatformOptimizer=true] - Passed through for the server to use
 * @returns {Promise<Object>} Raw nodes, tab URL, tab ID, and usePlatformOptimizer flag
 */
export async function getAccessibilityTree(params) {
  const { tab_id, usePlatformOptimizer = true } = params;

  if (!tab_id) {
    throw new Error('tab_id is required');
  }

  // Get tab URL to pass through to the server
  const tab = await chrome.tabs.get(tab_id);

  const target = await getSession(tab_id);

  await chrome.debugger.sendCommand(target, 'Accessibility.enable');
  const result = await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree');

  return {
    nodes: result.nodes,
    url: tab.url,
    tabId: tab_id,
    usePlatformOptimizer
  };
}
