/**
 * Threads Activity Page Formatter
 * Extracts follows, likes, milestones, replies, and polls from the activity feed
 */

export function formatActivityPage(context) {
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

  const activity = {
    _followSchema: ['user', 'others', 'time', 'ref'],
    follows: [],
    _followFromPostSchema: ['user', 'others', 'time', 'postUrl', 'followBackRef'],
    followsFromPost: [],
    _likeSchema: ['user', 'others', 'time', 'postUrl', 'postPreview', 'ref'],
    likes: [],
    _milestoneSchema: ['message', 'time', 'postUrl', 'ref'],
    milestones: [],
    _replySchema: ['url', 'content', 'time', 'likes', 'replies', 'likeRef', 'replyRef'],
    replies: [],
    _pollSchema: ['url', 'content', 'time', 'likes', 'replies', 'likeRef', 'replyRef'],
    polls: []
  };

  const allRegions = findChildrenByRole(rootNode.nodeId, 'region');
  const columnBody = allRegions.find(r => getNodeName(r).includes('Column body'));

  if (!columnBody) {
    return activity;
  }

  // Flatten all nodes under columnBody for sequential processing
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

  // Process nodes sequentially, looking for activity patterns
  for (let i = 0; i < flatNodes.length; i++) {
    const node = flatNodes[i];
    const role = getNodeRole(node);
    const name = getNodeName(node);
    const url = getNodeUrl(node);

    // Helper to look ahead/behind for related nodes
    function lookAround(startIdx, maxDist, predicate) {
      for (let j = Math.max(0, startIdx - maxDist); j < Math.min(flatNodes.length, startIdx + maxDist); j++) {
        if (predicate(flatNodes[j])) return flatNodes[j];
      }
      return null;
    }

    function lookAroundAll(startIdx, maxDist, predicate) {
      const results = [];
      for (let j = Math.max(0, startIdx - maxDist); j < Math.min(flatNodes.length, startIdx + maxDist); j++) {
        if (predicate(flatNodes[j])) results.push(flatNodes[j]);
      }
      return results;
    }

    // Detect "Followed you" - follow notification
    if (role === 'button' && name === 'Followed you') {
      const userLinks = lookAroundAll(i, 20, n => {
        const nUrl = getNodeUrl(n);
        const nName = getNodeName(n);
        return getNodeRole(n) === 'link' && nUrl && nUrl.includes('threads.com/@') &&
               !nUrl.includes('/post/') && nName && !nName.includes('profile picture') &&
               isValidUsername(nName);
      });
      const user = userLinks.length > 0 ? getNodeName(userLinks[0]) : null;

      // Check for "and N others"
      let others = 0;
      const othersNode = lookAround(i, 15, n => {
        const text = getNodeName(n);
        return getNodeRole(n) === 'StaticText' && text && text.match(/and \d+ others?/);
      });
      if (othersNode) {
        const match = getNodeName(othersNode).match(/and (\d+) others?/);
        if (match) others = parseInt(match[1], 10);
      }

      // Find time
      const timeNode = lookAround(i, 15, n => getNodeRole(n) === 'time');
      const time = timeNode ? parseRelativeTime(getNodeName(timeNode)) : null;

      if (user) {
        activity.follows.push([user, others, time, getRef(node)]);
      }
    }

    // Detect "Followed from your post"
    if (role === 'StaticText' && name === 'Followed from your post') {
      const userLinks = lookAroundAll(i, 20, n => {
        const nUrl = getNodeUrl(n);
        const nName = getNodeName(n);
        return getNodeRole(n) === 'link' && nUrl && nUrl.includes('threads.com/@') &&
               !nUrl.includes('/post/') && nName && !nName.includes('profile picture') &&
               isValidUsername(nName);
      });
      const user = userLinks.length > 0 ? getNodeName(userLinks[0]) : null;

      let others = 0;
      const othersNode = lookAround(i, 15, n => {
        const text = getNodeName(n);
        return getNodeRole(n) === 'StaticText' && text && text.match(/and \d+ others?/);
      });
      if (othersNode) {
        const match = getNodeName(othersNode).match(/and (\d+) others?/);
        if (match) others = parseInt(match[1], 10);
      }

      const timeNode = lookAround(i, 15, n => getNodeRole(n) === 'time');
      const time = timeNode ? parseRelativeTime(getNodeName(timeNode)) : null;

      // Find post URL
      const postLink = lookAround(i, 20, n => {
        const nUrl = getNodeUrl(n);
        return getNodeRole(n) === 'link' && nUrl && nUrl.includes('/post/');
      });
      const postUrl = postLink ? getNodeUrl(postLink).replace(/\/media$/, '') : null;

      // Find Follow back button
      const followBackBtn = lookAround(i, 20, n =>
        getNodeRole(n) === 'button' && getNodeName(n) === 'Follow back'
      );
      const followBackRef = followBackBtn ? getRef(followBackBtn) : null;

      if (user) {
        activity.followsFromPost.push([user, others, time, postUrl, followBackRef]);
      }
    }

    // Detect milestone - "Your thread got over X views"
    if (role === 'StaticText' && name.includes('Your thread got over')) {
      const timeNode = lookAround(i, 15, n => getNodeRole(n) === 'time');
      const time = timeNode ? parseRelativeTime(getNodeName(timeNode)) : null;

      const postLink = lookAround(i, 15, n => {
        const nUrl = getNodeUrl(n);
        return getNodeRole(n) === 'link' && nUrl && nUrl.includes('/post/');
      });
      const postUrl = postLink ? getNodeUrl(postLink).replace(/\/media$/, '') : null;
      const ref = postLink ? getRef(postLink) : null;

      activity.milestones.push([name, time, postUrl, ref]);
    }

    // Detect poll results
    if (role === 'StaticText' && name === 'Poll results are ready') {
      const timeNode = lookAround(i, 20, n => getNodeRole(n) === 'time');
      const time = timeNode ? parseRelativeTime(getNodeName(timeNode)) : null;

      const postLink = lookAround(i, 30, n => {
        const nUrl = getNodeUrl(n);
        const nName = getNodeName(n);
        return getNodeRole(n) === 'link' && nUrl && nUrl.includes('/post/') && nName && nName.length > 20;
      });
      const postUrl = postLink ? getNodeUrl(postLink).replace(/\/media$/, '') : null;
      const content = postLink ? getNodeName(postLink) : '';

      // Find action buttons
      let likes = 0, replies = 0, likeRef = null, replyRef = null;
      const likeBtn = lookAround(i, 30, n => {
        const nName = getNodeName(n);
        return getNodeRole(n) === 'button' && (nName.startsWith('Like') || nName.startsWith('Unlike'));
      });
      if (likeBtn) {
        likeRef = getRef(likeBtn);
        const match = getNodeName(likeBtn).match(/(?:Like|Unlike)\s+(\d+)/);
        if (match) likes = parseInt(match[1], 10);
      }

      const replyBtn = lookAround(i, 30, n => {
        const nName = getNodeName(n);
        return getNodeRole(n) === 'button' && nName.startsWith('Reply') && !nName.includes('Repost');
      });
      if (replyBtn) {
        replyRef = getRef(replyBtn);
        const match = getNodeName(replyBtn).match(/Reply\s+(\d+)/);
        if (match) replies = parseInt(match[1], 10);
      }

      if (postUrl) {
        activity.polls.push([postUrl, content, time, likes, replies, likeRef, replyRef]);
      }
    }

    // Detect likes - "and N others" near a post link (but not follow-related)
    if (role === 'StaticText' && name.match(/ and \d+ others?$/)) {
      // Check it's not a follow notification
      const followBtn = lookAround(i, 20, n => {
        const nName = getNodeName(n);
        return getNodeRole(n) === 'button' && (nName === 'Followed you' || nName === 'Follow back');
      });

      if (!followBtn) {
        const postLink = lookAround(i, 20, n => {
          const nUrl = getNodeUrl(n);
          return getNodeRole(n) === 'link' && nUrl && nUrl.includes('/post/');
        });

        if (postLink) {
          const userLinks = lookAroundAll(i, 15, n => {
            const nUrl = getNodeUrl(n);
            const nName = getNodeName(n);
            return getNodeRole(n) === 'link' && nUrl && nUrl.includes('threads.com/@') &&
                   !nUrl.includes('/post/') && nName && !nName.includes('profile picture') &&
                   isValidUsername(nName);
          });
          const user = userLinks.length > 0 ? getNodeName(userLinks[0]) : null;

          const match = name.match(/and (\d+) others?/);
          const others = match ? parseInt(match[1], 10) : 0;

          const timeNode = lookAround(i, 15, n => getNodeRole(n) === 'time');
          const time = timeNode ? parseRelativeTime(getNodeName(timeNode)) : null;

          const postUrl = getNodeUrl(postLink).replace(/\/media$/, '');
          const postPreview = getNodeName(postLink);

          // Avoid duplicates
          const exists = activity.likes.some(l => l[3] === postUrl && l[4] === postPreview);
          if (!exists && user) {
            activity.likes.push([user, others, time, postUrl, postPreview, getRef(postLink)]);
          }
        }
      }
    }

    // Detect replies - profile picture link followed by Like/Reply buttons
    if (role === 'link' && name.endsWith("'s profile picture") && url && url.includes('threads.com/@')) {
      // Check for action buttons nearby
      const likeBtn = lookAround(i, 40, n => {
        const nName = getNodeName(n);
        return getNodeRole(n) === 'button' && (nName.startsWith('Like') || nName.startsWith('Unlike'));
      });
      const replyBtn = lookAround(i, 40, n => {
        const nName = getNodeName(n);
        return getNodeRole(n) === 'button' && nName.startsWith('Reply') && !nName.includes('Repost');
      });

      // Must have action buttons to be a reply card
      if (likeBtn && replyBtn) {
        let likes = 0, replies = 0;
        const likeRef = getRef(likeBtn);
        const likeName = getNodeName(likeBtn);
        const likeMatch = likeName.match(/(?:Like|Unlike)\s+(\d+)/);
        if (likeMatch) likes = parseInt(likeMatch[1], 10);

        const replyRef = getRef(replyBtn);
        const replyName = getNodeName(replyBtn);
        const replyMatch = replyName.match(/Reply\s+(\d+)/);
        if (replyMatch) replies = parseInt(replyMatch[1], 10);

        const timeNode = lookAround(i, 30, n => getNodeRole(n) === 'time');
        const time = timeNode ? parseRelativeTime(getNodeName(timeNode)) : null;

        // Find reply URL and content
        const postLinks = lookAroundAll(i, 40, n => {
          const nUrl = getNodeUrl(n);
          return getNodeRole(n) === 'link' && nUrl && nUrl.includes('/post/');
        });

        let replyUrl = null;
        let content = [];
        for (const link of postLinks) {
          const linkUrl = getNodeUrl(link);
          const linkName = getNodeName(link);
          if (!replyUrl) replyUrl = linkUrl.replace(/\/media$/, '');
          if (linkName && linkName.length > 20 && !linkName.includes('profile picture')) {
            content.push(linkName);
          }
        }

        // Get static text content
        const contentTexts = lookAroundAll(i, 40, n => {
          const nName = getNodeName(n);
          const parentNode = nodeMap.get(n.parentId);
          const parentRole = parentNode ? getNodeRole(parentNode) : '';
          return getNodeRole(n) === 'StaticText' && nName && nName.length > 20 &&
                 parentRole !== 'button' && parentRole !== 'link' && parentRole !== 'time';
        });
        for (const st of contentTexts) {
          content.push(getNodeName(st));
        }

        if (replyUrl) {
          const filteredContent = [...new Set(content)].join('\n');
          const exists = activity.replies.some(r => r[0] === replyUrl);
          if (!exists) {
            activity.replies.push([replyUrl, filteredContent, time, likes, replies, likeRef, replyRef]);
          }
        }
      }
    }
  }

  return activity;
}
