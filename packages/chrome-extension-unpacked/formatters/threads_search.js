/**
 * Threads Search Page Formatter
 * Handles search landing page, search results, and autocomplete suggestions
 */

export function formatSearchPage(context) {
  const {
    nodeMap,
    getRef,
    getNodeName,
    getNodeRole,
    getNodeUrl,
    parseRelativeTime,
    isValidUsername,
    findChildrenByRole,
    rootNode
  } = context;

  const allRegions = findChildrenByRole(rootNode.nodeId, 'region');
  const columnBody = allRegions.find(r => getNodeName(r).includes('Column body'));

  if (!columnBody) {
    return { type: 'empty' };
  }

  // Check for autocomplete listbox first (appears when typing in search)
  const listboxes = findChildrenByRole(columnBody.nodeId, 'listbox');
  const autocompleteListbox = listboxes.find(lb =>
    getNodeName(lb).includes('suggested searches')
  );

  if (autocompleteListbox) {
    return formatAutocomplete(context, columnBody, autocompleteListbox);
  }

  // Check if this is a search results page (has filter tabs) or landing page
  const pageUrl = getNodeUrl(rootNode) || '';
  const hasQuery = pageUrl.includes('?q=');

  if (hasQuery) {
    return formatSearchResults(context, columnBody);
  } else {
    return formatSearchLanding(context, columnBody);
  }
}

/**
 * Format autocomplete suggestions when typing in search
 */
function formatAutocomplete(context, columnBody, listbox) {
  const {
    nodeMap,
    getRef,
    getNodeName,
    getNodeRole,
    getNodeUrl,
    isValidUsername,
    findChildrenByRole
  } = context;

  const threads = [];
  const searchTerms = [];
  const profiles = [];

  // Get search input ref
  let searchRef = null;
  const searchboxes = findChildrenByRole(columnBody.nodeId, 'searchbox');
  if (searchboxes.length > 0) {
    searchRef = getRef(searchboxes[0]);
  }

  // Get all options in the listbox
  const options = findChildrenByRole(listbox.nodeId, 'option');

  for (const option of options) {
    // Find the primary link in this option
    const links = findChildrenByRole(option.nodeId, 'link');
    if (links.length === 0) continue;

    const primaryLink = links[0];
    const linkUrl = getNodeUrl(primaryLink);
    if (!linkUrl) continue;

    // Flatten nodes in this option for text extraction
    const optionNodes = flattenNodes(option.nodeId, nodeMap);

    if (linkUrl.includes('serp_type=tags')) {
      // Thread/community suggestion
      const threadData = extractThreadData(optionNodes, context, primaryLink);
      if (threadData) {
        threads.push(threadData);
      }
    } else if (linkUrl.includes('serp_type=default')) {
      // Search term suggestion
      const termData = extractSearchTermData(optionNodes, context, primaryLink);
      if (termData) {
        searchTerms.push(termData);
      }
    } else if (linkUrl.includes('threads.com/@')) {
      // Profile suggestion
      const profileData = extractProfileSuggestion(optionNodes, context, primaryLink);
      if (profileData) {
        profiles.push(profileData);
      }
    }
  }

  return {
    type: 'autocomplete',
    searchRef,
    _threadsSchema: ['name', 'members', 'recentPosts', 'url', 'ref'],
    threads,
    _searchTermsSchema: ['query', 'url', 'ref'],
    searchTerms,
    _profileSchema: ['username', 'displayName', 'verified', 'following', 'url', 'ref', 'followRef'],
    profiles
  };
}

/**
 * Flatten nodes for sequential processing
 */
function flattenNodes(nodeId, nodeMap, result = []) {
  const node = nodeMap.get(nodeId);
  if (!node) return result;
  result.push(node);
  if (node.childIds) {
    for (const childId of node.childIds) {
      flattenNodes(childId, nodeMap, result);
    }
  }
  return result;
}

/**
 * Extract thread/community data from autocomplete option
 */
