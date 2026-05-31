'use strict';

const assert = require('assert');

const detector = require('../src/chrome/macos-detector');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS', name);
  } catch (err) {
    console.error('  FAIL', name, '\n   ', err.message);
    process.exitCode = 1;
  }
}

console.log('\n[macos-detector]');

test('extracts default user-data-dir containing spaces from macOS ps output', () => {
  const cmd = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '--user-data-dir=/Users/alice/Library/Application Support/Google/Chrome',
    '--profile-directory=Default',
    detector.FLAG,
  ].join(' ');

  assert.strictEqual(
    detector._extractUserDataDir(cmd),
    '/Users/alice/Library/Application Support/Google/Chrome'
  );
});

test('extracts profile-directory values containing spaces', () => {
  const cmd = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '--profile-directory=Profile 2',
    detector.FLAG,
  ].join(' ');

  assert.strictEqual(detector._extractProfileDirectory(cmd), 'Profile 2');
});

test('quoted flag values still parse', () => {
  const cmd = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ' +
    '--user-data-dir="/tmp/WebPilot Chrome" --profile-directory="Profile 3"';

  assert.strictEqual(detector._extractUserDataDir(cmd), '/tmp/WebPilot Chrome');
  assert.strictEqual(detector._extractProfileDirectory(cmd), 'Profile 3');
});

test('browser parent filter excludes Chrome helper processes', () => {
  assert.strictEqual(
    detector._isBrowserParent('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer'),
    false
  );
  assert.strictEqual(
    detector._isBrowserParent('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default'),
    true
  );
});

process.on('exit', () => {
  if (process.exitCode) return;
  console.log(`\nmacos-detector tests passed: ${passed}`);
});
