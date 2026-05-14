'use strict';

/**
 * Lightweight wrapper around console.log/console.error that tags every
 * message with [chrome:<component>] so a `grep "\[chrome:" daemon.log`
 * extracts the entire Chrome-management trail.
 *
 * Output goes to stdout/stderr; the service logger (src/service/logger.js)
 * tees stdout+stderr into daemon.log automatically.
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
  console.log('[chrome:' + component + '] ' + msg + formatExtra(extra));
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
  console.error('[chrome:' + component + '] ERROR ' + msg + suffix);
}

module.exports = { log, error };
