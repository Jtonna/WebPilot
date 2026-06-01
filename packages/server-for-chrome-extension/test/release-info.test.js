'use strict';

/**
 * Tests for release-info.js (issue #69).
 *
 * Verifies that getReleaseInfo() returns the parsed release-info.json when it
 * is present and well-formed, and falls back to package.json version with
 * channel='dev' when it is missing or malformed.
 *
 * Strategy: stub `fs.readFileSync` and `require('../package.json')` via
 * Module._load, then reload release-info.js fresh for each scenario using
 * the _resetCache() export.
 */

const assert = require('assert');
const Module = require('module');

const origLoad = Module._load.bind(Module);

// Per-scenario content for release-info.json (null = ENOENT)
let _releaseInfoContent = null;
// Per-scenario package.json version
let _pkgVersion = '9.8.7';

Module._load = function (request, parent, isMain) {
  const key = request.replace(/\\/g, '/');

  if (request === 'fs' || key === 'fs') {
    const realFs = origLoad(request, parent, isMain);
    return new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'readFileSync') {
          return function (filePath, encoding) {
            const p = String(filePath).replace(/\\/g, '/');
            if (p.endsWith('release-info.json')) {
              if (_releaseInfoContent === null) {
                const err = new Error('ENOENT: no such file or directory: ' + filePath);
                err.code = 'ENOENT';
                throw err;
              }
              return _releaseInfoContent;
            }
            return target.readFileSync(filePath, encoding);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  // Intercept require('../package.json') from within release-info.js
  if (key.endsWith('/package.json') && !key.includes('node_modules')) {
    return { version: _pkgVersion };
  }

  return origLoad(request, parent, isMain);
};

// ---- helpers ----
let testCount = 0;
let passCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log('  PASS', name);
  } catch (err) {
    console.error('  FAIL', name, '\n   ', err.message);
    process.exitCode = 1;
  }
}

function reloadReleaseInfo() {
  const key = require.resolve('../src/release-info');
  delete require.cache[key];
  return require('../src/release-info');
}

// ---- scenarios ----
console.log('\n[release-info] getReleaseInfo() coverage');

// Scenario 1: well-formed release-info.json → parsed content returned
test('well-formed release-info.json → returns parsed { ref, channel, version, builtAt }', () => {
  _releaseInfoContent = JSON.stringify({
    ref: 'v2.1.0',
    channel: 'stable',
    version: '2.1.0',
    builtAt: '2026-05-31T00:00:00Z',
  });
  const { getReleaseInfo } = reloadReleaseInfo();
  const info = getReleaseInfo();
  assert.strictEqual(info.ref, 'v2.1.0');
  assert.strictEqual(info.channel, 'stable');
  assert.strictEqual(info.version, '2.1.0');
  assert.strictEqual(info.builtAt, '2026-05-31T00:00:00Z');
});

// Scenario 2: memoisation — second call returns the same object reference
test('memoisation — repeated calls return same object (no re-read)', () => {
  _releaseInfoContent = JSON.stringify({
    ref: 'v2.1.0',
    channel: 'stable',
    version: '2.1.0',
    builtAt: '2026-05-31T00:00:00Z',
  });
  const { getReleaseInfo, _resetCache } = reloadReleaseInfo();
  const a = getReleaseInfo();
  const b = getReleaseInfo();
  assert.strictEqual(a, b, 'Both calls should return the same cached object reference');
});

// Scenario 3: file missing (ENOENT) → fallback with channel='dev'
test('release-info.json missing (ENOENT) → channel=dev, version from package.json', () => {
  _releaseInfoContent = null; // triggers ENOENT
  _pkgVersion = '9.8.7';
  const { getReleaseInfo } = reloadReleaseInfo();
  const info = getReleaseInfo();
  assert.strictEqual(info.channel, 'dev');
  assert.strictEqual(info.version, '9.8.7');
  assert.strictEqual(info.ref, null);
  assert.strictEqual(info.builtAt, null);
});

// Scenario 4: malformed JSON → fallback + console.warn
test('release-info.json malformed JSON → channel=dev, version from package.json, logs warn', () => {
  _releaseInfoContent = '{ not valid json !!!';
  _pkgVersion = '9.8.7';
  let warnCalled = false;
  let warnText = '';
  const origWarn = console.warn;
  console.warn = (...args) => { warnCalled = true; warnText += args.join(' '); };
  let info;
  try {
    const { getReleaseInfo } = reloadReleaseInfo();
    info = getReleaseInfo();
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(info.channel, 'dev');
  assert.strictEqual(info.version, '9.8.7');
  assert.strictEqual(warnCalled, true, 'Malformed JSON should emit console.warn');
  assert.ok(
    warnText.includes('malformed') || warnText.includes('falling back'),
    `Warning text should mention malformed/fallback, got: ${warnText}`
  );
});

// Scenario 5: partially-formed release-info.json (missing field) → fallback
test('release-info.json missing required field → channel=dev fallback', () => {
  // builtAt is missing
  _releaseInfoContent = JSON.stringify({ ref: 'v2.1.0', channel: 'stable', version: '2.1.0' });
  _pkgVersion = '9.8.7';
  let warnCalled = false;
  const origWarn = console.warn;
  console.warn = () => { warnCalled = true; };
  let info;
  try {
    const { getReleaseInfo } = reloadReleaseInfo();
    info = getReleaseInfo();
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(info.channel, 'dev', 'Partial release-info should fall back to dev channel');
  assert.strictEqual(info.version, '9.8.7');
  assert.strictEqual(warnCalled, true, 'Missing field should emit console.warn');
});

// Scenario 6: nightly release-info.json → returned as-is
test('nightly release-info.json → channel=nightly, version includes nightly tag', () => {
  _releaseInfoContent = JSON.stringify({
    ref: 'v2.1.1-nightly.20260531',
    channel: 'nightly',
    version: '2.1.1-nightly.20260531',
    builtAt: '2026-05-31T12:00:00Z',
  });
  const { getReleaseInfo } = reloadReleaseInfo();
  const info = getReleaseInfo();
  assert.strictEqual(info.channel, 'nightly');
  assert.ok(info.version.includes('nightly'), `Expected nightly in version, got: ${info.version}`);
  assert.strictEqual(info.ref, 'v2.1.1-nightly.20260531');
});

console.log(`\n${passCount}/${testCount} release-info tests passed`);
if (passCount < testCount) process.exitCode = 1;
