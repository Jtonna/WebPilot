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
 * @returns {string} The generated key
 */
function addKey(agentName) {
  const keys = loadKeys();
  const key = generateKey();
  keys.push({ key, agentName, createdAt: new Date().toISOString() });
  saveKeys(keys);
  return key;
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
  const existing = pairings.find(
    (p) => p.agentName === agentName && (p.status === 'pending' || p.status === 'approved')
  );
  if (existing) {
    console.log(
      `[pairing] requestPairing: returning existing ${existing.status} entry ` +
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
    createdAt: new Date().toISOString(),
  };
  pairings.push(entry);
  savePendingPairings(pairings);
  console.log(
    `[pairing] requestPairing: created new pending entry for agent "${agentName}" ` +
      `(pairingId=${entry.pairingId})`
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
    console.log(`[pairing] checkPairingStatus: pairingId=${pairingId} not found`);
    return null;
  }
  console.log(
    `[pairing] checkPairingStatus: pairingId=${pairingId} status=${entry.status}`
  );
  const result = { status: entry.status };
  if (entry.apiKey) result.apiKey = entry.apiKey;
  return result;
}

/**
 * Approve a pending pairing. Mints a real API key via addKey(), sets status='approved',
 * stamps apiKey + decidedAt, persists, and returns the updated entry.
 * If the pairing is already approved, returns it unchanged.
 *
 * @param {string} pairingId
 * @returns {object | null} The entry, or null if not found / cannot be approved.
 */
function approvePairing(pairingId) {
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
    return entry;
  }
  const key = addKey(entry.agentName);
  entry.status = 'approved';
  entry.apiKey = key;
  entry.decidedAt = new Date().toISOString();
  savePendingPairings(pairings);
  console.log(
    `[pairing] approvePairing: pairingId=${pairingId} approved for agent "${entry.agentName}", ` +
      `key=${key.slice(0, 8)}...`
  );
  emitPairingEvent('approved', entry);
  return entry;
}

/**
 * Deny a pending pairing. Sets status='denied', stamps decidedAt, persists.
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

module.exports = {
  loadKeys,
  saveKeys,
  generateKey,
  addKey,
  validateKey,
  renameKey,
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
  onPairingEvent,
};
