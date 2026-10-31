'use strict';

const { log, error } = require('./logger');

/**
 * Thrown when a process scan FAILED (as opposed to succeeding with no Chrome
 * found). Callers must treat this as "Chrome state unknown", never as
 * "Chrome not running". Tagged with code 'CHROME_DETECTION_FAILED'.
 */
class ChromeDetectionError extends Error {
  constructor(message, opts) {
    super(message);
    this.name = 'ChromeDetectionError';
    this.code = 'CHROME_DETECTION_FAILED';
    if (opts && opts.cause) this.cause = opts.cause;
  }
}

/**
 * Dispatch to the platform-specific detector. Returns an array of:
 *   { pid, commandLine, hasFlag, userDataDir, profileDirectory }
 * for browser-parent processes only (those without --type= in their command line).
 * An empty array means "scan succeeded, no Chrome". A failed scan REJECTS with
 * a ChromeDetectionError (code 'CHROME_DETECTION_FAILED').
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
    if (e && e.code === 'CHROME_DETECTION_FAILED') throw e;
    throw new ChromeDetectionError('detection failed: ' + (e && e.message), { cause: e });
  }
}

module.exports = { detectChromeBrowsers, ChromeDetectionError };
