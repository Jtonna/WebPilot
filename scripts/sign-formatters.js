#!/usr/bin/env node
'use strict';

/**
 * Sign the formatter + blocklist manifests for a release.
 *
 * For each of:
 *   - accessibility-tree-formatters/manifest.json
 *   - baseline-blocklists/manifest.json
 *
 * we:
 *
 *   1. Read the manifest, enumerate every file it references plus the
 *      manifest itself.
 *   2. Compute SHA-256 of every referenced file.
 *   3. Write `signed-manifest.json` alongside the original manifest. It
 *      embeds the manifest version, the manifest's own hash, and a flat
 *      { file: sha256 } map covering every referenced file.
 *   4. Sign `signed-manifest.json` with the Ed25519 private key loaded
 *      from $WEBPILOT_SIGNING_KEY (defaults to ~/.webpilot-signing-key).
 *      The signature is written as `signed-manifest.json.sig`, base64.
 *
 * The verifier in `formatter-updater.js` / `blocklist-updater.js`
 * fetches `signed-manifest.json` + `.sig`, verifies the signature against
 * the bundled `PUBKEY.pem`, then checks each downloaded file's SHA-256
 * against the manifest before writing it to disk.
 *
 * Idempotent: re-running with no file changes produces byte-identical
 * `signed-manifest.json` output, so the signature is also stable.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function repoRoot() {
  return path.resolve(__dirname, '..');
}

function privateKeyPath() {
  if (process.env.WEBPILOT_SIGNING_KEY) {
    return process.env.WEBPILOT_SIGNING_KEY;
  }
  return path.join(os.homedir(), '.webpilot-signing-key');
}

function abort(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Stable stringify so repeated runs produce byte-identical output and
 * therefore byte-identical signatures. Keys sorted at every level.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * For a given top-level manifest, return the list of referenced files
 * (relative to the manifest's directory). Each manifest schema is a
 * little different.
 */
function referencedFiles(manifest, manifestKind) {
  if (manifestKind === 'formatters') {
    // `files` is the canonical full list; fall back to `default` for
    // the very-old shape.
    const list = Array.isArray(manifest.files)
      ? manifest.files.slice()
      : manifest.default
        ? [manifest.default]
        : [];
    return list;
  }
  if (manifestKind === 'blocklists') {
    const lists = Array.isArray(manifest.lists) ? manifest.lists : [];
    return lists
      .filter((l) => l && typeof l.file === 'string')
      .map((l) => l.file);
  }
  throw new Error('Unknown manifest kind: ' + manifestKind);
}

function signBundle(dir, manifestKind) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    abort('Missing manifest: ' + manifestPath);
  }
  const manifestBuf = fs.readFileSync(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (e) {
    abort('Failed to parse ' + manifestPath + ': ' + e.message);
  }

  if (!manifest.version) {
    abort('Manifest at ' + manifestPath + ' is missing "version"');
  }

  const refs = referencedFiles(manifest, manifestKind);
  const fileHashes = {};
  fileHashes['manifest.json'] = sha256Hex(manifestBuf);
  for (const rel of refs) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
      abort('Manifest references missing file: ' + rel + ' (' + abs + ')');
    }
    fileHashes[rel] = sha256Hex(fs.readFileSync(abs));
  }

  const signed = {
    kind: manifestKind,
    version: String(manifest.version),
    algorithm: 'sha256',
    files: fileHashes,
  };
  const signedText = stableStringify(signed) + '\n';
  const signedPath = path.join(dir, 'signed-manifest.json');

  // Load private key + sign.
  const privPath = privateKeyPath();
  if (!fs.existsSync(privPath)) {
    abort(
      'Signing key not found: ' + privPath + '\n' +
      'Set WEBPILOT_SIGNING_KEY, or run `node scripts/generate-signing-key.js`.'
    );
  }
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({
      key: fs.readFileSync(privPath),
      format: 'pem',
    });
  } catch (e) {
    abort('Failed to load private key at ' + privPath + ': ' + e.message);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    abort('Private key at ' + privPath + ' is not Ed25519 (got ' +
      privateKey.asymmetricKeyType + ')');
  }

  // crypto.sign(null, data, key) uses Ed25519 raw signing (no separate
  // digest — Ed25519 hashes internally).
  const sig = crypto.sign(null, Buffer.from(signedText, 'utf8'), privateKey);
  const sigB64 = sig.toString('base64') + '\n';
  const sigPath = signedPath + '.sig';

  fs.writeFileSync(signedPath, signedText, 'utf8');
  fs.writeFileSync(sigPath, sigB64, 'utf8');

  console.log(
    '[sign-formatters] signed ' + manifestKind + ' (version ' +
    signed.version + ', ' + Object.keys(fileHashes).length + ' files)'
  );
  console.log('  manifest: ' + path.relative(repoRoot(), signedPath));
  console.log('  sig:      ' + path.relative(repoRoot(), sigPath));
}

function main() {
  const root = repoRoot();
  signBundle(path.join(root, 'accessibility-tree-formatters'), 'formatters');
  signBundle(path.join(root, 'baseline-blocklists'), 'blocklists');
}

main();
