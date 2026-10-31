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
    return { pid: 4242 };
  },
};
stubs['./local-state'] = { readProfiles: () => [{ directoryName: 'Default' }] };
stubs['./profile-activity'] = { getActiveProfiles: () => [] };
stubs['./paths'] = {
  getDefaultChromePath: () => 'chrome',
  getDefaultUserDataDir: () => UDD,
};

const { createChromeManager, FORCED_REFRESH_MIN_INTERVAL_MS } = require('../src/chrome/manager');

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
