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
  return { nodes: b.build(), refs: refs, navLinks: navLinks, dms: dms, search: search };
}

function dmConversationNodes() {
  const b = new Builder('https://discord.com/channels/@me/900000000000000099', 'Discord | @alice');
  const sb = b.sidebar({ dmBadges: ['Alice Example , 2 unread messages', 'Bob Example , 3 unread messages'] });
  const refs = fillSidebar(b, sb);
  const nav = b.add(b.root, 'navigation', 'Direct Messages');
  const navLinks = b.navLinks(nav, [FRIENDS, SHOP, NITRO, QUESTS]);
  const dms = b.dmLinks(nav, DM_LINKS);
  const tb = b.add(b.root, 'textbox', 'Message @alice');
  return { nodes: b.build(), refs: refs, navLinks: navLinks, dms: dms, textbox: tb };
}

function serverChannelNodes() {
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
  return { nodes: b.build(), refs: refs, chLink: chLink };
}

function unknownNodes() {
  const b = new Builder('https://discord.com/store', 'Discord | Store');
  const sb = b.sidebar();
  const refs = fillSidebar(b, sb);
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
