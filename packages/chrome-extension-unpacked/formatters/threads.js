/**
 * Threads Platform Formatter - Router
 * Detects page type and delegates to appropriate formatter
 */

import { formatActivityPage } from './threads_activity.js';
import { formatHomePage } from './threads_home.js';
import { formatSearchPage } from './threads_search.js';

export function formatThreadsTree(nodes) {
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

  function parseThreadsDate(dateStr) {
    if (!dateStr) return null;
    const cleaned = dateStr.replace(' at ', ' ');
    const timestamp = Date.parse(cleaned);
    return isNaN(timestamp) ? null : timestamp;
  }

  function parseRelativeTime(timeStr) {
    if (!timeStr) return null;
    const now = Date.now();
    const str = timeStr.toLowerCase().trim();

    // Short format: "2h", "1d", "3d", "1w", "1m"
    let match = str.match(/^(\d+)([hdwm])$/);
    if (match) {
      const num = parseInt(match[1], 10);
      const unit = match[2];
      const multipliers = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 };
      return now - (num * multipliers[unit]);
    }

    // Long format: "2 hours ago", "a day ago", "about an hour ago"
    match = str.match(/(?:about\s+)?(\d+|a|an)\s*(second|minute|hour|day|week|month)s?\s*ago/);
    if (match) {
      const num = (match[1] === 'a' || match[1] === 'an') ? 1 : parseInt(match[1], 10);
      const unit = match[2];
      const multipliers = {
        second: 1000, minute: 60000, hour: 3600000,
        day: 86400000, week: 604800000, month: 2592000000
      };
      return now - (num * multipliers[unit]);
    }

    return parseThreadsDate(timeStr);
  }

  function isValidUsername(name) {
    if (!name) return false;
    if (name.length > 30) return false;
    if (name.includes(' ')) return false;
    if (name.includes('?') || name.includes('!')) return false;
    return /^[a-zA-Z0-9._]+$/.test(name);
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
      postCount: 0,
      refs: {}
    };
  }

  // Extract source info
  const source = {
    title: getNodeName(rootNode),
    url: getNodeUrl(rootNode)
  };

  // Extract navigation (common to all pages)
  const nav = [];
  const navNames = ['Home', 'Search', 'Create', 'Notifications', 'Profile'];
  const allLinks = findChildrenByRole(rootNode.nodeId, 'link');
  const allButtons = findChildrenByRole(rootNode.nodeId, 'button');

  for (const link of allLinks) {
    const name = getNodeName(link);
    if (navNames.includes(name)) {
      nav.push([name, getRef(link), getNodeUrl(link)]);
    }
  }

  for (const button of allButtons) {
    const name = getNodeName(button);
    if (name === 'Create' && !nav.find(n => n[0] === 'Create')) {
      nav.push(['Create', getRef(button), null]);
    }
  }

  const navOrder = { 'Home': 0, 'Search': 1, 'Create': 2, 'Notifications': 3, 'Profile': 4 };
  nav.sort((a, b) => (navOrder[a[0]] ?? 99) - (navOrder[b[0]] ?? 99));

  // Shared context for page formatters
  const context = {
    nodeMap,
    getRef,
    getNodeName,
    getNodeRole,
    getNodeUrl,
    parseThreadsDate,
    parseRelativeTime,
    isValidUsername,
    findChildrenByRole,
    rootNode
  };

  // Detect page type and route to appropriate formatter
  const pageUrl = source.url || '';

  // Activity page
  if (pageUrl.includes('/activity')) {
    const activity = formatActivityPage(context);
    const output = { source, nav, activity };

    return {
      tree: JSON.stringify(output, null, 2),
      elementCount: refCounter - 1,
      activityCount: activity.follows.length + activity.likes.length +
                     activity.milestones.length + activity.replies.length + activity.polls.length,
      refs
    };
  }

  // Search page (landing, results, or autocomplete)
  if (pageUrl.includes('/search')) {
    const searchData = formatSearchPage(context);

    if (searchData.type === 'autocomplete') {
      const output = {
        source,
        nav,
        searchRef: searchData.searchRef,
        _threadsSchema: searchData._threadsSchema,
        threads: searchData.threads,
        _searchTermsSchema: searchData._searchTermsSchema,
        searchTerms: searchData.searchTerms,
        _profileSchema: searchData._profileSchema,
        profiles: searchData.profiles
      };

      return {
        tree: JSON.stringify(output, null, 2),
        elementCount: refCounter - 1,
        threadCount: searchData.threads.length,
        termCount: searchData.searchTerms.length,
        profileCount: searchData.profiles.length,
        refs
      };
    } else if (searchData.type === 'landing') {
      const output = {
        source,
        nav,
        searchRef: searchData.searchRef,
        filterRef: searchData.filterRef,
        _trendSchema: searchData._trendSchema,
        trends: searchData.trends,
        _suggestionSchema: searchData._suggestionSchema,
        suggestions: searchData.suggestions
      };

      return {
        tree: JSON.stringify(output, null, 2),
        elementCount: refCounter - 1,
        trendCount: searchData.trends.length,
        suggestionCount: searchData.suggestions.length,
        refs
      };
    } else {
      // Search results
      const output = {
        source,
        nav,
        filter: searchData.filter,
        _filterSchema: searchData._filterSchema,
        filters: searchData.filters,
        _postSchema: searchData._postSchema,
        posts: searchData.posts
      };

      return {
        tree: JSON.stringify(output, null, 2),
        elementCount: refCounter - 1,
        postCount: searchData.postCount,
        filter: searchData.filter,
        refs
      };
    }
  }

  // Home/Profile page (default)
  const homeData = formatHomePage(context);
  const output = {
    source,
    nav,
    _postSchema: homeData._postSchema,
    posts: homeData.posts,
    _ghostSchema: homeData._ghostSchema,
    ghosts: homeData.ghosts
  };

  return {
    tree: JSON.stringify(output, null, 2),
    elementCount: refCounter - 1,
    postCount: homeData.postCount,
    ghostCount: homeData.ghostCount,
    refs
  };
}
