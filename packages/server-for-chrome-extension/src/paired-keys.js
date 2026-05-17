'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { getDataDir } = require('./service/paths');

/**
 * Constant-time string equality. Used for every comparison of a caller-supplied
 * API key against a stored key, so a string-compare short-circuit on the first
 * differing byte cannot be measured to recover the secret. Returns false for
 * non-strings or strings of differing length (length is not secret — the stored
 * keys are all the same width — so the early return is safe).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function getKeysPath() {
  return path.join(getDataDir(), 'config', 'paired-keys.json');
}

function getPendingPairingsPath() {
  return path.join(getDataDir(), 'config', 'pending-pairings.json');
}

// Pending-pairing TTL: pending entries become "expired" after this many ms of
// inactivity. The agent can simply call request_pairing again to mint a fresh
// pairingId. See QOL review server I6.
const PENDING_PAIRING_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Garbage-collect terminal / very-old entries after this many ms.
const PAIRING_HARD_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d
// Unused-key expiry: a paired-keys entry whose `lastAccessed` is still null
// more than this many ms after `createdAt` is auto-revoked by
// cleanupUnusedKeys(). Use case: user opened the pair-agent modal, clicked
// Copy (which commits the entry so it survives modal close), but the AI agent
// never actually made a single tool call. The key is dead weight in the
// agents list — drop it. Used keys (any tool call → touchKey() sets
// lastAccessed) are kept indefinitely.
const UNUSED_KEY_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48h

/**
 * Listener registry. Other modules (server.js) can subscribe to pairing events
 * so they can broadcast `paired_agents_list` to the extension over WS, push
 * updates to the web UI over its WS, etc.
 *
 * Events:
 *   'approved' — payload: the approved pairing entry
 *   'denied'   — payload: the denied pairing entry
 *   'requested'— payload: the new pending entry (only fires when freshly created)
 */
const listeners = { approved: [], denied: [], requested: [] };

function onPairingEvent(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
}

function emitPairingEvent(event, payload) {
  const fns = listeners[event] || [];
  for (const fn of fns) {
    try {
      fn(payload);
    } catch (e) {
      console.log(`[pairing] listener for "${event}" threw: ${e.message}`);
    }
  }
}

// In-memory cache of paired-keys.json. validateKey is called twice per
// authenticated MCP tool call (auth gate + resolveTargetProfile), and each
// call previously hit the disk. The cache is invalidated automatically on
// every saveKeys() write; reads also stat the file and reload when its
// mtime changes, so an external edit between writes is still picked up on
// the next read. Note: filesystem mtime resolution is 1 second on some
// filesystems, so two writes from two processes within the same second
// might not be detected — acceptable for our single-process server model.
let cache = null;
let cacheMTime = null;

function invalidateCache() {
  cache = null;
  cacheMTime = null;
}

/**
 * Reads paired-keys.json from the config directory.
 * Returns a parsed array of key entries, or an empty array if the file does not exist.
 *
 * Backed by an in-memory cache that is refreshed when the file's mtime
 * changes on disk; populated lazily on first read.
 */
function loadKeys() {
  const keysPath = getKeysPath();
  try {
    if (!fs.existsSync(keysPath)) {
      cache = [];
      cacheMTime = null;
      return cache;
    }
    const stat = fs.statSync(keysPath);
    if (cache !== null && cacheMTime !== null && stat.mtimeMs === cacheMTime) {
      return cache;
    }
    const raw = fs.readFileSync(keysPath, 'utf8');
    cache = JSON.parse(raw);
    cacheMTime = stat.mtimeMs;
    return cache;
  } catch (e) {
    // Ignore read/parse/stat errors — treat as empty and clear cache so
    // the next call retries the disk.
    cache = null;
    cacheMTime = null;
    return [];
  }
}

/**
 * Writes the keys array to paired-keys.json.
 * Ensures the config directory exists before writing.
 *
 * Updates the in-memory cache and mtime stamp so subsequent loadKeys()
 * calls return the just-written value without re-reading the disk.
 *
 * @param {Array} keys
 */
