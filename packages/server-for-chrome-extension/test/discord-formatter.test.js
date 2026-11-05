'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const formatDiscord = require(path.join(
  __dirname, '..', '..', '..', 'accessibility-tree-formatters', 'discord', 'discord.js'
));
const { Builder, FRIENDS, SHOP, NITRO, QUESTS } = require('./fixtures/discord/build.js');

// --- Fixture assembly --------------------------------------------------------

// Fills the sidebar with every server/folder variant. Returns the clickable
// (focusable) node of each server, keyed by label, plus the folder treeitems.
function fillSidebar(b, sb) {
  const f = {};
  f.alpha = b.server(sb.servers, 'Alpha Guild');
  f.beta = b.server(sb.servers, 'Beta \u{1F47B} Crew', { prefix: 'Unread messages, ' });
  f.gamma = b.server(sb.servers, 'Gamma Hub', { prefix: '3 mentions, ', mentions: 3 });
  f.delta = b.server(sb.servers, 'Delta Den', { prefix: '1 mention, ', mentions: 1 });
  f.voice = b.server(sb.servers, 'Epsilon Voice', {
    prefix: 'Unread messages, ',
    suffix: ', Screenshare active Voice call active',
  });
  b.utilityButtons(sb.servers);

  f.games = b.folder(sb.servers, { text: 'Games, folder , 2 unread mentions', expanded: false });
  f.money = b.folder(sb.servers, {
    text: '$Money, folder , 7 unread mentions',
    accName: '$Money, folder , 7 unread mentions $Money',
    expanded: true,
    children: [
      ['{ we build }'],
      ['Fresno Fake Tech', { prefix: 'Unread messages, ' }],
      ['Other Server'],
    ],
  });
  // `expanded` property lags behind: children are visible, property says false
  f.lag = b.folder(sb.servers, {
    text: 'Lagging, folder',
    expanded: false,
    children: [['Lag Child']],
  });
  // property says expanded but nothing is rendered
  f.stale = b.folder(sb.servers, { text: 'Stale, folder', expanded: true, showGroup: false });
  f.unnamed = b.folder(sb.servers, {
    text: 'Aaa Guild, Bbb Guild, Ccc Guild, ..., folder',
    expanded: false,
  });
  f.tail = b.server(sb.servers, 'Zeta Tail');
  return f;
}

const DM_LINKS = [
  { name: 'unread, Alice Example (direct message), Idle' },
  { name: 'Bob Example (direct message), Online' },
  { name: 'Carol Example (direct message), Do Not Disturb' },
  { name: 'Dave Example (direct message)' },
  { name: '2 (direct message)' },
  { name: 'Study Group (group message), 3 Members' },
  { name: 'unread, Quiet Group (group message), 4 Members, Muted' },
];

function dmListNodes(opts) {
  opts = opts || {};
  const b = new Builder('https://discord.com/channels/@me', '(3) Discord | Friends');
  const sb = b.sidebar({ dmBadges: opts.badges });
  const refs = fillSidebar(b, sb);
  const nav = b.add(b.root, 'navigation', 'Direct Messages');
  const navLinks = b.navLinks(nav, [FRIENDS, SHOP, NITRO, QUESTS]);
  const dms = b.dmLinks(nav, DM_LINKS);
  const search = b.add(b.root, 'searchbox', 'Find or start a conversation');
  if (opts.popup) b.promoDialog(b.root, opts.popup);
  return { nodes: b.build(), refs: refs, navLinks: navLinks, dms: dms, search: search };
}

function dmConversationNodes(opts) {
  opts = opts || {};
  const b = new Builder('https://discord.com/channels/@me/900000000000000099', 'Discord | @alice');
  const sb = b.sidebar({ dmBadges: ['Alice Example , 2 unread messages', 'Bob Example , 3 unread messages'] });
  const refs = fillSidebar(b, sb);
  const nav = b.add(b.root, 'navigation', 'Direct Messages');
  const navLinks = b.navLinks(nav, [FRIENDS, SHOP, NITRO, QUESTS]);
  const dms = b.dmLinks(nav, DM_LINKS);
  const tb = b.add(b.root, 'textbox', 'Message @alice');
  if (opts.popup) b.promoDialog(b.root, opts.popup);
  return { nodes: b.build(), refs: refs, navLinks: navLinks, dms: dms, textbox: tb };
}

function serverChannelNodes(opts) {
  opts = opts || {};
  const b = new Builder('https://discord.com/channels/800000000000000001/800000000000000002', 'general | Alpha Guild');
  const sb = b.sidebar();
  const refs = fillSidebar(b, sb);
  const chanNav = b.add(b.root, 'navigation', 'Alpha Guild (server)');
  const list = b.add(chanNav, 'list', 'Channels');
  const catItem = b.add(list, 'listitem', '');
  const catBtn = b.add(catItem, 'button', 'INFO (category)');
  b.add(catBtn, 'heading', 'INFO');
  const chItem = b.add(list, 'listitem', '');
  const chLink = b.add(chItem, 'link', 'general (text channel)', {
    props: { focusable: true, url: 'https://discord.com/channels/800000000000000001/800000000000000002' },
  });
  if (opts.popup) b.promoDialog(b.root, opts.popup);
  return { nodes: b.build(), refs: refs, chLink: chLink };
}

function unknownNodes(opts) {
  opts = opts || {};
  const b = new Builder('https://discord.com/store', 'Discord | Store');
  const sb = b.sidebar();
  const refs = fillSidebar(b, sb);
  if (opts.pageLink) {
    b.add(b.root, 'link', opts.pageLink, { props: { focusable: true, url: 'https://discord.com/store/skus/1' } });
  }
  if (opts.popup) b.promoDialog(b.root, opts.popup);
  return { nodes: b.build(), refs: refs };
}

