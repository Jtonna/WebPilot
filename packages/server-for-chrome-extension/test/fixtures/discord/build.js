'use strict';

/**
 * Synthetic CDP accessibility-node builder for the Discord formatter tests.
 *
 * All names and ids are fake. Only the node STRUCTURE mirrors what Chrome
 * returns for discord.com (wrapper generics, ignored `none` nodes, a
 * focusable unnamed generic per server, StaticText labels, etc.).
 */

function Builder(url, title) {
  this.nodes = [];
  this.nextId = 1;
  this.nextBackend = 100;
  this.root = this.add(null, 'RootWebArea', title || 'Discord', {
    props: { url: url, focusable: true },
  });
}

// Add a node under `parent` (a node object or null). Returns the node.
Builder.prototype.add = function (parent, role, name, opts) {
  opts = opts || {};
  const id = String(this.nextId++);
  const node = {
    nodeId: id,
    backendDOMNodeId: this.nextBackend++,
    ignored: !!opts.ignored,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name || '' },
    childIds: [],
    properties: [],
  };
  if (parent) node.parentId = parent.nodeId;
  const props = opts.props || {};
  Object.keys(props).forEach(function (k) {
    const v = props[k];
    node.properties.push({
      name: k,
      value: { type: typeof v === 'string' ? 'string' : 'booleanOrUndefined', value: v },
    });
  });
  this.nodes.push(node);
  if (parent) parent.childIds.push(id);
  return node;
};

// StaticText followed by its (backend-less) InlineTextBox child, like Chrome.
Builder.prototype.text = function (parent, text) {
  const st = this.add(parent, 'StaticText', text);
  const box = this.add(st, 'InlineTextBox', text);
  delete box.backendDOMNodeId;
  return st;
};

// --- Servers sidebar -------------------------------------------------------

// opts.dmBadges: array of "Name , N unread messages" labels (creates the
// group "Direct Messages"). Returns { nav, tree, home, servers, dmGroup }.
Builder.prototype.sidebar = function (opts) {
  opts = opts || {};
  const nav = this.add(this.root, 'navigation', 'Servers sidebar');

  // stray "NEW" badge outside the tree
  const newWrap = this.add(nav, 'generic', '');
  const newInner = this.add(newWrap, 'generic', '');
  const newNone = this.add(newInner, 'none', '', { ignored: true });
  this.text(newNone, 'NEW');

  const tree = this.add(nav, 'tree', '', { props: { focusable: true } });
  const wrap = this.add(tree, 'generic', '');

  // home icon
  const homeWrap = this.add(wrap, 'generic', '');
  const homeNone = this.add(homeWrap, 'none', '', { ignored: true });
  const home = this.add(homeNone, 'generic', '', { props: { focusable: true } });
  const homeLabel = this.add(home, 'none', '', { ignored: true });
  this.text(homeLabel, 'Direct Messages');

  // unread DM badges: group "Direct Messages" with per-DM focusable generics
  let dmGroup = null;
  if (opts.dmBadges) {
    dmGroup = this.add(wrap, 'group', 'Direct Messages');
    for (const label of opts.dmBadges) {
      const w = this.add(dmGroup, 'generic', '');
      const f = this.add(w, 'generic', '', { props: { focusable: true } });
      const n = this.add(f, 'none', '', { ignored: true });
      this.text(n, label);
    }
  }

  const servers = this.add(wrap, 'group', 'Servers');
  return { nav: nav, tree: tree, home: home, servers: servers, dmGroup: dmGroup };
};

// Per-server wrapper. opts: { prefix, suffix, plain, mentions }
// Returns the FOCUSABLE generic (the clickable node).
Builder.prototype.server = function (parent, label, opts) {
  opts = opts || {};
  const first = (opts.prefix || '') + label + (opts.suffix || '');
  const wrapper = this.add(parent, 'generic', '');

  // branch 1: chain down to the focusable generic whose first StaticText is
  // the status-prefixed label
  const c1 = this.add(wrapper, 'generic', '');
  const c2 = this.add(c1, 'none', '', { ignored: true });
  const c3 = this.add(c2, 'generic', '');
  const c4 = this.add(c3, 'none', '', { ignored: true });
  const c5 = this.add(c4, 'generic', '');
  const focusable = this.add(c5, 'generic', '', { props: { focusable: true } });
  const none = this.add(focusable, 'none', '', { ignored: true });
  this.text(none, first);

  // mention badge (numeric StaticText) sits in a sibling branch of the chain
  if (opts.mentions) {
    const bw = this.add(c1, 'generic', '');
    const bn = this.add(bw, 'none', '', { ignored: true });
    this.text(bn, String(opts.mentions));
  }

  // branch 2: plain name, not clickable
  const p1 = this.add(wrapper, 'generic', '');
  const p2 = this.add(p1, 'generic', '');
  this.text(p2, opts.plain === undefined ? label : opts.plain);
  return focusable;
};

