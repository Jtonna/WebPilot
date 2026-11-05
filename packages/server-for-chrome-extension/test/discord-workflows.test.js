'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const DIR = path.join(__dirname, '..', '..', '..', 'accessibility-tree-formatters', 'discord');
const workflows = require(path.join(DIR, 'workflows.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

const TAB = 7;
// Mirrors PENDING_MESSAGE in workflows.js (not exported).
const PENDING_MESSAGE =
  'Timed out waiting for Discord; a late click may still apply — re-read state ' +
  '(e.g. call check_sidebar or get the tree) before retrying.';
const GUILD_URL = (g, c) =>
  c === undefined ? `https://discord.com/channels/${g}` : `https://discord.com/channels/${g}/${c}`;

/**
 * Stateful fake of the browser primitives. Refs embed a fetch generation so a
 * click with a ref from an older fetch fails (as in the real extension).
 *
 * state: { url, pageType, serverName, servers:[{name, folder?, id?}],
 *          folders:[{name, expanded}], dms }
 * opts.onClick(target, state, env) may mutate state / throw.
 */
function makeEnv(state, opts = {}) {
  const env = { gen: 0, clicks: [], types: [], stale: [], fetches: 0, state };
  env.browser = {
    async getAccessibilityTree() {
      env.gen++;
      env.fetches++;
      const g = env.gen;
      const hidden = (s) => {
        const f = state.folders.find((x) => x.name === s.folder);
        return f && !f.expanded;
      };
      return {
        tree: '',
        pageType: state.pageType,
        serverName: state.serverName,
        serverCount: state.servers.filter((s) => !hidden(s)).length,
        servers: state.servers.filter((s) => !hidden(s)).map((s, i) => ({
          name: s.name,
          ref: s.noRef ? null : `g${g}-s-${s.name}`,
          mentions: 0,
          unread: false,
          inFolder: s.folder || null
        })),
        folders: state.folders.map((f) => ({
          name: f.name,
          ref: `g${g}-f-${f.name}`,
          expanded: f.expanded,
          mentions: 0
        })),
        dms: state.dms || [],
        ...(state.channelId !== undefined ? { channelId: state.channelId } : {}),
        hasBlockingDialog: !!state.blocking,
        ...(state.blocking ? { blockingDialog: state.blocking } : {}),
        totalUnread: state.totalUnread === undefined ? null : state.totalUnread,
        ...memberFields(state, env, g),
        ...(state.profile ? { profile: state.profile } : {}),
        ...(state.users ? { users: state.users } : {})
      };
    },
    async type(args) {
      env.types.push(args);
    },
    ...(opts.resolveRefs
      ? {
          async resolveRefs(args) {
            env.resolveCalls = env.resolveCalls || [];
            env.resolveCalls.push({ ...args, fetchesAtCall: env.fetches });
            return opts.resolveRefs(args, state, env);
          }
        }
      : {}),
    async getTabs() {
      return [{ id: 1, url: 'https://example.com' }, { id: TAB, url: state.url }];
    },
    async click(args) {
      env.clicks.push(args);
      if (args.ref && !/^e\d+$/.test(args.ref)) {
        const m = /^g(\d+)-/.exec(args.ref);
        if (!m || Number(m[1]) !== env.gen) {
          env.stale.push(args.ref);
          throw new Error('stale ref ' + args.ref);
        }
      }
      if (opts.onClick) await opts.onClick(args, state, env);
    }
  };
  return env;
}

// Member-list fields of the fake tree. state.member = { open, count, total,
// toggleAfter } where the toggle is absent (and memberListOpen null) for the
// first `toggleAfter` fetches, like a toolbar that has not rendered yet.
function memberFields(state, env, g) {
  const m = state.member;
  if (!m) return {};
  const present = m.open || env.fetches > (m.toggleAfter || 0);
  return {
    memberListToggleRef: present ? `g${g}-member-toggle` : null,
    memberListOpen: m.open ? true : (present ? false : null),
    memberCount: m.open ? m.count || 0 : 0,
    memberTotal: m.open ? m.total || 0 : 0
  };
}

function run(name, env, params = {}, tabId = TAB) {
  return workflows[name].run({ params, browser: env.browser, tabId, findInTree: () => null });
}

function baseState(extra = {}) {
  return {
    url: 'https://discord.com/channels/@me',
    pageType: 'dm_list',
    serverName: undefined,
    servers: [],
    folders: [],
    dms: [],
    ...extra
  };
}

// Click handler: server click navigates; folder click expands.
function navClick(ids, { delay = 0, throws = false } = {}) {
  return async (args, state) => {
    const apply = () => {
      const ref = args.ref || '';
      const sm = /-s-(.*)$/.exec(ref);
      const fm = /-f-(.*)$/.exec(ref);
      if (sm) {
        const s = state.servers.find((x) => x.name === sm[1]);
        state.url = GUILD_URL(ids[s.name][0], ids[s.name][1]);
        state.serverName = s.name;
        state.pageType = 'server_channel';
      } else if (fm) {
        state.folders.find((f) => f.name === fm[1]).expanded = true;
      } else if (args.selector) {
        const name = args.selector.match(/data-dnd-name="(.*)"\]/)[1].replace(/\\(.)/g, '$1');
        const s = state.servers.find((x) => x.name === name);
        state.url = GUILD_URL(ids[s.name][0], ids[s.name][1]);
        state.serverName = s.name;
        state.pageType = 'server_channel';
      } else if (args.selector && args.selector.includes('guildsnav___home')) {
        state.pageType = 'dm_conversation';
      }
    };
    if (delay) setTimeout(apply, delay);
    else apply();
    if (throws) throw new Error('click timed out');
  };
}

// ---------------------------------------------------------------- registration

test('manifest and exports register the same workflows', () => {
  const declared = manifest.workflows.map((w) => w.name).sort();
  assert.deepStrictEqual(declared, Object.keys(workflows).sort());
  for (const w of manifest.workflows) {
    const impl = workflows[w.name];
    assert.strictEqual(typeof impl.description, 'string');
    assert.strictEqual(typeof impl.run, 'function');
    assert.ok(impl.parameters && typeof impl.parameters === 'object');
    assert.deepStrictEqual(Object.keys(impl.parameters).sort(), Object.keys(w.parameters).sort());
    for (const [k, v] of Object.entries(w.parameters)) {
      assert.strictEqual(impl.parameters[k].type, v.type, `${w.name}.${k} type`);
    }
    assert.strictEqual(impl.description, w.description);
  }
});

// ---------------------------------------------------------------- matching

const IDS = {
  'Alpha': ['1', '10'],
  'Alpha Beta': ['2', '20'],
  'Gamma': ['3', '30']
};

function serverState(names, extra = {}) {
  return baseState({
    servers: names.map((n) => (typeof n === 'string' ? { name: n } : n)),
    ...extra
  });
}

test('open_server: exact normalized match beats substring match', async () => {
  const st = serverState(['Alpha', 'Alpha Beta']);
  const env = makeEnv(st, { onClick: navClick(IDS) });
  const r = await run('open_server', env, { name: 'alpha', timeoutMs: 1000 });
  assert.strictEqual(r.name, 'Alpha');
  assert.strictEqual(r.serverId, '1');
  assert.strictEqual(r.channelId, '10');
  assert.strictEqual(r.verified, true);
});

test('open_server: ignores case, emoji and punctuation; unique substring works', async () => {
  const st = serverState(['🔥 Gamma!! Server', 'Alpha']);
  const ids = { '🔥 Gamma!! Server': ['3', '30'], Alpha: ['1', '10'] };
  const env = makeEnv(st, { onClick: navClick(ids) });
  let r = await run('open_server', env, { name: 'GAMMA server', timeoutMs: 1000 });
  assert.strictEqual(r.name, '🔥 Gamma!! Server');
  assert.strictEqual(r.serverId, '3');

  const st2 = serverState(['🔥 Gamma!! Server', 'Alpha']);
  const env2 = makeEnv(st2, { onClick: navClick(ids) });
  r = await run('open_server', env2, { name: 'gam', timeoutMs: 1000 });
  assert.strictEqual(r.name, '🔥 Gamma!! Server');
});

test('open_server: all-emoji name falls back to its own string', async () => {
  const ids = { '🎮': ['5', '50'], '🎲': ['6', '60'] };
  const env = makeEnv(serverState(['🎮', '🎲']), { onClick: navClick(ids) });
  const r = await run('open_server', env, { name: '🎲', timeoutMs: 1000 });
  assert.strictEqual(r.serverId, '6');
});

test('open_server: zero matches throws with at most 5 close matches', async () => {
  const names = ['Alpha', 'Alpine', 'Alps', 'Alphabet', 'Almond', 'Zebra', 'Yak'];
  const env = makeEnv(serverState(names), { onClick: navClick({}) });
  await assert.rejects(run('open_server', env, { name: 'Alpx', timeoutMs: 1000 }), (e) => {
    assert.match(e.message, /matches no server/);
    const listed = names.filter((n) => e.message.includes(JSON.stringify(n)));
    assert.ok(listed.length >= 1 && listed.length <= 5, e.message);
    assert.ok(e.message.includes('"Alpha"'));
    return true;
  });
  assert.strictEqual(env.clicks.length, 0);
});

test('open_server: ambiguous substring and ambiguous normalization both throw', async () => {
  const env = makeEnv(serverState(['Team One', 'Team Two']));
  await assert.rejects(run('open_server', env, { name: 'team', timeoutMs: 1000 }), /several servers/);

  const env2 = makeEnv(serverState(['we build', '{ we build }']));
  await assert.rejects(run('open_server', env2, { name: 'WE BUILD!', timeoutMs: 1000 }), (e) => {
    assert.match(e.message, /several servers/);
    assert.ok(e.message.includes('"we build"') && e.message.includes('"{ we build }"'));
    return true;
  });
  assert.strictEqual(env2.clicks.length, 0);
});

test('open_server: exact raw match wins over equal normalized names', async () => {
  const ids = { '{ we build }': ['7', '70'], 'we build': ['8', '80'] };
  for (const [typed, expected] of [['{ we build }', '{ we build }'], ['we build', 'we build']]) {
    const env = makeEnv(serverState(['we build', '{ we build }']), { onClick: navClick(ids) });
    const r = await run('open_server', env, { name: typed, timeoutMs: 1000 });
    assert.strictEqual(r.name, expected);
  }
});

test('open_server: ambiguity lists at most 5 close matches', async () => {
  const names = Array.from({ length: 9 }, (_, i) => `Team ${i}`);
  const env = makeEnv(serverState(names));
  await assert.rejects(run('open_server', env, { name: 'team', timeoutMs: 1000 }), (e) => {
    const listed = names.filter((n) => e.message.includes(JSON.stringify(n)));
    assert.strictEqual(listed.length, 5);
    return true;
  });
});

// ---------------------------------------------------------------- open_server

test('open_server: validates name and tabId', async () => {
  const env = makeEnv(serverState(['Alpha']));
  await assert.rejects(run('open_server', env, {}), /params\.name/);
  await assert.rejects(run('open_server', env, { name: '   ' }), /params\.name/);
  await assert.rejects(run('open_server', env, { name: 'Alpha' }, null), /tab_id/);
});

test('open_server: alreadyOpen returns without clicking', async () => {
  const st = serverState(['Alpha', 'Gamma'], {
    url: GUILD_URL('1', '10'),
    pageType: 'server_channel',
    serverName: 'Alpha'
  });
  const env = makeEnv(st);
  const r = await run('open_server', env, { name: 'ALPHA', timeoutMs: 1000 });
  assert.strictEqual(r.alreadyOpen, true);
  assert.strictEqual(r.serverId, '1');
  assert.strictEqual(r.channelId, '10');
  assert.strictEqual(env.clicks.length, 0);
});

test('open_server: verified is false when the tree shows another server', async () => {
  const st = serverState(['Alpha', 'Gamma']);
  const env = makeEnv(st, {
    onClick: async (args, state) => {
      state.url = GUILD_URL('1', '10');
      state.serverName = 'Something Else';
    }
  });
  const r = await run('open_server', env, { name: 'Alpha', timeoutMs: 1000 });
  assert.strictEqual(r.verified, false);
  assert.strictEqual(r.serverId, '1');
});

test('open_server: uses selector fallback with escaping when ref is null', async () => {
  const weird = 'Say "hi" \\ there';
  const st = serverState([{ name: weird, noRef: true }]);
  const env = makeEnv(st, { onClick: navClick({ [weird]: ['9', '90'] }) });
  const r = await run('open_server', env, { name: weird, timeoutMs: 1000 });
  assert.strictEqual(env.clicks[0].selector, '[data-dnd-name="Say \\"hi\\" \\\\ there"]');
  assert.strictEqual(r.serverId, '9');
});

test('cssAttr escapes newlines and control characters in the selector', async () => {
  const name = 'A\nB\tC';
  const st = serverState([{ name, noRef: true }]);
  const env = makeEnv(st, { onClick: async (a, s) => { s.url = GUILD_URL('1', '2'); } });
  await run('open_server', env, { name, timeoutMs: 1000 });
  assert.strictEqual(env.clicks[0].selector, '[data-dnd-name="A\\a B\\9 C"]');
});

test('open_server: click that throws but applies late still succeeds', async () => {
  const st = serverState(['Alpha', 'Gamma']);
  const env = makeEnv(st, { onClick: navClick(IDS, { delay: 250, throws: true }) });
  const r = await run('open_server', env, { name: 'Gamma', timeoutMs: 3000 });
  assert.strictEqual(r.serverId, '3');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(env.clicks.length, 1);
});

test('open_server: deadline yields pending result', async () => {
  const st = serverState(['Alpha']);
  const env = makeEnv(st, { onClick: async () => {} });
  const t0 = Date.now();
  const r = await run('open_server', env, { name: 'Alpha', timeoutMs: 1000 });
  assert.strictEqual(r.pending, true);
  assert.match(r.message, /re-read state/);
  assert.strictEqual(r.name, 'Alpha');
  assert.strictEqual(r.lastUrl, 'https://discord.com/channels/@me');
  assert.ok(Date.now() - t0 < 2500);
});

test('open_server: expands a collapsed folder to find a hidden server', async () => {
  const st = serverState(['Alpha', { name: 'Hidden', folder: 'Games' }], {
    folders: [{ name: 'Games', expanded: false }]
  });
  const ids = { Alpha: ['1', '10'], Hidden: ['4', '40'] };
  const env = makeEnv(st, { onClick: navClick(ids) });
  const r = await run('open_server', env, { name: 'hidden', timeoutMs: 3000 });
  assert.strictEqual(r.serverId, '4');
  assert.strictEqual(r.verified, true);
  assert.ok(env.clicks[0].ref.includes('-f-Games'));
  assert.deepStrictEqual(env.stale, []);
});

test('open_server: unknown name with collapsed folder still throws after expanding', async () => {
  const st = serverState(['Alpha'], { folders: [{ name: 'Games', expanded: false }] });
  const env = makeEnv(st, { onClick: navClick(IDS) });
  await assert.rejects(run('open_server', env, { name: 'Nope', timeoutMs: 3000 }), /matches no server/);
  assert.strictEqual(st.folders[0].expanded, true);
});


test('open_server: expands only as many folders as needed', async () => {
  const st = serverState(['Alpha', { name: 'InB', folder: 'B' }], {
    folders: [{ name: 'A', expanded: false }, { name: 'B', expanded: false }, { name: 'C', expanded: false }]
  });
  const ids = { Alpha: ['1', '10'], InB: ['5', '50'] };
  const env = makeEnv(st, { onClick: navClick(ids) });
  const r = await run('open_server', env, { name: 'InB', timeoutMs: 3000 });
  assert.strictEqual(r.serverId, '5');
  const folderClicks = env.clicks.filter((c) => /-f-/.test(c.ref || ''));
  assert.strictEqual(folderClicks.length, 2);
  assert.ok(folderClicks[0].ref.includes('-f-A'));
  assert.ok(folderClicks[1].ref.includes('-f-B'));
  assert.strictEqual(st.folders[2].expanded, false);
  assert.deepStrictEqual(env.stale, []);
});

test('open_server: unnamed folder listing the target is tried first', async () => {
  const un = '(unnamed: Foo, Rustland…)';
  const st = serverState(['Alpha', { name: 'Rustland', folder: un }], {
    folders: [{ name: 'A', expanded: false }, { name: un, expanded: false }]
  });
  const ids = { Alpha: ['1', '10'], Rustland: ['6', '60'] };
  const env = makeEnv(st, { onClick: navClick(ids) });
  const r = await run('open_server', env, { name: 'rust', timeoutMs: 3000 });
  assert.strictEqual(r.serverId, '6');
  const folderClicks = env.clicks.filter((c) => /-f-/.test(c.ref || ''));
  assert.strictEqual(folderClicks.length, 1);
  assert.ok(folderClicks[0].ref.includes('-f-(unnamed'));
  assert.strictEqual(st.folders[0].expanded, false);
});

test('open_server: not found after all folders lists close matches', async () => {
  const st = serverState(['Alpha', { name: 'Beta', folder: 'A' }], {
    folders: [{ name: 'A', expanded: false }, { name: 'B', expanded: false }]
  });
  const env = makeEnv(st, { onClick: navClick(IDS) });
  await assert.rejects(run('open_server', env, { name: 'Nope', timeoutMs: 3000 }), (e) => {
    assert.match(e.message, /matches no server/);
    assert.match(e.message, /Close matches/);
    return true;
  });
  assert.ok(st.folders.every((f) => f.expanded === true));
});

// ---------------------------------------------------------------- check_sidebar

test('check_sidebar: expands only collapsed folders and never re-clicks expanded ones', async () => {
  const st = serverState(
    ['Alpha', { name: 'In A', folder: 'A' }, { name: 'In B', folder: 'B' }, { name: 'In C', folder: 'C' }],
    {
      folders: [
        { name: 'A', expanded: true },
        { name: 'B', expanded: false },
        { name: 'C', expanded: false }
      ]
    }
  );
  const env = makeEnv(st, { onClick: navClick({}) });
  const r = await run('check_sidebar', env, { timeoutMs: 3000 });
  const clickedFolders = env.clicks.map((c) => /-f-(.*)$/.exec(c.ref)[1]);
  assert.deepStrictEqual(clickedFolders.sort(), ['B', 'C']);
  assert.deepStrictEqual(env.stale, []);
  assert.strictEqual(r.serverCount, 4);
  assert.strictEqual(r.servers.length, 4);
  assert.strictEqual(r.pending, undefined);
  assert.strictEqual(r.warnings, undefined);
  assert.ok(r.folders.every((f) => f.expanded));
});

test('check_sidebar: expandFolders false does not click', async () => {
  const st = serverState(['Alpha', { name: 'In B', folder: 'B' }], {
    folders: [{ name: 'B', expanded: false }]
  });
  const env = makeEnv(st, { onClick: navClick({}) });
  const r = await run('check_sidebar', env, { expandFolders: false, timeoutMs: 1000 });
  assert.strictEqual(env.clicks.length, 0);
  assert.strictEqual(r.serverCount, 1);
});

test('check_sidebar: late-applying throwing click is tolerated', async () => {
  const st = serverState([{ name: 'In B', folder: 'B' }], { folders: [{ name: 'B', expanded: false }] });
  const env = makeEnv(st, { onClick: navClick({}, { delay: 300, throws: true }) });
  const r = await run('check_sidebar', env, { timeoutMs: 4000 });
  assert.strictEqual(r.serverCount, 1);
  assert.strictEqual(env.clicks.length, 1);
});

test('check_sidebar: folder that never expands yields pending with partial servers', async () => {
  const st = serverState(['Alpha', { name: 'In B', folder: 'B' }], {
    folders: [{ name: 'B', expanded: false }]
  });
  const env = makeEnv(st, { onClick: async () => {} });
  const r = await run('check_sidebar', env, { timeoutMs: 1000 });
  assert.strictEqual(r.pending, true);
  assert.match(r.message, /re-read state/);
  assert.strictEqual(r.servers.length, 1);
  assert.strictEqual(r.folders[0].expanded, false);
});

test('check_sidebar: folder skipped when it expands between fetches', async () => {
  const st = serverState(['Alpha'], {
    folders: [{ name: 'B', expanded: false }, { name: 'C', expanded: false }]
  });
  // Clicking B also expands C (simulates a late-applied earlier click).
  const env = makeEnv(st, {
    onClick: async (args, state) => {
      state.folders.forEach((f) => { f.expanded = true; });
    }
  });
  await run('check_sidebar', env, { timeoutMs: 3000 });
  assert.strictEqual(env.clicks.length, 1);
});

// ---------------------------------------------------------------- check_dm_list

test('check_dm_list: navigates home from a server page', async () => {
  const dms = [{ name: 'Bob', ref: 'x', type: 'dm', status: null, unread: false, members: 2, muted: false }];
  const st = baseState({ pageType: 'server_channel', dms, totalUnread: 3 });
  const env = makeEnv(st, {
    onClick: async (args, state) => {
      assert.strictEqual(args.selector, '[data-list-item-id="guildsnav___home"]');
      state.pageType = 'dm_conversation';
    }
  });
  const r = await run('check_dm_list', env, { timeoutMs: 3000 });
  assert.strictEqual(env.clicks.length, 1);
  assert.deepStrictEqual(r, { dms, dmCount: 1, totalUnread: 3 });
});

test('check_dm_list: no click when already on @me', async () => {
  const env = makeEnv(baseState({ pageType: 'dm_list' }));
  const r = await run('check_dm_list', env, { timeoutMs: 1000 });
  assert.strictEqual(env.clicks.length, 0);
  assert.deepStrictEqual(r, { dms: [], dmCount: 0, totalUnread: 0 });
});

test('check_dm_list: pending when home navigation never lands', async () => {
  const env = makeEnv(baseState({ pageType: 'server_channel' }), { onClick: async () => {} });
  const r = await run('check_dm_list', env, { timeoutMs: 1000 });
  assert.strictEqual(r.pending, true);
  assert.strictEqual(r.pageType, 'server_channel');
});


test('open_server: alreadyOpen on a server-only URL takes channelId from the tree', async () => {
  const st = serverState(['Alpha', 'Gamma'], {
    url: GUILD_URL('1'),
    pageType: 'server_channel',
    serverName: 'Alpha',
    channelId: '10'
  });
  const env = makeEnv(st);
  const r = await run('open_server', env, { name: 'ALPHA', timeoutMs: 1000 });
  assert.strictEqual(r.alreadyOpen, true);
  assert.strictEqual(r.serverId, '1');
  assert.strictEqual(r.channelId, '10');
  assert.strictEqual(env.clicks.length, 0);
});

test('open_server: alreadyOpen on a server-only URL without tree channelId is null', async () => {
  const st = serverState(['Alpha', 'Gamma'], {
    url: GUILD_URL('1'),
    pageType: 'server_channel',
    serverName: 'Alpha'
  });
  const env = makeEnv(st);
  const r = await run('open_server', env, { name: 'Alpha', timeoutMs: 1000 });
  assert.strictEqual(r.alreadyOpen, true);
  assert.strictEqual(r.serverId, '1');
  assert.strictEqual(r.channelId, null);
});

test('open_server: click landing on a server-only URL resolves with tree channelId', async () => {
  const st = serverState(['Alpha', 'Gamma'], {
    url: GUILD_URL('1', '10'),
    pageType: 'server_channel',
    serverName: 'Alpha'
  });
  const env = makeEnv(st, {
    onClick: async (args, state) => {
      state.url = GUILD_URL('2');
      state.serverName = 'Gamma';
      state.channelId = '20';
    }
  });
  const r = await run('open_server', env, { name: 'Gamma', timeoutMs: 3000 });
  assert.strictEqual(r.pending, undefined);
  assert.strictEqual(r.serverId, '2');
  assert.strictEqual(r.channelId, '20');
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.url, GUILD_URL('2'));
});