function section(tree, header) {
  const lines = tree.split('\n');
  const start = lines.indexOf('--- ' + header + ' ---');
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length && lines[i] !== '' && !/^--- /.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

function backendOf(result, ref) {
  return result.refs[ref];
}

// --- Tests -------------------------------------------------------------------

describe('discord formatter: Servers section', () => {
  const fx = dmListNodes();
  const result = formatDiscord(fx.nodes);
  const byName = {};
  result.servers.forEach((s) => { byName[s.name] = s; });

  test('plain, unread, mentions (plural and singular) and voice servers', () => {
    assert.deepStrictEqual(byName['Alpha Guild'], {
      name: 'Alpha Guild', ref: byName['Alpha Guild'].ref, mentions: 0, unread: false, inFolder: null,
    });
    assert.strictEqual(byName['Beta \u{1F47B} Crew'].unread, true);
    assert.strictEqual(byName['Beta \u{1F47B} Crew'].mentions, 0);
    assert.strictEqual(byName['Gamma Hub'].mentions, 3);
    assert.strictEqual(byName['Gamma Hub'].unread, true);
    assert.strictEqual(byName['Delta Den'].mentions, 1);
    assert.strictEqual(byName['Delta Den'].unread, true);
    // voice suffix is stripped from the display name
    assert.ok(byName['Epsilon Voice']);
    assert.strictEqual(byName['Epsilon Voice'].unread, true);

    const lines = section(result.tree, 'Servers');
    assert.ok(lines.some((l) => /Alpha Guild$/.test(l)));
    assert.ok(lines.some((l) => /Beta \u{1F47B} Crew \(unread\)$/u.test(l)));
    assert.ok(lines.some((l) => /Gamma Hub \(3 mentions\)$/.test(l)));
    assert.ok(lines.some((l) => /Delta Den \(1 mention\)$/.test(l)));
    assert.ok(lines.some((l) => /Epsilon Voice \(unread, voice active\)$/.test(l)));
  });

  test('refs point at the focusable generic, not the StaticText', () => {
    const map = {
      'Alpha Guild': fx.refs.alpha, 'Gamma Hub': fx.refs.gamma, 'Epsilon Voice': fx.refs.voice,
    };
    Object.keys(map).forEach((n) => {
      assert.strictEqual(backendOf(result, byName[n].ref), map[n].backendDOMNodeId, n);
    });
    const alphaText = fx.nodes.find((n) => n.role.value === 'StaticText' && n.name.value === 'Alpha Guild');
    assert.notStrictEqual(backendOf(result, byName['Alpha Guild'].ref), alphaText.backendDOMNodeId);
  });

  test('Add a Server, Discover, Download Apps, NEW and the home icon are excluded', () => {
    const names = result.servers.map((s) => s.name);
    ['Add a Server', 'Discover', 'Download Apps', 'NEW', 'Direct Messages'].forEach((n) => {
      assert.ok(!names.includes(n), n);
    });
    const folderNames = result.folders.map((f) => f.name);
    assert.ok(!folderNames.includes('NEW'));
  });

  test('folders: collapsed with mentions, expanded with children, unnamed, lagging property', () => {
    const folders = {};
    result.folders.forEach((f) => { folders[f.name] = f; });
    assert.deepStrictEqual(folders['Games'], {
      name: 'Games', ref: folders['Games'].ref, expanded: false, mentions: 2,
    });
    assert.strictEqual(folders['$Money'].expanded, true);
    assert.strictEqual(folders['$Money'].mentions, 7);
    // children visible but property says expanded=false -> expanded
    assert.strictEqual(folders['Lagging'].expanded, true);
    // property says expanded=true but no children rendered -> collapsed
    assert.strictEqual(folders['Stale'].expanded, false);
    const unnamed = result.folders.find((f) => /^\(unnamed:/.test(f.name));
    assert.strictEqual(unnamed.name, '(unnamed: Aaa Guild, Bbb Guild, Ccc Guild…)');
    assert.strictEqual(unnamed.expanded, false);

    assert.strictEqual(backendOf(result, folders['Games'].ref), fx.refs.games.backendDOMNodeId);
    assert.strictEqual(backendOf(result, folders['$Money'].ref), fx.refs.money.backendDOMNodeId);

    assert.strictEqual(byName['{ we build }'].inFolder, '$Money');
    assert.strictEqual(byName['Fresno Fake Tech'].inFolder, '$Money');
    assert.strictEqual(byName['Fresno Fake Tech'].unread, true);
    assert.strictEqual(byName['Other Server'].inFolder, '$Money');
    assert.strictEqual(byName['Lag Child'].inFolder, 'Lagging');
    assert.strictEqual(byName['Zeta Tail'].inFolder, null);

    const lines = section(result.tree, 'Servers');
    assert.ok(lines.some((l) => /Folder: Games \(collapsed, 2 mentions\)$/.test(l)));
    assert.ok(lines.some((l) => /Folder: \$Money \(expanded, 7 mentions\)$/.test(l)));
    assert.ok(lines.some((l) => /Folder: \(unnamed: Aaa Guild, Bbb Guild, Ccc Guild…\) \(collapsed\)$/.test(l)));
    assert.ok(lines.some((l) => /^ {2}\[e\d+\] \{ we build \}$/.test(l)));
    assert.ok(lines.some((l) => /^ {2}\[e\d+\] Fresno Fake Tech \(unread\)$/.test(l)));
  });

  test('serverCount counts servers (children included, folders excluded) and each once', () => {
    // 5 top-level + 3 in $Money + 1 in Lagging + 1 tail
    assert.strictEqual(result.serverCount, 10);
    assert.strictEqual(result.servers.length, 10);
    const names = result.servers.map((s) => s.name);
    assert.strictEqual(new Set(names).size, names.length);
    const backends = result.servers.map((s) => result.refs[s.ref]);
    assert.strictEqual(new Set(backends).size, backends.length);
    assert.strictEqual(result.folders.length, 5);
  });

  test('extras have exactly the documented server and folder fields', () => {
    result.servers.forEach((s) => {
      assert.deepStrictEqual(Object.keys(s).sort(), ['inFolder', 'mentions', 'name', 'ref', 'unread']);
      assert.strictEqual(typeof s.ref, 'string');
      assert.strictEqual(typeof s.mentions, 'number');
      assert.strictEqual(typeof s.unread, 'boolean');
    });
    result.folders.forEach((f) => {
      assert.deepStrictEqual(Object.keys(f).sort(), ['expanded', 'mentions', 'name', 'ref']);
    });
  });

  test('no node receives two refs', () => {
    const backends = Object.values(result.refs);
    assert.strictEqual(new Set(backends).size, backends.length);
  });

  test('empty sidebar prints (No servers found)', () => {
    const b = new Builder('https://discord.com/channels/@me', 'Discord');
    b.sidebar();
    const r = formatDiscord(b.build());
    assert.ok(r.tree.includes('--- Servers ---\n(No servers found)'));
    assert.strictEqual(r.serverCount, 0);
    assert.deepStrictEqual(r.servers, []);
    assert.deepStrictEqual(r.folders, []);
  });

  test('missing sidebar entirely prints (No servers found)', () => {
    const b = new Builder('https://discord.com/channels/@me', 'Discord');
    const r = formatDiscord(b.build());
    assert.ok(r.tree.includes('(No servers found)'));
  });
});

describe('discord formatter: every page type gets a Servers section', () => {
  const cases = [
    ['dm_list', dmListNodes()],
    ['dm_conversation', dmConversationNodes()],
    ['server_channel', serverChannelNodes()],
    ['unknown', unknownNodes()],
  ];
  cases.forEach(function (c) {
    test(c[0], () => {
      const r = formatDiscord(c[1].nodes);
      assert.strictEqual(r.pageType, c[0]);
      assert.ok(r.tree.includes('--- Servers ---'));
      assert.strictEqual(r.serverCount, 10);
      assert.strictEqual(r.folders.length, 5);
      const names = r.servers.map((s) => s.name);
      assert.strictEqual(new Set(names).size, names.length);
      const backends = Object.values(r.refs);
      assert.strictEqual(new Set(backends).size, backends.length, 'a node got two refs');
      // Servers is the last section, after all page content
      const headers = r.tree.split('\n').filter((l) => /^--- .* ---$/.test(l));
      assert.strictEqual(headers[headers.length - 1], '--- Servers ---');
    });
  });

  test('server_channel: sidebar nodes do not leak into Channels, old section is gone', () => {
    const fx = serverChannelNodes();
    const r = formatDiscord(fx.nodes);
    assert.ok(!r.tree.includes('Server Notifications'));
    const channels = section(r.tree, 'Channels');
    assert.ok(channels, 'Channels section expected');
    assert.ok(channels.some((l) => /general/.test(l)));
    channels.forEach((l) => {
      assert.ok(!/folder|Games|\$Money|Gamma Hub|Alpha Guild$/.test(l), l);
    });
    assert.strictEqual(r.channelCount, 2); // category + one channel
    const chRef = channels.find((l) => /general/.test(l)).match(/\[(e\d+)\]/)[1];
    assert.strictEqual(r.refs[chRef], fx.chLink.backendDOMNodeId);
  });

  test('sidebar sections come after the existing content so content refs stay stable', () => {
    const fx = dmListNodes();
    const r = formatDiscord(fx.nodes);
    // 7 DMs then the search box take e1..e8; sidebar refs start after that
    const dmRefs = r.dms.map((d) => Number(d.ref.slice(1)));
    assert.deepStrictEqual(dmRefs, [1, 2, 3, 4, 5, 6, 7]);
    const firstSidebarRef = Math.min.apply(null, r.servers.map((s) => Number(s.ref.slice(1))));
    assert.ok(firstSidebarRef > 8);
    assert.ok(r.tree.indexOf('--- DM Conversations ---') < r.tree.indexOf('--- Navigation ---'));
    assert.ok(r.tree.indexOf('--- Navigation ---') < r.tree.indexOf('--- Servers ---'));
  });
});

describe('discord formatter: navigation links and DMs', () => {
  const fx = dmListNodes({ badges: ['Alice Example , 2 unread messages', 'Bob Example , 1 unread message'] });
  const r = formatDiscord(fx.nodes);

  test('nav links appear under Navigation, not in DMs', () => {
    const nav = section(r.tree, 'Navigation');
    assert.strictEqual(nav.length, 4);
    assert.ok(/^\[e\d+\] Shop \(new\)$/.test(nav.find((l) => /Shop/.test(l))));
    assert.ok(nav.some((l) => /^\[e\d+\] Friends$/.test(l)));
    assert.ok(nav.some((l) => /^\[e\d+\] Nitro Home$/.test(l)));
    assert.ok(nav.some((l) => /^\[e\d+\] Quests$/.test(l)));
    const dmSection = section(r.tree, 'DM Conversations').join('\n');
    ['Friends', 'Shop', 'Nitro', 'Quests'].forEach((n) => assert.ok(!dmSection.includes(n), n));
    // refs target the links
    const friendsRef = nav.find((l) => /Friends/.test(l)).match(/\[(e\d+)\]/)[1];
    assert.strictEqual(r.refs[friendsRef], fx.navLinks[0].backendDOMNodeId);
  });

  test('dmCount equals dms.length and excludes nav links', () => {
    assert.strictEqual(r.dmCount, 7);
    assert.strictEqual(r.dms.length, r.dmCount);
  });

  test('1:1, group, muted, unread, offline and numeric-named DMs', () => {
    const d = {};
    r.dms.forEach((x) => { d[x.name] = x; });
    assert.deepStrictEqual(Object.keys(r.dms[0]).sort(),
      ['members', 'muted', 'name', 'ref', 'status', 'type', 'unread']);
    assert.deepStrictEqual(
      { t: d['Alice Example'].type, s: d['Alice Example'].status, u: d['Alice Example'].unread, m: d['Alice Example'].members, mu: d['Alice Example'].muted },
      { t: 'dm', s: 'idle', u: true, m: null, mu: false }
    );
    assert.strictEqual(d['Bob Example'].status, 'online');
    assert.strictEqual(d['Bob Example'].unread, false);
    assert.strictEqual(d['Carol Example'].status, 'dnd');
    assert.strictEqual(d['Dave Example'].status, null);
    assert.strictEqual(d['2'].type, 'dm');
    assert.strictEqual(d['2'].unread, false);
    assert.strictEqual(d['Study Group'].type, 'group');
    assert.strictEqual(d['Study Group'].members, 3);
    assert.strictEqual(d['Study Group'].muted, false);
    assert.strictEqual(d['Quiet Group'].type, 'group');
    assert.strictEqual(d['Quiet Group'].members, 4);
    assert.strictEqual(d['Quiet Group'].muted, true);
    assert.strictEqual(d['Quiet Group'].unread, true);
    assert.strictEqual(r.refs[d['Bob Example'].ref], fx.dms[1].backendDOMNodeId);
    const lines = section(r.tree, 'DM Conversations');
    assert.ok(lines.some((l) => /Alice Example \(unread\)$/.test(l)));
    assert.ok(lines.some((l) => /\] 2$/.test(l)));
  });

  test('totalUnread sums the DM badge group', () => {
    assert.strictEqual(r.totalUnread, 3);
  });

  test('totalUnread is 0 without a badge group', () => {
    const none = formatDiscord(dmListNodes().nodes);
    assert.strictEqual(none.totalUnread, 0);
  });

  test('dm_conversation exposes dms, dmCount, totalUnread and Navigation', () => {
    const fxc = dmConversationNodes();
    const rc = formatDiscord(fxc.nodes);
    assert.strictEqual(rc.pageType, 'dm_conversation');
    assert.strictEqual(rc.dmCount, 7);
    assert.strictEqual(rc.dms.length, 7);
    assert.strictEqual(rc.totalUnread, 5);
    assert.ok(rc.tree.includes('--- Navigation ---'));
    const unreadSection = section(rc.tree, 'Unread DMs');
    assert.strictEqual(unreadSection.length, 2);
    assert.ok(!rc.tree.includes('Server Notifications'));
  });

  test('non-@me pages have no Navigation or DM extras', () => {
    const rs = formatDiscord(serverChannelNodes().nodes);
    assert.ok(!rs.tree.includes('--- Navigation ---'));
    assert.strictEqual(rs.dms, undefined);
  });
});

describe('discord formatter: unknown page fallback', () => {
  test('sidebar-only unknown page still gets --- Elements ---', () => {
    // a content link that is not part of the sidebar
    const b = new Builder('https://discord.com/store', 'Discord | Store');
    const sb = b.sidebar();
    fillSidebar(b, sb);
    b.add(b.root, 'link', 'Browse Orbs', { props: { focusable: true, url: 'https://discord.com/shop' } });
    b.add(b.root, 'button', 'Buy Now', { props: { focusable: true } });
    const r = formatDiscord(b.build());
    assert.strictEqual(r.pageType, 'unknown');
    assert.ok(r.tree.includes('--- Elements ---'));
    assert.ok(/\[e1\] button: Buy Now/.test(r.tree));
    // the shop nav link is the sidebar's, so it is not listed twice
    assert.ok(!/link: Browse Orbs/.test(r.tree));
    assert.ok(r.tree.includes('--- Servers ---'));
    const backends = Object.values(r.refs);
    assert.strictEqual(new Set(backends).size, backends.length);
  });
});

describe('discord formatter: performance', () => {
  test('large sidebar formats quickly', () => {
    const b = new Builder('https://discord.com/channels/@me', 'Discord');
    const sb = b.sidebar();
    for (let i = 0; i < 300; i++) b.server(sb.servers, 'Server ' + i, { prefix: i % 3 ? '' : 'Unread messages, ' });
    const links = [];
    for (let i = 0; i < 200; i++) links.push({ name: 'User ' + i + ' (direct message)' });
    b.dmLinks(b.root, links);
    const t = Date.now();
    const r = formatDiscord(b.build());
    assert.ok(Date.now() - t < 1000);
    assert.strictEqual(r.serverCount, 300);
    assert.strictEqual(r.dmCount, 200);
  });
});

// --- Member list toggle and totals -------------------------------------------

// Server channel page with an optional channel header toggle and members
// panel. opts: { toggle: 'Show'|'Hide'|null, noBackend, groups, decoy }
function memberListPage(opts) {
  opts = opts || {};
  const b = new Builder('https://discord.com/channels/800000000000000001/800000000000000002', 'general | Alpha Guild');
  const sb = b.sidebar();
  fillSidebar(b, sb);
  let decoy = null;
  if (opts.decoy) decoy = b.add(sb.nav, 'button', 'Show Member List', { props: { focusable: true } });
  const header = b.channelHeader(b.root, { toggle: opts.toggle, noBackend: opts.noBackend });
  const panel = opts.groups ? b.membersPanel(b.root, opts.groups) : null;
  return { nodes: b.build(), header: header, panel: panel, decoy: decoy };
}

const TWO_GROUPS = [
  { name: 'Owner', count: 1, members: [['Alice', 'Online']] },
  { name: 'Online', count: 40, members: [['Bob', 'Idle'], ['Carol', 'Do Not Disturb']] },
];

describe('discord formatter: member list toggle and totals', () => {
  test('panel closed: Show line, memberListOpen false, ref resolves, no totals', () => {
    const fx = memberListPage({ toggle: 'Show' });
    const r = formatDiscord(fx.nodes);
    assert.strictEqual(r.pageType, 'server_channel');
    assert.strictEqual(r.memberListOpen, false);
    assert.match(r.memberListToggleRef, /^e\d+$/);
    assert.ok(r.tree.split('\n').includes('[' + r.memberListToggleRef + '] Show Member List (button)'));
    assert.strictEqual(r.refs[r.memberListToggleRef], fx.header.toggle.backendDOMNodeId);
    assert.strictEqual(r.memberCount, 0);
    assert.strictEqual(r.memberTotal, 0);
    assert.deepStrictEqual(r.groups, []);
    assert.ok(!r.tree.includes('--- Members ---'));
  });

  test('toggle line sits right after the header line', () => {
    const r = formatDiscord(memberListPage({ toggle: 'Show' }).nodes);
    const lines = r.tree.split('\n');
    assert.strictEqual(lines[0].split(' | ')[0], 'Discord');
    assert.match(lines[1], /^\[e\d+\] Show Member List \(button\)$/);
  });

  test('panel open: Hide line, totals from group headers, memberCount = rendered rows', () => {
    const fx = memberListPage({ toggle: 'Hide', groups: TWO_GROUPS });
    const r = formatDiscord(fx.nodes);
    assert.strictEqual(r.memberListOpen, true);
    assert.ok(r.tree.includes('[' + r.memberListToggleRef + '] Hide Member List (button)'));
    assert.strictEqual(r.refs[r.memberListToggleRef], fx.header.toggle.backendDOMNodeId);
    assert.deepStrictEqual(r.groups, [{ name: 'Owner', count: 1 }, { name: 'Online', count: 40 }]);
    assert.strictEqual(r.memberTotal, 41);
    assert.strictEqual(r.memberCount, 3);
    assert.ok(r.memberTotal > r.memberCount);
    const members = section(r.tree, 'Members');
    assert.ok(members.some((l) => /Bob \(Idle\)$/.test(l)));
  });

  test('singular "1 member" header is parsed', () => {
    const r = formatDiscord(memberListPage({
      toggle: 'Hide',
      groups: [{ name: 'Solo', count: 1, members: [['Dan', 'Online']] }],
    }).nodes);
    assert.deepStrictEqual(r.groups, [{ name: 'Solo', count: 1 }]);
    assert.strictEqual(r.memberTotal, 1);
  });

  test('role names with a comma or a slash keep the full name', () => {
    const r = formatDiscord(memberListPage({
      toggle: 'Hide',
      groups: [
        { name: 'Foo, Bar', count: 3, members: [['Eve', 'Online']] },
        { name: 'Gadget Maker / Partners', count: 1, members: [['Fay', 'Idle']] },
      ],
    }).nodes);
    assert.deepStrictEqual(r.groups, [
      { name: 'Foo, Bar', count: 3 },
      { name: 'Gadget Maker / Partners', count: 1 },
    ]);
    assert.strictEqual(r.memberTotal, 4);
  });

  test('a heading and its StaticText twin are counted once', () => {
    const fx = memberListPage({ toggle: 'Hide', groups: [{ name: 'Mods', count: 5 }] });
    const r = formatDiscord(fx.nodes);
    assert.deepStrictEqual(r.groups, [{ name: 'Mods', count: 5 }]);
    assert.strictEqual(r.memberTotal, 5);
    assert.strictEqual(r.tree.split('\n').filter((l) => l === '  Mods, 5 members').length, 1);
  });

  test('decoy Show Member List button in the server sidebar is ignored', () => {
    const fx = memberListPage({ toggle: 'Show', decoy: true });
    const r = formatDiscord(fx.nodes);
    assert.strictEqual(r.refs[r.memberListToggleRef], fx.header.toggle.backendDOMNodeId);
    assert.notStrictEqual(r.refs[r.memberListToggleRef], fx.decoy.backendDOMNodeId);
    // decoy alone: no toggle at all
    const r2 = formatDiscord(memberListPage({ decoy: true }).nodes);
    assert.strictEqual(r2.memberListToggleRef, null);
    assert.strictEqual(r2.memberListOpen, null);
  });

  test('toggle without a backendDOMNodeId does not throw', () => {
    const r = formatDiscord(memberListPage({ toggle: 'Show', noBackend: true }).nodes);
    assert.strictEqual(r.pageType, 'server_channel');
    assert.strictEqual(r.memberListToggleRef, null);
    assert.ok(!/Member List \(button\)/.test(r.tree));
  });

  test('no toggle and no members region: memberListOpen and ref are null', () => {
    const r = formatDiscord(memberListPage({}).nodes);
    assert.strictEqual(r.memberListOpen, null);
    assert.strictEqual(r.memberListToggleRef, null);
    assert.strictEqual(r.memberTotal, 0);
    assert.deepStrictEqual(r.groups, []);
  });

  test('no toggle but a members region infers open', () => {
    const r = formatDiscord(memberListPage({ groups: TWO_GROUPS }).nodes);
    assert.strictEqual(r.memberListOpen, true);
    assert.strictEqual(r.memberListToggleRef, null);
    assert.strictEqual(r.memberTotal, 41);
  });
});

// --- Blocking promo dialog (#156) --------------------------------------------

const PROMO = {
  headings: ['NEW IN THE SHOP: PROFILE FRAMES', 'Complete Your Look', 'Gift and Wishlist'],
  buttons: ['Browse Frames'],
};
const PROMO_INSTRUCTION = 'A modal dialog is covering the page. Clicking or running workflows on any '
  + 'other elements will not work until the dialog is closed. Close it by clicking [e1] Close, then '
  + 're-fetch the accessibility tree before doing anything else.';

function withPopupOpts(popup) {
  return { popup: Object.assign({}, PROMO, popup || {}) };
}

describe('discord formatter: blocking promo dialog', () => {
  const pages = [
    ['dm_list', dmListNodes],
    ['dm_conversation', dmConversationNodes],
    ['server_channel', serverChannelNodes],
    ['unknown', unknownNodes],
  ];

  pages.forEach(function (pg) {
    test(pg[0] + ': popup block renders first with Close as e1', () => {
      const r = formatDiscord(pg[1](withPopupOpts()).nodes);
      assert.strictEqual(r.pageType, pg[0]);
      const lines = r.tree.split('\n');
      assert.match(lines[0], /^Discord/);
      assert.strictEqual(lines[1], '--- BLOCKING POPUP: NEW IN THE SHOP: PROFILE FRAMES ---');
      assert.strictEqual(lines[2], PROMO_INSTRUCTION);
      const headers = lines.filter((l) => /^--- .* ---$/.test(l));
      assert.strictEqual(headers[0], '--- BLOCKING POPUP: NEW IN THE SHOP: PROFILE FRAMES ---');
      assert.ok(lines.includes('[e1] Close (button)'));
      assert.ok(lines.includes('[e2] Browse Frames (button)'));
      assert.ok(lines.includes('Headings: NEW IN THE SHOP: PROFILE FRAMES | Complete Your Look | Gift and Wishlist'));
      assert.strictEqual(r.hasBlockingDialog, true);
      assert.deepStrictEqual(r.blockingDialog, {
        name: 'NEW IN THE SHOP: PROFILE FRAMES',
        closeRef: 'e1',
        buttons: [{ ref: 'e1', text: 'Close' }, { ref: 'e2', text: 'Browse Frames' }],
        headings: ['NEW IN THE SHOP: PROFILE FRAMES', 'Complete Your Look', 'Gift and Wishlist'],
      });
      // Servers is still the last section
      assert.strictEqual(headers[headers.length - 1], '--- Servers ---');
    });

    test(pg[0] + ': no popup leaves the tree unchanged and flags false', () => {
      const r = formatDiscord(pg[1]().nodes);
      assert.strictEqual(r.hasBlockingDialog, false);
      assert.strictEqual(r.blockingDialog, undefined);
      assert.ok(!r.tree.includes('BLOCKING POPUP'));
      assert.strictEqual(r.tree.split('\n')[1], '');
    });
  });

  test('no popup: DM refs still start at e1', () => {
    const r = formatDiscord(dmListNodes().nodes);
    assert.deepStrictEqual(r.dms.map((d) => d.ref), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  });

  test('popup + server_channel: no node receives two refs, e1 is the Close button', () => {
    const fx = serverChannelNodes(withPopupOpts());
    const r = formatDiscord(fx.nodes);
    const backends = Object.values(r.refs);
    assert.strictEqual(new Set(backends).size, backends.length, 'a node got two refs');
    const closeNode = fx.nodes.find((n) => n.role.value === 'button' && n.name.value === 'Close');
    assert.strictEqual(r.refs.e1, closeNode.backendDOMNodeId);
  });

  test('named dialog keeps the existing --- <name> --- rendering, no blocking flag', () => {
    const r = formatDiscord(serverChannelNodes(withPopupOpts({ named: 'Jtonna' })).nodes);
    assert.ok(r.tree.split('\n').includes('--- Jtonna ---'));
    assert.strictEqual(r.hasBlockingDialog, false);
    assert.ok(!r.tree.includes('BLOCKING POPUP'));
  });

  test('unknown page: Elements fallback still fires when only popup refs exist', () => {
    const r = formatDiscord(unknownNodes(Object.assign({ pageLink: 'Some Store Item' }, withPopupOpts())).nodes);
    assert.strictEqual(r.hasBlockingDialog, true);
    const els = section(r.tree, 'Elements');
    assert.ok(els, 'Elements section expected');
    assert.ok(els.some((l) => /link: Some Store Item$/.test(l)));
    assert.ok(!els.some((l) => /Close|Browse Frames/.test(l)));
    const backends = Object.values(r.refs);
    assert.strictEqual(new Set(backends).size, backends.length);
  });

  const rejections = [
    ['dialog with a textbox', { textbox: true }],
    ['dialog with a tabpanel', { tabpanel: true }],
    ['dialog without a Close button', { withClose: false }],
    ['dialog nested under a named region', { wrapperNamedRegion: true }],
  ];
  rejections.forEach(function (c) {
    test('rejected: ' + c[0], () => {
      const r = formatDiscord(dmListNodes(withPopupOpts(c[1])).nodes);
      assert.strictEqual(r.hasBlockingDialog, false);
      assert.strictEqual(r.blockingDialog, undefined);
      assert.ok(!r.tree.includes('BLOCKING POPUP'));
    });
  });

  test('headings are optional: name falls back to Dialog, Headings line omitted', () => {
    const r = formatDiscord(dmListNodes({ popup: { headings: [], buttons: ['Got It'] } }).nodes);
    const lines = r.tree.split('\n');
    assert.strictEqual(lines[1], '--- BLOCKING POPUP: Dialog ---');
    assert.ok(lines.includes('[e1] Close (button)'));
    assert.ok(lines.includes('[e2] Got It (button)'));
    assert.ok(!lines.some((l) => /^Headings:/.test(l)));
    assert.strictEqual(r.blockingDialog.name, 'Dialog');
    assert.deepStrictEqual(r.blockingDialog.headings, []);
  });
});

// --- Server-only URLs (#157) -------------------------------------------------

const GUILD_URL = 'https://discord.com/channels/1';

// Server page whose URL may lack the channel segment. opts: { url, title,
// header: false | true | '<heading name>', main: bool, toggle, groups,
// invite (default true), noNames }. The channel list holds "general"
// (.../1/10, current, Invite child) and "build-general" (.../1/11).
function serverOnlyPage(opts) {
  opts = opts || {};
  const b = new Builder(opts.url || GUILD_URL, opts.title !== undefined ? opts.title : '(3) Discord | #general | Alpha Guild');
  const sb = b.sidebar();
  fillSidebar(b, sb);
  const chanNav = b.add(b.root, 'navigation', 'Alpha Guild (server)');
  const list = b.add(chanNav, 'list', 'Channels');
  const catItem = b.add(list, 'listitem', '');
  const catBtn = b.add(catItem, 'button', 'INFO (category)');
  b.add(catBtn, 'heading', 'INFO');
  const general = b.channelLink(list, 'general (text channel)', 'https://discord.com/channels/1/10', { invite: opts.invite !== false });
  const build = b.channelLink(list, 'build-general (text channel)', 'https://discord.com/channels/1/11');
  let header = null;
  if (opts.header) {
    header = b.channelHeader(b.root, {
      toggle: opts.toggle,
      heading: typeof opts.header === 'string' ? opts.header : undefined,
    });
  }
  if (opts.main) b.mainLandmark(b.root, 'general');
  const panel = opts.groups ? b.membersPanel(b.root, opts.groups) : null;
  return { nodes: b.build(), general: general, build: build, header: header, panel: panel };
}

describe('discord formatter: server-only URL routing', () => {
  test('server-only URL with a Channel header region routes to server_channel', () => {
    const r = formatDiscord(serverOnlyPage({ header: true }).nodes);
    assert.strictEqual(r.pageType, 'server_channel');
  });

  test('server-only URL with only a "(channel)" main landmark routes to server_channel', () => {
    const r = formatDiscord(serverOnlyPage({ main: true }).nodes);
    assert.strictEqual(r.pageType, 'server_channel');
  });

  test('server-only URL with no rendered channel stays unknown', () => {
    const r = formatDiscord(serverOnlyPage().nodes);
    assert.strictEqual(r.pageType, 'unknown');
  });

  test('server-only URL with a trailing slash routes the same way', () => {
    const r = formatDiscord(serverOnlyPage({ url: GUILD_URL + '/', header: true }).nodes);
    assert.strictEqual(r.pageType, 'server_channel');
  });

  test('full channel URL is unchanged', () => {
    assert.strictEqual(formatDiscord(serverChannelNodes().nodes).pageType, 'server_channel');
    const r = formatDiscord(serverOnlyPage({ url: 'https://discord.com/channels/1/10' }).nodes);
    assert.strictEqual(r.pageType, 'server_channel');
  });

  test('@me URLs are unchanged', () => {
    assert.strictEqual(formatDiscord(dmListNodes().nodes).pageType, 'dm_list');
    assert.strictEqual(formatDiscord(dmConversationNodes().nodes).pageType, 'dm_conversation');
  });
});

describe('discord formatter: serverId / channelId extras', () => {
  test('server-only page renders like a channel page and derives channelId', () => {
    const fx = serverOnlyPage({ header: true, main: true, toggle: 'Hide', groups: TWO_GROUPS });
    const r = formatDiscord(fx.nodes);
    const lines = r.tree.split('\n');
    assert.strictEqual(r.pageType, 'server_channel');
    assert.strictEqual(lines[0], 'Discord | Alpha Guild | #general');
    const channels = section(r.tree, 'Channels');
    assert.ok(channels, 'Channels section present');
    assert.ok(channels.some((l) => /\] general \(text channel\) \(current\)$/.test(l)));
    assert.strictEqual(r.serverId, '1');
    assert.strictEqual(r.channelId, '10');
    assert.strictEqual(r.memberListOpen, true);
    assert.ok(lines.includes('[' + r.memberListToggleRef + '] Hide Member List (button)'));
    assert.ok(r.tree.includes('--- Members ---'));
  });

  test('full channel URL: channelId is the URL second segment', () => {
    const r = formatDiscord(serverChannelNodes().nodes);
    assert.strictEqual(r.serverId, '800000000000000001');
    assert.strictEqual(r.channelId, '800000000000000002');
    const r2 = formatDiscord(serverOnlyPage({ url: 'https://discord.com/channels/1/11', header: true }).nodes);
    assert.strictEqual(r2.channelId, '11');
  });

  test('channelId derived from the main landmark when no header heading exists', () => {
    const r = formatDiscord(serverOnlyPage({ main: true, title: 'Discord' }).nodes);
    assert.strictEqual(r.pageType, 'server_channel');
    assert.strictEqual(r.channelId, '10');
  });

  test('channelId derived from the Invite to Channel child when no name source matches', () => {
    const r = formatDiscord(serverOnlyPage({ header: 'Alpha Guild', title: 'Discord' }).nodes);
    assert.strictEqual(r.pageType, 'server_channel');
    assert.strictEqual(r.channelId, '10');
  });

  test('channelId is null when nothing identifies the channel', () => {
    const r = formatDiscord(serverOnlyPage({ header: 'Alpha Guild', title: 'Discord', invite: false }).nodes);
    assert.strictEqual(r.pageType, 'server_channel');
    assert.strictEqual(r.serverId, '1');
    assert.strictEqual(r.channelId, null);
  });
});

describe('discord formatter: current channel match', () => {
  test('full URL: only the exact channel is current, not a name that contains it', () => {
    const fx = serverOnlyPage({ url: 'https://discord.com/channels/1/10', title: 'Discord | Alpha Guild | #general' });
    const r = formatDiscord(fx.nodes);
    const channels = section(r.tree, 'Channels');
    assert.ok(channels.some((l) => /\] general \(text channel\) \(current\)$/.test(l)));
    assert.ok(!channels.some((l) => /build-general.*\(current\)/.test(l)));
  });

  test('server-only URL: build-general is not marked current', () => {
    const r = formatDiscord(serverOnlyPage({ header: true }).nodes);
    const channels = section(r.tree, 'Channels');
    assert.ok(channels.some((l) => /\] general \(text channel\) \(current\)$/.test(l)));
    assert.ok(!channels.some((l) => /build-general.*\(current\)/.test(l)));
  });

  test('unread prefix and emoji do not stop the exact match', () => {
    const b = new Builder('https://discord.com/channels/1/12', 'Discord | Alpha Guild | #\u{1F44B}-welcome');
    const nav = b.add(b.root, 'navigation', 'Alpha Guild (server)');
    const list = b.add(nav, 'list', 'Channels');
    const cat = b.add(list, 'listitem', '');
    b.add(cat, 'button', 'INFO (category)');
    b.channelLink(list, 'unread, \u{1F44B}-welcome (text channel)', 'https://discord.com/channels/1/12');
    b.channelLink(list, '\u{1F44B}-welcome-archive (text channel)', 'https://discord.com/channels/1/13');
    const channels = section(formatDiscord(b.build()).tree, 'Channels');
    assert.strictEqual(channels.filter((l) => /\(current\)$/.test(l)).length, 1);
    assert.ok(channels.some((l) => /\u{1F44B}-welcome \(text channel\) \(current\)$/u.test(l)));
  });
});

