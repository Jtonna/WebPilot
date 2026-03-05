'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { getDataDir } = require('./service/paths');

function getKeysPath() {
  return path.join(getDataDir(), 'config', 'paired-keys.json');
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
};