// ---------------------------------------------------------------- open_member_list

function memberState(member, extra = {}) {
  return baseState({
    url: GUILD_URL('800000000000000001', '800000000000000002'),
    pageType: 'server_channel',
    serverName: 'Alpha Guild',
    member,
    ...extra
  });
}

const opensOnClick = async (args, state) => {
  if (/member-toggle$/.test(args.ref || '')) state.member.open = true;
};

test('open_member_list: declared in the manifest', () => {
  assert.ok(manifest.workflows.some((w) => w.name === 'open_member_list'));
  assert.strictEqual(typeof workflows.open_member_list.run, 'function');
});

test('open_member_list: already open is a no-op', async () => {
  const env = makeEnv(memberState({ open: true, count: 3, total: 41 }));
  const r = await run('open_member_list', env, { timeoutMs: 1000 });
  assert.strictEqual(env.clicks.length, 0);
  assert.deepStrictEqual(r, { ok: true, opened: false, memberListOpen: true, memberCount: 3, memberTotal: 41 });
});

test('open_member_list: succeeds on a server-only URL reported as server_channel', async () => {
  const env = makeEnv(
    memberState({ open: false, count: 3, total: 41 }, { url: GUILD_URL('800000000000000001') }),
    { onClick: opensOnClick }
  );
  const r = await run('open_member_list', env, { timeoutMs: 3000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(env.clicks.length, 1);
});

test('open_member_list: closed panel gets exactly one click', async () => {
  const env = makeEnv(memberState({ open: false, count: 3, total: 41 }), { onClick: opensOnClick });
  const r = await run('open_member_list', env, { timeoutMs: 3000 });
  assert.strictEqual(env.clicks.length, 1);
  assert.strictEqual(env.stale.length, 0);
  assert.deepStrictEqual(r, { ok: true, opened: true, memberListOpen: true, memberCount: 3, memberTotal: 41 });
});

test('open_member_list: waits for a late toggle, then clicks once', async () => {
  const env = makeEnv(memberState({ open: false, count: 2, total: 2, toggleAfter: 3 }), { onClick: opensOnClick });
  const r = await run('open_member_list', env, { timeoutMs: 5000 });
  assert.strictEqual(env.clicks.length, 1);
  assert.ok(env.fetches > 3);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.opened, true);
});

test('open_member_list: clicked but never opens is pending, still one click', async () => {
  const env = makeEnv(memberState({ open: false }), { onClick: async () => {} });
  const r = await run('open_member_list', env, { timeoutMs: 1000 });
  assert.strictEqual(env.clicks.length, 1);
  assert.strictEqual(r.pending, true);
  assert.strictEqual(r.message, PENDING_MESSAGE);
  assert.strictEqual(r.memberListOpen, false);
});

test('open_member_list: toggle that never appears returns ok:false', async () => {
  const env = makeEnv(memberState({ open: false, toggleAfter: 1e9 }), { onClick: opensOnClick });
  const r = await run('open_member_list', env, { timeoutMs: 1000 });
  assert.strictEqual(env.clicks.length, 0);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /toggle not found/);
});

