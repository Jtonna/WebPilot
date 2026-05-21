'use strict';

/**
 * Cryptographic verification of formatter + baseline-blocklist releases.
 *
 * Threat model: even if an attacker takes over the maintainer's GitHub
 * account, they cannot push a malicious formatter that executes inside
 * the daemon — because the daemon refuses to write any file whose
 * SHA-256 does not match the hash claimed by a `signed-manifest.json`
 * that itself was Ed25519-signed by the (offline) signing key.
 *
 * The public half of the signing key (`PUBKEY.pem`) is committed to the
 * repo AND bundled into the pkg binary as a snapshot asset, so a fresh
 * install never has to trust the network to learn it.
 *
 * Backward compatibility: this module exposes a `loadSignedManifest()`
 * helper that returns `{signed, sigB64}` on success, or `null` (with a
 * warning logged) if the remote bundle returns 404 for the signed
 * manifest or its signature. Callers should treat the null case as
 * "skip this update tick" — fail-skip, not fail-close — so that users
 * running a release that pre-dates the signing infrastructure don't get
 * locked out of their existing data.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBKEY_FILENAME = 'PUBKEY.pem';

let _cachedPubKey = null;
let _cachedPubKeyPath = null;

/**
 * Stable JSON stringify — keys sorted at every level. MUST match the
 * implementation in `scripts/sign-formatters.js` byte-for-byte, because
 * the signature was computed over the stable stringification.
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
 * Candidate paths to look for PUBKEY.pem, in priority order. We try:
 *
 *   1. WEBPILOT_PUBKEY_PATH env var (escape hatch for tests + ops).
 *   2. Alongside the running binary's `dist/` (legacy pkg install).
 *   3. `process.resourcesPath` (Electron extraResources layout).
 *   4. Snapshot path under pkg: `<snapshot>/accessibility-tree-formatters/PUBKEY.pem`.
 *   5. Repo-relative dev path: `<repo>/accessibility-tree-formatters/PUBKEY.pem`.
 *
 * The first existing readable file wins. The list is deliberately
 * permissive so the verifier works in every deployment mode WebPilot
 * currently ships (pkg binary, Electron-wrapped daemon, `npm run dev`).
 */
function _pubkeyCandidates() {
  const candidates = [];
  if (process.env.WEBPILOT_PUBKEY_PATH) {
    candidates.push(process.env.WEBPILOT_PUBKEY_PATH);
  }
  // pkg snapshot — assets glob includes ../../accessibility-tree-formatters/PUBKEY.pem
  // which lands at this path inside the snapshot. __dirname inside pkg
  // resolves to /snapshot/<package>/src/lib so the relative .. .. ..
  // accessibility-tree-formatters walks back up to the repo root.
  try {
    candidates.push(path.join(__dirname, '..', '..', '..', '..', 'accessibility-tree-formatters', PUBKEY_FILENAME));
    candidates.push(path.join(__dirname, '..', '..', '..', 'accessibility-tree-formatters', PUBKEY_FILENAME));
  } catch (_e) { /* ignore */ }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'server', 'PUBKEY.pem'));
    candidates.push(path.join(process.resourcesPath, 'PUBKEY.pem'));
  }
  try {
    candidates.push(path.join(path.dirname(process.execPath), PUBKEY_FILENAME));
  } catch (_e) { /* ignore */ }
  return candidates;
}

function loadPubKey() {
  if (_cachedPubKey) return { key: _cachedPubKey, path: _cachedPubKeyPath };
  for (const candidate of _pubkeyCandidates()) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        const pem = fs.readFileSync(candidate);
        const key = crypto.createPublicKey({ key: pem, format: 'pem' });
        if (key.asymmetricKeyType !== 'ed25519') {
          console.warn(
            `[manifest-verifier] PUBKEY at ${candidate} is not Ed25519 (got ${key.asymmetricKeyType}) — skipping`
          );
          continue;
        }
        _cachedPubKey = key;
        _cachedPubKeyPath = candidate;
        return { key, path: candidate };
      }
    } catch (err) {
      console.warn(`[manifest-verifier] failed to load pubkey ${candidate}: ${err.message}`);
    }
  }
  return null;
}

/**
 * Verify that `sigB64` is a valid Ed25519 signature over `signedText`
 * under the bundled public key.
 */
