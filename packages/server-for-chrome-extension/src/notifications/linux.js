'use strict';

const { execFile } = require('node:child_process');
const { log, error } = require('./logger');

/**
 * Linux notification via `notify-send -u critical "<title>" "<body>"`.
 * Sound handling is up to the desktop environment based on urgency level.
 *
 * NOTE: scaffold-quality. Verify on a real Linux desktop before relying on this.
 */

function notify(payload) {
  return new Promise((resolve) => {
    const title = (payload && payload.title) || 'WebPilot';
    const body = (payload && payload.body) || '';
    const url = (payload && payload.url) || '';

    const bodyWithUrl = url ? body + '\n' + url : body;

    // execFile arg array means no shell escaping required — notify-send
    // accepts <title> <body> as positional args.
    const args = ['-u', 'critical', title, bodyWithUrl];

    log('linux', 'TODO: Linux notification is scaffolded — verify on real Linux desktop');
    log('linux', 'invoking notify-send', { args });

    execFile('notify-send', args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        error('linux', 'notify-send failed', err);
        if (stderr) error('linux', 'stderr', stderr);
      } else {
        log('linux', 'notification shown');
      }
      resolve();
    });
  });
}

module.exports = { notify };
