'use strict';

const { log, error } = require('./logger');

/**
 * Dispatch to the platform-specific detector. Returns an array of:
 *   { pid, commandLine, hasFlag, userDataDir, profileDirectory }
 * for browser-parent processes only (those without --type= in their command line).
 */
async function detectChromeBrowsers() {
  const platform = process.platform;
  log('detector', 'detectChromeBrowsers called', { platform });

  try {
    let impl;
    if (platform === 'win32') {
      impl = require('./windows-detector');
    } else if (platform === 'darwin') {
      log('detector', 'platform=darwin not yet fully implemented — running scaffold');
      impl = require('./macos-detector');
    } else if (platform === 'linux') {
      log('detector', 'platform=linux not yet fully implemented — running scaffold');
      impl = require('./linux-detector');
    } else {
      log('detector', 'unsupported platform — returning empty list', { platform });
      return [];
    }

    const result = await impl.detect();
    log('detector', 'detection done', { count: result.length });
    return result;
  } catch (e) {
    error('detector', 'detection failed', e);
    return [];
  }
}

module.exports = { detectChromeBrowsers };