function extractThreadData(nodes, context, primaryLink) {
  const { getRef, getNodeName, getNodeRole, getNodeUrl } = context;

  let tagName = null;
  let members = null;
  let recentPosts = null;

  for (const node of nodes) {
    const role = getNodeRole(node);
    const name = getNodeName(node);

    if (role === 'StaticText' && name) {
      // Check for member/post count pattern: "336K members · 153 recent posts"
      const statsMatch = name.match(/^([\d.]+[KMB]?)\s*members?\s*·\s*([\d.]+[KMB]?)\s*recent\s*posts?$/i);
      if (statsMatch) {
        members = statsMatch[1];
        recentPosts = statsMatch[2];
      } else if (!tagName && !name.includes('members') && !name.includes('profile picture')) {
        // First non-stats text is likely the tag name
        tagName = name;
      }
    }
  }

  if (!tagName) return null;

  return [
    tagName,
    members,
    recentPosts,
    getNodeUrl(primaryLink),
    getRef(primaryLink)
  ];
}

/**
 * Extract search term data from autocomplete option
 */
function extractSearchTermData(nodes, context, primaryLink) {
  const { getRef, getNodeName, getNodeRole, getNodeUrl } = context;

  let query = null;

  for (const node of nodes) {
    const role = getNodeRole(node);
    const name = getNodeName(node);

    // Look for StaticText that's not "Search" or "Continue"
    if (role === 'StaticText' && name &&
        name !== 'Search' && name !== 'Continue' &&
        !name.includes('profile picture')) {
      query = name;
      break;
    }
  }

  if (!query) return null;

  return [
    query,
    getNodeUrl(primaryLink),
    getRef(primaryLink)
  ];
}

/**
 * Extract profile suggestion data from autocomplete option
 */
function extractProfileSuggestion(nodes, context, primaryLink) {
  const { getRef, getNodeName, getNodeRole, getNodeUrl, isValidUsername } = context;

  let username = null;
  let displayName = null;
  let verified = false;
  let following = false;
  let followRef = null;

  for (const node of nodes) {
    const role = getNodeRole(node);
    const name = getNodeName(node);
    const url = getNodeUrl(node);

    // Username from nested link
    if (role === 'link' && url && url.includes('threads.com/@')) {
      const potentialUsername = name;
      if (isValidUsername(potentialUsername) && !username) {
        username = potentialUsername;
      }
    }

    // Verified badge
    if (role === 'image' && name === 'Verified') {
      verified = true;
    }

    // Follow/Following button
    if (role === 'button') {
      if (name === 'Follow') {
        followRef = getRef(node);
        following = false;
      } else if (name === 'Following') {
        followRef = getRef(node);
        following = true;
      }
    }

    // Display name (StaticText that's not username or button text)
    if (role === 'StaticText' && name && !displayName) {
      if (name !== username &&
          name !== 'Follow' &&
          name !== 'Following' &&
          !name.includes('profile picture')) {
        displayName = name;
      }
    }
  }

  if (!username) return null;

  return [
    username,
    displayName,
    verified,
    following,
    getNodeUrl(primaryLink),
    getRef(primaryLink),
    followRef
  ];
}

/**
 * Format search landing page (trending topics + follow suggestions)
 */
