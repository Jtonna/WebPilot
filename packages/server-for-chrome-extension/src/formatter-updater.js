'use strict';

const fs = require('fs');
const path = require('path');
const { getFormatterDir } = require('./service/paths');
const {
  fetchAndVerifyManifest,
  fetchOptionalText,
  verifyFileHash,
} = require('./lib/manifest-verifier');

// GitHub raw content base URL — hardcoded to this repo
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Jtonna/WebPilot/main/accessibility-tree-formatters';

let formatterManager = null;

function init(manager) {
  formatterManager = manager;
}

// This updater intentionally manages only the auto-updated formatters/ directory.
// The custom-formatters/ directory is never read or written here — it is managed
// exclusively by the user and loaded by formatter-manager.js alongside this dir.
//
// Supply-chain integrity: every released formatter bundle ships a
// `signed-manifest.json` + `.sig` produced by `scripts/sign-formatters.js`.
// The daemon refuses to write any file whose SHA-256 does not match the
// hash recorded in the signed manifest, and refuses to consider a
// signed manifest at all unless its Ed25519 signature verifies against
// the bundled `PUBKEY.pem`. See `lib/manifest-verifier.js`.
//
// Pre-signing releases (no signed-manifest.json on the branch) are
// handled fail-skip: log a warning, leave the on-disk formatters alone,
// and try again next tick. This keeps existing installs from getting
// stuck if they predate the first signed release.
async function checkForUpdates() {
  const formatterDir = getFormatterDir();
  const localManifestPath = path.join(formatterDir, 'manifest.json');

  // Read local manifest version
  let localVersion = '0';
  if (fs.existsSync(localManifestPath)) {
    try {
      const localManifest = JSON.parse(fs.readFileSync(localManifestPath, 'utf8'));
      localVersion = localManifest.version;
    } catch (err) {
      console.warn('[formatter-updater] Failed to read local manifest:', err.message);
    }
  }

  let signedBundle;
  try {
    signedBundle = await fetchAndVerifyManifest(GITHUB_RAW_BASE, 'formatter-updater');
  } catch (err) {
    console.error(`[formatter-updater] signature check failed: ${err.message} — refusing update`);
    return { updated: false, error: 'signature: ' + err.message };
  }
  if (!signedBundle) {
    // 404 on signed-manifest or .sig — release predates the signing
    // infrastructure (or the branch is mid-deploy). Fail-skip.
    return { updated: false, skipped: 'no-signed-manifest' };
  }

  // The signed manifest is now trusted. From here on, we ONLY read
  // file hashes out of `signedBundle.signed.files` and refuse to write
  // anything not listed there.
  const signed = signedBundle.signed;
  const claimedHashes = signed.files;

  if (!claimedHashes['manifest.json']) {
    console.error('[formatter-updater] signed manifest does not cover manifest.json — refusing');
    return { updated: false, error: 'signed manifest missing manifest.json hash' };
  }

  // Fetch the actual manifest.json and check its hash against the signed bundle.
  let manifestText;
  try {
    manifestText = await fetchOptionalText(`${GITHUB_RAW_BASE}/manifest.json`);
  } catch (err) {
    console.error(`[formatter-updater] manifest fetch failed: ${err.message}`);
    return { updated: false, error: err.message };
  }
  if (manifestText === null) {
    console.error('[formatter-updater] manifest.json missing on remote — refusing');
    return { updated: false, error: 'manifest.json missing on remote' };
  }
  const manifestBuf = Buffer.from(manifestText, 'utf8');
  if (!verifyFileHash(signed, 'manifest.json', manifestBuf)) {
    console.error('[formatter-updater] manifest.json hash mismatch — refusing update');
    return { updated: false, error: 'manifest.json hash mismatch' };
  }

  let remoteManifest;
  try {
    remoteManifest = JSON.parse(manifestText);
  } catch (err) {
    console.error('[formatter-updater] manifest.json parse failed:', err.message);
    return { updated: false, error: 'manifest parse: ' + err.message };
  }

  if (remoteManifest.version === localVersion) {
    console.log(`[formatter-updater] Already up to date (version ${localVersion})`);
    return { updated: false, currentVersion: localVersion };
  }

  console.log(`[formatter-updater] Update available: ${localVersion} -> ${remoteManifest.version}`);

  // Build the list of files to fetch from the SIGNED manifest's keys,
  // intersected with what the regular manifest claims. We don't trust
  // the regular manifest's file list independently — the signed
  // manifest is the authority on what's allowed.
  const declaredFiles = Array.isArray(remoteManifest.files)
    ? remoteManifest.files
    : remoteManifest.default
      ? [remoteManifest.default]
      : [];

  for (const file of declaredFiles) {
    if (!claimedHashes[file]) {
      console.error(`[formatter-updater] manifest declares "${file}" but signed-manifest has no hash for it — refusing update`);
      return { updated: false, error: `unsigned file in manifest: ${file}` };
    }
  }

  // Buffer the verified file bytes in memory before writing anything
  // to disk. That way a hash mismatch halfway through doesn't leave
  // the on-disk formatter tree in a half-updated, partially-attacker-
  // controlled state.
  const verifiedFiles = [];
  verifiedFiles.push({ rel: 'manifest.json', body: manifestBuf });

  for (const file of declaredFiles) {
    let body;
    try {
      const text = await fetchOptionalText(`${GITHUB_RAW_BASE}/${file}`);
      if (text === null) {
        console.error(`[formatter-updater] file "${file}" missing on remote — refusing update`);
        return { updated: false, error: `missing on remote: ${file}` };
      }
      body = Buffer.from(text, 'utf8');
    } catch (err) {
      console.error(`[formatter-updater] failed to fetch "${file}": ${err.message}`);
      return { updated: false, error: err.message };
    }
    if (!verifyFileHash(signed, file, body)) {
      console.error(`[formatter-updater] hash mismatch for "${file}" — refusing update`);
      return { updated: false, error: `hash mismatch: ${file}` };
    }
    verifiedFiles.push({ rel: file, body });
  }

  // All fetches verified. Commit to disk.
  for (const { rel, body } of verifiedFiles) {
    const destPath = path.join(formatterDir, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, body);
  }

  console.log(
    `[formatter-updater] Updated from version ${localVersion} to ${remoteManifest.version} ` +
      `(${verifiedFiles.length} files, signature verified)`
  );

  // Reload formatters in memory
  if (formatterManager) {
    formatterManager.reload();
  }

  return { updated: true, fromVersion: localVersion, toVersion: remoteManifest.version };
}

module.exports = { init, checkForUpdates };
