'use strict';

// Issue #132: ChromeManager must treat a failed process scan as "unknown"
// (never spawn/close on it), re-verify a stale hasFlag:false cache (rate
// limited), and prefer the flagged browser-parent when several match.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const stubs = {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const key = request.replace(/\\/g, '/');
  for (const [pattern, stub] of Object.entries(stubs)) {
    if (key === pattern || key.endsWith('/' + pattern)) return stub;
  }
  return originalLoad.apply(this, arguments);
};

const UDD = process.platform === 'win32' ? 'C:\\ud' : '/tmp/ud';
const ALIVE_PID = process.pid; // process.kill(pid, 0) succeeds for ourselves

let detectCalls;
let detectImpl;
let closerCalls;
let launcherCalls;
let onLaunch;
let activeProfiles;

function detectionError(msg) {
  const e = new Error(msg);
  e.code = 'CHROME_DETECTION_FAILED';
  return e;
}

stubs['./logger'] = { log: () => {}, error: () => {} };
stubs['./detector'] = {
  detectChromeBrowsers: async () => {
    detectCalls += 1;
    return detectImpl();
  },
};
stubs['./closer'] = {
  closeChromeGracefully: async (pids) => {
    closerCalls.push(pids);
    return { closed: true, remaining: [], durationMs: 1 };
  },
};
stubs['./launcher'] = {
  launchChromeProfile: (o) => {
    launcherCalls.push(o);
    if (onLaunch) onLaunch(o);
    return { pid: 4242 };
  },
};
stubs['./local-state'] = { readProfiles: () => [{ directoryName: 'Default' }] };
stubs['./profile-activity'] = { getActiveProfiles: () => activeProfiles };
stubs['./paths'] = {
  getDefaultChromePath: () => 'chrome',
  getDefaultUserDataDir: () => UDD,
};

const {
  createChromeManager,
  FORCED_REFRESH_MIN_INTERVAL_MS,
  CONNECT_BUDGET_RUNNING_MS,
  CONNECT_BUDGET_LAUNCH_MS,
  EXTENSION_GRACE_MS,
  RESTORE_SESSION_FLAG,
} = require('../src/chrome/manager');

function browser(pid, hasFlag) {
  return { pid, hasFlag, commandLine: '', userDataDir: UDD, profileDirectory: 'Default' };
}

function makeManager(bridge) {
  return createChromeManager({
    userDataDir: UDD,
    chromePath: 'chrome',
    extensionBridge: bridge || null,
    connectTimeoutMs: 50,
    connectPollIntervalMs: 10,
  });
}

beforeEach(() => {
  detectCalls = 0;
  closerCalls = [];
  launcherCalls = [];
  onLaunch = null;
  activeProfiles = [];
  detectImpl = () => [];
});

test('refresh prefers the flagged parent over ours[0]', async () => {
  detectImpl = () => [browser(ALIVE_PID, false), browser(ALIVE_PID + 1, true)];
  const m = makeManager();
  const s = await m.refresh();
  assert.equal(s.browserPid, ALIVE_PID + 1);
  assert.equal(s.hasFlag, true);
});

test('cached hasFlag:true with live pid is trusted (no re-scan)', async () => {
  detectImpl = () => [browser(ALIVE_PID, true)];
  const m = makeManager();
  await m.getStatus();
  assert.equal(detectCalls, 1);
  const s = await m.getStatus();
  assert.equal(s.fromCache, true);
  assert.equal(detectCalls, 1);
});

test('stale cache with hasFlag:false is re-verified', async () => {
  detectImpl = () => [browser(ALIVE_PID, false)];
  const m = makeManager();
  await m.getStatus();
  assert.equal(detectCalls, 1);
  m._lastForcedRefreshAt = Date.now() - FORCED_REFRESH_MIN_INTERVAL_MS - 1;
  // Chrome was restarted with the flag in the meantime.
  detectImpl = () => [browser(ALIVE_PID, true)];
  const s = await m.getStatus();
  assert.equal(detectCalls, 2);
  assert.equal(s.hasFlag, true);
});