// --- User ids via page resolvers (#161) ---------------------------------------

const ID_ALICE = '100000000000000001';
const ID_BOB = '100000000000000002';
const ID_CAROL = '100000000000000003';
const ID_DAVE = '100000000000000004';

function userPage(opts) {
  opts = opts || {};
  const b = new Builder('https://discord.com/channels/800000000000000001/800000000000000002', 'general | Alpha Guild');
  b.channelHeader(b.root, { toggle: 'Hide' });
  const msgs = b.messageList(b.root, 'general', opts.messages || [
    { author: 'Alice', time: '10:00 AM', parts: ['hello ', { mention: '@Bob' }, ' there'] },
    { author: 'Alice', time: '10:01 AM', followUp: true, parts: ['second'] },
    { author: 'Bob', time: '10:02 AM', parts: ['ping ', { mention: '@everyone' }, ' and ', { mention: '@here' }] },
  ]);
  const panel = b.membersPanel(b.root, [
    { name: 'Online', count: 2, members: [['Alice', 'Idle'], ['Bob', 'Online']] },
    { name: 'Offline', count: 1, members: [['Carol', null]] },
  ]);
  const dialog = opts.dialog ? b.profileDialog(b.root, 'Dave', 'dave.d', opts.dialog) : null;
  return { nodes: b.build(), msgs: msgs, panel: panel, dialog: dialog };
}

