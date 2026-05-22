#!/usr/bin/env node
'use strict';

/**
 * Generate an Ed25519 signing keypair for WebPilot formatter / blocklist
 * release signing. Writes:
 *
 *   - private key  -> ~/.webpilot-signing-key  (0o600, PEM, PKCS#8)
 *   - public key   -> accessibility-tree-formatters/PUBKEY.pem (PEM, SPKI)
 *
 * The public key is committed to the repo and embedded into the daemon
 * binary so that on first boot the verifier has a trust anchor without
 * fetching anything from the network.
 *
 * Refuses to overwrite an existing private key — key rotation is a
 * deliberate action. Delete the old file first if you really mean it.
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

function publicKeyPath() {
  return path.join(repoRoot(), 'accessibility-tree-formatters', 'PUBKEY.pem');
}

function abort(msg) {
  console.error('ERROR: ' + msg);
  process.exit(1);
}

function main() {
  const privPath = privateKeyPath();
  const pubPath = publicKeyPath();

  if (fs.existsSync(privPath)) {
    abort(
      'Private key already exists at ' + privPath + '\n' +
      'Refusing to overwrite. To rotate the key, delete this file first\n' +
      '(and follow the key rotation procedure in CONTRIBUTING.md).'
    );
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  fs.mkdirSync(path.dirname(privPath), { recursive: true });
  fs.writeFileSync(privPath, privPem, { mode: 0o600 });
  try {
    // Belt-and-braces — writeFileSync mode is advisory on Windows; chmod
    // is a no-op there but matters on macOS / Linux.
    fs.chmodSync(privPath, 0o600);
  } catch (_e) { /* ignore */ }

  fs.mkdirSync(path.dirname(pubPath), { recursive: true });
  fs.writeFileSync(pubPath, pubPem, 'utf8');

  console.log('Generated Ed25519 signing keypair.');
  console.log('  private: ' + privPath + ' (0o600)');
  console.log('  public:  ' + pubPath);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Commit ' + path.relative(repoRoot(), pubPath));
  console.log('  2. Base64-encode the private key and add it to GitHub Actions');
  console.log('     as the WEBPILOT_SIGNING_KEY_BASE64 repo secret. On *nix:');
  console.log('       base64 -w0 ' + privPath);
  console.log('     On Windows PowerShell:');
  console.log('       [Convert]::ToBase64String([IO.File]::ReadAllBytes("' + privPath + '"))');
  console.log('  3. Run `node scripts/sign-formatters.js` to produce signed manifests.');
}

main();
