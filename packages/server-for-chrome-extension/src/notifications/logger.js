'use strict';

/**
 * Logger for the notifications module — tags every line with
 * [notify:<component>] so the notification trail is greppable.
 *
 * Output goes to stdout/stderr; the service logger tees those into daemon.log.
 */

function formatExtra(extra) {
  if (extra === undefined || extra === null) return '';
  if (typeof extra === 'string') return ' ' + extra;
  try {
    return ' ' + JSON.stringify(extra);
  } catch (e) {
    return ' [unserializable extra: ' + e.message + ']';
  }
}

function log(component, msg, extra) {
  console.log('[notify:' + component + '] ' + msg + formatExtra(extra));
}

function error(component, msg, err) {
  let suffix = '';
  if (err) {
    if (err instanceof Error) {
      suffix = ' ' + err.message + (err.stack ? '\n' + err.stack : '');
    } else if (typeof err === 'string') {
      suffix = ' ' + err;
    } else {
      try {
        suffix = ' ' + JSON.stringify(err);
      } catch (e) {
        suffix = ' [unserializable err]';
      }
    }
  }
  console.error('[notify:' + component + '] ERROR ' + msg + suffix);
}

module.exports = { log, error };