test('open_member_list: non-server page fails immediately', async () => {
  const env = makeEnv(baseState({ pageType: 'dm_conversation' }));
  const r = await run('open_member_list', env, { timeoutMs: 1000 });
  assert.strictEqual(env.clicks.length, 0);
  assert.strictEqual(env.fetches, 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.pageType, 'dm_conversation');
});

// --- blocking popup guard ---
const BLOCKING = {
  name: 'Shop promo',
  closeRef: 'e99',
  buttons: [{ ref: 'e99', text: 'Close' }],
  headings: ['New in the shop']
};

for (const [name, params] of [
  ['send_message', { text: 'hi' }],
  ['check_sidebar', { timeoutMs: 1000 }],
  ['open_server', { name: 'Alpha', timeoutMs: 1000 }],
  ['check_dm_list', { timeoutMs: 1000 }],
  ['open_member_list', { timeoutMs: 1000 }]
]) {
  test(`${name}: returns blocked result without acting while a popup is open`, async () => {
    const st = serverState(['Alpha'], { blocking: BLOCKING, folders: [{ name: 'F', expanded: false }] });
    const env = makeEnv(st);
    const r = await workflows[name].run({
      params,
      browser: env.browser,
      tabId: TAB,
      findInTree: () => ({ ref: 'composer' })
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blocked, true);
    assert.strictEqual(r.reason, 'blocking_dialog');
    assert.ok(r.message.includes('modal dialog'));
    assert.ok(r.message.includes('e99'));
    assert.deepStrictEqual(r.blockingDialog, BLOCKING);
    assert.strictEqual(env.clicks.length, 0);
    assert.strictEqual(env.types.length, 0);
  });
}

test('hasBlockingDialog false leaves open_server unchanged', async () => {
  const st = serverState(['Alpha', 'Gamma'], {
    url: GUILD_URL('1', '10'),
    pageType: 'server_channel',
    serverName: 'Alpha'
  });
  const env = makeEnv(st);
  const r = await run('open_server', env, { name: 'ALPHA', timeoutMs: 1000 });
  assert.strictEqual(r.blocked, undefined);
  assert.strictEqual(r.alreadyOpen, true);
  assert.strictEqual(env.clicks.length, 0);
});

// ---------------------------------------------------------------- get_member_profile

const PROFILE = {
  name: 'Alice',
  username: 'alice_h',
  userId: '111',
  roles: ['Admin', 'Mod'],
  messageButtonRef: 'e50',
  closeRef: null
};

// Clicking the ref opens the popout (sets state.profile) after `delay` ms.
function profileClick(profile = PROFILE, { delay = 0 } = {}) {
  return async (args, state) => {
    const open = () => { state.profile = profile; };
    if (delay) setTimeout(open, delay);
    else open();
  };
}

const USER = { id: '111', username: 'alice_h', globalName: 'Alice A' };

test('get_member_profile: happy path resolves user, clicks once, returns fields', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, { onClick: profileClick(), resolveRefs: async () => [USER] });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.deepStrictEqual(r, {
    ok: true,
    userId: '111',
    username: 'alice_h',
    displayName: 'Alice A',
    roles: ['Admin', 'Mod'],
    messageButtonRef: 'e50',
    closeRef: null,
    popoutOpen: true
  });
  assert.strictEqual(env.clicks.length, 1);
  assert.strictEqual(env.clicks[0].ref, 'e5');
  assert.strictEqual(env.resolveCalls.length, 1);
  assert.deepStrictEqual(env.resolveCalls[0].refs, ['e5']);
  assert.strictEqual(env.resolveCalls[0].tab_id, TAB);
  assert.ok(['function', 'string'].includes(typeof env.resolveCalls[0].resolver));
});