function saveKeys(keys) {
  const keysPath = getKeysPath();
  fs.mkdirSync(path.dirname(keysPath), { recursive: true });
  fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2), 'utf8');
  cache = keys;
  try {
    const stat = fs.statSync(keysPath);
    cacheMTime = stat.mtimeMs;
  } catch (e) {
    cacheMTime = null;
  }
}

/**
 * Generates a new random UUID to use as an API key.
 *
 * @returns {string}
 */
function generateKey() {
  return crypto.randomUUID();
}

/**
 * Generates a new key for the given agent name, appends it to the store, saves, and returns the key string.
 *
 * @param {string} agentName
 * @param {string|null} [profileId] Optional Chrome profile directory name to
 *   bind to this key. Used by v1.5+ for per-agent profile routing; stored as
 *   `null` for legacy entries.
 * @param {string|null} [source] Optional provenance tag stored on the entry
 *   (e.g. 'web-ui-direct' when the operator pre-provisions a key from the
 *   pair-agent modal without going through request_pairing first). Stored as
 *   `null` for entries minted via the classic approval path so existing rows
 *   are unaffected.
 * @returns {string} The generated key
 */
function addKey(agentName, profileId = null, source = null) {
  const keys = loadKeys();
  const key = generateKey();
  const entry = {
    key,
    agentName,
    createdAt: new Date().toISOString(),
    profileId: profileId || null,
  };
  if (source) entry.source = source;
  keys.push(entry);
  saveKeys(keys);
  return key;
}

/**
 * Direct UI pre-provision: mint a paired-keys entry without going through the
 * request_pairing → approval handshake. Used by `POST /api/ui/agents` when the
 * operator wants to hand an AI agent a pre-approved key from the web UI. The
 * caller is responsible for validating `agentName` and `profileId` against
 * known profiles before invoking this — see server.js.
 *
 * Mirrors the side effects of approvePairing's `addKey()` call: same key
 * generation routine (`generateKey` via `addKey`), same on-disk schema, plus
 * a `source: 'web-ui-direct'` tag so the provenance is auditable.
 *
 * @param {{ agentName: string, profileId: string }} params
 * @returns {{ apiKey: string, agentName: string, profileId: string, createdAt: string }}
 */
function createPairedAgent({ agentName, profileId }) {
  const key = addKey(agentName, profileId || null, 'web-ui-direct');
  const entry = loadKeys().find((e) => e.key === key) || null;
  console.log(
    `[pairing:createPairedAgent] minted direct key for agent "${agentName}" ` +
      `(profileId="${profileId || ''}", key=${key.slice(0, 8)}...)`
  );
  return {
    apiKey: key,
    agentName,
    profileId: profileId || null,
    createdAt: entry ? entry.createdAt : new Date().toISOString(),
  };
}

/**
 * Checks whether apiKey exists in the store.
 * Returns the matching entry object, or null if not found.
 *
 * @param {string} apiKey
 * @returns {object|null}
 */
function validateKey(apiKey) {
  const keys = loadKeys();
  return keys.find((entry) => constantTimeEqual(entry.key, apiKey)) || null;
}

/**
 * Renames the agent associated with the given apiKey.
 * Returns true if the entry was found and renamed, false otherwise.
 *
 * @param {string} apiKey
 * @param {string} newName
 * @returns {boolean}
 */
function renameKey(apiKey, newName) {
  const keys = loadKeys();
  const entry = keys.find((e) => constantTimeEqual(e.key, apiKey));
  if (!entry) return false;
  entry.agentName = newName;
  saveKeys(keys);
  return true;
}

/**
 * Updates the profileId binding for the given apiKey. Used by the Web UI to
 * re-bind an existing agent's tool-call routing to a different Chrome
 * profile. Tool-call routing is a per-call lookup (see
 * `mcp-handler.resolveTargetProfile`) so a field flip is sufficient — no
 * sockets need to be torn down, no extension reload is required.
 *
 * @param {string} apiKey
 * @param {string} profileId Chrome profile directoryName to bind to.
 * @returns {boolean} true if the entry was found and updated, false otherwise.
 */
