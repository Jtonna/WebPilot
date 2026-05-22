'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { getDataDir } = require('./service/paths');

/**
 * Persistent notification-preferences store.
 *
 * File: <dataDir>/config/notifications.json
 *
 * Shape: { systemNotifications: boolean, sound: boolean }
 *
 * Defaults to both `true` when the file is missing or unreadable.
 *
 * Two access modes:
 *   - loadSettings()              — always re-reads from disk (authoritative).
 *   - getSettings()               — returns the in-memory cache; lazy-loads on
 *                                   first call. Use this on hot paths like the
 *                                   pairing-notification fire site.
 *   - saveSettings(partial)       — partial-merges, persists, refreshes cache,
 *                                   returns the new full object.
 */

const DEFAULTS = Object.freeze({
  systemNotifications: true,
  sound: true,
});

let _cache = null;

function getSettingsPath() {
  return path.join(getDataDir(), 'config', 'notifications.json');
}

function _normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (typeof raw.systemNotifications === 'boolean') {
      out.systemNotifications = raw.systemNotifications;
    }
    if (typeof raw.sound === 'boolean') {
      out.sound = raw.sound;
    }
  }
  return out;
}

function loadSettings() {
  const filePath = getSettingsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      _cache = _normalize(parsed);
      return _cache;
    }
  } catch (e) {
    console.log(`[notifications-settings] failed to load ${filePath}: ${e.message}`);
  }
  _cache = { ...DEFAULTS };
  return _cache;
}

function saveSettings(partial) {
  const current = _cache || loadSettings();
  const next = _normalize({ ...current, ...(partial || {}) });
  const filePath = getSettingsPath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
    _cache = next;
    console.log(
      `[notifications-settings] saved systemNotifications=${next.systemNotifications} sound=${next.sound}`
    );
  } catch (e) {
    console.log(`[notifications-settings] failed to save: ${e.message}`);
  }
  return next;
}

function getSettings() {
  if (_cache) return _cache;
  return loadSettings();
}

module.exports = {
  loadSettings,
  saveSettings,
  getSettings,
  DEFAULTS,
};
