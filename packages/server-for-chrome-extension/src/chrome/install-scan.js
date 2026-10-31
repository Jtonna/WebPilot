'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * install-scan.js — find which Chrome profile an extension install lives in
 * by looking for its `installId` in that profile's extension storage (#138).
 *
 * The extension keeps `webpilot.installId` in `chrome.storage.local`, which
 * Chrome persists as a LevelDB under
 *   `<userDataDir>/<profileDir>/Local Extension Settings/<extensionId>/`.
 * The value is written as UTF-8 JSON text, so a plain byte search of the
 * `*.log` / `*.ldb` files finds it without parsing LevelDB.
 *
 * Safety rules (this reads inside the user's real Chrome profile tree):
 *   - `extensionId` and `installId` are validated BEFORE any filesystem call;
 *     invalid input returns no matches and touches nothing.
 *   - profile directory names containing `/`, `\`, `..`, `:` or NUL are
 *     rejected, so no path can escape `userDataDir`.
 *   - directories and files are `lstat`ed and symlinks are skipped.
 *   - read-only; only `*.log` and `*.ldb` files are opened (never `LOCK`,
 *     `CURRENT`, `MANIFEST-*`).
 *   - per-file and total byte caps; files over the per-file cap are skipped,
 *     and the scan stops (`truncated: true`) once the total cap would be
 *     exceeded.
 *   - per-file errors (locked/missing/unreadable) are counted as `skipped`,
 *     never thrown.
 *   - this module never logs; callers log counts only (never paths or
 *     installIds).
 *
 * A small in-module cache keyed by installId (+ extensionId + userDataDir)
 * remembers results that did NOT resolve to exactly one profile for 30s, so
 * the extension's hello retries (3s / 10s / 30s) don't rescan the disk.
 */

const EXTENSION_ID_RE = /^[a-p]{32}$/;
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMITS = Object.freeze({
  perFileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
});

const CACHE_TTL_MS = 30 * 1000;
const _cache = new Map(); // key -> { at, result }

function isValidExtensionId(value) {
  return typeof value === 'string' && EXTENSION_ID_RE.test(value);
}

function isValidInstallId(value) {
  return typeof value === 'string' && INSTALL_ID_RE.test(value);
}

function isSafeProfileDir(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !name.includes(':') &&
    !name.includes('\0')
  );
}

function emptyResult() {
  return { matches: [], scanned: 0, skipped: 0, truncated: false };
}

function cloneResult(result, cached) {
  return {
    matches: result.matches.slice(),
    scanned: result.scanned,
    skipped: result.skipped,
    truncated: result.truncated,
    cached,
  };
}

/** Clear the negative cache. Exported for tests. */
function clearScanCache() {
  _cache.clear();
}

/** True when `p` exists and is a real directory (not a symlink). */
function isRealDirectory(p) {
  const st = fs.lstatSync(p);
  return !st.isSymbolicLink() && st.isDirectory();
}

/**
 * Read up to `size` bytes of `filePath`. Reads only what was measured by
 * lstat, so a file growing under us can't blow the cap.
 */
function readCapped(filePath, size) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = fs.readSync(fd, buf, offset, size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    return offset < size ? buf.subarray(0, offset) : buf;
  } finally {
    try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
  }
}

/** `.log` first (newest writes), then `.ldb` newest-numbered first. */
function orderCandidateFiles(names) {
  const logs = names.filter((n) => n.toLowerCase().endsWith('.log')).sort().reverse();
  const ldbs = names.filter((n) => n.toLowerCase().endsWith('.ldb')).sort().reverse();
  return logs.concat(ldbs);
}

/**
 * Scan each profile's extension storage for `installId`.
 *
 * @param {{ userDataDir: string, profileDirs: string[], extensionId: string,
 *           installId: string,
 *           limits?: { perFileBytes?: number, totalBytes?: number },
 *           now?: () => number }} opts
 * @returns {{ matches: string[], scanned: number, skipped: number,
 *             truncated: boolean, cached?: boolean }}
 *   `matches` lists profile directory names (each profile at most once).
 *   `scanned` counts files read; `skipped` counts files (or extension dirs)
 *   that could not be read or were over the per-file cap.
 */
function scanForInstallId(opts) {
  const {
    userDataDir,
    profileDirs,
    extensionId,
    installId,
    limits = {},
    now = Date.now,
  } = opts || {};

  // Validate everything that shapes a path or the needle BEFORE touching fs.
  if (!isValidExtensionId(extensionId) || !isValidInstallId(installId)) {
    return emptyResult();
  }
  if (typeof userDataDir !== 'string' || userDataDir.length === 0) {
    return emptyResult();
  }
  if (!Array.isArray(profileDirs) || profileDirs.length === 0) {
    return emptyResult();
  }

  const perFileBytes = Number.isFinite(limits.perFileBytes) ? limits.perFileBytes : DEFAULT_LIMITS.perFileBytes;
  const totalBytes = Number.isFinite(limits.totalBytes) ? limits.totalBytes : DEFAULT_LIMITS.totalBytes;

  const cacheKey = `${installId.toLowerCase()}\0${extensionId}\0${userDataDir}`;
  const hit = _cache.get(cacheKey);
  if (hit) {
    if (now() - hit.at < CACHE_TTL_MS) return cloneResult(hit.result, true);
    _cache.delete(cacheKey);
  }

  // The extension writes a lowercase crypto.randomUUID(); search for the
  // value exactly as supplied (it is what the extension sent us).
  const needle = Buffer.from(installId, 'utf8');
  const result = emptyResult();
  let totalRead = 0;

  outer:
  for (const dir of profileDirs) {
    if (!isSafeProfileDir(dir)) continue;

    const profilePath = path.join(userDataDir, dir);
    const settingsPath = path.join(profilePath, 'Local Extension Settings');
    const extPath = path.join(settingsPath, extensionId);

    let entries;
    try {
      if (!isRealDirectory(profilePath) || !isRealDirectory(settingsPath) || !isRealDirectory(extPath)) {
        continue;
      }
      entries = fs.readdirSync(extPath);
    } catch (e) {
      // Missing extension storage is the normal "not installed here" case.
      if (!e || e.code !== 'ENOENT') result.skipped += 1;
      continue;
    }

    for (const name of orderCandidateFiles(entries)) {
      const filePath = path.join(extPath, name);
      let buf;
      try {
        const st = fs.lstatSync(filePath);
        if (st.isSymbolicLink() || !st.isFile()) continue;
        if (st.size > perFileBytes) {
          result.skipped += 1;
          continue;
        }
        if (totalRead + st.size > totalBytes) {
          result.truncated = true;
          break outer;
        }
        totalRead += st.size;
        buf = readCapped(filePath, st.size);
      } catch (_e) {
        // EBUSY / EPERM / ENOENT / EACCES (and anything else): tolerate.
        result.skipped += 1;
        continue;
      }
      result.scanned += 1;
      if (buf.indexOf(needle) !== -1) {
        result.matches.push(dir);
        continue outer; // count a profile once, however many occurrences
      }
    }
  }

  if (result.matches.length !== 1) {
    _cache.set(cacheKey, { at: now(), result: cloneResult(result, false) });
  }
  return cloneResult(result, false);
}

module.exports = {
  scanForInstallId,
  clearScanCache,
  isValidExtensionId,
  isValidInstallId,
  DEFAULT_LIMITS,
  CACHE_TTL_MS,
};