function updateProfileBinding(apiKey, profileId) {
  const keys = loadKeys();
  const entry = keys.find((e) => constantTimeEqual(e.key, apiKey));
  if (!entry) return false;
  entry.profileId = profileId || null;
  saveKeys(keys);
  return true;
}

/**
 * Updates the lastAccessed timestamp for the given apiKey.
 *
 * @param {string} apiKey
 */
function touchKey(apiKey) {
  const keys = loadKeys();
  const entry = keys.find((e) => constantTimeEqual(e.key, apiKey));
  if (entry) {
    entry.lastAccessed = new Date().toISOString();
    saveKeys(keys);
  }
}

/**
 * Removes the entry with the given apiKey from the store.
 * Returns true if an entry was removed, false if no matching key was found.
 *
 * @param {string} apiKey
 * @returns {boolean}
 */
function revokeKey(apiKey) {
  const keys = loadKeys();
  const filtered = keys.filter((entry) => !constantTimeEqual(entry.key, apiKey));
  if (filtered.length === keys.length) {
    return false;
  }
  saveKeys(filtered);
  return true;
}

/**
 * Returns all key entries with the key truncated to the first 8 characters followed by '...'.
 *
 * @returns {Array<{ agentName: string, createdAt: string, key: string }>}
 */
function listKeys() {
  const keys = loadKeys();
  return keys.map((entry) => ({
    agentName: entry.agentName,
    createdAt: entry.createdAt,
    lastAccessed: entry.lastAccessed || null,
    key: entry.key,
    keyDisplay: entry.key.slice(0, 8) + '...',
    profileId: entry.profileId || null,
  }));
}

/**
 * Loads the pending-pairings array from disk.
 * Returns empty array on missing file or parse error.
 *
 * @returns {Array}
 */
function loadPendingPairings() {
  const filePath = getPendingPairingsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    console.log(`[pairing] Failed to load pending-pairings.json: ${e.message}`);
  }
  return [];
}

/**
 * Persists the pending-pairings array to disk. Creates the config dir if needed.
 *
 * @param {Array} pairings
 */
function savePendingPairings(pairings) {
  const filePath = getPendingPairingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(pairings, null, 2), 'utf8');
}

/**
 * Idempotent pairing request. If an existing 'pending' or 'approved' entry
 * for this agentName exists, returns it. Otherwise mints a new pending entry
 * with a fresh UUID pairingId, persists, and returns it.
 *
 * @param {string} agentName
 * @returns {{ pairingId: string, status: string, apiKey?: string, created: boolean }}
 *   `created` is true if a fresh pending entry was just minted.
 */
function requestPairing(agentName) {
  const pairings = loadPendingPairings();
  const now = Date.now();
  let dirty = false;
  const existing = pairings.find((p) => {
    if (p.agentName !== agentName) return false;
    if (p.status === 'approved') return true;
    if (p.status === 'pending') {
      // Skip pending entries that have aged past the TTL — they should be
      // treated as if absent. Mark them expired in-place so the store
      // reflects reality.
      if (p.expiresAt && p.expiresAt < now) {
        console.log(
          `[pairing:requestPairing] expiring stale pending entry for "${agentName}" ` +
            `(pairingId=${p.pairingId}, expiresAt=${new Date(p.expiresAt).toISOString()})`
        );
        p.status = 'expired';
        p.decidedAt = new Date(now).toISOString();
        dirty = true;
        return false;
      }
      return true;
    }
    return false;
  });
  if (existing) {
    if (dirty) savePendingPairings(pairings);
    console.log(
      `[pairing:requestPairing] returning existing ${existing.status} entry ` +
        `for agent "${agentName}" (pairingId=${existing.pairingId})`
    );
    return {
      pairingId: existing.pairingId,
      status: existing.status,
      apiKey: existing.apiKey,
      created: false,
    };
  }
  const entry = {
    pairingId: crypto.randomUUID(),
    agentName,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: now + PENDING_PAIRING_TTL_MS,
  };
  pairings.push(entry);
  savePendingPairings(pairings);
  console.log(
    `[pairing:requestPairing] created new pending entry for agent "${agentName}" ` +
      `(pairingId=${entry.pairingId}, expiresAt=${new Date(entry.expiresAt).toISOString()})`
  );
  emitPairingEvent('requested', entry);
  return { pairingId: entry.pairingId, status: entry.status, created: true };
}