function dmUserPage(opts) {
  opts = opts || {};
  const b = new Builder('https://discord.com/channels/@me/900000000000000099', 'Discord | @Alice Example');
  const header = opts.noHeader ? null : b.dmHeader(b.root, 'Alice Example', 'alice.ex');
  const msgs = b.messageList(b.root, 'Alice Example', [
    { author: 'Alice Example', time: '9:00 AM', parts: ['hi'] },
  ]);
  const form = b.add(b.root, 'form', '');
  const composer = b.add(form, 'textbox', 'Message @Alice Example', { props: { focusable: true } });
  const dialog = opts.dialog ? b.profileDialog(b.root, 'Dave', 'dave.d', opts.dialog) : null;
  return { nodes: b.build(), header: header, msgs: msgs, composer: composer, dialog: dialog };
}

// Resolved values keyed like the formatter's requests, built from a
// backendNodeId -> user map (what the server's resolve pass produces).
function resolveWith(result, byBackend) {
  const out = {};
  for (const req of result.__resolve.requests) {
    if (Object.prototype.hasOwnProperty.call(byBackend, req.backendNodeId)) out[req.key] = byBackend[req.backendNodeId];
  }
  return out;
}

function user(id, username, globalName) {
  return {
    id: id,
    username: username === undefined ? null : username,
    globalName: globalName === undefined ? null : globalName,
  };
}

