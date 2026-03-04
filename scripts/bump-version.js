#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function abort(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function validateSemver(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    abort('Version "' + version + '" does not look like semver (X.Y.Z).');
  }
}

/**
 * Read a JSON file, apply mutator(obj) which updates obj in-place and returns
 * the old version string, then write the file back with 2-space indent + trailing newline.
 */
function updateJson(filePath, mutator) {
  if (!fs.existsSync(filePath)) {
    abort('File not found: ' + filePath);
  }
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    abort('Failed to parse JSON in ' + filePath + ': ' + e.message);
  }
  const oldVersion = mutator(obj);
  try {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (e) {
    abort('Failed to write ' + filePath + ': ' + e.message);
  }
  console.log(filePath + '  ' + oldVersion + ' -> ' + obj.version);
}

/**
 * Update a JS source file by replacing via a regex pattern.
 * The replacer function receives the full regex match and returns the replacement string.
 */
function updateJs(filePath, pattern, replacer) {
  if (!fs.existsSync(filePath)) {
    abort('File not found: ' + filePath);
  }
  let src;
  try {
    src = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    abort('Failed to read ' + filePath + ': ' + e.message);
  }
  const match = src.match(pattern);
  if (!match) {
    abort('Pattern ' + pattern + ' not found in ' + filePath);
  }
  const oldSnippet = match[0];
  const newSnippet = replacer(oldSnippet);
  const newSrc = src.replace(pattern, newSnippet);
  try {
    fs.writeFileSync(filePath, newSrc, 'utf8');
  } catch (e) {
    abort('Failed to write ' + filePath + ': ' + e.message);
  }
  console.log(filePath + '  "' + oldSnippet + '" -> "' + newSnippet + '"');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const ROOT_PACKAGE_JSON = path.join(ROOT, 'package.json');

// 1. Resolve the new version
const argVersion = process.argv[2];

if (argVersion) {
  validateSemver(argVersion);
  // Update root package.json first with the supplied version
  updateJson(ROOT_PACKAGE_JSON, (obj) => {
    const old = obj.version;
    obj.version = argVersion;
    return old;
  });
}

// 2. Read the authoritative version from root package.json
if (!fs.existsSync(ROOT_PACKAGE_JSON)) {
  abort('Root package.json not found at ' + ROOT_PACKAGE_JSON);
}
let rootPkg;
try {
  rootPkg = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, 'utf8'));
} catch (e) {
  abort('Failed to parse root package.json: ' + e.message);
}
const newVersion = rootPkg.version;
validateSemver(newVersion);

console.log('Syncing version ' + newVersion + ' across monorepo...\n');

// 3. packages/electron/package.json
updateJson(path.join(ROOT, 'packages/electron/package.json'), (obj) => {
  const old = obj.version;
  obj.version = newVersion;
  return old;
});

// 4. packages/server-for-chrome-extension/package.json
updateJson(
  path.join(ROOT, 'packages/server-for-chrome-extension/package.json'),
  (obj) => {
    const old = obj.version;
    obj.version = newVersion;
    return old;
  }
);

// 5. packages/chrome-extension-unpacked/manifest.json
updateJson(
  path.join(ROOT, 'packages/chrome-extension-unpacked/manifest.json'),
  (obj) => {
    const old = obj.version;
    obj.version = newVersion;
    return old;
  }
);

// 6. packages/server-for-chrome-extension/src/mcp-handler.js
//    Replace version: '...' inside the serverInfo object (single-line form).
//    Pattern is anchored to the serverInfo object to avoid matching other version fields.
updateJs(
  path.join(ROOT, 'packages/server-for-chrome-extension/src/mcp-handler.js'),
  /serverInfo:\s*\{[^}]*version:\s*'[^']*'/,
  (matched) => matched.replace(/version:\s*'[^']*'/, "version: '" + newVersion + "'")
);

// 7. packages/server-for-chrome-extension/package-lock.json
//    Update both top-level "version" and packages[""].version
updateJson(
  path.join(ROOT, 'packages/server-for-chrome-extension/package-lock.json'),
  (obj) => {
    const old = obj.version;
    obj.version = newVersion;
    if (obj.packages && obj.packages['']) {
      obj.packages[''].version = newVersion;
    }
    return old;
  }
);

// 8. Root package-lock.json
//    Update both top-level "version" and packages[""].version
updateJson(path.join(ROOT, 'package-lock.json'), (obj) => {
  const old = obj.version;
  obj.version = newVersion;
  if (obj.packages && obj.packages['']) {
    obj.packages[''].version = newVersion;
  }
  return old;
});

console.log('\nDone. All files updated to version ' + newVersion + '.');