// Folder. opts: { text, expanded (property), children: [[label, opts], ...],
// showGroup }. `text` is the folder StaticText, e.g.
// "Games, folder , 2 unread mentions". Returns the folder treeitem.
Builder.prototype.folder = function (parent, opts) {
  const wrap = this.add(parent, 'generic', '');
  const outer = this.add(wrap, 'generic', '');
  const g0 = this.add(outer, 'group', '');
  const children = opts.children || [];
  const showGroup = opts.showGroup !== undefined ? opts.showGroup : children.length > 0;
  const item = this.add(g0, 'treeitem', opts.accName || opts.text, {
    props: { focusable: true, level: '1', expanded: !!opts.expanded, selected: false },
  });
  const none = this.add(item, 'none', '', { ignored: true });
  this.text(none, opts.text);
  this.add(item, 'none', '', { ignored: true });
  if (showGroup) {
    const grp = this.add(item, 'group', 'folder-group');
    for (const c of children) this.server(grp, c[0], c[1]);
  }
  return item;
};

// Excluded sidebar buttons (Add a Server, Discover, Download Apps)
Builder.prototype.utilityButtons = function (parent) {
  const out = [];
  for (const nm of ['Add a Server', 'Discover', 'Download Apps']) {
    const w = this.add(parent, 'generic', '');
    out.push(this.add(w, 'generic', nm, { props: { focusable: true } }));
  }
  return out;
};

// --- DM / nav links --------------------------------------------------------

Builder.prototype.dmLinks = function (parent, links) {
  const out = [];
  let n = 0;
  for (const l of links) {
    const id = l.id || String(900000000000000000 + n++);
    out.push(this.add(parent, 'link', l.name, {
      props: { focusable: true, url: 'https://discord.com/channels/@me/' + id },
    }));
  }
  return out;
};

Builder.prototype.navLinks = function (parent, links) {
  const out = [];
  for (const l of links) {
    out.push(this.add(parent, 'link', l.name, { props: { focusable: true, url: l.url } }));
  }
  return out;
};

// --- Server channel header / member list -----------------------------------

// Live structure: region "Channel header" holding a title heading and sibling
// buttons (no toolbar ancestor). opts.toggle: 'Show' | 'Hide' | null (omit the
// toggle, as before the toolbar has rendered). opts.noBackend drops the
// toggle's backendDOMNodeId. opts.heading overrides the title heading's name
// (default "Alpha Guild: general"). Returns { region, toggle }.
Builder.prototype.channelHeader = function (parent, opts) {
  opts = opts || {};
  const region = this.add(parent, 'region', 'Channel header');
  const title = this.add(region, 'heading', opts.heading || 'Alpha Guild: general', { props: { level: '1' } });
  this.text(title, 'Alpha Guild');
  for (const nm of ['Threads', 'Notification Settings', 'Pinned Messages']) {
    this.add(region, 'button', nm, { props: { focusable: true, expanded: false } });
  }
  let toggle = null;
  if (opts.toggle) {
    toggle = this.add(region, 'button', opts.toggle + ' Member List', { props: { focusable: true } });
    if (opts.noBackend) delete toggle.backendDOMNodeId;
  }
  return { region: region, toggle: toggle };
};

// Chat-area landmark, live name "<channel> (channel)". Returns the main node.
Builder.prototype.mainLandmark = function (parent, channelName) {
  return this.add(parent, 'main', channelName + ' (channel)');
};

// Channel sidebar link inside its own listitem. opts.invite adds the
// "Invite to Channel" child button the live tree renders on the current
// channel. Returns the link.
Builder.prototype.channelLink = function (list, linkName, url, opts) {
  opts = opts || {};
  const item = this.add(list, 'listitem', '');
  const link = this.add(item, 'link', linkName, { props: { focusable: true, url: url } });
  if (opts.invite) this.add(link, 'button', 'Invite to Channel', { props: { focusable: true } });
  return link;
};

