'use strict';

/**
 * Tests for issue #67: channel-aware formatter auto-update ref resolution.
 *
 * Verifies that formatter-updater.js derives GITHUB_RAW_BASE from the bundled
 * release-info.json (ref field) and falls back to "main" when the file is
 * absent or malformed.
 *
 * Strategy: stub `fs` and other deps via Module._load, then reload
 * formatter-updater.js fresh for each scenario and call checkForUpdates()
 * to capture the URL passed to fetchAndVerifyManifest.
 */

const assert = require('assert');
const Module = require('module');

// ---- Module._load hook ----
const origLoad = Module._load.bind(Module);

// Per-scenario: which release-info.json content to serve
let _releaseInfoContent = null; // null = ENOENT; string = raw content

// Mutable stub for manifest-verifier (replaced per scenario)
let _capturedBase = null;
const manifestVerifierStub = {
  fetchAndVerifyManifest: async (base) => { _capturedBase = base; return null; },
  fetchOptionalText: async () => null,
  verifyFileHash: () => false,
};

Module._load = function (request, parent, isMain) {
  const key = request.replace(/\\/g, '/');

  if (request === 'fs' || key === 'fs') {
    const realFs = origLoad(request, parent, isMain);
    // Return a proxy that intercepts only release-info.json reads
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
      }
    });
  }

  if (key === './service/paths' || key.endsWith('/service/paths')) {
    return { getFormatterDir: () => '/fake/formatters', getDataDir: () => '/fake/data' };
  }

  if (key === './lib/manifest-verifier' || key.endsWith('/lib/manifest-verifier')) {
    return manifestVerifierStub;
  }

  return origLoad(request, parent, isMain);
};

// ---- helpers ----
let testCount = 0;
let passCount = 0;

async function test(name, fn) {
  testCount++;
  try {
    await fn();
    passCount++;
    console.log('  PASS', name);
  } catch (err) {
    console.error('  FAIL', name, '\n   ', err.message);
    process.exitCode = 1;
  }
}

function reloadUpdater() {
  const key = require.resolve('../src/formatter-updater');
  delete require.cache[key];
  // Also clear manifest-verifier and paths from cache so the stub is re-applied
  for (const k of Object.keys(require.cache)) {
    if (k.includes('manifest-verifier') || k.includes('service/paths') || k.includes('service\\paths')) {
      delete require.cache[k];
    }
  }
  return require('../src/formatter-updater');
}

// ---- run scenarios ----
console.log('\n[formatter-updater-ref] ref resolution');

async function runAll() {

  // Scenario 1: stable ref
  await test('release-info.json ref="v2.0.4" (stable) → GITHUB_RAW_BASE contains /v2.0.4/', async () => {
    _releaseInfoContent = JSON.stringify({ ref: 'v2.0.4', channel: 'stable', version: '2.0.4', builtAt: '2026-05-30T00:00:00Z' });
    _capturedBase = null;
    const updater = reloadUpdater();
    await updater.checkForUpdates();
    assert.ok(_capturedBase, 'fetchAndVerifyManifest should have been called');
    assert.ok(
      _capturedBase.includes('/v2.0.4/'),
      `Expected /v2.0.4/ in base URL, got: ${_capturedBase}`
    );
    assert.ok(
      !_capturedBase.includes('/main/'),
      `Base URL should not contain /main/ for a stable ref, got: ${_capturedBase}`
    );
  });

  // Scenario 2: nightly ref
  await test('release-info.json ref="v2.0.4-nightly.20260530" → GITHUB_RAW_BASE contains that ref', async () => {
    _releaseInfoContent = JSON.stringify({ ref: 'v2.0.4-nightly.20260530', channel: 'nightly', version: '2.0.4-nightly.20260530', builtAt: '2026-05-30T00:00:00Z' });
    _capturedBase = null;
    const updater = reloadUpdater();
    await updater.checkForUpdates();
    assert.ok(_capturedBase, 'fetchAndVerifyManifest should have been called');
    assert.ok(
      _capturedBase.includes('/v2.0.4-nightly.20260530/'),
      `Expected /v2.0.4-nightly.20260530/ in base URL, got: ${_capturedBase}`
    );
  });

  // Scenario 3: file missing (ENOENT) → main, no warning logged
  await test('release-info.json missing (ENOENT) → falls back to /main/ without console.warn', async () => {
    _releaseInfoContent = null; // triggers ENOENT
    _capturedBase = null;
    let warnCalled = false;
    const origWarn = console.warn;
    console.warn = () => { warnCalled = true; };
    let updater;
    try {
      updater = reloadUpdater();
    } finally {
      console.warn = origWarn;
    }
    await updater.checkForUpdates();
    assert.ok(_capturedBase, 'fetchAndVerifyManifest should have been called');
    assert.ok(
      _capturedBase.includes('/main/'),
      `Expected /main/ in fallback base URL, got: ${_capturedBase}`
    );
    assert.strictEqual(warnCalled, false, 'ENOENT should not emit console.warn');
  });

  // Scenario 4: malformed JSON → main + warning logged
  await test('release-info.json malformed JSON → falls back to /main/ + logs console.warn', async () => {
    _releaseInfoContent = '{ not valid json !!!';
    _capturedBase = null;
    let warnCalled = false;
    let warnText = '';
    const origWarn = console.warn;
    console.warn = (...args) => { warnCalled = true; warnText += args.join(' '); };
    let updater;
    try {
      updater = reloadUpdater();
    } finally {
      console.warn = origWarn;
    }
    await updater.checkForUpdates();
    assert.ok(_capturedBase, 'fetchAndVerifyManifest should have been called');
    assert.ok(
      _capturedBase.includes('/main/'),
      `Expected /main/ in fallback base URL, got: ${_capturedBase}`
    );
    assert.strictEqual(warnCalled, true, 'Malformed JSON should emit console.warn');
    assert.ok(
      warnText.includes('malformed') || warnText.includes('falling back'),
      `Warning text should mention malformed/fallback, got: ${warnText}`
    );
  });

  console.log(`\n${passCount}/${testCount} formatter-updater-ref tests passed`);
  if (passCount < testCount) process.exitCode = 1;
}

runAll().catch(err => {
  console.error('Test suite error:', err);
  process.exitCode = 1;
});
