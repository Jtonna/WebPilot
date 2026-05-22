'use strict';

const { execFile } = require('node:child_process');
const { log, error } = require('./logger');

/**
 * macOS notification via osascript `display notification`.
 *
 * NOTE: scaffold-quality. Best-effort implementation per spec; not verified
 * on a real macOS host from this Windows machine.
 */

// AppleScript double-quoted string escape: backslash and double-quote
function asEscape(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function notify(payload) {
  return new Promise((resolve) => {
    const title = (payload && payload.title) || 'WebPilot';
    const body = (payload && payload.body) || '';
    const url = (payload && payload.url) || '';
    const sound = payload && payload.sound === false ? false : true;

    // Build AppleScript: display notification "<body>" with title "<title>" [subtitle "<url>"] [sound name "default"]
    let script = 'display notification "' + asEscape(body) + '" with title "' + asEscape(title) + '"';
    if (url) {
      script += ' subtitle "' + asEscape(url) + '"';
    }
    if (sound) {
      script += ' sound name "default"';
    }

    const args = ['-e', script];
    log('macos', 'TODO: macOS notification is scaffolded — verify on real macOS');
    log('macos', 'invoking osascript', { script });

    execFile('osascript', args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        error('macos', 'osascript failed', err);
        if (stderr) error('macos', 'stderr', stderr);
      } else {
        log('macos', 'notification shown');
      }
      resolve();
    });
  });
}

module.exports = { notify };