function verifySignature(signedText, sigB64) {
  const loaded = loadPubKey();
  if (!loaded) {
    return { ok: false, reason: 'pubkey-not-found' };
  }
  let sig;
  try {
    sig = Buffer.from(String(sigB64).trim(), 'base64');
  } catch (e) {
    return { ok: false, reason: 'sig-decode-failed: ' + e.message };
  }
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(signedText, 'utf8'), loaded.key, sig);
  } catch (e) {
    return { ok: false, reason: 'verify-threw: ' + e.message };
  }
  if (!ok) return { ok: false, reason: 'signature-mismatch' };
  return { ok: true, pubkeyPath: loaded.path };
}

/**
 * Parse a `signed-manifest.json` body. Returns the parsed object or
 * throws on malformed input. The text MUST be the verbatim bytes
 * fetched from the network — the caller already verified the signature
 * over those exact bytes.
 */
function parseSignedManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('signed-manifest is not JSON: ' + e.message);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('signed-manifest is not an object');
  }
  if (parsed.algorithm !== 'sha256') {
    throw new Error('unsupported hash algorithm: ' + parsed.algorithm);
  }
  if (!parsed.files || typeof parsed.files !== 'object') {
    throw new Error('signed-manifest is missing "files" map');
  }
  if (!parsed.version) {
    throw new Error('signed-manifest is missing "version"');
  }
  return parsed;
}

/**
 * Fetch helper used by the updaters when pulling signed-manifest.json
 * + its .sig. Returns `null` on 404 (so the caller can fail-skip on
 * pre-signing releases) and throws on any other error.
 */
async function fetchOptionalText(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    return await res.text();
  } catch (err) {
    clearTimeout(t);
    if (err && err.name === 'AbortError') {
      throw new Error(`Timeout fetching ${url}`);
    }
    throw err;
  }
}

/**
 * Fetch the signed manifest + signature from `<base>/signed-manifest.json`,
 * verify the signature against the bundled pubkey, and return the
 * parsed bundle. Returns `null` if either file 404s — the caller MUST
 * treat that as "skip this update tick".
 *
 * Throws on any other failure (network, malformed JSON, bad signature)
 * so the updater can log it and skip writing anything.
 */
async function fetchAndVerifyManifest(baseUrl, label = 'manifest-verifier') {
  const signedUrl = baseUrl.replace(/\/+$/, '') + '/signed-manifest.json';
  const sigUrl = signedUrl + '.sig';

  const signedText = await fetchOptionalText(signedUrl);
  if (signedText === null) {
    console.warn(
      `[${label}] no signed-manifest.json at ${signedUrl} — refusing to apply unsigned update`
    );
    return null;
  }
  const sigText = await fetchOptionalText(sigUrl);
  if (sigText === null) {
    console.warn(
      `[${label}] signed-manifest.json present but ${sigUrl} returned 404 — refusing to apply`
    );
    return null;
  }

  const v = verifySignature(signedText, sigText);
  if (!v.ok) {
    throw new Error('signature verification failed: ' + v.reason);
  }

  const signed = parseSignedManifest(signedText);
  console.log(
    `[${label}] signature verified (version=${signed.version}, files=${Object.keys(signed.files).length}, pubkey=${v.pubkeyPath})`
  );
  return { signed, signedText, sigText, pubkeyPath: v.pubkeyPath };
}

/**
 * Given a file's claimed relative path + its bytes, confirm the SHA-256
 * matches the hash recorded in the signed manifest. Returns `true` /
 * `false`. The relative path lookup is exact — the manifest is the
 * authority on what files exist.
 */
function verifyFileHash(signed, relPath, bodyBuf) {
  const claimed = signed.files[relPath];
  if (!claimed || typeof claimed !== 'string') return false;
  const actual = crypto.createHash('sha256').update(bodyBuf).digest('hex');
  // timingSafeEqual is overkill here (the hash isn't a secret) but it's
  // free and stops a class of subtle compare bugs.
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(claimed, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  loadPubKey,
  verifySignature,
  parseSignedManifest,
  fetchAndVerifyManifest,
  fetchOptionalText,
  verifyFileHash,
  stableStringify,
  // exposed for tests
  _pubkeyCandidates,
};
