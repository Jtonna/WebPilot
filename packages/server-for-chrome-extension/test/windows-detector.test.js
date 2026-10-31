'use strict';

// Issue #132: a failed PowerShell scan must surface as "unknown" (a rejected
// ChromeDetectionError) rather than an empty list, which would read as
// "Chrome not running". A real empty scan still resolves [].

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

let execResult = null;
stubs['node:child_process'] = {
  execFile: (cmd, args, opts, cb) => {
    const r = execResult;
    setImmediate(() => cb(r.err || null, r.stdout || '', r.stderr || ''));
  },
};
stubs['./logger'] = { log: () => {}, error: () => {} };

const windowsDetector = require('../src/chrome/windows-detector');

beforeEach(() => {
  execResult = null;
});

test('execFile error rejects with a tagged detection error', async () => {
  execResult = { err: new Error('powershell blew up'), stderr: 'boom' };
  await assert.rejects(windowsDetector.detect(), (e) => {
    assert.equal(e.code, 'CHROME_DETECTION_FAILED');
    assert.equal(e.name, 'ChromeDetectionError');
    return true;
  });
});

test('garbage stdout rejects with a tagged detection error', async () => {
  execResult = { stdout: 'not json at all {{' };
  await assert.rejects(windowsDetector.detect(), (e) => e.code === 'CHROME_DETECTION_FAILED');
});

test('empty stdout resolves []', async () => {
  execResult = { stdout: '   \n' };
  assert.deepEqual(await windowsDetector.detect(), []);
});

test('empty JSON array resolves []', async () => {
  execResult = { stdout: '[]' };
  assert.deepEqual(await windowsDetector.detect(), []);
});

test('flagged browser parent is detected; child processes are skipped', async () => {
  execResult = {
    stdout: JSON.stringify([
      {
        ProcessId: 111,
        CommandLine: '"C:\\chrome.exe" --user-data-dir="C:\\Data Dir" --profile-directory=Default --silent-debugger-extension-api',
      },
      { ProcessId: 112, CommandLine: '"C:\\chrome.exe" --type=renderer --user-data-dir="C:\\Data Dir"' },
    ]),
  };
  const out = await windowsDetector.detect();
  assert.equal(out.length, 1);
  assert.equal(out[0].pid, 111);
  assert.equal(out[0].hasFlag, true);
  assert.equal(out[0].userDataDir, 'C:\\Data Dir');
  assert.equal(out[0].profileDirectory, 'Default');
});

test('unflagged browser parent reports hasFlag false', async () => {
  execResult = { stdout: JSON.stringify({ ProcessId: 5, CommandLine: '"C:\\chrome.exe"' }) };
  const out = await windowsDetector.detect();
  assert.equal(out.length, 1);
  assert.equal(out[0].hasFlag, false);
});