// Members panel. groups: [{ name, count, text?, members: [[displayName, status], ...] }].
// `text` overrides the heading text. Each heading carries a StaticText child
// with the same text, as in the live tree (the "duplicate" in the raw outline).
// Returns { panel, list, headings, items }.
Builder.prototype.membersPanel = function (parent, groups) {
  const wrapper = this.add(parent, 'generic', 'Members list for general (channel)', { props: { focusable: true } });
  const panel = this.add(wrapper, 'complementary', 'Members list for general (channel)');
  const ph = this.add(panel, 'heading', 'Members list for general (channel)', { props: { level: '2' } });
  this.text(ph, 'Members list for general (channel)');
  const list = this.add(panel, 'list', 'Members', { props: { focusable: true } });
  const headings = [];
  const items = [];
  for (const g of groups) {
    const t = g.text || g.name + ', ' + g.count + (g.count === 1 ? ' member' : ' members');
    const h = this.add(list, 'heading', t, { props: { level: '3' } });
    this.text(h, t);
    headings.push(h);
    for (const m of g.members || []) {
      const li = this.add(list, 'listitem', '', { props: { focusable: true, level: '1', expanded: false } });
      // m[1] === null: offline row, avatar image named by username only
      this.add(li, 'image', m[0].toLowerCase() + (m[1] === null ? '' : ', ' + (m[1] || 'Online')));
      this.text(li, m[0]);
      items.push(li);
    }
  }
  return { panel: panel, list: list, headings: headings, items: items };
};

// --- Promo / shop modal -----------------------------------------------------

// Discord promo modal as seen live: an UNNAMED dialog under ignored generic
// wrappers (no named landmark between it and RootWebArea).
// opts: { headings: string[], buttons: string[], named?: string,
//   withClose?: boolean (default true), textbox?: boolean, tabpanel?: boolean,
//   wrapperNamedRegion?: boolean (wrap in a named region instead) }.
// Returns { dialog, closeBtn, buttons }.
Builder.prototype.promoDialog = function (parent, opts) {
  opts = opts || {};
  const wrapper = opts.wrapperNamedRegion
    ? this.add(parent, 'region', 'Some Panel')
    : this.add(parent, 'generic', '', { ignored: true });
  const dialog = this.add(wrapper, 'dialog', opts.named || '', { props: { focusable: true } });
  this.add(dialog, 'log', '');
  this.add(dialog, 'log', '');
  let closeBtn = null;
  if (opts.withClose !== false) {
    closeBtn = this.add(dialog, 'button', 'Close', { props: { focusable: true } });
  }
  for (const h of opts.headings || []) {
    this.add(dialog, 'heading', h, { props: { level: '1' } });
    this.text(dialog, h + ' description text.');
  }
  const buttons = [];
  for (const nm of opts.buttons || []) {
    buttons.push(this.add(dialog, 'button', nm, { props: { focusable: true } }));
  }
  if (opts.textbox) this.add(dialog, 'textbox', 'Message', { props: { focusable: true } });
  if (opts.tabpanel) this.add(dialog, 'tabpanel', 'Overview');
  return { dialog: dialog, closeBtn: closeBtn, buttons: buttons };
};

// --- Messages / DM header / profile popout (#161) ---------------------------

// Message list as seen live: main "<channel> (channel)" > list "Messages in
// <channel>" > listitem > article. A message with an author has a heading
// (level 3) holding the author button and a time; a grouped follow-up has
// no heading, only a time. Content sits in an unnamed generic wrapper.
// messages: [{ author, time, parts, followUp?, mentionDirect? }] where parts
// is an array of strings and { mention: '@Name' } entries. mentionDirect puts
// the content parts straight under the article (no wrapper).
// Returns { main, list, items: [{ item, article, authorBtn, mentions[] }] }.
Builder.prototype.messageList = function (parent, channelName, messages) {
  const main = this.add(parent, 'main', channelName + ' (channel)');
  const group = this.add(main, 'group', '', { props: { focusable: true } });
  const list = this.add(group, 'list', 'Messages in ' + channelName, { props: { focusable: true } });
  const items = [];
  for (const m of messages) {
    const item = this.add(list, 'listitem', '', { props: { level: '1' } });
    const text = m.parts.map(function (p) { return typeof p === 'string' ? p : p.mention; }).join('');
    const article = this.add(item, 'article', (m.author || '') + ' , ' + text + ' , ' + m.time,
      { props: { focusable: true } });
    let authorBtn = null;
    if (!m.followUp) {
      const heading = this.add(article, 'heading', m.author + ' ' + m.time, { props: { level: '3' } });
      authorBtn = this.add(heading, 'button', m.author, { props: { focusable: true, expanded: false } });
      this.text(authorBtn, m.author);
      const time = this.add(heading, 'time', '');
      this.text(time, m.time);
    } else {
      const time = this.add(article, 'time', '');
      this.text(time, m.time);
    }
    const wrap = m.mentionDirect ? article : this.add(article, 'generic', '');
    const mentions = [];
    for (const p of m.parts) {
      if (typeof p === 'string') {
        this.text(wrap, p);
      } else {
        const btn = this.add(wrap, 'button', p.mention, { props: { focusable: true, expanded: false } });
        this.text(btn, p.mention);
        mentions.push(btn);
      }
    }
    items.push({ item: item, article: article, authorBtn: authorBtn, mentions: mentions });
  }
  return { main: main, list: list, items: items };
};

