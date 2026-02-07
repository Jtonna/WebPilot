/**
 * Threads Home/Profile Page Formatter
 * Extracts posts from the home feed or profile pages
 */

export function formatHomePage(context) {
  const {
    nodeMap,
    getRef,
    getNodeName,
    getNodeRole,
    getNodeUrl,
    parseThreadsDate,
    parseRelativeTime,
    findChildrenByRole,
    rootNode
  } = context;

  const posts = [];
  const ghosts = [];
  const allRegions = findChildrenByRole(rootNode.nodeId, 'region');
  const columnBody = allRegions.find(r => getNodeName(r).includes('Column body'));

  if (!columnBody) {
    return { posts: [], postCount: 0, ghosts: [], ghostCount: 0 };
  }

  let currentItem = null;
  let passedCompose = false;

  // Any profile picture marker starts a new item
  function isProfilePicture(node) {
    const role = getNodeRole(node);
    const name = getNodeName(node);
    const url = getNodeUrl(node);
    if (role === 'link' && name.endsWith("'s profile picture") && url && url.includes('threads.com/@')) {
      return true;
    }
    if (role === 'button' && name.includes("'s profile picture")) {
      return true;
    }
    return false;
  }

  function isComposeArea(node) {
    const role = getNodeRole(node);
    const name = getNodeName(node);
    return role === 'button' && name.includes('Type to compose');
  }

  function createNewItem() {
    return {
      // Common fields
      authorUrl: null,
      content: [],
      likeRef: null,
      hitSuggestedSection: false,
      // Post-specific fields
      postUrl: null,
      timestamp: null,
      likes: 0,
      replies: 0,
      replyRef: null,
      // Ghost-specific fields
      expires: null
    };
  }

  function saveCurrentItem() {
    if (!currentItem) return;

    // Determine if it's a post or ghost based on whether it has a /post/ URL
    if (currentItem.postUrl) {
      posts.push(currentItem);
    } else if (currentItem.authorUrl) {
      ghosts.push(currentItem);
    }
  }

  function processNode(nodeId) {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = getNodeRole(node);
    const name = getNodeName(node);
    const url = getNodeUrl(node);

    if (isComposeArea(node)) {
      passedCompose = true;
    }

    if (role === 'separator') {
      passedCompose = true;
    }

    if (passedCompose) {
      // Any profile picture starts a new item
      if (isProfilePicture(node)) {
        saveCurrentItem();
        currentItem = createNewItem();
      }
      // Process current item data
      else if (currentItem) {
        // Extract author URL from profile link (not /post/ links)
        if (role === 'link' && url && url.includes('threads.com/@') && !url.includes('/post/')) {
          if (!currentItem.authorUrl) {
            currentItem.authorUrl = url;
          }
        }

        // Extract post URL and timestamp (this makes it a regular post)
        if (role === 'link' && url && url.includes('/post/')) {
          currentItem.postUrl = url;
          const timeChildren = findChildrenByRole(node.nodeId, 'time');
          if (timeChildren.length > 0) {
            currentItem.timestamp = getNodeName(timeChildren[0]);
          }
        }

        // Extract expiration time for ghosts (e.g., "9h left")
        if (role === 'button' && name.match(/^\d+[hmd]\s+left$/i)) {
          currentItem.expires = name;
        }

        // Extract content text
        if (role === 'StaticText' && name) {
          // Stop collecting content if we hit "Suggested for you" section
          if (name.includes('Suggested for you')) {
            currentItem.hitSuggestedSection = true;
          }

          if (!currentItem.hitSuggestedSection) {
            const parentNode = nodeMap.get(node.parentId);
            const parentRole = parentNode ? getNodeRole(parentNode) : '';
            if (parentRole !== 'button' && parentRole !== 'link' && parentRole !== 'Abbr' && parentRole !== 'time') {
              // Skip numeric-only, whitespace, and expiration time patterns
              if (!name.match(/^\d+$/) && name.length > 1 && name !== ' ' && !name.match(/^\d+[hmd]\s+left$/i)) {
                currentItem.content.push(name);
              }
            }
          }
        }

        // Extract action buttons
        if (role === 'button') {
          if (name.startsWith('Like') || name.startsWith('Unlike')) {
            currentItem.likeRef = getRef(node);
            const match = name.match(/(?:Like|Unlike)\s+(\d+(?:\.\d+)?K?)/);
            if (match) {
              const val = match[1];
              if (val.endsWith('K')) {
                currentItem.likes = parseFloat(val) * 1000;
              } else {
                currentItem.likes = parseInt(val, 10);
              }
            }
          } else if (name.startsWith('Reply')) {
            currentItem.replyRef = getRef(node);
            const match = name.match(/Reply\s+(\d+)/);
            if (match) currentItem.replies = parseInt(match[1], 10);
          }
        }
      }
    }

    if (node.childIds) {
      for (const childId of node.childIds) {
        processNode(childId);
      }
    }
  }

  processNode(columnBody.nodeId);

  // Save any pending item
  saveCurrentItem();

  // Format posts into schema array
  const formattedPosts = posts.map(p => {
    // Clean URL - remove /media suffix
    const cleanUrl = p.postUrl?.replace(/\/media$/, '') || null;

    // Extract author from URL (e.g., https://threads.com/@username/post/xyz)
    const authorMatch = cleanUrl?.match(/@([^/]+)/);
    const author = authorMatch ? authorMatch[1] : null;

    // Filter out author name from content (it's derivable from URL)
    const filteredContent = [...new Set(p.content)]
      .filter(line => line !== author)
      .join('\n');

    // Convert timestamp to numeric
    const numericTime = parseThreadsDate(p.timestamp);

    return [
      cleanUrl,
      filteredContent,
      numericTime,
      p.likes,
      p.replies,
      p.likeRef,
      p.replyRef
    ];
  });

  // Format ghosts into schema array
  const formattedGhosts = ghosts.map(g => {
    // Extract author from URL for filtering content
    const authorMatch = g.authorUrl?.match(/@([^/]+)/);
    const author = authorMatch ? authorMatch[1] : null;

    // Filter content
    const filteredContent = [...new Set(g.content)]
      .filter(line => line !== author)
      .join('\n');

    // Parse expiration to timestamp (time remaining from now)
    let expiresTimestamp = null;
    if (g.expires) {
      const match = g.expires.match(/^(\d+)([hmd])\s+left$/i);
      if (match) {
        const num = parseInt(match[1], 10);
        const unit = match[2].toLowerCase();
        const multipliers = { h: 3600000, m: 60000, d: 86400000 };
        expiresTimestamp = Date.now() + (num * multipliers[unit]);
      }
    }

    return [
      g.authorUrl,
      filteredContent,
      expiresTimestamp,
      g.likeRef
    ];
  });

  return {
    _postSchema: ['url', 'content', 'time', 'likes', 'replies', 'likeRef', 'replyRef'],
    posts: formattedPosts,
    postCount: formattedPosts.length,
    _ghostSchema: ['authorUrl', 'content', 'expires', 'likeRef'],
    ghosts: formattedGhosts,
    ghostCount: formattedGhosts.length
  };
}
