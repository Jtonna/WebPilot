'use strict';

const fs = require('fs');
const path = require('path');
const { getFormatterDir } = require('./service/paths');
const {
  fetchAndVerifyManifest,
  fetchOptionalText,
  verifyFileHash,
} = require('./lib/manifest-verifier');

// GitHub raw content base URL — derived from the embedded release-info.json.
//
// At build time the CI workflow writes
//   packages/server-for-chrome-extension/release-info.json
// and it is bundled into the pkg binary via the `assets` list.  The file
// contains { ref, channel, version, builtAt } where `ref` is the git tag
// the binary was published against (e.g. "v2.0.4" or "v2.0.4-nightly.20260530").
//
// This lets the auto-updater fetch formatter manifests from the exact ref that
// produced the running binary instead of always tracking `main`.  Stable users
// get formatters frozen at their stable tag; nightly users get formatters frozen
// at their nightly tag.
//
// Fallback: if the file is absent (dev checkout, legacy build, or any parse
// error) we fall back to "main" — identical to the pre-epic behaviour.
const GITHUB_RAW_BASE = (() => {
  const REPO_BASE = 'https://raw.githubusercontent.com/Jtonna/WebPilot';
  const FORMATTER_PATH = 'accessibility-tree-formatters';
  try {
    // __dirname resolves correctly both in plain Node and inside a pkg snapshot.
    // release-info.json lives one directory up from src/ (i.e. at the package root).
    const infoPath = path.join(__dirname, '..', 'release-info.json');
    const raw = fs.readFileSync(infoPath, 'utf8');
    const info = JSON.parse(raw);
    if (info && typeof info.ref === 'string' && info.ref.length > 0) {
      return `${REPO_BASE}/${info.ref}/${FORMATTER_PATH}`;
    }
    console.warn('[formatter-updater] release-info.json missing "ref" field — falling back to main');
  } catch (_err) {
    // File absent in dev/legacy builds — silent fallback (not a warning-worthy condition).
    if (_err.code !== 'ENOENT') {
      console.warn('[formatter-updater] release-info.json missing or malformed — falling back to main');
    }
  }
  return `${REPO_BASE}/main/${FORMATTER_PATH}`;
})();

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

  // Persist the verified signed manifest + signature to disk. This is the
  // trust anchor for any future boot-time re-verification: if the on-disk
  // formatter files don't match these hashes, the daemon knows the cache
  // has drifted. Writing this on EVERY successful verification (not just
  // when files update) covers two cases:
  //   1. Fresh install — bootstrap the signed manifest alongside the
  //      bundled formatter files.
  //   2. Upgrader from a pre-signing release — formatters/ has the
  //      formatter files already but no signed-manifest.json, because
  //      the previous daemon wrote files without one. This lazy-
  //      bootstraps the missing trust anchor without requiring a
  //      version bump.
  try {
    fs.mkdirSync(formatterDir, { recursive: true });
    fs.writeFileSync(path.join(formatterDir, 'signed-manifest.json'), signedBundle.signedText, 'utf8');
    fs.writeFileSync(path.join(formatterDir, 'signed-manifest.json.sig'), signedBundle.sigText, 'utf8');
  } catch (err) {
    console.warn(`[formatter-updater] failed to persist signed manifest: ${err.message}`);
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