/**
 * Look up a pairing by id. Returns { status, apiKey? } or null if not found.
 *
 * @param {string} pairingId
 * @returns {{ status: string, apiKey?: string } | null}
 */
function checkPairingStatus(pairingId) {
  const pairings = loadPendingPairings();
  const entry = pairings.find((p) => p.pairingId === pairingId);
  if (!entry) {
    console.log(`[pairing:checkPairingStatus] pairingId=${pairingId} not found`);
    return null;
  }
  // Lazy expiration: a pending entry past expiresAt becomes 'expired' on read.
  if (entry.status === 'pending' && entry.expiresAt && entry.expiresAt < Date.now()) {
    console.log(
      `[pairing:checkPairingStatus] pairingId=${pairingId} expired ` +
        `(expiresAt=${new Date(entry.expiresAt).toISOString()}) — marking expired`
    );
    entry.status = 'expired';
    entry.decidedAt = new Date().toISOString();
    savePendingPairings(pairings);
    return { status: 'expired' };
  }
  console.log(
    `[pairing:checkPairingStatus] pairingId=${pairingId} status=${entry.status}`
  );
  const result = { status: entry.status };
  if (entry.apiKey) result.apiKey = entry.apiKey;
  return result;
}

/**
 * Approve a pending pairing. Mints a real API key via addKey(), sets status='approved',
 * stamps apiKey + decidedAt, persists, and returns the updated entry.
 * If the pairing is already approved, returns it unchanged (idempotent).
 *
 * @param {string} pairingId
 * @param {{ profileId?: string|null }} [options] Optional approval metadata.
 *   `profileId` — Chrome profile-directory name that the operator chose for
 *   this agent in the UI. Persisted on both the pending-pairings entry and
 *   the minted paired-keys entry so v1.5+ per-agent routing can use it.
 * @returns {object | null} The approved entry, or null when the pairing is in
 *   a terminal non-approved state (denied / expired) or does not exist.
 */
function approvePairing(pairingId, options = {}) {
  const profileId = (options && options.profileId) || null;
  const pairings = loadPendingPairings();
  const entry = pairings.find((p) => p.pairingId === pairingId);
  if (!entry) {
    console.log(`[pairing] approvePairing: pairingId=${pairingId} not found`);
    return null;
  }
  if (entry.status === 'approved') {
    console.log(
      `[pairing] approvePairing: pairingId=${pairingId} already approved, returning existing`
    );
    return entry;
  }
  if (entry.status === 'denied') {
    console.log(
      `[pairing] approvePairing: pairingId=${pairingId} is denied, cannot approve`
    );
    return null;
  }
  if (entry.status === 'expired') {
    console.log(
      `[pairing] approvePairing: pairingId=${pairingId} is expired, cannot approve`
    );
    return null;
  }
  const key = addKey(entry.agentName, profileId);
  entry.status = 'approved';
  entry.apiKey = key;
  entry.profileId = profileId;
  entry.decidedAt = new Date().toISOString();
  savePendingPairings(pairings);
  console.log(
    `[pairing] approvePairing: pairingId=${pairingId} approved for agent "${entry.agentName}", ` +
      `key=${key.slice(0, 8)}..., profileId="${profileId || ''}"`
  );
  emitPairingEvent('approved', entry);
  return entry;
}

/**
 * Deny a pending pairing. Sets status='denied', stamps decidedAt, persists.
 *
 * Idempotent on `denied`. Returns null when the pairing is in a non-deny-able
 * terminal state (approved / expired) or does not exist.
 *
 * @param {string} pairingId
 * @returns {object | null}
 */
