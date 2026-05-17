'use strict';

/**
 * Discord Platform Formatter for WebPilot
 *
 * Processes raw CDP accessibility nodes from Discord pages and returns
 * a clean, compact tree optimized for LLM consumption.
 *
 * Supported page types:
 *   - DM List:         discord.com/channels/@me
 *   - DM Conversation: discord.com/channels/@me/<id>
 *   - Server Channel:  discord.com/channels/<serverId>/<channelId>
 *
 * Composer rendering: the message composer is a textbox whose accessible
 * name discriminates the conversation. It renders as
 *   [eN] Message @<recipient> textbox   (DM)
 *   [eN] Message #<channel> textbox     (server channel)
 * preserving the discriminating prefix so workflows can disambiguate
 * multiple composers from the formatted tree alone.
 */

module.exports = function formatDiscord(nodes) {
  // --- Build lookup structures ---
  const byId = new Map();
  for (const node of nodes) {
    byId.set(node.nodeId, node);
  }

  // --- Helpers ---
  function role(node) {
    return (node.role && node.role.value) || '';
  }

  function name(node) {
    return (node.name && node.name.value) || '';
  }

  function prop(node, propName) {
    if (!node.properties) return undefined;
    const p = node.properties.find(function (pr) { return pr.name === propName; });
    return p ? p.value : undefined;
  }

  // Get a property value from a node, unwrapping CDP's {value: x} format.
  // Normalizes boolean strings ("true"/"false") to actual booleans so callers
  // can safely use === true without worrying about string vs boolean mismatch.
  // This matters for properties like 'checked', 'selected', 'expanded', etc.
  function propValue(node, propName) {
    const v = prop(node, propName);
    if (v === undefined || v === null) return undefined;
    var result = v;
    if (typeof v === 'object' && v.value !== undefined) result = v.value;
    if (result === 'true') return true;
    if (result === 'false') return false;
    return result;
  }

  function children(node) {
    if (!node.childIds || !node.childIds.length) return [];
    const result = [];
    for (let i = 0; i < node.childIds.length; i++) {
      const child = byId.get(node.childIds[i]);
      if (child) result.push(child);
    }
    return result;
  }

  function descendants(node) {
    var result = [];
    var stack = children(node).slice();
    while (stack.length) {
      var n = stack.pop();
      result.push(n);
      var kids = children(n);
      for (var i = kids.length - 1; i >= 0; i--) {
        stack.push(kids[i]);
      }
    }
    return result;
  }

  function isIgnored(node) {
    return node.ignored === true;
  }

  // Detect URL from the document/webarea node
  function detectUrl() {
    for (const node of nodes) {
      const r = role(node);
      if (r === 'RootWebArea' || r === 'WebArea' || r === 'document') {
        const n = name(node);
        const urlProp = propValue(node, 'url');
        if (urlProp) return { url: urlProp, title: n };
        return { url: '', title: n };
      }
    }
    return { url: '', title: '' };
  }

  // Try harder to find the URL
  function findDiscordUrl() {
    const info = detectUrl();
    if (info.url && info.url.includes('discord.com')) return info.url;
    for (const node of nodes) {
      const n = name(node);
      if (n && n.includes('discord.com/channels')) return n;
      const urlProp = propValue(node, 'url');
      if (urlProp && urlProp.includes('discord.com/channels')) return urlProp;
    }
    return '';
  }

  // --- Page type detection ---
  function detectPageType(url) {
    const m = url.match(/discord\.com\/channels\/(.+)/);
    if (!m) return { type: 'unknown', params: {} };
    const path = m[1].replace(/\/+$/, '');
    const parts = path.split('/');
    if (parts[0] === '@me') {
      if (parts.length === 1) return { type: 'dm_list', params: {} };
      return { type: 'dm_conversation', params: { recipientId: parts[1] } };
    }
    if (parts.length >= 2) {
      return { type: 'server_channel', params: { serverId: parts[0], channelId: parts[1] } };
    }
    return { type: 'unknown', params: {} };
  }

  // --- Node finders ---
  function findNodes(predicate) {
    const result = [];
    for (const node of nodes) {
      if (!isIgnored(node) && predicate(node)) result.push(node);
    }
    return result;
  }

  function findNode(predicate) {
    for (const node of nodes) {
      if (!isIgnored(node) && predicate(node)) return node;
    }
    return null;
  }

  function hasAncestor(node, predicate, maxDepth) {
    maxDepth = maxDepth || 20;
    let current = node;
    let depth = 0;
    while (current && depth < maxDepth) {
      if (predicate(current)) return true;
      current = byId.get(current.parentId);
      depth++;
    }
    return false;
  }

  function getAncestor(node, predicate, maxDepth) {
    maxDepth = maxDepth || 20;
    let current = byId.get(node.parentId);
    let depth = 0;
    while (current && depth < maxDepth) {
      if (predicate(current)) return current;
      current = byId.get(current.parentId);
      depth++;
    }
    return null;
  }

  // --- Ref management ---
  const refs = {};
  let refCounter = 1;

  function addRef(node) {
    if (!node || !node.backendDOMNodeId) return null;
    const ref = 'e' + refCounter++;
    refs[ref] = node.backendDOMNodeId;
    return ref;
  }

  // --- Extract DM sidebar items ---
  // Returns an array of objects: { line, unread }
  function extractDmList() {
    const items = [];

    // DM links are inside a navigation region whose name contains "direct message(s)"
    // Link name pattern: "unread, Username (direct message)" or "Username (direct message)"
    var dmLinks = findNodes(function (node) {
      var r = role(node);
      if (r !== 'link') return false;
      var n = name(node);
      if (!n) return false;
      // DM sidebar links contain "(direct message)" in their name
      if (n.toLowerCase().includes('(direct message)')) return true;
      // Also check ancestor for Direct Messages context
      return hasAncestor(node, function (anc) {
        var ancName = name(anc).toLowerCase();
        return ancName.includes('direct message') || ancName.includes('direct messages');
      }, 10);
    });

    if (dmLinks.length === 0) {
      // Fallback: look for list items that look like DM entries
      var listItems = findNodes(function (node) {
        var r = role(node);
        return r === 'listitem' || r === 'option';
      });

      for (var li = 0; li < listItems.length; li++) {
        var item = listItems[li];
        var text = name(item).trim();
        if (!text) continue;
        if (text.match(/^#/) || text.length < 2) continue;

        var itemDesc = descendants(item);
        var unread = false;
        var msgCount = '';
        for (var di = 0; di < itemDesc.length; di++) {
          var dt = name(itemDesc[di]).toLowerCase();
          if (dt.includes('unread') || dt.match(/\d+\s*message/)) {
            unread = true;
            var mc = dt.match(/(\d+)\s*message/);
            if (mc) msgCount = mc[1];
          }
        }

        var ref = addRef(item);
        var line = ref ? '[' + ref + '] ' : '';
        line += text;
        if (unread) {
          line += ' (unread';
          if (msgCount) line += ', ' + msgCount + ' messages';
          line += ')';
        }
        items.push({ line: line, unread: unread });
      }
    } else {
      for (var idx = 0; idx < dmLinks.length; idx++) {
        var link = dmLinks[idx];
        var rawText = name(link).trim();
        if (!rawText) continue;

        var lower = rawText.toLowerCase();
        var isUnread = false;
        var badgeCount = '';

        // Check for "unread" prefix in link name: "unread, Username (direct message)"
        // or "N unread messages" pattern
        if (lower.startsWith('unread') || lower.match(/\d+\s*unread/)) {
          isUnread = true;
          var countMatch = lower.match(/(\d+)\s*unread/);
          if (countMatch) badgeCount = countMatch[1];
        }

        // Check ONLY immediate children for badge count (not deep descendants)
        // Deep descendant scanning picks up false positives from activity counts (+1), member counts, etc.
        var directKids = children(link);
        for (var di2 = 0; di2 < directKids.length; di2++) {
          var d = directKids[di2];
          var dn = name(d).trim();
          // Badge elements are typically small numeric nodes at the link level
          if (dn.match(/^\d+$/) && role(d) === 'StaticText') {
            var num = parseInt(dn, 10);
            if (num > 0 && num < 1000) {
              isUnread = true;
              badgeCount = dn;
            }
          }
        }

        // Clean up the display name:
        // Remove "unread, " prefix and "(direct message)" suffix
        var cleanName = rawText
          .replace(/^unread,?\s*/i, '')
          .replace(/\s*\(direct message\)\s*/gi, '')
          .replace(/,?\s*\d+\s*messages?\s*/i, '')
          .replace(/\(unread\)/i, '')
          .trim();

        var ref2 = addRef(link);
        var line2 = ref2 ? '[' + ref2 + '] ' : '';
        line2 += cleanName;
        if (isUnread) {
          line2 += ' (';
          if (badgeCount) {
            line2 += badgeCount + ' unread';
          } else {
            line2 += 'unread';
          }
          line2 += ')';
        }
        items.push({ line: line2, unread: isUnread });
      }
    }

    return items;
  }

  // --- Extract messages ---
  function extractMessages() {
    var messages = [];

    // Strategy 1: Find listitem nodes inside the main chat message list
    // IMPORTANT: Must be inside a `main` region, NOT the sidebar "Direct Messages" list
    var messageListItems = findNodes(function (node) {
      var r = role(node);
      if (r !== 'listitem') return false;
      // Must be inside the main content area (not navigation/sidebar)
      var inMain = hasAncestor(node, function (anc) {
        return role(anc) === 'main';
      }, 10);
      if (!inMain) return false;
      // Must be inside a list with "Messages" in the name
      return hasAncestor(node, function (anc) {
        var n = name(anc).toLowerCase();
        return role(anc) === 'list' && n.includes('messages in');
      }, 5);
    });

    if (messageListItems.length > 0) {
      return extractMessagesFromListItems(messageListItems);
    }

    // Strategy 2: Find article or group nodes that represent messages
    var messageArticles = findNodes(function (node) {
      var r = role(node);
      return (r === 'article' || r === 'group') &&
        name(node).length > 10 &&
        hasAncestor(node, function (anc) {
          return name(anc).toLowerCase().includes('message');
        }, 8);
    });

    if (messageArticles.length > 0) {
      return extractMessagesFromListItems(messageArticles);
    }

    return messages;
  }

  function extractMessagesFromListItems(items) {
    var messages = [];
    var lastAuthor = '';

    for (var idx = 0; idx < items.length; idx++) {
      var item = items[idx];
      var itemName = name(item).trim();
      var descs = descendants(item);

      // Look for separator / "new messages" divider
      for (var si = 0; si < descs.length; si++) {
        var sepNode = descs[si];
        var sepName = name(sepNode).toLowerCase();
        var sepRole = role(sepNode);
        if (sepRole === 'separator' && (sepName.includes('new') || sepName.includes('unread'))) {
          messages.push({ type: 'divider', text: name(sepNode).trim() || 'New Messages' });
        }
      }

      // Find the article node for this message (could be the item itself or a child)
      var articleNode = null;
      if (role(item) === 'article') {
        articleNode = item;
      } else {
        for (var ai = 0; ai < descs.length; ai++) {
          if (role(descs[ai]) === 'article') {
            articleNode = descs[ai];
            break;
          }
        }
      }

      // Use article descendants if we found one, otherwise use item descendants
      var msgDescs = articleNode ? descendants(articleNode) : descs;

      var author = '';
      var authorNode = null;
      var timestamp = '';
      var hasImage = false;
      var hasEmbed = false;

      // --- Author extraction ---
      // Discord puts author in: heading > button (with author name)
      // The button is a descendant of the heading, find it by scanning msgDescs
      var foundHeading = false;
      for (var hi = 0; hi < msgDescs.length; hi++) {
        var hNode = msgDescs[hi];
        if (role(hNode) === 'heading') {
          foundHeading = true;
          // Look for button descendants of this heading in the msgDescs list
          var headingDescs = descendants(hNode);
          for (var hd = 0; hd < headingDescs.length; hd++) {
            var hdNode = headingDescs[hd];
            if (role(hdNode) === 'button') {
              var btnName = name(hdNode).trim();
              // Skip Server Tag buttons and other non-author buttons
              if (btnName && btnName.length < 60 &&
                  !btnName.includes('Server Tag')) {
                author = btnName;
                authorNode = hdNode;
                break;
              }
            }
          }
          // Fallback: if no button found, look for a link descendant
          if (!author) {
            for (var hl = 0; hl < headingDescs.length; hl++) {
              var hlNode = headingDescs[hl];
              if (role(hlNode) === 'link') {
                var linkName = name(hlNode).trim();
                if (linkName && linkName.length < 60 && !linkName.includes(':')) {
                  author = linkName;
                  break;
                }
              }
            }
          }
          // Last resort: use the heading name directly if it's short enough
          if (!author) {
            var headingName = name(hNode).trim();
            if (headingName && headingName.length < 60 && !headingName.includes(':')) {
              author = headingName;
            }
          }
          if (author) break;
        }
      }

      // Fallback: parse author from article aria-label
      // Discord article names look like: "Username , message text , timestamp"
      // or "Username Server Tag: X , message text , timestamp"
      if (!author && articleNode) {
        var artName = name(articleNode).trim();
        if (artName) {
          // Author is the first segment before " , " or " Server Tag:"
          var commaIdx = artName.indexOf(' , ');
          var tagIdx = artName.indexOf(' Server Tag:');
          var cutIdx = -1;
          if (tagIdx > 0 && (commaIdx < 0 || tagIdx < commaIdx)) {
            cutIdx = tagIdx;
          } else if (commaIdx > 0) {
            cutIdx = commaIdx;
          }
          if (cutIdx > 0) {
            author = artName.substring(0, cutIdx).trim();
          }
        }
      }

      // --- Timestamp extraction ---
      // Look for time elements first (most reliable)
      for (var ti = 0; ti < msgDescs.length; ti++) {
        var tNode = msgDescs[ti];
        var tRole = role(tNode);
        var tName = name(tNode).trim();
        if (tRole === 'time' && tName) {
          timestamp = tName;
          break;
        }
      }
      // Fallback: look for StaticText matching time patterns
      if (!timestamp) {
        for (var ti2 = 0; ti2 < msgDescs.length; ti2++) {
          var tNode2 = msgDescs[ti2];
          var tName2 = name(tNode2).trim();
          if (role(tNode2) === 'StaticText' && tName2.match(/\d{1,2}:\d{2}\s*(AM|PM|am|pm)/)) {
            timestamp = tName2;
            break;
          }
        }
      }
      // Fallback: parse from item name
      if (!author && itemName) {
        var nameMatch = itemName.match(/^(.+?)(?:\s+BOT)?\s*[\u2014\u2014\-]\s*/);
        if (nameMatch) {
          author = nameMatch[1].trim();
        }
      }
      if (!timestamp && itemName) {
        var timeMatch = itemName.match(/((?:Today|Yesterday|\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
        if (timeMatch) {
          timestamp = timeMatch[1].trim();
        } else {
          var simpleTime = itemName.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
          if (simpleTime) timestamp = simpleTime[1].trim();
        }
      }

      // Clean up timestamp
      timestamp = timestamp
        .replace(/^Today at\s*/i, '')
        .replace(/^Yesterday at\s*/i, 'Yesterday ')
        .trim();

      // --- Content extraction ---
      // Only collect StaticText nodes that are actual message content.
      // Skip: author name, timestamp text, buttons, toolbars, headings, article names.
      // Build a set of node IDs to skip (heading subtree, time nodes)
      var skipNodeIds = new Set();

      // Mark heading subtrees as skip (they contain author/timestamp chrome)
      for (var ski = 0; ski < msgDescs.length; ski++) {
        var skNode = msgDescs[ski];
        if (role(skNode) === 'heading') {
          skipNodeIds.add(skNode.nodeId);
          var headDescs = descendants(skNode);
          for (var hdi = 0; hdi < headDescs.length; hdi++) {
            skipNodeIds.add(headDescs[hdi].nodeId);
          }
        }
        // Skip time elements and their children
        if (role(skNode) === 'time') {
          skipNodeIds.add(skNode.nodeId);
          var timeDescs = descendants(skNode);
          for (var tdi = 0; tdi < timeDescs.length; tdi++) {
            skipNodeIds.add(timeDescs[tdi].nodeId);
          }
        }
      }

      var contentParts = [];
      var seenTexts = new Set();

      // Track which articles are the "message article" vs nested embed articles
      // The message article is the top-level one; nested articles are embeds
      var messageArticleId = articleNode ? articleNode.nodeId : null;

      for (var ci = 0; ci < msgDescs.length; ci++) {
        var cNode = msgDescs[ci];
        var cRole = role(cNode);
        var cName = name(cNode).trim();

        // Skip nodes in heading/time subtrees
        if (skipNodeIds.has(cNode.nodeId)) continue;
        if (cRole === 'InlineTextBox') continue;
        if (!cName) continue;

        // Skip buttons, toolbars, interactive chrome, message action groups
        if (cRole === 'button' || cRole === 'toolbar' || cRole === 'menuitem' || cRole === 'group') {
          // Skip all descendants of groups (Message Actions, etc.)
          if (cRole === 'group') {
            var groupDescs = descendants(cNode);
            for (var gi = 0; gi < groupDescs.length; gi++) {
              skipNodeIds.add(groupDescs[gi].nodeId);
            }
          }
          continue;
        }

        // Skip separator nodes (already handled above)
        if (cRole === 'separator') continue;

        // Handle images
        if (cRole === 'image' || cRole === 'img') {
          if (cName && !cName.match(/avatar|icon/i)) {
            if (cName.match(/emoji/i)) {
              // Inline emoji — include the emoji name
              var emojiName = cName.replace(/emoji/i, '').trim();
              if (emojiName) contentParts.push(emojiName);
            } else {
              hasImage = true;
              if (cName.length > 3 && cName !== author) {
                contentParts.push('[image: ' + cName + ']');
              } else {
                contentParts.push('[image]');
              }
            }
          }
          continue;
        }

        // Handle nested articles (embeds) — only articles that are NOT the message article itself
        if (cRole === 'article' && cNode.nodeId !== messageArticleId) {
          hasEmbed = true;
          // Collect text from this embed subtree
          var embedDescs = descendants(cNode);
          var embedParts = [];
          for (var ei = 0; ei < embedDescs.length; ei++) {
            var eNode = embedDescs[ei];
            if (role(eNode) === 'StaticText' || role(eNode) === 'text') {
              var eText = name(eNode).trim();
              if (eText && !seenTexts.has(eText)) {
                seenTexts.add(eText);
                embedParts.push(eText);
              }
            }
          }
          if (embedParts.length > 0) {
            contentParts.push('[embed: ' + embedParts.join(' ') + ']');
          } else if (cName) {
            contentParts.push('[embed: ' + cName + ']');
          }
          // Skip all descendants of this embed since we already processed them
          for (var esi = 0; esi < embedDescs.length; esi++) {
            skipNodeIds.add(embedDescs[esi].nodeId);
          }
          continue;
        }

        // Handle links that are URLs (likely link previews)
        if (cRole === 'link' && cName.match(/^https?:\/\//)) {
          if (!seenTexts.has(cName)) {
            seenTexts.add(cName);
            contentParts.push(cName);
          }
          continue;
        }

        // Collect actual message text from StaticText nodes
        if (cRole === 'StaticText' || cRole === 'text') {
          // Skip UI chrome text
          if (cName === 'Delete' || cName === 'Edit' || cName === 'Forward' ||
              cName === 'More' || cName === 'Reply' || cName === 'Add Reaction' ||
              cName === 'Remove Message Attachment' ||
              cName === '(' || cName === ')' || cName === 'edited' ||
              cName === 'Click to react') continue;
          // Skip full date strings like "Friday, March 27, 2026 at 11:59 PM"
          if (cName.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s/)) continue;
          // Skip empty/whitespace
          if (!cName.replace(/\s+/g, '')) continue;
          if (!seenTexts.has(cName)) {
            seenTexts.add(cName);
            contentParts.push(cName);
          }
          continue;
        }

        // For links (non-URL), collect their text content
        if (cRole === 'link') {
          // Only add if it's not a duplicate of something we already have
          if (!seenTexts.has(cName) && cName.length < 200) {
            seenTexts.add(cName);
            contentParts.push(cName);
          }
          continue;
        }
      }

      var content = contentParts.join(' ').trim();

      // Skip items that don't look like real messages
      if (!content && !hasImage && !hasEmbed) continue;

      // Continuation messages: no heading means same author
      if (!author && lastAuthor) {
        author = lastAuthor;
      }
      if (author) lastAuthor = author;

      var ref = addRef(item);
      var authorRef = authorNode ? addRef(authorNode) : null;

      messages.push({
        type: 'message',
        ref: ref,
        author: author,
        authorRef: authorRef,
        timestamp: timestamp,
        content: content,
        hasImage: hasImage,
        hasEmbed: hasEmbed
      });
    }

    return messages;
  }

  // --- Extract "new messages" separator positions ---
  function findNewMessageDividers() {
    return findNodes(function (node) {
      var r = role(node);
      var n = name(node).toLowerCase();
      return r === 'separator' &&
        (n.includes('new') || n.includes('unread'));
    });
  }

  // --- Extract textbox ---
  function extractTextbox() {
    var textbox = findNode(function (node) {
      var r = role(node);
      return (r === 'textbox' || r === 'textarea') &&
        name(node).toLowerCase().includes('message');
    });
    return textbox;
  }

  // Format the message composer line, preserving the discriminating part
  // of its accessible name (e.g. "Message @notboosted" or "Message #general")
  // so workflows can disambiguate which composer they're looking at from the
  // formatted tree alone. Falls back to plain "Message textbox" if the name
  // doesn't match the expected pattern.
  function formatComposerLine(ref, textboxNode) {
    var nm = name(textboxNode).trim();
    if (/^Message\s+[#@]/.test(nm)) {
      return '[' + ref + '] ' + nm + ' textbox';
    }
    return '[' + ref + '] Message textbox';
  }

  // --- Extract channel/server info ---
  function extractChannelInfo() {
    var channelName = '';
    var serverName = '';

    // Try to parse from RootWebArea title first (e.g. "Discord | MyServer | #general")
    var info = detectUrl();
    if (info.title) {
      var titleParts = info.title.split(/\s*\|\s*/);
      for (var i = 1; i < titleParts.length; i++) {
        var part = titleParts[i].trim();
        if (part.startsWith('#') && !channelName) {
          channelName = part;
        } else if (!part.startsWith('#') && part.toLowerCase() !== 'discord' && !serverName) {
          serverName = part;
        }
      }
    }

    // Fallback: channel name from heading
    if (!channelName) {
      var headings = findNodes(function (node) {
        return role(node) === 'heading';
      });
      for (var hi = 0; hi < headings.length; hi++) {
        var n = name(headings[hi]).trim();
        if (n.startsWith('#')) {
          channelName = n;
          break;
        }
      }
    }

    // Fallback: channel name from banner/toolbar
    if (!channelName) {
      var banners = findNodes(function (node) {
        var r = role(node);
        return r === 'banner' || r === 'toolbar';
      });
      for (var bi = 0; bi < banners.length; bi++) {
        var bDescs = descendants(banners[bi]);
        for (var bd = 0; bd < bDescs.length; bd++) {
          var bn = name(bDescs[bd]).trim();
          if (bn.startsWith('#') && bn.length < 60) {
            channelName = bn;
            break;
          }
        }
        if (channelName) break;
      }
    }

    // Fallback: server name from sidebar button/heading
    if (!serverName) {
      var serverBtn = findNode(function (node) {
        var r = role(node);
        return (r === 'button' || r === 'heading') &&
          hasAncestor(node, function (anc) {
            return name(anc).toLowerCase().includes('server') ||
              role(anc) === 'banner';
          }, 5) &&
          name(node).trim().length > 0 &&
          name(node).trim().length < 60 &&
          !name(node).toLowerCase().includes('channel');
      });
      if (serverBtn) {
        serverName = name(serverBtn).trim();
      }
    }

    return { channelName: channelName, serverName: serverName };
  }

  // --- Extract server sidebar channels (with categories) ---
  //
  // Discord's channel sidebar structure in the a11y tree:
  //   navigation "ServerName (server)"
  //     list "Channels"
  //       listitem                          <-- category
  //         button "INFORMATION (category)"
  //           heading "INFORMATION"
  //         button "Create Channel"
  //       listitem                          <-- channel
  //         link "📋・rules (text channel), Private Channel (locked)"
  //       listitem                          <-- voice channel
  //         button "🔉・Public VC (voice channel), ..."
  //       ...
  //
  // Categories are identified by buttons whose a11y name contains "(category)".
  // Channels belong to the nearest preceding category in the same list.
  // Nav items (Discover, Direct Messages, etc.) are excluded because they
  // have no preceding category sibling.
  //
  // The "Create Channel" button next to each category is a hover-only element
  // that may or may not be in the a11y tree depending on scroll/hover state.
  //
  function extractServerChannels() {
    var channels = [];
    var chanInfo = extractChannelInfo();
    var currentChannelName = chanInfo.channelName || '';

    // --- Strategy: find ALL category buttons globally, then locate the channel list from them ---
    // Category buttons have "(category)" in their a11y name (e.g. "INFORMATION (category)")
    // This is more reliable than traversing nav > list > listitem since the nav/list
    // structure varies depending on Discord version and server state.
    var allCatButtons = findNodes(function (node) {
      if (role(node) !== 'button') return false;
      return name(node).includes('(category)');
    });

    // Build a map of category listitem nodeId -> category data
    // Each category button lives inside a listitem; the listitem is the category container
    var categoryItemMap = {}; // listitem nodeId -> { type, ref, createRef, name, annotation }

    for (var cb = 0; cb < allCatButtons.length; cb++) {
      var catBtn = allCatButtons[cb];
      // Extract category name from heading descendant, fallback to button name
      var catName = '';
      var catDescs = descendants(catBtn);
      for (var cd = 0; cd < catDescs.length; cd++) {
        if (role(catDescs[cd]) === 'heading') {
          catName = name(catDescs[cd]).trim();
          break;
        }
      }
      if (!catName) {
        catName = name(catBtn).replace(/\s*\(category\)\s*/i, '').trim();
      }
      if (!catName) continue;

      // Find the parent listitem
      var catListItem = getAncestor(catBtn, function (anc) {
        return role(anc) === 'listitem';
      }, 3);
      if (!catListItem) continue;

      // Find the sibling "Create Channel" button within the same listitem
      var catItemKids = children(catListItem);
      var createButton = null;
      for (var ck = 0; ck < catItemKids.length; ck++) {
        if (role(catItemKids[ck]) === 'button' && name(catItemKids[ck]).trim() === 'Create Channel') {
          createButton = catItemKids[ck];
          break;
        }
      }

      var createRef = createButton ? addRef(createButton) : null;
      var catRef = addRef(catBtn);

      categoryItemMap[catListItem.nodeId] = {
        type: 'category',
        ref: catRef,
        createRef: createRef,
        name: catName,
        annotation: ''
      };
    }

    // --- Find the channel list container (tree or list) ---
    // Strategy 1: Walk up from a category button to find the tree/list ancestor
    var navList = null;
    if (allCatButtons.length > 0) {
      navList = getAncestor(allCatButtons[0], function (anc) {
        var r = role(anc);
        return r === 'list' || r === 'tree';
      }, 5);
    }

    // Strategy 2: Find navigation node and look for tree/list child
    var channelListNav = null;
    if (!navList) {
      channelListNav = findNode(function (node) {
        var r = role(node);
        var n = name(node).toLowerCase();
        return r === 'navigation' && (n.includes('server') || n.includes('community') || n.includes('channel'));
      });
      if (channelListNav) {
        var navDescs = children(channelListNav);
        for (var ni = 0; ni < navDescs.length; ni++) {
          var ndRole = role(navDescs[ni]);
          var ndName = name(navDescs[ni]).toLowerCase();
          if ((ndRole === 'list' || ndRole === 'tree') && (ndName.includes('channel') || ndName === '')) {
            navList = navDescs[ni];
            break;
          }
        }
      }
    }

    // Now extract channel nodes (links/treeitems) as before
    var channelNodes = findNodes(function (node) {
      var r = role(node);
      if (r !== 'treeitem' && r !== 'link' && r !== 'listitem') return false;
      var n = name(node).trim().toLowerCase();
      if (!n) return false;
      // Must be in a sidebar/navigation area
      var inNav = hasAncestor(node, function (anc) {
        var ancName = name(anc).toLowerCase();
        var ancRole = role(anc);
        return ancRole === 'navigation' || ancRole === 'complementary' ||
          ancRole === 'tree' || ancName.includes('channel');
      }, 10);
      if (!inNav) return false;
      // Exclude nodes inside main/chat area
      var inMain = hasAncestor(node, function (anc) {
        var ancRole = role(anc);
        var ancName = name(anc).toLowerCase();
        return ancRole === 'main' ||
          (ancName.includes('message') && (ancRole === 'list' || ancRole === 'region'));
      }, 10);
      return !inMain;
    });

    // Build the final channel list by interleaving categories with channels.
    //
    // For each channel, we walk up to its parent listitem, then walk backwards
    // through sibling listitems to find the nearest category. This ensures:
    //   1. Channels are grouped under their correct category
    //   2. Categories are emitted exactly once, before their first channel
    //   3. Items outside any category (Discover, Direct Messages, etc.) are
    //      naturally excluded since they have no preceding category sibling
    //
    var emittedCategories = new Set();
    var seen = new Set();

    for (var ci = 0; ci < channelNodes.length; ci++) {
      var node = channelNodes[ci];
      var rawName2 = name(node).trim();
      var lower2 = rawName2.toLowerCase();
      if (seen.has(lower2)) continue;
      seen.add(lower2);
      if (lower2.includes('(muted)')) continue;

      // Only include channels that belong to a category.
      // Walk up from the channel node to find its parent listitem, then check
      // if a preceding sibling listitem is a known category.
      // This naturally excludes nav items (Discover, Direct Messages, etc.)
      // that live outside category groups.
      var belongsToCategory = false;
      var chanListItem2 = getAncestor(node, function (anc) {
        return role(anc) === 'listitem';
      }, 3);
      if (chanListItem2) {
        var parentList2 = byId.get(chanListItem2.parentId);
        if (parentList2) {
          var parentKids2 = children(parentList2);
          var chanIdx2 = -1;
          for (var pk2 = 0; pk2 < parentKids2.length; pk2++) {
            if (parentKids2[pk2].nodeId === chanListItem2.nodeId) { chanIdx2 = pk2; break; }
          }
          if (chanIdx2 >= 0) {
            for (var bk2 = chanIdx2 - 1; bk2 >= 0; bk2--) {
              if (categoryItemMap[parentKids2[bk2].nodeId]) {
                belongsToCategory = true;
                break;
              }
            }
          }
        }
      }
      if (!belongsToCategory && Object.keys(categoryItemMap).length > 0) continue;

      // Check if this channel has a category ancestor
      // Walk up to find the parent listitem of the category
      var chanListItem = getAncestor(node, function (anc) {
        return role(anc) === 'listitem';
      }, 3);
      if (chanListItem) {
        // Check if this listitem's parent list has a preceding category listitem
        var parentList = byId.get(chanListItem.parentId);
        if (parentList) {
          var parentKids = children(parentList);
          // Walk backwards from this listitem to find the nearest category
          var chanIdx = -1;
          for (var pk = 0; pk < parentKids.length; pk++) {
            if (parentKids[pk].nodeId === chanListItem.nodeId) { chanIdx = pk; break; }
          }
          if (chanIdx >= 0) {
            for (var bk = chanIdx - 1; bk >= 0; bk--) {
              var prevItem = parentKids[bk];
              if (categoryItemMap[prevItem.nodeId] && !emittedCategories.has(prevItem.nodeId)) {
                channels.push(categoryItemMap[prevItem.nodeId]);
                emittedCategories.add(prevItem.nodeId);
                break;
              } else if (categoryItemMap[prevItem.nodeId]) {
                break; // Found our category, already emitted
              }
            }
          }
        }
      }

      var unread2 = false;
      var mentionCount2 = '';
      var nodeDescs2 = descendants(node);
      for (var di2 = 0; di2 < nodeDescs2.length; di2++) {
        var dn2 = name(nodeDescs2[di2]).toLowerCase();
        if (dn2.includes('unread') || dn2 === 'new') unread2 = true;
        if (role(nodeDescs2[di2]) === 'StaticText' && dn2.match(/^\d+$/)) {
          var num2 = parseInt(dn2, 10);
          if (num2 > 0 && num2 < 10000) { mentionCount2 = dn2; unread2 = true; }
        }
      }
      if (lower2.includes('unread')) unread2 = true;

      var isCurrent2 = false;
      if (currentChannelName) {
        var cleanCurrent2 = currentChannelName.replace(/^#/, '').toLowerCase();
        var cleanNode2 = rawName2.replace(/^#/, '').replace(/\s*\(unread\)\s*/gi, '').toLowerCase();
        cleanNode2 = cleanNode2.replace(/^text[- ]?channel[,\s]*/i, '');
        if (cleanNode2 === cleanCurrent2 || rawName2.toLowerCase().includes(cleanCurrent2)) isCurrent2 = true;
      }
      var selectedProp2 = propValue(node, 'selected');
      var currentProp2 = propValue(node, 'current');
      if (selectedProp2 === true || selectedProp2 === 'true' ||
          currentProp2 === 'page' || currentProp2 === 'true' || currentProp2 === true) {
        isCurrent2 = true;
      }

      var displayName2 = rawName2.replace(/\s*\(unread\)\s*/gi, '').replace(/\s*\(muted\)\s*/gi, '').trim();
      var ref2 = addRef(node);
      var annotation2 = '';
      if (isCurrent2) annotation2 = ' (current)';
      else if (mentionCount2) annotation2 = ' (' + mentionCount2 + ' mentions)';
      else if (unread2) annotation2 = ' (unread)';

      channels.push({ ref: ref2, name: displayName2, unread: unread2, isCurrent: isCurrent2, annotation: annotation2 });
    }

    return channels;
  }

  // --- Extract DM conversation partner from title/header ---
  // Returns { username, displayName } where:
  //   username    = the @handle (e.g. "notboosted") — from page title or @-prefixed heading
  //   displayName = the human-facing label (e.g. "Jtonna") — from the chat-area toolbar
  //                 heading that does NOT start with "@". Either may be empty.
  // Surfacing both lets the agent recognize that "Jtonna" and "@notboosted" refer
  // to the same person (a frequent source of confusion when users mix them).
  function extractDmRecipient() {
    var info = detectUrl();
    var username = '';
    var displayName = '';

    // 1) Username from page title — "Discord | @Username"
    if (info.title) {
      var m = info.title.match(/@(\S+)/);
      if (m) username = m[1];
    }

    // 2) Username fallback — any heading whose text starts with "@"
    if (!username) {
      var atHeading = findNode(function (node) {
        return role(node) === 'heading' && name(node).trim().startsWith('@');
      });
      if (atHeading) {
        username = name(atHeading).trim().replace(/^@/, '');
      }
    }

    // 3) Display name — heading or static text inside toolbar/banner whose text
    //    is NOT @-prefixed. Discord renders the recipient's display name as a
    //    plain heading in the chat header toolbar; the username may also appear
    //    nearby as a separate @-prefixed node, which we skip here.
    var headerNode = findNode(function (node) {
      var r = role(node);
      if (r !== 'heading' && r !== 'StaticText') return false;
      var n = name(node).trim();
      if (!n || n.length >= 40) return false;
      if (n.startsWith('@')) return false;
      if (n.toLowerCase() === 'direct messages') return false;
      return hasAncestor(node, function (anc) {
        return role(anc) === 'toolbar' || role(anc) === 'banner';
      }, 5);
    });
    if (headerNode) {
      displayName = name(headerNode).trim();
    }

    // 4) If we still have nothing for username, fall back to any short
    //    toolbar/banner text (legacy behavior before the displayName split).
    if (!username && !displayName) {
      var anyHeading = findNode(function (node) {
        var r = role(node);
        return (r === 'heading' || r === 'StaticText') &&
          name(node).trim().length > 0 &&
          name(node).trim().length < 40 &&
          hasAncestor(node, function (anc) {
            return role(anc) === 'toolbar' || role(anc) === 'banner';
          }, 5);
      });
      if (anyHeading) {
        username = name(anyHeading).trim().replace(/^@/, '');
      }
    }

    // If display name and username collapse to the same value, drop the
    // displayName so we don't render "@foo (@foo)".
    if (displayName && username && displayName.replace(/^@/, '').toLowerCase() === username.toLowerCase()) {
      displayName = '';
    }

    return { username: username, displayName: displayName };
  }

  // --- Extract member list ---
  function extractMemberList() {
    var members = [];
    // Member list is in a complementary region with "Members" in the name
    var memberList = findNode(function (node) {
      return role(node) === 'complementary' && name(node).toLowerCase().includes('members');
    });
    if (!memberList) return members;

    var descs = descendants(memberList);
    var currentRole = '';

    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      var r = role(d);
      var n = name(d).trim();

      // Role group headings (e.g. "Owner, 1 member", "Admin, 3 members")
      // Must contain "member" to be a role group, not the section heading
      if (r === 'heading' && n && n.toLowerCase().includes('member') &&
          !n.toLowerCase().includes('members list')) {
        currentRole = n;
        members.push({ type: 'role', name: currentRole });
        continue;
      }

      // Member items are listitem nodes
      if (r === 'listitem') {
        // Extract member name and status from children
        var memberKids = children(d);
        var memberDescs = descendants(d);
        var memberName = '';
        var status = '';

        // First check: image nodes often have "username, Status" format
        for (var mk = 0; mk < memberDescs.length; mk++) {
          var kid = memberDescs[mk];
          var kidRole = role(kid);
          var kidName = name(kid).trim();

          if (kidRole === 'image' && kidName.includes(',')) {
            var parts = kidName.split(',');
            if (parts.length >= 2) {
              status = parts[parts.length - 1].trim();
            }
          }
        }

        // Get display name from StaticText children (not image alt text)
        for (var mk2 = 0; mk2 < memberDescs.length; mk2++) {
          var kid2 = memberDescs[mk2];
          var kidRole2 = role(kid2);
          var kidName2 = name(kid2).trim();

          if (kidRole2 === 'StaticText' && kidName2 && kidName2.length < 60 &&
              kidName2 !== 'Members' && !kidName2.match(/^\d+ member/) &&
              !kidName2.includes('icon') && !kidName2.includes('Invite') &&
              !kidName2.includes('Edit') && kidName2 !== 'Online' &&
              kidName2 !== 'Offline' && kidName2 !== 'Idle' &&
              kidName2 !== 'Do Not Disturb') {
            memberName = kidName2;
            break;
          }
        }

        if (memberName) {
          var ref = addRef(d);
          members.push({
            type: 'member',
            ref: ref,
            name: memberName,
            status: status
          });
        }
      }
    }

    return members;
  }

  // --- Extract server notifications from sidebar ---
  function extractServerNotifications() {
    var notifications = [];
    // Server treeitems in the sidebar often have "N mentions, ServerName" pattern
    var serverItems = findNodes(function (node) {
      var r = role(node);
      if (r !== 'treeitem') return false;
      var n = name(node).trim();
      // Match patterns like "2 mentions, GetZenith" or servers with unread
      return n.match(/\d+\s*mention/) || false;
    });

    for (var i = 0; i < serverItems.length; i++) {
      var item = serverItems[i];
      var itemName = name(item).trim();
      var mentionMatch = itemName.match(/(\d+)\s*mentions?,\s*(.+)/);
      if (mentionMatch) {
        var ref = addRef(item);
        notifications.push({
          ref: ref,
          server: mentionMatch[2].trim(),
          mentions: parseInt(mentionMatch[1], 10)
        });
      }
    }

    return notifications;
  }

  // --- Extract profile sidebar (DM conversations and server profiles) ---
  function extractProfileSidebar() {
    var profile = { items: [] };

    // Profile sidebar is a complementary region with "profile" in the name
    var profileNode = findNode(function (node) {
      return role(node) === 'complementary' && name(node).toLowerCase().includes('profile');
    });
    if (!profileNode) return profile;

    var descs = descendants(profileNode);

    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      var r = role(d);
      var n = name(d).trim();

      // View Full Profile button
      if (r === 'button' && n === 'View Full Profile') {
        var ref = addRef(d);
        profile.items.push({ type: 'action', ref: ref, text: 'View Full Profile' });
        continue;
      }

      // Add Note / Edit Note button/area
      if (r === 'button' && (n.includes('Add Note') || n.includes('Edit Note') || n.includes('Note'))) {
        // Skip generic "Note" tab buttons in profile modal
        if (n === 'Note') continue;
        var ref2 = addRef(d);
        var noteLabel = n.includes('Edit Note') ? 'Edit Note (has note)' : 'Add Note';
        profile.items.push({ type: 'action', ref: ref2, text: noteLabel });
        continue;
      }

      // Note textarea in sidebar (appears after clicking Add Note, or when note exists)
      if (r === 'textbox' || r === 'textarea') {
        // Skip the main message textbox (it's inside main, not the sidebar)
        var inMainArea = hasAncestor(d, function (anc) {
          return role(anc) === 'main';
        }, 10);
        if (!inMainArea) {
          var noteRef = addRef(d);
          var noteValue = propValue(d, 'value');
          var noteText = '';
          if (noteValue && typeof noteValue === 'string') {
            noteText = noteValue.trim();
          }
          if (!noteText) {
            var noteDescs = descendants(d);
            for (var ni = 0; ni < noteDescs.length; ni++) {
              if (role(noteDescs[ni]) === 'StaticText') {
                var nt = name(noteDescs[ni]).trim();
                if (nt && nt !== 'Note' && nt !== 'Click to add a note') {
                  noteText = nt;
                  break;
                }
              }
            }
          }
          if (noteText) {
            profile.note = noteText;
            profile.items.push({ type: 'note', ref: noteRef, text: 'Note: ' + noteText });
          } else {
            profile.items.push({ type: 'note', ref: noteRef, text: 'Add Note' });
          }
          continue;
        }
      }

      // Friend/Message/Block buttons
      if (r === 'button' && (n === 'Friend' || n === 'Add Friend' || n === 'Message' ||
          n === 'Block' || n === 'Send Friend Request')) {
        var ref3 = addRef(d);
        profile.items.push({ type: 'action', ref: ref3, text: n });
        continue;
      }

      // Display name button (usually first button with a short name)
      if (r === 'button' && n.length > 0 && n.length < 40 &&
          !n.includes('Server Tag') && !n.includes('More') &&
          !n.includes('React') && !n.includes('Reply') &&
          !n.includes('View') && !n.includes('Add') &&
          !n.includes('Mutual') && !n.includes('Friend') &&
          !profile.displayName) {
        profile.displayName = n;
        var ref4 = addRef(d);
        profile.items.push({ type: 'name', ref: ref4, text: n });
        continue;
      }

      // Username button (contains # or is after display name)
      if (r === 'button' && profile.displayName && n !== profile.displayName &&
          n.length > 0 && n.length < 40 && !n.includes('Server Tag') &&
          !n.includes('More') && !n.includes('React') && !n.includes('Reply') &&
          !n.includes('View') && !n.includes('Add') && !n.includes('Mutual') &&
          !n.includes('Friend') && !profile.username) {
        profile.username = n;
        continue;
      }

      // Custom status tooltip
      if (r === 'tooltip' && n.includes('Custom status')) {
        profile.customStatus = n.replace('Custom status:', '').trim();
        continue;
      }

      // Bio region
      if (r === 'region' && n.toLowerCase() === 'bio') {
        var bioDescs = descendants(d);
        var bioParts = [];
        for (var bi = 0; bi < bioDescs.length; bi++) {
          var bNode = bioDescs[bi];
          if (role(bNode) === 'StaticText') {
            var bText = name(bNode).trim();
            if (bText && bText !== 'Bio') bioParts.push(bText);
          }
        }
        if (bioParts.length > 0) {
          profile.bio = bioParts.join(' ');
        }
        continue;
      }

      // Member Since region
      if (r === 'region' && n.toLowerCase().includes('member since')) {
        var msDescs = descendants(d);
        for (var mi = 0; mi < msDescs.length; mi++) {
          if (role(msDescs[mi]) === 'StaticText') {
            var msText = name(msDescs[mi]).trim();
            if (msText && msText !== 'Member Since' && msText.match(/\w/)) {
              profile.memberSince = msText;
              break;
            }
          }
        }
        continue;
      }

      // Badges group
      if (r === 'group' && n === 'User Badges') {
        var badgeDescs = descendants(d);
        var badges = [];
        for (var bdi = 0; bdi < badgeDescs.length; bdi++) {
          if (role(badgeDescs[bdi]) === 'button') {
            var badgeName = name(badgeDescs[bdi]).trim();
            if (badgeName) badges.push(badgeName);
          }
        }
        if (badges.length > 0) profile.badges = badges;
        continue;
      }

      // Mutual servers/friends buttons
      if (r === 'button' && n.includes('Mutual')) {
        var ref5 = addRef(d);
        profile.items.push({ type: 'action', ref: ref5, text: n });
        continue;
      }

      // Note text (StaticText after Add Note that isn't UI chrome)
      if (r === 'StaticText' && n.includes('Add Note')) {
        // The actual note content follows, skip the label
        continue;
      }

      // Roles region
      if (r === 'region' && n.toLowerCase() === 'roles') {
        var roleDescs = descendants(d);
        var roles = [];
        for (var ri = 0; ri < roleDescs.length; ri++) {
          if (role(roleDescs[ri]) === 'listitem') {
            var roleName = name(roleDescs[ri]).trim();
            if (roleName) roles.push(roleName);
          }
        }
        if (roles.length > 0) profile.roles = roles;
        continue;
      }
    }

    return profile;
  }

  // --- Extract dialog/popup (profile popups, inbox, etc.) ---
  function extractDialog() {
    // Find any open dialog (profile popup, inbox, etc.)
    var dialogNode = findNode(function (node) {
      return role(node) === 'dialog' && name(node).trim().length > 0;
    });
    if (!dialogNode) return null;

    var dialogName = name(dialogNode).trim();

    // Check if this is a settings/admin dialog - route to specialized extractor
    var settingsKeywords = ['Channel Settings', 'Category Settings', 'Create Channel',
      'Server Profile', 'Manage Roles', 'Roles', 'Permissions', 'Sync permissions'];
    var isSettings = false;
    for (var sk = 0; sk < settingsKeywords.length; sk++) {
      if (dialogName.includes(settingsKeywords[sk])) { isSettings = true; break; }
    }
    // Also check page title for settings pages
    var info = detectUrl();
    if (info.title && (info.title.includes('Permissions') || info.title.includes('Overview') ||
        info.title.includes('Roles') || info.title.includes('Server Profile'))) {
      isSettings = true;
    }
    // Check for tabpanel (settings dialogs have tabpanels)
    var hasTabpanel = false;
    var dDescs = descendants(dialogNode);
    for (var tp = 0; tp < dDescs.length; tp++) {
      if (role(dDescs[tp]) === 'tabpanel') { hasTabpanel = true; break; }
    }
    if (hasTabpanel) isSettings = true;

    if (isSettings) return extractSettingsDialog(dialogNode);

    var dialog = { items: [], name: dialogName };
    var descs = descendants(dialogNode);

    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      var r = role(d);
      var n = name(d).trim();

      // Close button
      if (r === 'button' && n === 'Close') {
        var closeRef = addRef(d);
        dialog.items.unshift({ type: 'action', ref: closeRef, text: 'Close' });
        continue;
      }

      // Buttons (View Full Profile, Add Friend, More, etc.)
      if (r === 'button' && n && n.length < 60 &&
          !n.includes('Click to react')) {
        var ref = addRef(d);
        dialog.items.push({ type: 'action', ref: ref, text: n });
        continue;
      }

      // Textbox (Message @user, Note)
      if (r === 'textbox' || r === 'textarea') {
        var tbRef = addRef(d);
        var tbLabel = n || 'Note';
        var tbValue = propValue(d, 'value');
        var tbContent = '';
        if (tbValue && typeof tbValue === 'string') tbContent = tbValue.trim();
        // Fallback: check descendants for StaticText with note content
        if (!tbContent) {
          var tbDescs = descendants(d);
          for (var tbi = 0; tbi < tbDescs.length; tbi++) {
            if (role(tbDescs[tbi]) === 'StaticText') {
              var tbText = name(tbDescs[tbi]).trim();
              if (tbText && tbText !== 'Note' && tbText !== 'Click to add a note') {
                tbContent = tbText;
                break;
              }
            }
          }
        }
        var tbDisplay = tbLabel;
        if (tbContent) tbDisplay = tbLabel + ': ' + tbContent;
        dialog.items.push({ type: 'textbox', ref: tbRef, text: tbDisplay });
        continue;
      }

      // Bio region
      if (r === 'region' && n.toLowerCase() === 'bio') {
        var bioDescs = descendants(d);
        var bioParts = [];
        for (var bi = 0; bi < bioDescs.length; bi++) {
          if (role(bioDescs[bi]) === 'StaticText') {
            var bText = name(bioDescs[bi]).trim();
            if (bText && bText !== 'Bio') bioParts.push(bText);
          }
        }
        if (bioParts.length > 0) dialog.bio = bioParts.join(' ');
        continue;
      }

      // Roles
      if (r === 'region' && n.toLowerCase() === 'roles') {
        var roleDescs = descendants(d);
        var roles = [];
        for (var ri = 0; ri < roleDescs.length; ri++) {
          if (role(roleDescs[ri]) === 'listitem') {
            var roleName = name(roleDescs[ri]).trim();
            if (roleName) roles.push(roleName);
          }
        }
        if (roles.length > 0) dialog.roles = roles;
        continue;
      }

      // Badges
      if (r === 'group' && n === 'User Badges') {
        var badgeDescs = descendants(d);
        var badges = [];
        for (var bdi = 0; bdi < badgeDescs.length; bdi++) {
          if (role(badgeDescs[bdi]) === 'button') {
            var badgeName = name(badgeDescs[bdi]).trim();
            if (badgeName) badges.push(badgeName);
          }
        }
        if (badges.length > 0) dialog.badges = badges;
        continue;
      }

      // Tabs (Mutual Servers, Mutual Friends, Connections)
      if (r === 'tab' && n) {
        var ref3 = addRef(d);
        dialog.items.push({ type: 'tab', ref: ref3, text: n });
        continue;
      }
    }

    return dialog;
  }

  // --- Extract settings/admin dialog (Channel Settings, Server Settings, Create Channel, etc.) ---
  //
  // Handles Discord's settings dialogs which contain a mix of:
  //   - Navigation tabs (Overview, Permissions, etc.)
  //   - Switches (Private Channel toggle, etc.)
  //   - Text inputs (Channel Name, etc.)
  //   - Permission radiogroups (Deny/Passthrough/Allow per permission)
  //   - Action buttons (Save Changes, Sync Now, Create Channel, etc.)
  //   - Comboboxes/dropdowns (Slowmode, etc.)
  //   - Options lists (role/member picker when adding permissions)
  //   - Access lists (who can see a private channel)
  //   - Channel type radios (Text, Voice, Forum - in Create Channel dialog)
  //
  // Returns a dialog object with type: 'settings' which renderDialog() formats
  // into compact, actionable output with clickable refs.
  //
  // IMPORTANT: processedIds is used to prevent double-processing of nodes.
  // Sections are processed in a specific order so earlier sections can claim
  // nodes before later sections try to match them (e.g. switch labels are
  // claimed before the permission section tries to pair them with radiogroups).
  //
  function extractSettingsDialog(dialogNode) {
    var dialogName = name(dialogNode).trim();
    var dialog = { items: [], name: dialogName, type: 'settings' };
    var descs = descendants(dialogNode);

    // Track processed node IDs to avoid duplicates
    var processedIds = new Set();

    // --- Navigation tabs (Overview, Permissions, Invites, etc.) ---
    var navTabs = [];
    for (var i = 0; i < descs.length; i++) {
      var d = descs[i];
      if (role(d) === 'tab' && !processedIds.has(d.nodeId)) {
        var tabName = name(d).trim();
        if (tabName) {
          var selected = propValue(d, 'selected') === true;
          var tabRef = addRef(d);
          navTabs.push({ ref: tabRef, name: tabName, selected: selected });
          processedIds.add(d.nodeId);
        }
      }
    }
    if (navTabs.length > 0) dialog.tabs = navTabs;

    // --- Title from heading ---
    for (var hi = 0; hi < descs.length; hi++) {
      if (role(descs[hi]) === 'heading') {
        var hName = name(descs[hi]).trim();
        if (hName && hName.length > 2 && hName !== dialogName &&
            !hName.includes('member') && hName.length < 80) {
          dialog.heading = hName;
          break;
        }
      }
    }

    // --- Sync status ---
    for (var si = 0; si < descs.length; si++) {
      var sn = name(descs[si]).trim();
      if (role(descs[si]) === 'StaticText' && sn.includes('synced with category')) {
        dialog.syncStatus = sn;
      }
    }

    // --- Switches (Private Channel, Age-Restricted, etc.) ---
    for (var swi = 0; swi < descs.length; swi++) {
      var swNode = descs[swi];
      if (role(swNode) === 'switch' && !processedIds.has(swNode.nodeId)) {
        var swName = name(swNode).trim();
        var swChecked = propValue(swNode, 'checked');
        // Try to find label from parent
        var swParent = byId.get(swNode.parentId);
        if (swParent && role(swParent) === 'LabelText') {
          var swLabelDescs = descendants(swParent);
          for (var sli = 0; sli < swLabelDescs.length; sli++) {
            if (role(swLabelDescs[sli]) === 'StaticText') {
              var slText = name(swLabelDescs[sli]).trim();
              if (slText && slText.length > 2) { swName = slText; break; }
            }
          }
        }
        if (!swName) swName = 'Toggle';
        var swRef = addRef(swNode);
        dialog.items.push({
          type: 'switch',
          ref: swRef,
          text: swName + ': ' + (swChecked ? 'ON' : 'OFF')
        });
        processedIds.add(swNode.nodeId);
      }
    }

    // --- Text inputs ---
    for (var ii = 0; ii < descs.length; ii++) {
      var iNode = descs[ii];
      if ((role(iNode) === 'textbox' || role(iNode) === 'textarea') && !processedIds.has(iNode.nodeId)) {
        var iName = name(iNode).trim();
        var iRef = addRef(iNode);
        // Get current value
        var iDescs = descendants(iNode);
        var iValue = '';
        for (var idi = 0; idi < iDescs.length; idi++) {
          if (role(iDescs[idi]) === 'StaticText') {
            var iText = name(iDescs[idi]).trim();
            if (iText && iText !== '\u200B') { iValue = iText; break; }
          }
        }
        dialog.items.push({
          type: 'input',
          ref: iRef,
          text: (iName || 'Input') + (iValue ? ': ' + iValue : '')
        });
        processedIds.add(iNode.nodeId);
      }
    }

    // --- Permission radiogroups (Deny/Passthrough/Allow) ---
    //
    // Discord's permission settings use fieldset elements (a11y role: "group") with
    // section names like "General Channel Permissions", "Text Channel Permissions", etc.
    //
    // IMPORTANT: In the a11y tree, the group node's childIds may NOT directly contain
    // the LabelText and radiogroup nodes. They are often nested inside intermediate
    // wrapper nodes (role: "none"). Therefore we use descendants() instead of children()
    // to find LabelText + radiogroup pairs within each group.
    //
    // Each permission is a LabelText (containing the permission name as StaticText)
    // followed by a radiogroup with exactly 3 radio buttons: Deny, Passthrough, Allow.
    // Labels containing a switch child are toggle labels (e.g. Private Channel), not
    // permission labels - those are skipped.
    //
    // The group's name may come from its a11y name property OR from a Legend descendant's
    // StaticText child (the Legend node itself may have an empty name).
    //
    var permGroups = [];

    for (var pi = 0; pi < descs.length; pi++) {
      var pNode = descs[pi];
      if (role(pNode) !== 'group' || processedIds.has(pNode.nodeId)) continue;

      // Check if this group is a permissions group
      // Use the group's own name first, then check legend descendants
      var sectionName = name(pNode).trim();
      if (!sectionName) {
        var gDescs = descendants(pNode);
        for (var gd = 0; gd < gDescs.length; gd++) {
          if (role(gDescs[gd]) === 'Legend' || role(gDescs[gd]) === 'StaticText') {
            var gdName = name(gDescs[gd]).trim();
            if (gdName && gdName.includes('Permissions')) {
              sectionName = gdName;
              break;
            }
          }
        }
      }
      if (!sectionName.includes('Permissions') && !sectionName.includes('permissions')) continue;

      // Use descendants (not children) to find LabelText + radiogroup pairs
      // since they may be nested inside wrapper divs
      var groupDescs = descendants(pNode);
      var hasRadiogroup = false;
      for (var grc = 0; grc < groupDescs.length; grc++) {
        if (role(groupDescs[grc]) === 'radiogroup') { hasRadiogroup = true; break; }
      }
      if (!hasRadiogroup) continue;

      // Walk descendants in order: pair each LabelText with the next radiogroup
      var pendingLabel = '';
      var pendingLabelId = null;
      for (var gc = 0; gc < groupDescs.length; gc++) {
        var kid = groupDescs[gc];
        var kidRole = role(kid);

        if (kidRole === 'LabelText') {
          // Extract label text, skip if it contains a switch (toggle labels)
          var kidDescs = descendants(kid);
          var labelText = '';
          var hasSwitch = false;
          for (var kd = 0; kd < kidDescs.length; kd++) {
            if (role(kidDescs[kd]) === 'switch') { hasSwitch = true; break; }
            if (role(kidDescs[kd]) === 'StaticText' && !labelText) {
              labelText = name(kidDescs[kd]).trim();
            }
          }
          if (labelText && !hasSwitch) {
            pendingLabel = labelText;
            pendingLabelId = kid.nodeId;
          }
        } else if (kidRole === 'radiogroup' && pendingLabel) {
          var radios = children(kid);
          // Only match 3-radio groups (Deny/Passthrough/Allow)
          if (radios.length === 3) {
            var selectedValue = 'Passthrough';
            var radioRefs = {};
            for (var ri = 0; ri < radios.length; ri++) {
              if (role(radios[ri]) === 'radio') {
                var radioLabel = name(radios[ri]).trim() || ['Deny', 'Passthrough', 'Allow'][ri] || 'Unknown';
                var radioChecked = propValue(radios[ri], 'checked') === true;
                var rRef = addRef(radios[ri]);
                radioRefs[radioLabel] = rRef;
                if (radioChecked) selectedValue = radioLabel;
              }
            }
            permGroups.push({
              section: sectionName,
              permission: pendingLabel,
              value: selectedValue,
              refs: radioRefs
            });
            if (pendingLabelId) processedIds.add(pendingLabelId);
            processedIds.add(kid.nodeId);
            pendingLabel = '';
            pendingLabelId = null;
          }
        }
        // Other siblings (StaticText descriptions, links) are naturally skipped
      }
      processedIds.add(pNode.nodeId);
    }

    if (permGroups.length > 0) {
      dialog.permissions = permGroups;
    }

    // --- Buttons (Save Changes, Sync Now, Create Channel, Close, etc.) ---
    for (var bi = 0; bi < descs.length; bi++) {
      var bNode = descs[bi];
      if (role(bNode) === 'button' && !processedIds.has(bNode.nodeId)) {
        var bName = name(bNode).trim();
        if (!bName || bName.length > 60) continue;
        // Skip InlineTextBox-only buttons and chrome
        if (bName === 'Close' || bName === 'Cancel') {
          var bRef = addRef(bNode);
          dialog.items.push({ type: 'button', ref: bRef, text: bName });
          processedIds.add(bNode.nodeId);
          continue;
        }
        // Important action buttons
        if (bName === 'Save Changes' || bName === 'Sync Now' || bName === 'Create Channel' ||
            bName === 'Create Role' || bName === 'Delete Channel' || bName === 'Delete Category' ||
            bName === 'BACK' || bName === 'Advanced permissions' || bName === 'Add members or roles' ||
            bName === 'Reset' || bName === 'Sync Permissions' ||
            bName.includes('Remove') || bName.includes('ROLES')) {
          var bRef2 = addRef(bNode);
          var disabled = propValue(bNode, 'disabled') === true || bNode.disabled;
          dialog.items.push({
            type: 'button',
            ref: bRef2,
            text: bName + (disabled ? ' (disabled)' : '')
          });
          processedIds.add(bNode.nodeId);
        }
      }
    }

    // --- Comboboxes / Dropdowns ---
    for (var ci = 0; ci < descs.length; ci++) {
      var cNode = descs[ci];
      if (role(cNode) === 'combobox' && !processedIds.has(cNode.nodeId)) {
        var cName = name(cNode).trim();
        var cRef = addRef(cNode);
        var cDescs = descendants(cNode);
        var cValue = '';
        for (var cdi = 0; cdi < cDescs.length; cdi++) {
          if (role(cDescs[cdi]) === 'StaticText') {
            var cText = name(cDescs[cdi]).trim();
            if (cText) { cValue = cText; break; }
          }
        }
        dialog.items.push({
          type: 'dropdown',
          ref: cRef,
          text: (cName || 'Dropdown') + (cValue ? ': ' + cValue : '')
        });
        processedIds.add(cNode.nodeId);
      }
    }

    // --- Options list (role picker dropdown) ---
    var options = [];
    for (var oi = 0; oi < descs.length; oi++) {
      if (role(descs[oi]) === 'option' && !processedIds.has(descs[oi].nodeId)) {
        var oName = name(descs[oi]).trim();
        if (oName) {
          var oRef = addRef(descs[oi]);
          options.push({ ref: oRef, text: oName });
          processedIds.add(descs[oi].nodeId);
        }
      }
    }
    if (options.length > 0) dialog.options = options;

    // --- List items (role/member access list) ---
    var accessList = [];
    for (var li = 0; li < descs.length; li++) {
      var lNode = descs[li];
      if (role(lNode) === 'listitem' && !processedIds.has(lNode.nodeId)) {
        var lDescs = descendants(lNode);
        var lTexts = [];
        for (var ldi = 0; ldi < lDescs.length; ldi++) {
          if (role(lDescs[ldi]) === 'StaticText') {
            var lt = name(lDescs[ldi]).trim();
            if (lt && lt !== 'Remove' && lt.length < 60) lTexts.push(lt);
          }
        }
        if (lTexts.length > 0) {
          var lText = lTexts.join(' - ');
          // Only include if it looks like a role/member entry
          if (lText.includes('Role') || lText.includes('Administrator') ||
              lText.includes('Server Owner') || lText.includes('Member')) {
            accessList.push(lText);
            processedIds.add(lNode.nodeId);
          }
        }
      }
    }
    if (accessList.length > 0) dialog.accessList = accessList;

    // --- Radio groups for channel type (Create Channel dialog) ---
    var channelTypes = [];
    for (var rti = 0; rti < descs.length; rti++) {
      var rtNode = descs[rti];
      if (role(rtNode) === 'radio' && !processedIds.has(rtNode.nodeId)) {
        var rtName = name(rtNode).trim();
        var rtChecked = propValue(rtNode, 'checked') === true;
        if (rtName && (rtName.includes('Text') || rtName.includes('Voice') ||
            rtName.includes('Forum') || rtName.includes('Announcement') ||
            rtName.includes('Stage') || rtName.includes('Media'))) {
          var rtRef = addRef(rtNode);
          // Extract just the type name (first word before description)
          var typeName = rtName.split(/\s/)[0];
          channelTypes.push({
            ref: rtRef,
            text: typeName + (rtChecked ? ' (selected)' : '')
          });
          processedIds.add(rtNode.nodeId);
        }
      }
    }
    if (channelTypes.length > 0) dialog.channelTypes = channelTypes;

    return dialog;
  }

  // --- Render dialog data into output lines ---
  function renderDialog(lines, dialogData) {
    if (!dialogData) return;

    // Settings dialog (Channel Settings, Create Channel, Permissions, etc.)
    if (dialogData.type === 'settings') {
      lines.push('--- Settings: ' + (dialogData.heading || dialogData.name || 'Dialog') + ' ---');

      // Navigation tabs
      if (dialogData.tabs && dialogData.tabs.length > 0) {
        var tabLine = 'Tabs: ';
        var tabParts = [];
        for (var ti = 0; ti < dialogData.tabs.length; ti++) {
          var tab = dialogData.tabs[ti];
          var tPart = '[' + tab.ref + '] ' + tab.name;
          if (tab.selected) tPart += ' (selected)';
          tabParts.push(tPart);
        }
        tabLine += tabParts.join(' | ');
        lines.push(tabLine);
      }

      // Sync status
      if (dialogData.syncStatus) {
        lines.push('Sync: ' + dialogData.syncStatus);
      }

      // Switches
      for (var si = 0; si < dialogData.items.length; si++) {
        var item = dialogData.items[si];
        if (item.type === 'switch') {
          lines.push('[' + item.ref + '] ' + item.text);
        }
      }

      // Inputs
      for (var ii = 0; ii < dialogData.items.length; ii++) {
        var iItem = dialogData.items[ii];
        if (iItem.type === 'input') {
          lines.push('[' + iItem.ref + '] ' + iItem.text);
        }
      }

      // Channel types (Create Channel dialog)
      if (dialogData.channelTypes && dialogData.channelTypes.length > 0) {
        lines.push('Channel Type:');
        for (var ct = 0; ct < dialogData.channelTypes.length; ct++) {
          var cType = dialogData.channelTypes[ct];
          lines.push('  [' + cType.ref + '] ' + cType.text);
        }
      }

      // Access list
      if (dialogData.accessList && dialogData.accessList.length > 0) {
        lines.push('Access: ' + dialogData.accessList.join(', '));
      }

      // Options (role/member picker dropdown)
      if (dialogData.options && dialogData.options.length > 0) {
        lines.push('Options:');
        for (var oi = 0; oi < dialogData.options.length; oi++) {
          var opt = dialogData.options[oi];
          lines.push('  [' + opt.ref + '] ' + opt.text);
        }
      }

      // Permissions
      if (dialogData.permissions && dialogData.permissions.length > 0) {
        var lastSection = '';
        lines.push('');
        lines.push('Permissions (@everyone or selected role):');
        for (var pi = 0; pi < dialogData.permissions.length; pi++) {
          var perm = dialogData.permissions[pi];
          if (perm.section && perm.section !== lastSection) {
            lines.push('  ' + perm.section + ':');
            lastSection = perm.section;
          }
          var permLine = '    ' + perm.permission + ': ' + perm.value;
          // Add refs for non-passthrough values or key permissions
          var keyPerms = ['View Channel', 'View Channels', 'Send Messages',
            'Send Messages and Create Posts', 'Connect'];
          var isKey = false;
          for (var kp = 0; kp < keyPerms.length; kp++) {
            if (perm.permission === keyPerms[kp]) { isKey = true; break; }
          }
          if (isKey || perm.value !== 'Passthrough') {
            permLine += ' (';
            var refParts = [];
            if (perm.refs['Deny']) refParts.push('deny=[' + perm.refs['Deny'] + ']');
            if (perm.refs['Passthrough']) refParts.push('pass=[' + perm.refs['Passthrough'] + ']');
            if (perm.refs['Allow']) refParts.push('allow=[' + perm.refs['Allow'] + ']');
            permLine += refParts.join(', ') + ')';
          }
          lines.push(permLine);
        }
      }

      // Action buttons
      var actionButtons = [];
      for (var bi = 0; bi < dialogData.items.length; bi++) {
        var bItem = dialogData.items[bi];
        if (bItem.type === 'button' || bItem.type === 'dropdown') {
          actionButtons.push(bItem);
        }
      }
      if (actionButtons.length > 0) {
        lines.push('');
        for (var ab = 0; ab < actionButtons.length; ab++) {
          var aItem = actionButtons[ab];
          lines.push('[' + aItem.ref + '] ' + aItem.text);
        }
      }

      return;
    }

    // Profile / generic dialog
    lines.push('--- ' + dialogData.name + ' ---');
    if (dialogData.bio) lines.push('Bio: ' + dialogData.bio);
    if (dialogData.badges) lines.push('Badges: ' + dialogData.badges.join(', '));
    if (dialogData.roles) lines.push('Roles: ' + dialogData.roles.join(', '));
    for (var di = 0; di < dialogData.items.length; di++) {
      var dItem = dialogData.items[di];
      var dLine = '';
      if (dItem.ref) dLine += '[' + dItem.ref + '] ';
      dLine += dItem.text;
      lines.push(dLine);
    }
  }

  // =========================================================================
  // Page formatters
  // =========================================================================

  function formatDmList() {
    var lines = [];
    lines.push('Discord | Direct Messages');
    lines.push('');

    var dmItems = extractDmList();
    if (dmItems.length > 0) {
      lines.push('--- DM Conversations ---');
      for (var i = 0; i < dmItems.length; i++) {
        lines.push(dmItems[i].line);
      }
    } else {
      lines.push('(No DM conversations found)');
    }

    lines.push('');

    var textbox = findNode(function (node) {
      var r = role(node);
      return r === 'textbox' || r === 'searchbox';
    });
    if (textbox) {
      var ref = addRef(textbox);
      lines.push('[' + ref + '] ' + (name(textbox).trim() || 'Search'));
    }

    return {
      tree: lines.join('\n'),
      elementCount: refCounter - 1,
      refs: refs,
      pageType: 'dm_list',
      dmCount: dmItems.length
    };
  }

  function formatDmConversation() {
    var lines = [];
    var recipient = extractDmRecipient();
    var headerLabel;
    if (recipient.displayName && recipient.username) {
      // Both available — render display name first, username in parens.
      // Tells the agent that e.g. "Jtonna" and "@notboosted" are the same person.
      headerLabel = recipient.displayName + ' (@' + recipient.username + ')';
    } else if (recipient.username) {
      headerLabel = '@' + recipient.username;
    } else if (recipient.displayName) {
      headerLabel = recipient.displayName;
    } else {
      headerLabel = '@Unknown';
    }

    lines.push('Discord | ' + headerLabel + ' (DM)');
    lines.push('');

    // Only show UNREAD DMs in sidebar (fix: filter to unread only)
    var allDmItems = extractDmList();
    var unreadDmItems = [];
    for (var i = 0; i < allDmItems.length; i++) {
      if (allDmItems[i].unread) {
        unreadDmItems.push(allDmItems[i]);
      }
    }
    if (unreadDmItems.length > 0) {
      lines.push('--- Unread DMs ---');
      for (var j = 0; j < unreadDmItems.length; j++) {
        lines.push(unreadDmItems[j].line);
      }
      lines.push('');
    }

    // Messages
    var messageData = extractMessages();

    if (messageData.length > 0) {
      lines.push('--- Messages ---');
      var inNewSection = false;

      for (var mi = 0; mi < messageData.length; mi++) {
        var msg = messageData[mi];
        if (msg.type === 'divider') {
          if (!inNewSection) {
            lines.push('');
            lines.push('--- ' + msg.text + ' ---');
            inNewSection = true;
          }
          continue;
        }

        var line = '';
        if (msg.ref) line += '[' + msg.ref + '] ';
        if (msg.author && msg.authorRef) {
          line += '[' + msg.authorRef + ':' + msg.author + ']';
        } else if (msg.author) {
          line += msg.author;
        }
        if (msg.timestamp) line += ' (' + msg.timestamp + ')';
        if (msg.author || msg.timestamp) line += ': ';
        line += msg.content;

        lines.push(line);
      }
    } else {
      lines.push('(No messages found)');
    }

    lines.push('');

    var textbox = extractTextbox();
    if (textbox) {
      var tbRef = addRef(textbox);
      lines.push(formatComposerLine(tbRef, textbox));
    }

    // Profile sidebar
    var profileData = extractProfileSidebar();
    if (profileData.items.length > 0 || profileData.displayName) {
      lines.push('');
      lines.push('--- Profile ---');
      if (profileData.displayName) lines.push('Name: ' + profileData.displayName);
      if (profileData.username) lines.push('Username: ' + profileData.username);
      if (profileData.customStatus) lines.push('Status: ' + profileData.customStatus);
      if (profileData.bio) lines.push('Bio: ' + profileData.bio);
      if (profileData.badges) lines.push('Badges: ' + profileData.badges.join(', '));
      if (profileData.memberSince) lines.push('Member Since: ' + profileData.memberSince);
      if (profileData.roles) lines.push('Roles: ' + profileData.roles.join(', '));
      for (var pi = 0; pi < profileData.items.length; pi++) {
        var pItem = profileData.items[pi];
        var pLine = '';
        if (pItem.ref) pLine += '[' + pItem.ref + '] ';
        pLine += pItem.text;
        lines.push(pLine);
      }
    }

    // Dialog popup (profile popup from clicking a name)
    var dialogData = extractDialog();
    if (dialogData) {
      lines.push('');
      renderDialog(lines, dialogData);
    }

    return {
      tree: lines.join('\n'),
      elementCount: refCounter - 1,
      refs: refs,
      pageType: 'dm_conversation',
      recipient: recipient.username || recipient.displayName || '',
      recipientUsername: recipient.username,
      recipientDisplayName: recipient.displayName,
      messageCount: messageData.filter(function (m) { return m.type === 'message'; }).length
    };
  }

  function formatServerChannel() {
    var lines = [];
    var chanInfo = extractChannelInfo();

    var header = 'Discord';
    if (chanInfo.serverName) header += ' | ' + chanInfo.serverName;
    if (chanInfo.channelName) header += ' | ' + chanInfo.channelName;
    lines.push(header);
    lines.push('');

    // Server notifications (mentions in other servers)
    var serverNotifs = extractServerNotifications();
    if (serverNotifs.length > 0) {
      lines.push('--- Server Notifications ---');
      for (var ni = 0; ni < serverNotifs.length; ni++) {
        var notif = serverNotifs[ni];
        var nLine = '';
        if (notif.ref) nLine += '[' + notif.ref + '] ';
        nLine += notif.server + ' (' + notif.mentions + ' mentions)';
        lines.push(nLine);
      }
      lines.push('');
    }

    // Server channels sidebar
    var sidebarChannels = extractServerChannels();
    if (sidebarChannels.length > 0) {
      lines.push('--- Channels ---');
      for (var ci = 0; ci < sidebarChannels.length; ci++) {
        var ch = sidebarChannels[ci];
        if (ch.type === 'category') {
          // Category header with optional Create Channel button
          var catLine = '[' + ch.ref + '] ';
          catLine += '▸ ' + ch.name;
          if (ch.createRef) catLine += ' (+[' + ch.createRef + '])';
          lines.push(catLine);
        } else {
          var line = '  ';
          if (ch.ref) line += '[' + ch.ref + '] ';
          line += ch.name;
          line += ch.annotation;
          lines.push(line);
        }
      }
      lines.push('');
    }

    // Messages
    var messageData = extractMessages();

    if (messageData.length > 0) {
      lines.push('--- Messages ---');
      var inNewSection = false;

      for (var mi = 0; mi < messageData.length; mi++) {
        var msg = messageData[mi];
        if (msg.type === 'divider') {
          if (!inNewSection) {
            lines.push('');
            lines.push('--- ' + msg.text + ' ---');
            inNewSection = true;
          }
          continue;
        }

        var line2 = '';
        if (msg.ref) line2 += '[' + msg.ref + '] ';
        if (msg.author && msg.authorRef) {
          line2 += '[' + msg.authorRef + ':' + msg.author + ']';
        } else if (msg.author) {
          line2 += msg.author;
        }
        if (msg.timestamp) line2 += ' (' + msg.timestamp + ')';
        if (msg.author || msg.timestamp) line2 += ': ';
        line2 += msg.content;

        lines.push(line2);
      }
    } else {
      lines.push('(No messages found)');
    }

    lines.push('');

    var textbox = extractTextbox();
    if (textbox) {
      var tbRef = addRef(textbox);
      lines.push(formatComposerLine(tbRef, textbox));
    }

    // Member list
    var memberData = extractMemberList();
    if (memberData.length > 0) {
      lines.push('');
      lines.push('--- Members ---');
      for (var mli = 0; mli < memberData.length; mli++) {
        var mem = memberData[mli];
        if (mem.type === 'role') {
          lines.push('  ' + mem.name);
        } else {
          var mLine = '';
          if (mem.ref) mLine += '[' + mem.ref + '] ';
          mLine += mem.name;
          if (mem.status) mLine += ' (' + mem.status + ')';
          lines.push('  ' + mLine);
        }
      }
    }

    // Dialog (settings, profile popup, create channel, etc.)
    var dialogData = extractDialog();
    if (dialogData) {
      lines.push('');
      renderDialog(lines, dialogData);
    }

    // Also check for confirmation dialogs (Sync permissions?, Delete Channel?, etc.)
    var confirmDialogs = findNodes(function (node) {
      return role(node) === 'dialog' && name(node).trim().length > 0;
    });
    for (var cdi = 0; cdi < confirmDialogs.length; cdi++) {
      var cd = confirmDialogs[cdi];
      var cdName = name(cd).trim();
      // Skip the main settings dialog (already handled above)
      if (cdName === 'Channel Settings' || cdName === 'Category Settings') continue;
      if (dialogData && cdName === dialogData.name) continue;
      // This is a secondary confirmation dialog
      var cdDescs = descendants(cd);
      lines.push('');
      lines.push('--- Confirm: ' + cdName + ' ---');
      for (var cddi = 0; cddi < cdDescs.length; cddi++) {
        var cdn = cdDescs[cddi];
        if (role(cdn) === 'button') {
          var cdBtnName = name(cdn).trim();
          if (cdBtnName && cdBtnName.length < 40) {
            var cdRef = addRef(cdn);
            lines.push('[' + cdRef + '] ' + cdBtnName);
          }
        }
      }
    }

    var result = {
      tree: lines.join('\n'),
      elementCount: refCounter - 1,
      refs: refs,
      pageType: 'server_channel',
      serverName: chanInfo.serverName,
      channelName: chanInfo.channelName,
      messageCount: messageData.filter(function (m) { return m.type === 'message'; }).length,
      channelCount: sidebarChannels.length,
      memberCount: memberData.filter(function (m) { return m.type === 'member'; }).length
    };

    if (dialogData && dialogData.type === 'settings') {
      result.hasSettingsDialog = true;
      result.dialogName = dialogData.heading || dialogData.name;
    }

    return result;
  }

  function formatUnknown() {
    var lines = [];
    var info = detectUrl();
    lines.push('Discord | ' + (info.title || 'Unknown Page'));
    lines.push('');

    var messageData = extractMessages();
    if (messageData.length > 0) {
      lines.push('--- Messages ---');
      for (var mi = 0; mi < messageData.length; mi++) {
        var msg = messageData[mi];
        if (msg.type === 'divider') {
          lines.push('');
          lines.push('--- ' + msg.text + ' ---');
          continue;
        }
        var line = '';
        if (msg.ref) line += '[' + msg.ref + '] ';
        if (msg.author && msg.authorRef) {
          line += '[' + msg.authorRef + ':' + msg.author + ']';
        } else if (msg.author) {
          line += msg.author;
        }
        if (msg.timestamp) line += ' (' + msg.timestamp + ')';
        if (msg.author || msg.timestamp) line += ': ';
        line += msg.content;
        lines.push(line);
      }
      lines.push('');
    }

    var textbox = extractTextbox();
    if (textbox) {
      var ref = addRef(textbox);
      lines.push(formatComposerLine(ref, textbox));
    }

    if (refCounter === 1) {
      lines.push('--- Elements ---');
      var interactiveRoles = new Set([
        'link', 'button', 'textbox', 'textarea', 'searchbox',
        'menuitem', 'tab', 'checkbox', 'radio', 'switch',
        'combobox', 'option', 'treeitem'
      ]);
      for (var ni = 0; ni < nodes.length; ni++) {
        var node = nodes[ni];
        if (isIgnored(node)) continue;
        var r = role(node);
        if (!interactiveRoles.has(r)) continue;
        var n = name(node).trim();
        if (!n || n.length < 2) continue;
        var ref2 = addRef(node);
        lines.push('[' + ref2 + '] ' + r + ': ' + n);
        if (refCounter > 80) break;
      }
    }

    return {
      tree: lines.join('\n'),
      elementCount: refCounter - 1,
      refs: refs,
      pageType: 'unknown'
    };
  }

  // =========================================================================
  // Router
  // =========================================================================

  var url = findDiscordUrl();
  var page = detectPageType(url);

  switch (page.type) {
    case 'dm_list':
      return formatDmList();
    case 'dm_conversation':
      return formatDmConversation();
    case 'server_channel':
      return formatServerChannel();
    default:
      return formatUnknown();
  }
};
