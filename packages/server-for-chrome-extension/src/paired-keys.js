'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { getDataDir } = require('./service/paths');

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

/**
 * Reads paired-keys.json from the config directory.
 * Returns a parsed array of key entries, or an empty array if the file does not exist.
 */
function loadKeys() {
  const keysPath = getKeysPath();
  try {
    if (fs.existsSync(keysPath)) {
      const raw = fs.readFileSync(keysPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    // Ignore read/parse errors — treat as empty
  }
  return [];
}

/**
 * Writes the keys array to paired-keys.json.
 * Ensures the config directory exists before writing.
 *
 * @param {Array} keys
 */
function saveKeys(keys) {
  const keysPath = getKeysPath();
  fs.mkdirSync(path.dirname(keysPath), { recursive: true });
  fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2), 'utf8');
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
  return keys.find((entry) => entry.key === apiKey) || null;
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
  const entry = keys.find((e) => e.key === apiKey);
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
  const entry = keys.find((e) => e.key === apiKey);
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
  const entry = keys.find((e) => e.key === apiKey);
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
  const filtered = keys.filter((entry) => entry.key !== apiKey);
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

module.exports = {
  loadKeys,
  saveKeys,
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
  onPairingEvent,
};
