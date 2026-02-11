/**
 * Accessibility handlers - fetch and format accessibility trees.
 */

import { formatAccessibilityTree, extractAncestryContext } from '../accessibility-tree.js';
import { formatThreadsTree } from '../formatters/threads.js';
import { formatZillowTree } from '../formatters/zillow.js';
import { storeRefs, storeRefContext } from '../accessibility-storage.js';
import { getSession } from '../utils/debugger.js';

/**
 * Detect platform from URL and return appropriate formatter.
 *
 * @param {string} url - Tab URL
 * @returns {{ formatter: Function, platform: string } | null}
 */
function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname;

    if (hostname.includes('threads.com')) {
      return { formatter: formatThreadsTree, platform: 'threads' };
    }

    if (hostname.includes('zillow.com')) {
      return { formatter: formatZillowTree, platform: 'zillow' };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Build ancestry context for all refs.
 * Stores structural context (role, name, parent, ancestor content) for re-identification after scroll.
 *
 * @param {number} tab_id - Tab ID
 * @param {Array} nodes - Raw accessibility tree nodes
 * @param {Object} refs - Map of ref -> backendNodeId
 */
function buildRefContext(tab_id, nodes, refs) {
  // Build nodeMap for parent lookup
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Store ancestry context for each ref
  for (const [ref, backendNodeId] of Object.entries(refs)) {
    const node = nodes.find(n => n.backendDOMNodeId === backendNodeId);
    if (node) {
      const context = extractAncestryContext(node, nodeMap);
      storeRefContext(tab_id, ref, context);
    }
  }
}

/**
 * Get the accessibility tree for a tab.
 *
 * @param {Object} params
 * @param {number} params.tab_id - Target tab ID
 * @param {boolean} [params.usePlatformOptimizer=true] - Use platform-specific formatting if available
 * @returns {Promise<Object>} Formatted tree and element count
 */
export async function getAccessibilityTree(params) {
  const { tab_id, usePlatformOptimizer = true } = params;

  if (!tab_id) {
    throw new Error('tab_id is required');
  }

  // Get tab URL for platform detection
  let platformInfo = null;
  if (usePlatformOptimizer) {
    const tab = await chrome.tabs.get(tab_id);
    platformInfo = detectPlatform(tab.url || '');
  }

  const target = await getSession(tab_id);

  await chrome.debugger.sendCommand(target, 'Accessibility.enable');
  const result = await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree');

  // Use platform-specific formatter or generic
  if (platformInfo) {
    const formatted = platformInfo.formatter(result.nodes);
    storeRefs(tab_id, formatted.refs);

    // Build ancestry context for re-identification after scroll
    buildRefContext(tab_id, result.nodes, formatted.refs);

    return {
      tree: formatted.tree,
      elementCount: formatted.elementCount,
      postCount: formatted.postCount,
      listingCount: formatted.listingCount,
      platform: platformInfo.platform
    };
  }

  // Default: generic accessibility tree
  const { tree, elementCount, refs } = formatAccessibilityTree(result.nodes);
  storeRefs(tab_id, refs);

  // Build ancestry context for re-identification after scroll
  buildRefContext(tab_id, result.nodes, refs);

  return { tree, elementCount };
}