test('get_member_profile: no tree fetch before the click (refs stay valid)', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  let fetchesAtClick = -1;
  const env = makeEnv(st, {
    resolveRefs: async () => [USER],
    onClick: async (args, state, e) => { fetchesAtClick = e.fetches; state.profile = PROFILE; }
  });
  await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(fetchesAtClick, 0);
  assert.strictEqual(env.resolveCalls[0].fetchesAtCall, 0);
});

test('get_member_profile: displayName falls back to username, then users{} globalName', async () => {
  let st = serverState([], { pageType: 'server_channel' });
  let env = makeEnv(st, {
    onClick: profileClick(),
    resolveRefs: async () => [{ id: '111', username: 'alice_h', globalName: null }]
  });
  let r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(r.displayName, 'alice_h');

  st = serverState([], {
    pageType: 'server_channel',
    users: { 111: { id: '111', username: 'alice_h', globalName: 'From Users' } }
  });
  env = makeEnv(st, { onClick: profileClick(), resolveRefs: async () => [{ id: '111' }] });
  r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(r.username, 'alice_h');
  assert.strictEqual(r.displayName, 'From Users');
});

test('get_member_profile: resolveRefs undefined -> profile.userId with warning', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, { onClick: profileClick() });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.userId, '111');
  assert.strictEqual(r.displayName, 'alice_h');
  assert.ok(r.warnings.some((w) => /does not support node resolution/.test(w)));
  assert.strictEqual(env.clicks.length, 1);
});