function formatSearchLanding(context, columnBody) {
  const {
    nodeMap,
    getRef,
    getNodeName,
    getNodeRole,
    getNodeUrl,
    isValidUsername,
    findChildrenByRole
  } = context;

  const trends = [];
  const suggestions = [];
  const seenTrends = new Set();
  const seenSuggestions = new Set();

  // Control refs
  let searchRef = null;
  let filterRef = null;

  // Flatten nodes for sequential processing
  function flattenNodes(nodeId, result = []) {
    const node = nodeMap.get(nodeId);
    if (!node) return result;
    result.push(node);
    if (node.childIds) {
      for (const childId of node.childIds) {
        flattenNodes(childId, result);
      }
    }
    return result;
  }

  const flatNodes = flattenNodes(columnBody.nodeId);

  // Track which section we're in
  let inTrending = false;
  let inSuggestions = false;

  for (let i = 0; i < flatNodes.length; i++) {
    const node = flatNodes[i];
    const role = getNodeRole(node);
    const name = getNodeName(node);
    const url = getNodeUrl(node);

    // Extract control refs
    if (role === 'searchbox' && name === 'Search' && !searchRef) {
      searchRef = getRef(node);
    }
    if (role === 'button' && name === 'Filter' && !filterRef) {
      filterRef = getRef(node);
    }

    // Detect section markers
    if (role === 'StaticText' && name === 'Trending now') {
      inTrending = true;
      inSuggestions = false;
      continue;
    }
    if (role === 'heading' && name === 'Follow suggestions') {
      inTrending = false;
      inSuggestions = true;
      continue;
    }

    // Extract trending topics
    if (inTrending && role === 'link' && url && url.includes('serp_type=trends')) {
      const fullText = name || '';
      if (fullText && !seenTrends.has(url)) {
        seenTrends.add(url);

        // Extract post count (e.g., "14K posts", "657K posts")
        const postMatch = fullText.match(/(\d+(?:\.\d+)?[KMB]?)\s*posts?$/i);
        const postCount = postMatch ? postMatch[1] : null;

        // Description is the full text without post count suffix
        let description = fullText;
        if (postCount) {
          description = fullText.replace(/\s*\d+(?:\.\d+)?[KMB]?\s*posts?$/i, '').trim();
        }

        trends.push([description, postCount, getRef(node)]);
      }
    }

    // Extract follow suggestions
    if (inSuggestions && role === 'link' && url && url.includes('threads.com/@')) {
      const username = name;
      if (isValidUsername(username) && !seenSuggestions.has(username)) {
        seenSuggestions.add(username);

        // Look around for profile info
        const profileData = extractProfileData(flatNodes, i, context);
        suggestions.push([
          url,
          profileData.bio,
          profileData.followers,
          profileData.followRef,
          getRef(node)
        ]);
      }
    }
  }

  return {
    type: 'landing',
    searchRef,
    filterRef,
    _trendSchema: ['description', 'posts', 'ref'],
    trends,
    _suggestionSchema: ['profileUrl', 'bio', 'followers', 'followRef', 'profileRef'],
    suggestions
  };
}

/**
 * Format search results page (posts matching query)
 */
function formatSearchResults(context, columnBody) {
  const {
    nodeMap,
    getRef,
    getNodeName,
    getNodeRole,
    getNodeUrl,
    parseRelativeTime,
    isValidUsername,
    findChildrenByRole,
    rootNode
  } = context;

  // Detect active filter and extract filter tab refs
  let activeFilter = 'Top';
  const filterTabs = [];
  const filterNames = ['Top', 'Recent', 'Profiles'];
  const allLinks = findChildrenByRole(columnBody.nodeId, 'link');

  // Extract filter tabs with refs
  for (const link of allLinks) {
    const linkName = getNodeName(link);
    if (filterNames.includes(linkName)) {
      filterTabs.push([linkName, getRef(link)]);
    }
  }

  // Check URL for active filter
  const pageUrl = getNodeUrl(rootNode) || '';
  if (pageUrl.includes('filter=recent')) {
    activeFilter = 'Recent';
  } else if (pageUrl.includes('filter=profiles')) {
    activeFilter = 'Profiles';
  }

  const posts = [];
  const seenPosts = new Set();

  // Flatten nodes
  function flattenNodes(nodeId, result = []) {
    const node = nodeMap.get(nodeId);
    if (!node) return result;
    result.push(node);
    if (node.childIds) {
      for (const childId of node.childIds) {
        flattenNodes(childId, result);
      }
    }
    return result;
  }

  const flatNodes = flattenNodes(columnBody.nodeId);

  // Look for profile picture markers to identify posts
  for (let i = 0; i < flatNodes.length; i++) {
    const node = flatNodes[i];
    const role = getNodeRole(node);
    const name = getNodeName(node);
    const url = getNodeUrl(node);

    // Skip filter links
    if (role === 'link' && ['Top', 'Recent', 'Profiles'].includes(name)) {
      continue;
    }

    // Detect post start: profile picture link or button
    const isProfilePic = (role === 'link' || role === 'button') &&
                         name && name.includes("'s profile picture");

    if (isProfilePic) {
      const postData = extractPostData(flatNodes, i, context, seenPosts);
      if (postData && !seenPosts.has(postData.url)) {
        seenPosts.add(postData.url);
        posts.push(postData.asArray());
      }
    }
  }

  return {
    type: 'results',
    filter: activeFilter,
    _filterSchema: ['name', 'ref'],
    filters: filterTabs,
    _postSchema: ['url', 'content', 'time', 'likes', 'replies', 'reposts', 'shares', 'likeRef', 'replyRef', 'tags'],
    posts,
    postCount: posts.length
  };
}