// Live DM header: region "Channel header" > button > heading (level 1) with
// StaticText [displayName, username]. Returns { region, button, heading }.
Builder.prototype.dmHeader = function (parent, displayName, username) {
  const region = this.add(parent, 'region', 'Channel header');
  this.text(region, 'Direct Message');
  const button = this.add(region, 'button', displayName + ' ' + username, { props: { focusable: true } });
  const heading = this.add(button, 'heading', displayName + ' ' + username, { props: { level: '1' } });
  this.text(heading, displayName);
  this.text(heading, username);
  this.add(region, 'button', 'Start Voice Call', { props: { focusable: true } });
  return { region: region, button: button, heading: heading };
};

// Member profile popout as seen live: dialog "<name>'s profile" with the
// avatar image "<username>, <status>", display-name and username buttons,
// badges, a Roles list of unnamed listitems and the inline DM textbox
// "Message @<name>". opts: { status, roles, messageButton (adds a
// "Message" button), close (adds a Close button), noTextbox, noBadges }.
// Returns { dialog, textbox, messageButton, closeBtn }.
Builder.prototype.profileDialog = function (parent, displayName, username, opts) {
  opts = opts || {};
  const dialog = this.add(parent, 'dialog', displayName + "'s profile", { props: { focusable: true } });
  const h = this.add(dialog, 'heading', displayName + "'s profile", { props: { level: '1' } });
  this.text(h, displayName + "'s profile");
  let closeBtn = null;
  if (opts.close) closeBtn = this.add(dialog, 'button', 'Close', { props: { focusable: true } });
  for (const nm of ['Add Friend', 'More', 'View Full Profile']) {
    this.add(dialog, 'button', nm, { props: { focusable: true } });
  }
  this.add(dialog, 'image', username + (opts.status === null ? '' : ', ' + (opts.status || 'Idle')));
  const nameBtn = this.add(dialog, 'button', displayName, { props: { focusable: true } });
  this.text(nameBtn, displayName);
  this.add(dialog, 'button', 'Add Note (only visible to you)', { props: { focusable: true } });
  const userBtn = this.add(dialog, 'button', username, { props: { focusable: true } });
  this.text(userBtn, username);
  if (!opts.noBadges) {
    const badges = this.add(dialog, 'group', 'User Badges');
    this.add(badges, 'link', 'Account Age', { props: { focusable: true } });
  }
  let messageButton = null;
  if (opts.messageButton) {
    messageButton = this.add(dialog, 'button', 'Message', { props: { focusable: true } });
  }
  if (opts.roles) {
    const rl = this.add(dialog, 'list', 'Roles');
    for (const r of opts.roles) {
      const li = this.add(rl, 'listitem', '', { props: { level: '1' } });
      this.text(li, r);
    }
  }
  let textbox = null;
  if (!opts.noTextbox) {
    textbox = this.add(dialog, 'textbox', 'Message @' + displayName, { props: { focusable: true } });
  }
  return { dialog: dialog, textbox: textbox, messageButton: messageButton, closeBtn: closeBtn };
};

Builder.prototype.build = function () {
  return this.nodes;
};

const FRIENDS = { name: 'Friends', url: 'https://discord.com/channels/@me' };
const SHOP = { name: 'Shop NEW', url: 'https://discord.com/shop' };
const NITRO = { name: 'Nitro Home', url: 'https://discord.com/store' };
const QUESTS = { name: 'Quests', url: 'https://discord.com/quest-home' };

module.exports = { Builder, FRIENDS, SHOP, NITRO, QUESTS };