test('get_member_profile: resolveRefs undefined and no profile id -> null userId with warnings', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, { onClick: profileClick({ ...PROFILE, userId: null }) });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(r.userId, null);
  assert.strictEqual(r.username, 'alice_h');
  assert.ok(r.warnings.some((w) => /could not be determined/.test(w)));
});

test('get_member_profile: resolveRefs throwing falls back with warning', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, {
    onClick: profileClick(),
    resolveRefs: async () => { throw new Error('unknown command resolve_nodes'); }
  });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.userId, '111');
  assert.ok(r.warnings.some((w) => /user id resolution unavailable: unknown command/.test(w)));
  assert.strictEqual(env.clicks.length, 1);
});

test('get_member_profile: unresolved ref (null) warns but still opens popout', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, { onClick: profileClick(), resolveRefs: async () => [null] });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(r.userId, '111');
  assert.ok(r.warnings.some((w) => /did not resolve to a user/.test(w)));
});

test('get_member_profile: site-policy block from resolveRefs is rethrown, no click', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, {
    onClick: profileClick(),
    resolveRefs: async () => {
      const e = new Error('blocked by policy');
      e.__sitePolicyEnvelope = { blocked: true };
      throw e;
    }
  });
  await assert.rejects(run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 }), /blocked by policy/);
  assert.strictEqual(env.clicks.length, 0);
});