test('forced re-verify is rate limited', async () => {
  detectImpl = () => [browser(ALIVE_PID, false)];
  const m = makeManager();
  await m.getStatus(); // cache-miss refresh
  m._lastForcedRefreshAt = Date.now() - FORCED_REFRESH_MIN_INTERVAL_MS - 1;
  await m.getStatus(); // forced
  assert.equal(detectCalls, 2);
  const s = await m.getStatus(); // inside the window: served from cache
  assert.equal(detectCalls, 2);
  assert.equal(s.fromCache, true);
  assert.equal(s.rateLimited, true);
});

test('extensionDisconnected hint forces re-verify of a flagged cache', async () => {
  detectImpl = () => [browser(ALIVE_PID, true)];
  const m = makeManager();
  await m.getStatus();
  await m.getStatus({ extensionDisconnected: true });
  assert.equal(detectCalls, 2);
});

test('refresh on detection failure returns unknown and leaves cache untouched', async () => {
  detectImpl = () => [browser(ALIVE_PID, true)];
  const m = makeManager();
  await m.refresh();
  const before = { ...m._cache };
  detectImpl = () => { throw detectionError('ps down'); };
  const s = await m.refresh();
  assert.equal(s.unknown, true);
  assert.equal(s.running, null);
  assert.equal(s.hasFlag, null);
  assert.deepEqual(m._cache, before);
});

test('ensureReady aborts with chrome_state_unknown without spawning or closing', async () => {
  detectImpl = () => { throw detectionError('ps down'); };
  const m = makeManager();
  const r = await m.ensureReady(['Default']);
  assert.equal(r.action, 'abort');
  assert.equal(r.reason, 'chrome_state_unknown');
  assert.equal(r.unknown, true);
  assert.deepEqual(r.launched, []);
  assert.equal(launcherCalls.length, 0);
  assert.equal(closerCalls.length, 0);
});

test('closeAll does not report closed on unknown', async () => {
  detectImpl = () => { throw detectionError('ps down'); };
  const m = makeManager();
  const r = await m.closeAll();
  assert.equal(r.closed, false);
  assert.equal(r.unknown, true);
  assert.equal(closerCalls.length, 0);
});

test('closeAll still reports closed:true on a genuine empty scan', async () => {
  const m = makeManager();
  const r = await m.closeAll();
  assert.equal(r.closed, true);
});

test('ensureReady with Chrome genuinely absent still launches', async () => {
  const m = makeManager();
  const r = await m.ensureReady(['Default']);
  assert.equal(r.action, 'launch');
  assert.equal(launcherCalls.length, 1);
});

// ---- ensureReady: single coordinated wait, URL launch, session restore ----

function fakeBridge(initiallyConnected) {
  const b = { connected: !!initiallyConnected, isConnected: () => b.connected };
  return b;
}

function fastManager(bridge, extra) {
  return createChromeManager({
    userDataDir: UDD,
    chromePath: 'chrome',
    extensionBridge: bridge || null,
    connectTimeoutMs: 400,
    launchConnectTimeoutMs: 400,
    extensionGraceMs: 60,
    connectPollIntervalMs: 5,
    ...(extra || {}),
  });
}

// Replace the wait with a recorder; `impl` decides the outcome.
function spyWait(m, impl) {
  const calls = [];
  m._waitForProfileConnections = async (profiles, timeoutMs, opts) => {
    calls.push({ profiles, timeoutMs, opts });
    return impl ? impl(profiles, timeoutMs, opts) : { allConnected: true, stillMissing: [], waitedMs: 0, spawned: false };
  };
  return calls;
}

test('Case 2: extension reconnects during the grace wait → noop, nothing spawned', async () => {
  detectImpl = () => [browser(ALIVE_PID, true)];
  const bridge = fakeBridge(false);
  setTimeout(() => { bridge.connected = true; }, 15);
  const m = fastManager(bridge);
  const r = await m.ensureReady(['Default'], { url: 'https://example.com/' });
  assert.equal(r.action, 'noop');
  assert.equal(r.reconnected, true);
  assert.equal(r.connected, true);
  assert.equal(launcherCalls.length, 0);
});