function lineRe(text) {
  return new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<e>/g, 'e\\d+') + '$');
}

describe('discord formatter: user id resolve hook', () => {
  test('__resolve is non-enumerable, base result has no markers and plain extras', () => {
    const r = formatDiscord(userPage().nodes);
    assert.ok(r.__resolve, 'hook present');
    assert.ok(!Object.keys(r).includes('__resolve'));
    assert.ok(!JSON.stringify(r).includes('\u0000'));
    assert.ok(!r.tree.includes('[user='));
    assert.deepStrictEqual(r.users, {});
    assert.strictEqual(r.usersResolved, false);
    assert.strictEqual(typeof r.__resolve.apply, 'function');
    for (const k of ['user', 'messageAuthor', 'mention', 'dmRecipient']) {
      assert.strictEqual(r.__resolve.resolvers[k], formatDiscord.pageResolvers[k].toString());
    }
    // spreading (what an old server does) drops the hook
    assert.ok(!('__resolve' in Object.assign({}, r)));
  });

  test('base tree text is unchanged by the feature', () => {
    const r = formatDiscord(userPage().nodes);
    const msgs = section(r.tree, 'Messages');
    assert.match(msgs[0], lineRe('[<e>] [<e>:Alice] (10:00 AM): hello @Bob there'));
    assert.match(msgs[1], lineRe('[<e>] Alice (10:01 AM): second'));
    assert.match(msgs[2], lineRe('[<e>] [<e>:Bob] (10:02 AM): ping @everyone and @here'));
    const tree = r.tree.split('\n');
    assert.ok(tree.some((l) => lineRe('  [<e>] Alice (Idle)').test(l)));
    assert.ok(tree.some((l) => lineRe('  [<e>] Carol').test(l)));
  });

  test('apply({}) returns the base tree, usersResolved true, no ids', () => {
    const r = formatDiscord(userPage().nodes);
    const a = r.__resolve.apply({});
    assert.strictEqual(a.tree, r.tree);
    assert.strictEqual(a.usersResolved, true);
    assert.deepStrictEqual(a.users, {});
    assert.ok(a.members.every((m) => m.userId === null));
    assert.ok(!('__resolve' in a));
    assert.strictEqual(r.__resolve.apply(null).tree, r.tree);
  });

  test('requests: one per member, message, user mention; none for @everyone/@here', () => {
    const fx = userPage();
    const r = formatDiscord(fx.nodes);
    const reqs = r.__resolve.requests;
    const byResolver = (n) => reqs.filter((q) => q.resolver === n);
    assert.strictEqual(byResolver('mention').length, 1);
    assert.strictEqual(byResolver('mention')[0].backendNodeId, fx.msgs.items[0].mentions[0].backendDOMNodeId);
    assert.deepStrictEqual(byResolver('messageAuthor').map((q) => q.backendNodeId),
      fx.msgs.items.map((it) => it.item.backendDOMNodeId));
    assert.deepStrictEqual(byResolver('user').map((q) => q.backendNodeId),
      fx.panel.items.map((li) => li.backendDOMNodeId));
    assert.strictEqual(new Set(reqs.map((q) => q.key)).size, reqs.length);
    reqs.forEach((q) => assert.deepStrictEqual(Object.keys(q).sort(), ['backendNodeId', 'key', 'resolver']));
  });

  test('resolved: member, message, follow-up and mention lines carry [user=ID]; refs unchanged', () => {
    const fx = userPage();
    const r = formatDiscord(fx.nodes);
    const [m1, m2, m3] = fx.msgs.items;
    const [pa, pb, pc] = fx.panel.items;
    const a = r.__resolve.apply(resolveWith(r, {
      [m1.item.backendDOMNodeId]: user(ID_ALICE, 'alice', 'Alice'),
      [m2.item.backendDOMNodeId]: user(ID_ALICE, 'alice', 'Alice'),
      [m3.item.backendDOMNodeId]: user(ID_BOB, 'bob', null),
      [m1.mentions[0].backendDOMNodeId]: user(ID_BOB),
      [pa.backendDOMNodeId]: user(ID_ALICE, 'alice', 'Alice'),
      [pb.backendDOMNodeId]: user(ID_BOB, 'bob', 'Bobby'),
      [pc.backendDOMNodeId]: user(ID_CAROL, 'carol', null),
    }));
    assert.deepStrictEqual(a.refs, r.refs);
    assert.strictEqual(a.elementCount, r.elementCount);
    const msgs = section(a.tree, 'Messages');
    assert.match(msgs[0], lineRe('[<e>] [<e>:Alice] [user=' + ID_ALICE + '] (10:00 AM): hello @Bob [user=' + ID_BOB + '] there'));
    assert.match(msgs[1], lineRe('[<e>] Alice [user=' + ID_ALICE + '] (10:01 AM): second'));
    assert.match(msgs[2], lineRe('[<e>] [<e>:Bob] [user=' + ID_BOB + '] (10:02 AM): ping @everyone and @here'));
    const lines = a.tree.split('\n');
    assert.ok(lines.includes('  [' + r.members[0].ref + '] Alice [user=' + ID_ALICE + '] (Idle)'));
    assert.ok(lines.includes('  [' + r.members[2].ref + '] Carol [user=' + ID_CAROL + ']'));
    assert.deepStrictEqual(a.members.map((m) => m.userId), [ID_ALICE, ID_BOB, ID_CAROL]);
    // the id-only mention entry does not erase the richer member entry
    assert.deepStrictEqual(a.users[ID_BOB], { id: ID_BOB, username: 'bob', globalName: 'Bobby' });
    assert.deepStrictEqual(Object.keys(a.users).sort(), [ID_ALICE, ID_BOB, ID_CAROL]);
    // base result untouched
    assert.ok(!r.tree.includes('[user='));
    assert.ok(r.members.every((m) => m.userId === null));
  });

  test('unresolved and invalid values render nothing', () => {
    const fx = userPage();
    const r = formatDiscord(fx.nodes);
    const a = r.__resolve.apply(resolveWith(r, {
      [fx.panel.items[0].backendDOMNodeId]: { id: '12345', username: 'x', globalName: null },
      [fx.panel.items[1].backendDOMNodeId]: null,
      [fx.panel.items[2].backendDOMNodeId]: { id: 1000000000000000 },
    }));
    assert.strictEqual(a.tree, r.tree);
    assert.deepStrictEqual(a.users, {});
  });

  test('members[].username comes from the avatar image without resolution', () => {
    const r = formatDiscord(userPage().nodes);
    assert.deepStrictEqual(r.members.map((m) => [m.name, m.username, m.status, m.userId]), [
      ['Alice', 'alice', 'Idle', null],
      ['Bob', 'bob', 'Online', null],
      ['Carol', 'carol', null, null],
    ]);
  });

  test('page text containing a marker sequence cannot inject a tag', () => {
    const fx = userPage({
      messages: [{ author: 'Mallory', time: '10:00 AM', parts: ['evil \u0000Um:e1\u0000 \u0000Uu:e5\u0000 text'] }],
    });
    const r = formatDiscord(fx.nodes);
    assert.ok(!JSON.stringify(r).includes('\u0000'));
    const all = {};
    for (const q of r.__resolve.requests) all[q.key] = user(ID_DAVE);
    const a = r.__resolve.apply(all);
    const line = section(a.tree, 'Messages')[0];
    assert.match(line, lineRe('[<e>] [<e>:Mallory] [user=' + ID_DAVE + '] (10:00 AM): evil Um:e1 Uu:e5 text'));
    assert.strictEqual(a.tree.split('[user=').length - 1, r.__resolve.requests.length);
  });

  test('mention as a direct article child (descendants order quirk) still tags the mention', () => {
    const fx = userPage({
      messages: [
        { author: 'Alice', time: '10:00 AM', parts: ['x'] },
        { author: 'Alice', time: '10:01 AM', followUp: true, mentionDirect: true, parts: ['yo ', { mention: '@Carol' }, ' end'] },
      ],
    });
    const r = formatDiscord(fx.nodes);
    const base = section(r.tree, 'Messages')[1];
    assert.ok(base.includes('@Carol'));
    const a = r.__resolve.apply(resolveWith(r, { [fx.msgs.items[1].mentions[0].backendDOMNodeId]: user(ID_CAROL) }));
    assert.strictEqual(section(a.tree, 'Messages')[1], base.replace('@Carol', '@Carol [user=' + ID_CAROL + ']'));
  });

  test('page with no taggable nodes has no hook but still has users extras', () => {
    const r = formatDiscord(dmListNodes().nodes);
    assert.strictEqual(r.__resolve, undefined);
    assert.deepStrictEqual(r.users, {});
    assert.strictEqual(r.usersResolved, false);
  });
});

