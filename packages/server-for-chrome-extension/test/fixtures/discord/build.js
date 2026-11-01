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

Builder.prototype.build = function () {
  return this.nodes;
};

const FRIENDS = { name: 'Friends', url: 'https://discord.com/channels/@me' };
const SHOP = { name: 'Shop NEW', url: 'https://discord.com/shop' };
const NITRO = { name: 'Nitro Home', url: 'https://discord.com/store' };
const QUESTS = { name: 'Quests', url: 'https://discord.com/quest-home' };

module.exports = { Builder, FRIENDS, SHOP, NITRO, QUESTS };