/**
 * Extract profile data from around a username link
 */
function extractProfileData(flatNodes, startIdx, context) {
  const { getRef, getNodeName, getNodeRole, nodeMap } = context;

  let verified = false;
  let displayName = null;
  let bio = null;
  let followers = null;
  let followRef = null;

  // Search in a range around the username
  const searchRange = 30;
  const start = Math.max(0, startIdx - 5);
  const end = Math.min(flatNodes.length, startIdx + searchRange);

  for (let j = start; j < end; j++) {
    const n = flatNodes[j];
    const nRole = getNodeRole(n);
    const nName = getNodeName(n);

    // Verified badge
    if (nRole === 'image' && nName === 'Verified') {
      verified = true;
    }

    // Follow button
    if (nRole === 'button' && nName === 'Follow' && !followRef) {
      followRef = getRef(n);
    }

    // Display name (StaticText that's not the username, followers, or bio-like)
    if (nRole === 'StaticText' && nName && !displayName) {
      if (!nName.includes('followers') && !nName.includes('profile picture') &&
          nName.length < 50 && !nName.includes('\n')) {
        // Check parent isn't a link or button
        const parent = nodeMap.get(n.parentId);
        const parentRole = parent ? getNodeRole(parent) : '';
        if (parentRole !== 'link' && parentRole !== 'button') {
          displayName = nName;
        }
      }
    }

    // Followers count
    if (nRole === 'StaticText' && nName && nName.includes('followers')) {
      const match = nName.match(/([\d,.]+[KMB]?)\s*followers/i);
      if (match) {
        followers = match[1];
      }
    }

    // Bio (longer StaticText)
    if (nRole === 'StaticText' && nName && nName.length > 30 && !bio) {
      if (!nName.includes('followers') && !nName.includes('profile picture')) {
        bio = nName;
      }
    }
  }

  return { verified, displayName, bio, followers, followRef };
}

/**
 * Extract post data starting from a profile picture marker
 */