describe('discord formatter: DM header and profile popout ids', () => {
  test('DM header: display (@username) from the header heading, tagged after the label', () => {
    const fx = dmUserPage();
    const r = formatDiscord(fx.nodes);
    assert.strictEqual(r.tree.split('\n')[0], 'Discord | Alice Example (@alice.ex) (DM)');
    assert.strictEqual(r.recipientUsername, 'alice.ex');
    assert.strictEqual(r.recipientDisplayName, 'Alice Example');
    assert.strictEqual(r.recipientId, null);
    const req = r.__resolve.requests.find((q) => q.key === 'dm');
    assert.strictEqual(req.resolver, 'dmRecipient');
    assert.strictEqual(req.backendNodeId, fx.header.button.backendDOMNodeId);
    const a = r.__resolve.apply({ dm: user(ID_ALICE, 'alice.ex', 'Alice Example') });
    assert.strictEqual(a.tree.split('\n')[0], 'Discord | Alice Example (@alice.ex) [user=' + ID_ALICE + '] (DM)');
    assert.strictEqual(a.recipientId, ID_ALICE);
    assert.deepStrictEqual(a.users[ID_ALICE], { id: ID_ALICE, username: 'alice.ex', globalName: 'Alice Example' });
  });

  test('DM without the header region keeps the title-based label and no dm request', () => {
    const r = formatDiscord(dmUserPage({ noHeader: true }).nodes);
    assert.strictEqual(r.tree.split('\n')[0], 'Discord | @Alice (DM)');
    assert.ok(!r.__resolve.requests.some((q) => q.key === 'dm'));
    assert.strictEqual(r.__resolve.apply({}).recipientId, null);
  });

  test('profile popout: profile extra, username, roles, textbox as message ref, tagged header', () => {
    const fx = userPage({ dialog: { roles: ['Mods', 'Helpers'] } });
    const r = formatDiscord(fx.nodes);
    const p = r.profile;
    assert.deepStrictEqual(Object.keys(p).sort(), ['closeRef', 'messageButtonRef', 'name', 'roles', 'userId', 'username']);
    assert.strictEqual(p.name, 'Dave');
    assert.strictEqual(p.username, 'dave.d');
    assert.strictEqual(p.userId, null);
    assert.deepStrictEqual(p.roles, ['Mods', 'Helpers']);
    assert.strictEqual(r.refs[p.messageButtonRef], fx.dialog.textbox.backendDOMNodeId);
    assert.strictEqual(p.closeRef, null);
    const lines = r.tree.split('\n');
    assert.ok(lines.includes("--- Dave's profile ---"));
    assert.ok(lines.includes('Roles: Mods, Helpers'));
    const req = r.__resolve.requests.find((q) => q.key === 'dialog');
    assert.strictEqual(req.resolver, 'user');
    assert.strictEqual(req.backendNodeId, fx.dialog.dialog.backendDOMNodeId);
    const a = r.__resolve.apply({ dialog: user(ID_DAVE, 'dave.d', 'Dave') });
    assert.ok(a.tree.split('\n').includes("--- Dave's profile [user=" + ID_DAVE + '] ---'));
    assert.strictEqual(a.profile.userId, ID_DAVE);
    assert.strictEqual(r.profile.userId, null);
  });

  test('profile popout: Message button wins over the textbox; Close button gives closeRef', () => {
    const fx = userPage({ dialog: { messageButton: true, close: true } });
    const r = formatDiscord(fx.nodes);
    assert.strictEqual(r.refs[r.profile.messageButtonRef], fx.dialog.messageButton.backendDOMNodeId);
    assert.strictEqual(r.refs[r.profile.closeRef], fx.dialog.closeBtn.backendDOMNodeId);
    assert.deepStrictEqual(r.profile.roles, []);
  });

  test('profile popout on a DM page: profile extra, composer is NOT the popout textbox', () => {
    const fx = dmUserPage({ dialog: {} });
    const r = formatDiscord(fx.nodes);
    assert.strictEqual(r.profile.username, 'dave.d');
    const composerLine = r.tree.split('\n').find((l) => / textbox$/.test(l));
    const ref = composerLine.match(/^\[(e\d+)\]/)[1];
    assert.strictEqual(r.refs[ref], fx.composer.backendDOMNodeId);
    assert.strictEqual(composerLine, '[' + ref + '] Message @Alice Example textbox');
  });

  test('settings and plain dialogs carry no profile', () => {
    assert.strictEqual(formatDiscord(userPage().nodes).profile, undefined);
    const b = new Builder('https://discord.com/channels/800000000000000001/800000000000000002', 'general | Alpha Guild');
    const d = b.add(b.root, 'dialog', 'Channel Settings', { props: { focusable: true } });
    b.add(d, 'tabpanel', 'Overview');
    b.add(d, 'textbox', 'Message @x', { props: { focusable: true } });
    const r2 = formatDiscord(b.build());
    assert.strictEqual(r2.profile, undefined);
    assert.ok(!r2.__resolve || !r2.__resolve.requests.some((q) => q.key === 'dialog'));
  });
});