test('Case 2: still missing after grace → spawns with the URL in extraArgs, then connects', async () => {
  detectImpl = () => [browser(ALIVE_PID, true)];
  const bridge = fakeBridge(false);
  onLaunch = () => setTimeout(() => { bridge.connected = true; }, 10);
  const m = fastManager(bridge);
  const r = await m.ensureReady(['Default'], { url: 'https://example.com/a?b=1' });
  assert.equal(r.action, 'launch-additional');
  assert.equal(r.connected, true);
  assert.equal(r.urlLaunched, true);
  assert.equal(launcherCalls.length, 1);
  assert.equal(launcherCalls[0].profileDirectory, 'Default');
  assert.equal(launcherCalls[0].withFlag, true);
  assert.deepEqual(launcherCalls[0].extraArgs, ['https://example.com/a?b=1']);
  assert.ok(r.waitedMs >= 60, 'spawn must come after the grace period');
});

test('Case 2: never connects → partial within the one budget, spawned once', async () => {
  detectImpl = () => [browser(ALIVE_PID, true)];
  const m = fastManager(fakeBridge(false), { connectTimeoutMs: 120 });
  const r = await m.ensureReady(['Default'], { url: 'https://example.com/' });
  assert.equal(r.action, 'partial');
  assert.equal(r.connected, false);
  assert.deepEqual(r.stillMissing, ['Default']);
  assert.equal(r.budgetMs, 120);
  assert.equal(launcherCalls.length, 1);
  assert.ok(r.waitedMs < 400, `waited ${r.waitedMs}ms; must be one budget, not two`);
});

for (const bad of ['chrome://settings', 'javascript:alert(1)', 'file:///C:/x', 'not a url', '']) {
  test(`invalid / non-http URL ${JSON.stringify(bad)} is not passed to Chrome`, async () => {
    detectImpl = () => [browser(ALIVE_PID, true)];
    const m = fastManager(fakeBridge(false));
    await m.ensureReady(['Default'], { url: bad, waitForConnect: false });
    assert.equal(launcherCalls.length, 1);
    assert.deepEqual(launcherCalls[0].extraArgs, []);
  });
}

test('scheme-less URL is normalized to https for the launch', async () => {
  const m = fastManager(null);
  await m.ensureReady(['Default'], { url: 'example.com/x' });
  assert.deepEqual(launcherCalls[0].extraArgs, ['https://example.com/x']);
});

test('restart passes --restore-last-session to every relaunch; URL only for required profiles', async () => {
  detectImpl = () => [browser(ALIVE_PID, false)];
  activeProfiles = ['Profile 1'];
  const m = fastManager(fakeBridge(false));
  const r = await m.ensureReady(['Default'], { url: 'https://example.com/', waitForConnect: false });
  assert.equal(r.action, 'restart');
  assert.equal(closerCalls.length, 1);
  assert.equal(RESTORE_SESSION_FLAG, '--restore-last-session');
  const byProfile = Object.fromEntries(launcherCalls.map((c) => [c.profileDirectory, c.extraArgs]));
  assert.deepEqual(byProfile['Profile 1'], ['--restore-last-session']);
  assert.deepEqual(byProfile['Default'], ['--restore-last-session', 'https://example.com/']);
  assert.equal(r.urlLaunched, true);
});

test('restart on unknown close state closes and spawns nothing', async () => {
  detectImpl = () => [browser(ALIVE_PID, false)];
  const m = fastManager(fakeBridge(false));
  await m.getStatus(); // prime cache: running, no flag
  m._lastForcedRefreshAt = Date.now(); // keep getStatus on the cache
  detectImpl = () => { throw detectionError('ps down'); };
  const r = await m.ensureReady(['Default'], { url: 'https://example.com/' });
  assert.equal(r.action, 'abort');
  assert.equal(r.reason, 'chrome_state_unknown');
  assert.equal(closerCalls.length, 0);
  assert.equal(launcherCalls.length, 0);
});

test('default budgets: 10s when Chrome is running, 15s after launch/restart', () => {
  assert.equal(CONNECT_BUDGET_RUNNING_MS, 10000);
  assert.equal(CONNECT_BUDGET_LAUNCH_MS, 15000);
  assert.ok(EXTENSION_GRACE_MS > 0 && EXTENSION_GRACE_MS < CONNECT_BUDGET_RUNNING_MS);
  const m = createChromeManager({ userDataDir: UDD, chromePath: 'chrome' });
  assert.equal(m.connectTimeoutMs, CONNECT_BUDGET_RUNNING_MS);
  assert.equal(m.launchConnectTimeoutMs, CONNECT_BUDGET_LAUNCH_MS);
  assert.equal(m.extensionGraceMs, EXTENSION_GRACE_MS);
});