function extractPostData(flatNodes, startIdx, context, seenPosts) {
  const {
    getRef,
    getNodeName,
    getNodeRole,
    getNodeUrl,
    parseRelativeTime,
    isValidUsername,
    nodeMap
  } = context;

  let username = null;
  let verified = false;
  let postUrl = null;
  let timestamp = null;
  let content = [];
  let likes = 0;
  let replies = 0;
  let reposts = 0;
  let shares = 0;
  let likeRef = null;
  let replyRef = null;
  let tags = [];

  // Search forward from profile picture
  const searchRange = 80;
  const end = Math.min(flatNodes.length, startIdx + searchRange);

  // First pass: find the post URL (this defines the post boundary)
  for (let j = startIdx; j < end; j++) {
    const n = flatNodes[j];
    const nRole = getNodeRole(n);
    const nUrl = getNodeUrl(n);

    // Find post URL from timestamp link
    if (nRole === 'link' && nUrl && nUrl.includes('/post/')) {
      postUrl = nUrl.replace(/\/media$/, '');
      break;
    }
  }

  // If no post URL found, this might be a profile card
  if (!postUrl) {
    return null;
  }

  // Check if we've already seen this post
  if (seenPosts.has(postUrl)) {
    return null;
  }

  // Second pass: extract all data
  for (let j = startIdx; j < end; j++) {
    const n = flatNodes[j];
    const nRole = getNodeRole(n);
    const nName = getNodeName(n);
    const nUrl = getNodeUrl(n);

    // Stop at next profile picture (next post)
    if (j > startIdx && nRole === 'link' && nName && nName.includes("'s profile picture")) {
      break;
    }
    if (j > startIdx && nRole === 'button' && nName && nName.includes("'s profile picture")) {
      break;
    }

    // Username (link to profile, not the profile picture link)
    if (nRole === 'link' && nUrl && nUrl.includes('threads.com/@') && !nUrl.includes('/post/')) {
      const potentialUsername = nName;
      if (isValidUsername(potentialUsername) && !username) {
        username = potentialUsername;
      }
    }

    // Verified badge
    if (nRole === 'image' && nName === 'Verified') {
      verified = true;
    }

    // Tags (like "AI Threads")
    if (nRole === 'link' && nUrl && nUrl.includes('serp_type=tags')) {
      const tagName = nName;
      if (tagName && !tags.includes(tagName)) {
        tags.push(tagName);
      }
    }

    // Timestamp
    if (nRole === 'time' && !timestamp) {
      timestamp = parseRelativeTime(nName);
    }
    if (nRole === 'Abbr' && !timestamp) {
      timestamp = parseRelativeTime(nName);
    }

    // Content (StaticText not in buttons/links)
    if (nRole === 'StaticText' && nName) {
      const parent = nodeMap.get(n.parentId);
      const parentRole = parent ? getNodeRole(parent) : '';

      // Skip if parent is interactive element
      if (parentRole !== 'button' && parentRole !== 'link' &&
          parentRole !== 'time' && parentRole !== 'Abbr') {
        // Skip short numeric values and common patterns
        if (nName.length > 2 &&
            !nName.match(/^\d+[KMB]?$/) &&
            !nName.match(/^\d+\/\d+\/\d+$/) &&
            nName !== ' ' &&
            !nName.includes('profile picture')) {
          content.push(nName);
        }
      }
    }

    // Engagement buttons
    if (nRole === 'button') {
      if (nName.startsWith('Like') || nName.startsWith('Unlike')) {
        likeRef = getRef(n);
        const match = nName.match(/(?:Like|Unlike)\s+([\d,.]+[KMB]?)/);
        if (match) {
          likes = parseEngagementCount(match[1]);
        }
      } else if (nName.startsWith('Reply') && !nName.includes('Repost')) {
        replyRef = getRef(n);
        const match = nName.match(/Reply\s+([\d,.]+[KMB]?)/);
        if (match) {
          replies = parseEngagementCount(match[1]);
        }
      } else if (nName.startsWith('Repost')) {
        const match = nName.match(/Repost\s+([\d,.]+[KMB]?)/);
        if (match) {
          reposts = parseEngagementCount(match[1]);
        }
      } else if (nName.startsWith('Share')) {
        const match = nName.match(/Share\s+([\d,.]+[KMB]?)/);
        if (match) {
          shares = parseEngagementCount(match[1]);
        }
      }
    }
  }

  // Clean up content
  const filteredContent = [...new Set(content)]
    .filter(line => line !== username)
    .join('\n');

  return {
    url: postUrl,
    content: filteredContent,
    time: timestamp,
    likes,
    replies,
    reposts,
    shares,
    likeRef,
    replyRef,
    tags: tags.length > 0 ? tags : null,
    asArray: function() {
      return [
        this.url,
        this.content,
        this.time,
        this.likes,
        this.replies,
        this.reposts,
        this.shares,
        this.likeRef,
        this.replyRef,
        this.tags
      ];
    }
  };
}

/**
 * Parse engagement counts like "1.5K", "2.3M", "500"
 */
function parseEngagementCount(str) {
  if (!str) return 0;
  str = str.replace(/,/g, '');

  if (str.endsWith('K')) {
    return parseFloat(str) * 1000;
  } else if (str.endsWith('M')) {
    return parseFloat(str) * 1000000;
  } else if (str.endsWith('B')) {
    return parseFloat(str) * 1000000000;
  }
  return parseInt(str, 10) || 0;
}
