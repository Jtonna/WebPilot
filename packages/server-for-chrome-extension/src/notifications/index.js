'use strict';

const { log, error } = require('./logger');

/**
 * Public notification API.
 *
 *   await notify({ title, body, url, sound = true });
 *
 * Dispatches to the per-OS implementation. Never throws — failures are
 * logged and swallowed so a missing OS tool can't crash the daemon.
 */

async function notify(opts) {
  const payload = opts || {};
  const platform = process.platform;
  log('index', 'notify called', {
    platform,
    title: payload.title,
    bodyLen: payload.body ? payload.body.length : 0,
    urlPresent: !!payload.url,
    sound: payload.sound !== false,
  });

  try {
    let impl;
    if (platform === 'win32') {
      impl = require('./windows');
    } else if (platform === 'darwin') {
      impl = require('./macos');
    } else if (platform === 'linux') {
      impl = require('./linux');
    } else {
      log('index', 'unsupported platform — notify is a no-op', { platform });
      return;
    }

    await impl.notify(payload);
    log('index', 'notify complete');
  } catch (e) {
    error('index', 'notify failed', e);
  }
}

module.exports = { notify };