// --- Page resolvers -----------------------------------------------------------

// Recompile from source text: proves each resolver is self-contained.
function compile(fn) {
  return new Function('return (' + fn.toString() + ')')();
}

// Fake DOM element whose fiber chain carries the given memoizedProps, from
// the element's own fiber (index 0) upward.
function fakeEl(propsChain, key) {
  let fiber = null;
  for (let i = propsChain.length - 1; i >= 0; i--) {
    fiber = { memoizedProps: propsChain[i], return: fiber };
  }
  const el = { className: 'x' };
  el[key || '__reactFiber$abc123'] = fiber;
  return el;
}

const R = {};
for (const k of ['user', 'messageAuthor', 'mention', 'dmRecipient']) R[k] = compile(formatDiscord.pageResolvers[k]);
const FULL = { id: ID_ALICE, username: 'alice', globalName: 'Alice', email: 'a@x.test', token: 'secret', avatar: 'h' };

describe('discord page resolvers', () => {
  test('pageResolvers is exported next to the formatter function', () => {
    assert.strictEqual(typeof formatDiscord, 'function');
    assert.deepStrictEqual(Object.keys(formatDiscord.pageResolvers).sort(), ['dmRecipient', 'mention', 'messageAuthor', 'user']);
  });

  test('user: finds props.user up the chain and returns only id/username/globalName', () => {
    const r = R.user.call(fakeEl([{}, { className: 'y' }, {}, { user: FULL }]));
    assert.deepStrictEqual(r, { id: ID_ALICE, username: 'alice', globalName: 'Alice' });
    assert.deepStrictEqual(Object.keys(r), ['id', 'username', 'globalName']);
  });

  test('user: accepts global_name and the legacy __reactInternalInstance$ key', () => {
    const r = R.user.call(fakeEl([{ author: { id: ID_BOB, username: 'bob', global_name: 'Bobby' } }], '__reactInternalInstance$zz'));
    assert.deepStrictEqual(r, { id: ID_BOB, username: 'bob', globalName: 'Bobby' });
  });

  test('user: message.author is used when there is no user prop', () => {
    assert.strictEqual(R.user.call(fakeEl([{ message: { author: { id: ID_BOB } } }])).id, ID_BOB);
  });

  test('null: no fiber key, non-snowflake id, throwing getter, cyclic and too-deep chains', () => {
    assert.strictEqual(R.user.call({ foo: 1 }), null);
    assert.strictEqual(R.user.call(fakeEl([{ user: { id: '12345' } }])), null);
    assert.strictEqual(R.user.call(fakeEl([{ user: { id: 100000000000000001 } }])), null);
    const throwing = {};
    Object.defineProperty(throwing, 'user', { get() { throw new Error('boom'); } });
    Object.defineProperty(throwing, 'message', { get() { throw new Error('boom'); } });
    for (const k of Object.keys(R)) assert.strictEqual(R[k].call(fakeEl([throwing])), null, k);
    const cyc = { memoizedProps: {}, return: null };
    cyc.return = cyc;
    for (const k of Object.keys(R)) assert.strictEqual(R[k].call({ __reactFiber$q: cyc }), null, k);
    const deep = [];
    for (let i = 0; i < 26; i++) deep.push({});
    deep.push({ user: FULL });
    for (const k of Object.keys(R)) assert.strictEqual(R[k].call(fakeEl(deep)), null, k);
    assert.strictEqual(R.user.call(fakeEl(deep.slice(2))).id, ID_ALICE);
  });

  test('messageAuthor: prefers message.author over user; rejects system messages', () => {
    const chain = [{}, {}, { user: { id: ID_BOB }, message: { type: 0, author: FULL } }];
    assert.deepStrictEqual(R.messageAuthor.call(fakeEl(chain)), { id: ID_ALICE, username: 'alice', globalName: 'Alice' });
    assert.strictEqual(R.messageAuthor.call(fakeEl([{ message: { type: 19, author: FULL } }])).id, ID_ALICE);
    assert.strictEqual(R.messageAuthor.call(fakeEl([{ message: { author: FULL } }])).id, ID_ALICE);
    assert.strictEqual(R.messageAuthor.call(fakeEl([{ message: { type: 7, author: FULL } }, { user: { id: ID_BOB } }])), null);
  });

  test('mention: userId gives an id-only user, user prop gives the full one', () => {
    assert.deepStrictEqual(R.mention.call(fakeEl([{}, { userId: ID_BOB }])), { id: ID_BOB, username: null, globalName: null });
    assert.deepStrictEqual(R.mention.call(fakeEl([{}, { user: FULL, currentUser: { id: ID_DAVE } }])),
      { id: ID_ALICE, username: 'alice', globalName: 'Alice' });
  });

  test('mention: stops at the message fiber, never returns the message author', () => {
    assert.strictEqual(R.mention.call(fakeEl([{}, { userId: null }, { message: { author: FULL } }, { user: FULL }])), null);
    assert.strictEqual(R.mention.call(fakeEl([{}, { message: { author: FULL }, user: FULL }])), null);
  });

  test('mention: gives up after 10 levels', () => {
    const chain = [];
    for (let i = 0; i < 10; i++) chain.push({});
    chain.push({ userId: ID_BOB });
    assert.strictEqual(R.mention.call(fakeEl(chain)), null);
  });

  test('dmRecipient: user prop, single raw recipient, single recipient id; null for group DMs', () => {
    assert.strictEqual(R.dmRecipient.call(fakeEl([{ user: FULL }])).id, ID_ALICE);
    assert.deepStrictEqual(R.dmRecipient.call(fakeEl([{}, { channel: { rawRecipients: [FULL], recipients: [ID_ALICE] } }])),
      { id: ID_ALICE, username: 'alice', globalName: 'Alice' });
    assert.deepStrictEqual(R.dmRecipient.call(fakeEl([{ channel: { recipients: [ID_BOB] } }])),
      { id: ID_BOB, username: null, globalName: null });
    assert.strictEqual(R.dmRecipient.call(fakeEl([{ channel: { recipients: [ID_BOB, ID_CAROL] } }])), null);
  });

  test('resolver sources reference nothing outside themselves', () => {
    for (const k of Object.keys(formatDiscord.pageResolvers)) {
      const src = formatDiscord.pageResolvers[k].toString();
      assert.ok(!/require|module|PAGE_RESOLVERS|SNOWFLAKE_RE|localStorage|document|window|eval|content/.test(src), k);
    }
  });
});
