/**
 * Zillow Platform Formatter - Router
 * Detects page type and delegates to appropriate formatter.
 * Detects property detail overlay and includes overlay data when present.
 */

import { formatHomePage } from './zillow_home.js';
import { formatSearchPage } from './zillow_search.js';
import { formatDetailOverlay } from './zillow_detail.js';
import { formatDetailPage } from './zillow_detail_page.js';

export function formatZillowTree(nodes) {
  // Build node map for fast lookups
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  // Ref tracking for element references
  const refMap = new Map();
  const refs = {};
  let refCounter = 1;

  function getRef(node) {
    const nodeId = node.nodeId;
    if (!refMap.has(nodeId)) {
      const ref = `e${refCounter++}`;
      refMap.set(nodeId, ref);
      if (node.backendDOMNodeId) {
        refs[ref] = node.backendDOMNodeId;
      }
    }
    return refMap.get(nodeId);
  }

  // Helper functions
  function getNodeName(node) {
    return node.name?.value || '';
  }

  function getNodeRole(node) {
    return node.role?.value || '';
  }

  function getNodeUrl(node) {
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name === 'url' && prop.value?.value) {
          return prop.value.value;
        }
      }
    }
    return null;
  }

  function findChildrenByRole(nodeId, role) {
    const results = [];
    const node = nodeMap.get(nodeId);
    if (!node || !node.childIds) return results;

    for (const childId of node.childIds) {
      const child = nodeMap.get(childId);
      if (child && getNodeRole(child) === role) {
        results.push(child);
      }
      results.push(...findChildrenByRole(childId, role));
    }
    return results;
  }

  // Find root node
  const rootNode = nodes.find(n => !n.parentId);
  if (!rootNode) {
    return {
      tree: JSON.stringify({ error: 'No content found' }),
      elementCount: 0,
      listingCount: 0,
      refs: {}
    };
  }

  // Extract source info
  const source = {
    title: getNodeName(rootNode),
    url: getNodeUrl(rootNode)
  };

  // Extract main navigation
  const nav = [];
  const navNames = ['Buy', 'Rent', 'Sell', 'Get a mortgage', 'Find an agent'];
  const allLinks = findChildrenByRole(rootNode.nodeId, 'link');

  for (const link of allLinks) {
    const name = getNodeName(link);
    if (navNames.includes(name)) {
      nav.push([name, getRef(link), getNodeUrl(link)]);
    }
  }

  // Shared context for page formatters
  const context = {
    nodeMap,
    getRef,
    getNodeName,
    getNodeRole,
    getNodeUrl,
    findChildrenByRole,
    rootNode
  };

  // --- Detect property detail overlay ---
  // The overlay is a region whose name is an address (contains a comma),
  // and is NOT "filters" or "Map".
  const ignoredRegions = ['filters', 'Map', ''];
  let overlayRegion = null;

  const topRegions = findChildrenByRole(rootNode.nodeId, 'region');
  for (const region of topRegions) {
    const name = getNodeName(region);
    if (!ignoredRegions.includes(name) && name.includes(',')) {
      overlayRegion = region;
      break;
    }
  }

  let overlay = null;
  if (overlayRegion) {
    overlay = formatDetailOverlay(overlayRegion, context);
  }

  // --- Detect page type and route ---
  const pageUrl = source.url || '';

  // Search results page: has searchQueryState param, /homes/ path, or city slug like /austin-tx/
  const isSearchPage = pageUrl.includes('searchQueryState') ||
    pageUrl.includes('/homes/') ||
    /\/[a-z]+-[a-z]{2}\//i.test(pageUrl);

  // Property detail page (full page, not overlay): /homedetails/ in URL
  const isDetailPage = pageUrl.includes('/homedetails/');

  if (isSearchPage && !isDetailPage) {
    const searchData = formatSearchPage(context);
    const output = {
      source,
      nav,
      page: 'search',
      ...searchData,
      overlay
    };

    return {
      tree: JSON.stringify(output, null, 2),
      elementCount: refCounter - 1,
      listingCount: searchData.listingCount,
      refs
    };
  }

  // Full property detail page - /homedetails/ URL
  if (isDetailPage) {
    const detailData = formatDetailPage(context);
    const output = {
      source,
      nav,
      page: 'detail',
      ...detailData
    };

    return {
      tree: JSON.stringify(output, null, 2),
      elementCount: refCounter - 1,
      listingCount: 0,
      refs
    };
  }

  // Homepage (default)
  const homeData = formatHomePage(context);
  const output = {
    source,
    nav,
    page: 'home',
    searchRef: homeData.searchRef,
    submitRef: homeData.submitRef,
    _listingSchema: homeData._listingSchema,
    listings: homeData.listings,
    _savedSearchSchema: homeData._savedSearchSchema,
    savedSearches: homeData.savedSearches
  };

  // Include autocomplete suggestions if present
  if (homeData.suggestions) {
    output._suggestionSchema = homeData._suggestionSchema;
    output.suggestions = homeData.suggestions;
  }

  return {
    tree: JSON.stringify(output, null, 2),
    elementCount: refCounter - 1,
    listingCount: homeData.listingCount,
    savedSearchCount: homeData.savedSearchCount,
    refs
  };
}