test('Case 2 runs exactly one wait with the running budget and grace-then-spawn', async () => {
  detectImpl = () => [browser(ALIVE_PID, true)];
  const m = createChromeManager({ userDataDir: UDD, chromePath: 'chrome', extensionBridge: fakeBridge(false) });
  const calls = spyWait(m, (profiles, _t, opts) => {
    opts.spawn(profiles);
    return { allConnected: true, stillMissing: [], waitedMs: 1, spawned: true };
  });
  const r = await m.ensureReady(['Default'], { url: 'https://example.com/' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 10000);
  assert.equal(calls[0].opts.spawnAfterMs, EXTENSION_GRACE_MS);
  assert.equal(r.action, 'launch-additional');
  assert.equal(r.budgetMs, 10000);
  assert.equal(launcherCalls.length, 1);
});

test('launch runs exactly one wait with the launch budget', async () => {
  const m = createChromeManager({ userDataDir: UDD, chromePath: 'chrome', extensionBridge: fakeBridge(false) });
  const calls = spyWait(m);
  const r = await m.ensureReady(['Default'], { url: 'https://example.com/' });
  assert.equal(r.action, 'launch');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 15000);
  assert.deepEqual(calls[0].profiles, ['Default']);
  assert.equal(r.connected, true);
  assert.equal(r.budgetMs, 15000);
});

test('restart runs exactly one wait (required profiles only) with the launch budget', async () => {
  detectImpl = () => [browser(ALIVE_PID, false)];
  activeProfiles = ['Profile 1'];
  const m = createChromeManager({ userDataDir: UDD, chromePath: 'chrome', extensionBridge: fakeBridge(false) });
  const calls = spyWait(m, () => ({ allConnected: false, stillMissing: ['Default'], waitedMs: 15000, spawned: false }));
  const r = await m.ensureReady(['Default']);
  assert.equal(r.action, 'restart');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 15000);
  assert.deepEqual(calls[0].profiles, ['Default']);
  assert.equal(r.connected, false);
  assert.deepEqual(r.stillMissing, ['Default']);
});

test('waitForConnect:false returns without waiting on every spawn path', async () => {
  // Case 2
  detectImpl = () => [browser(ALIVE_PID, true)];
  let m = createChromeManager({ userDataDir: UDD, chromePath: 'chrome', extensionBridge: fakeBridge(false) });
  let calls = spyWait(m);
  let r = await m.ensureReady(['Default'], { waitForConnect: false });
  assert.equal(r.action, 'launch-additional');
  assert.equal(r.connected, null);
  assert.equal(calls.length, 0);
  assert.equal(launcherCalls.length, 1);

  // Case 3
  detectImpl = () => [browser(ALIVE_PID, false)];
  m = createChromeManager({ userDataDir: UDD, chromePath: 'chrome', extensionBridge: fakeBridge(false) });
  calls = spyWait(m);
  r = await m.ensureReady(['Default'], { waitForConnect: false });
  assert.equal(r.action, 'restart');
  assert.equal(r.connected, null);
  assert.equal(calls.length, 0);

  // Case 4
  detectImpl = () => [];
  m = createChromeManager({ userDataDir: UDD, chromePath: 'chrome', extensionBridge: fakeBridge(false) });
  calls = spyWait(m);
  r = await m.ensureReady(['Default'], { waitForConnect: false });
  assert.equal(r.action, 'launch');
  assert.equal(r.connected, null);
  assert.equal(calls.length, 0);
});

test('all required profiles already connected → noop with no wait and no spawn', async () => {
  detectImpl = () => [browser(ALIVE_PID, true)];
  const m = createChromeManager({ userDataDir: UDD, chromePath: 'chrome', extensionBridge: fakeBridge(true) });
  const calls = spyWait(m);
  const r = await m.ensureReady(['Default'], { url: 'https://example.com/' });
  assert.equal(r.action, 'noop');
  assert.equal(calls.length, 0);
  assert.equal(launcherCalls.length, 0);
});