function denyPairing(pairingId) {
  const pairings = loadPendingPairings();
  const entry = pairings.find((p) => p.pairingId === pairingId);
  if (!entry) {
    console.log(`[pairing] denyPairing: pairingId=${pairingId} not found`);
    return null;
  }
  if (entry.status === 'denied') {
    console.log(`[pairing] denyPairing: pairingId=${pairingId} already denied`);
    return entry;
  }
  if (entry.status === 'approved') {
    console.log(
      `[pairing] denyPairing: pairingId=${pairingId} is approved, cannot deny`
    );
    return null;
  }
  if (entry.status === 'expired') {
    console.log(
      `[pairing] denyPairing: pairingId=${pairingId} is expired, cannot deny`
    );
    return null;
  }
  entry.status = 'denied';
  entry.decidedAt = new Date().toISOString();
  savePendingPairings(pairings);
  console.log(
    `[pairing] denyPairing: pairingId=${pairingId} denied for agent "${entry.agentName}"`
  );
  emitPairingEvent('denied', entry);
  return entry;
}

/**
 * @returns {Array} all entries currently in 'pending' status
 */
function listPendingPairings() {
  return loadPendingPairings().filter((p) => p.status === 'pending');
}

/**
 * @returns {Array} all pairing entries (pending + approved + denied)
 */
function listAllPairings() {
  return loadPendingPairings();
}

/**
 * Walk the pending-pairings store and:
 *   1. Mark any 'pending' entry past expiresAt as 'expired'.
 *   2. Drop any entry older than PAIRING_HARD_TTL_MS (terminal states).
 *
 * Designed to be called periodically (e.g. once an hour) and once at startup.
 * Returns a small summary for logging.
 */
function cleanupExpiredPairings() {
  const pairings = loadPendingPairings();
  const now = Date.now();
  const cutoff = now - PAIRING_HARD_TTL_MS;
  let expired = 0;
  let dropped = 0;
  const kept = [];
  for (const entry of pairings) {
    // Hard drop: anything created longer ago than the hard TTL is purged.
    const created = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
    if (Number.isFinite(created) && created < cutoff) {
      dropped += 1;
      continue;
    }
    // Lazy expire: pending past expiresAt becomes 'expired'.
    if (entry.status === 'pending' && entry.expiresAt && entry.expiresAt < now) {
      entry.status = 'expired';
      entry.decidedAt = new Date(now).toISOString();
      expired += 1;
    }
    kept.push(entry);
  }
  if (expired || dropped || kept.length !== pairings.length) {
    savePendingPairings(kept);
    console.log(
      `[pairing:cleanup] expired=${expired} dropped=${dropped} kept=${kept.length}`
    );
  }
  return { expired, dropped, kept: kept.length };
}

/**
 * Prune terminal-state pending-pairings entries (status === 'denied' or
 * 'expired') that are older than `maxAgeDays`. Designed for periodic
 * maintenance so the on-disk JSON store doesn't grow unbounded as denials
 * and expirations accumulate.
 *
 * Touch matrix:
 *   - pending  → ALWAYS preserved (own 24h TTL flow via cleanupExpiredPairings)
 *   - approved → ALWAYS preserved (active credential — dropping would log the
 *                agent out unexpectedly)
 *   - denied   → dropped when age > maxAgeDays
 *   - expired  → dropped when age > maxAgeDays
 *
 * Age is measured from the entry's most recent state-change timestamp:
 *   decidedAt → createdAt (fallback). Entries whose timestamps are missing
 *   or unparseable are kept defensively.
 *
 * Safe to call concurrently with other paired-keys operations: it reads
 * the entire store, computes the next state, and persists in a single
 * `savePendingPairings()` write — the same pattern used by
 * cleanupExpiredPairings().
 *
 * @param {number} [maxAgeDays=7] Threshold in days. Entries strictly older
 *   than this many days (by their state-change timestamp) are removed.
 * @returns {{ removed: number, kept: number }} Counts of dropped vs retained
 *   entries after the sweep.
 */