test('get_member_profile: waits for the popout and clicks exactly once', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, { onClick: profileClick(PROFILE, { delay: 800 }), resolveRefs: async () => [USER] });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 3000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(env.clicks.length, 1);
  assert.ok(env.fetches >= 2);
});

test('get_member_profile: blocking popup after the click returns blocked result', async () => {
  const st = serverState([], { pageType: 'server_channel', blocking: BLOCKING });
  const env = makeEnv(st, { resolveRefs: async () => [USER] });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'blocking_dialog');
  assert.strictEqual(env.clicks.length, 1);
});

test('get_member_profile: no popout before deadline returns pending, no second click', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, { resolveRefs: async () => [USER] });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 1000 });
  assert.strictEqual(r.pending, true);
  assert.ok(/do NOT click again/.test(r.message));
  assert.strictEqual(env.clicks.length, 1);
});

test('get_member_profile: invalid ref or tabId throws', async () => {
  const env = makeEnv(serverState([]));
  for (const ref of [undefined, '', 'x5', 'e', 'e5 ', 5]) {
    await assert.rejects(run('get_member_profile', env, { ref }), /params\.ref/);
  }
  await assert.rejects(run('get_member_profile', env, { ref: 'e5' }, 'nope'), /tab_id/);
  assert.strictEqual(env.clicks.length, 0);
});

test('get_member_profile: id mismatch between resolver and popout warns', async () => {
  const st = serverState([], { pageType: 'server_channel' });
  const env = makeEnv(st, { onClick: profileClick(), resolveRefs: async () => [{ ...USER, id: '222' }] });
  const r = await run('get_member_profile', env, { ref: 'e5', timeoutMs: 2000 });
  assert.strictEqual(r.userId, '222');
  assert.ok(r.warnings.some((w) => /differs from profile popout/.test(w)));
});

test('get_member_profile: declared in the manifest with ref and timeoutMs params', () => {
  const w = manifest.workflows.find((x) => x.name === 'get_member_profile');
  assert.ok(w);
  assert.deepStrictEqual(Object.keys(w.parameters).sort(), ['ref', 'timeoutMs']);
});