function cleanupOldPairings(maxAgeDays = 7) {
  const pairings = loadPendingPairings();
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const kept = [];
  let removed = 0;
  for (const entry of pairings) {
    // Only denied / expired are eligible for pruning.
    if (entry.status !== 'denied' && entry.status !== 'expired') {
      kept.push(entry);
      continue;
    }
    // Use the most recent state-change timestamp; fall back to createdAt.
    const tsRaw = entry.decidedAt || entry.createdAt;
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    // Defensive: keep entries with missing/unparseable timestamps so a
    // malformed row isn't silently deleted by housekeeping.
    if (!Number.isFinite(ts)) {
      kept.push(entry);
      continue;
    }
    if (now - ts > maxAgeMs) {
      removed += 1;
      continue;
    }
    kept.push(entry);
  }
  if (removed > 0) {
    savePendingPairings(kept);
    console.log(
      `[pairing:cleanupOldPairings] removed=${removed} kept=${kept.length} ` +
        `(maxAgeDays=${maxAgeDays}, terminal-only: denied + expired)`
    );
  }
  return { removed, kept: kept.length };
}

/**
 * Walk paired-keys.json and revoke any entry whose `lastAccessed` is still
 * null more than `maxAgeMs` after `createdAt`. Designed to be called at
 * startup and hourly, in the same schedule as `cleanupExpiredPairings`.
 *
 * Defensive: entries with missing or unparseable `createdAt` are SKIPPED
 * (left alone) — legacy rows that predate the field shouldn't be silently
 * deleted by a housekeeping pass.
 *
 * Entries with any non-null `lastAccessed` are kept regardless of age —
 * the user clearly used the key at some point.
 *
 * Writes via saveKeys(), which updates the in-memory cache atomically.
 *
 * @param {number} [maxAgeMs] Override threshold (used by tests).
 * @returns {number} Count of entries revoked.
 */
function cleanupUnusedKeys(maxAgeMs = UNUSED_KEY_EXPIRY_MS) {
  const keys = loadKeys();
  const now = Date.now();
  const kept = [];
  let revoked = 0;
  for (const entry of keys) {
    // Only touch entries that have never been accessed.
    if (entry.lastAccessed) {
      kept.push(entry);
      continue;
    }
    // Defensive: skip if createdAt is missing or unparseable so legacy rows
    // aren't deleted by a housekeeping pass.
    const created = entry.createdAt ? Date.parse(entry.createdAt) : NaN;
    if (!Number.isFinite(created)) {
      kept.push(entry);
      continue;
    }
    if (now - created > maxAgeMs) {
      const keyDisplay = (entry.key || '').slice(0, 8) + '...';
      console.log(
        `[paired-keys:cleanupUnusedKeys] revoked unused key ${keyDisplay} ` +
          `for agent "${entry.agentName}" (created ${entry.createdAt}, never accessed)`
      );
      revoked += 1;
      continue;
    }
    kept.push(entry);
  }
  if (revoked > 0) {
    saveKeys(kept);
  }
  return revoked;
}

module.exports = {
  loadKeys,
  saveKeys,
  invalidateCache,
  generateKey,
  addKey,
  createPairedAgent,
  validateKey,
  renameKey,
  updateProfileBinding,
  touchKey,
  revokeKey,
  listKeys,
  // Async pairing
  requestPairing,
  checkPairingStatus,
  approvePairing,
  denyPairing,
  listPendingPairings,
  listAllPairings,
  cleanupExpiredPairings,
  cleanupOldPairings,
  cleanupUnusedKeys,
  onPairingEvent,
  // Constant-time string equality helper. Exposed so other auth paths
  // (extension WS handshake in server.js, etc.) can share the same primitive.
  constantTimeEqual,
  // Constants (exposed for docs / tests; not strictly part of the runtime API)
  UNUSED_KEY_EXPIRY_MS,
};
