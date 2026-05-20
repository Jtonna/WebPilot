'use strict';

const { log, error } = require('./logger');
const { detectChromeBrowsers } = require('./detector');
const { closeChromeGracefully } = require('./closer');
const { launchChromeProfile } = require('./launcher');
const { readProfiles } = require('./local-state');
const { getActiveProfiles } = require('./profile-activity');
const { getDefaultChromePath, getDefaultUserDataDir } = require('./paths');

/**
 * ChromeManager — orchestrates Chrome detection, graceful close, and relaunch.
 *
 * The cache holds the last-known browser-parent that controls our managed
 * user-data-dir along with whether it has the --silent-debugger-extension-api
 * flag. getStatus() performs a cheap PID liveness check via
 * `process.kill(pid, 0)` and only triggers a full refresh on cache miss.
 *
 * This module stands alone — Wave 2 will wire it into the MCP handler.
 */
class ChromeManager {
  constructor(opts) {
    const options = opts || {};
    this.userDataDir = options.userDataDir || getDefaultUserDataDir();
    this.chromePath = options.chromePath || getDefaultChromePath();
    this.activityWindowSeconds = options.activityWindowSeconds || 30;
    this._cache = {
      browserPid: null,
      hasFlag: false,
      profileDirectory: null,
      lastFullCheck: 0,
    };

    log('manager', 'ChromeManager constructed', {
      userDataDir: this.userDataDir,
      chromePath: this.chromePath,
      activityWindowSeconds: this.activityWindowSeconds,
    });
  }

  /**
   * Cheap status read. If the cached PID is still alive, returns cached info
   * without re-enumerating processes. Otherwise triggers a refresh().
   *
   * Returns: { running, browserPid, hasFlag, userDataDir, knownProfiles }
   */
  async getStatus() {
    log('manager', 'getStatus called', { cachedPid: this._cache.browserPid });

    if (this._cache.browserPid && this._isAlive(this._cache.browserPid)) {
      const knownProfiles = readProfiles(this.userDataDir);
      log('manager', 'getStatus cache-hit', {
        browserPid: this._cache.browserPid,
        hasFlag: this._cache.hasFlag,
      });
      return {
        running: true,
        browserPid: this._cache.browserPid,
        hasFlag: this._cache.hasFlag,
        userDataDir: this.userDataDir,
        knownProfiles,
        fromCache: true,
      };
    }

    log('manager', 'getStatus cache-miss — running refresh');
    return await this.refresh();
  }

  /**
   * Full re-detection. Enumerates Chrome browser-parents, picks the one
   * matching our user-data-dir (or the first one without --user-data-dir if
   * we're using the OS default), updates cache.
   */
  async refresh() {
    log('manager', 'refresh called');
    const startedAt = Date.now();

    const browsers = await detectChromeBrowsers();
    const knownProfiles = readProfiles(this.userDataDir);

    // Match: a browser whose --user-data-dir equals ours, OR a browser with
    // no --user-data-dir if we're using the OS default.
    const defaultUdd = getDefaultUserDataDir();
    const ourMatcher = (b) => {
      if (b.userDataDir) return this._pathsEqual(b.userDataDir, this.userDataDir);
      // Chrome launched without --user-data-dir uses the OS default
      return this._pathsEqual(this.userDataDir, defaultUdd);
    };

    const ours = browsers.filter(ourMatcher);
    log('manager', 'matched browser-parents for our user-data-dir', {
      ours: ours.map((b) => ({ pid: b.pid, hasFlag: b.hasFlag, profileDirectory: b.profileDirectory })),
      othersCount: browsers.length - ours.length,
    });

    let cacheEntry;
    if (ours.length === 0) {
      cacheEntry = { browserPid: null, hasFlag: false, profileDirectory: null };
    } else {
      const first = ours[0];
      cacheEntry = {
        browserPid: first.pid,
        hasFlag: !!first.hasFlag,
        profileDirectory: first.profileDirectory || null,
      };
    }
    cacheEntry.lastFullCheck = Date.now();
    this._cache = cacheEntry;

    const result = {
      running: !!cacheEntry.browserPid,
      browserPid: cacheEntry.browserPid,
      hasFlag: cacheEntry.hasFlag,
      userDataDir: this.userDataDir,
      knownProfiles,
      fromCache: false,
      durationMs: Date.now() - startedAt,
    };
    log('manager', 'refresh complete', {
      running: result.running,
      browserPid: result.browserPid,
      hasFlag: result.hasFlag,
      durationMs: result.durationMs,
    });
    return result;
  }

  /**
   * Returns array of profile directory names with recent fs activity.
   */
  async getActiveProfiles() {
    log('manager', 'getActiveProfiles called');
    const known = readProfiles(this.userDataDir).map((p) => p.directoryName);
    const active = getActiveProfiles(this.userDataDir, known, this.activityWindowSeconds);
    log('manager', 'getActiveProfiles result', { active });
    return active;
  }

  /**
   * Gracefully close all of OUR Chrome browser-parents. We close everything
   * the detector returns that matches our user-data-dir, plus their child
   * processes get cleaned up by Chrome's normal shutdown path.
   *
   * Returns: { closed, remaining, durationMs }
   */
  async closeAll(opts) {
    const options = opts || {};
    const timeoutMs = options.timeoutMs || 20000;
    log('manager', 'closeAll called', { timeoutMs });

    const browsers = await detectChromeBrowsers();
    const defaultUdd = getDefaultUserDataDir();
    const ours = browsers.filter((b) => {
      if (b.userDataDir) return this._pathsEqual(b.userDataDir, this.userDataDir);
      return this._pathsEqual(this.userDataDir, defaultUdd);
    });

    if (ours.length === 0) {
      log('manager', 'closeAll — no matching browser-parents');
      this._cache = { browserPid: null, hasFlag: false, profileDirectory: null, lastFullCheck: Date.now() };
      return { closed: true, remaining: [], durationMs: 0 };
    }

    const pids = ours.map((b) => b.pid);
    log('manager', 'closeAll — closing pids', { pids });
    const result = await closeChromeGracefully(pids, timeoutMs);

    if (result.closed) {
      this._cache = { browserPid: null, hasFlag: false, profileDirectory: null, lastFullCheck: Date.now() };
    } else {
      // Refresh to find out what's still alive
      await this.refresh();
    }

    log('manager', 'closeAll complete', result);
    return result;
  }

  /**
   * Idempotent: ensure Chrome is running with the flag and all requiredProfiles
   * are open.
   *
   * Algorithm (per spec 4.1):
   *   1. getStatus() — fast path
   *   2. if running && hasFlag — assume sufficient (Wave 2 will additionally
   *      verify each required profile has an extension WebSocket connected)
   *   3. if running && !hasFlag — getActiveProfiles → closeAll → launch active ∪ required
   *   4. if !running — launch required profiles
   *
   * Returns: { action, browserPid?, launched: string[], reason }
   */
  async ensureReady(requiredProfiles) {
    const reqProfiles = Array.isArray(requiredProfiles) && requiredProfiles.length > 0
      ? requiredProfiles
      : ['Default'];

    log('manager', 'ensureReady called', { requiredProfiles: reqProfiles });

    const status = await this.getStatus();

    // Case 2: running with flag — Wave 2 will add per-profile WS check; for now, no-op.
    if (status.running && status.hasFlag) {
      log('manager', 'ensureReady — already running with flag, no action', { browserPid: status.browserPid });
      return {
        action: 'noop',
        browserPid: status.browserPid,
        launched: [],
        reason: 'chrome already running with flag',
      };
    }

    // Case 3: running without flag — kill + relaunch preserving active profiles
    if (status.running && !status.hasFlag) {
      log('manager', 'ensureReady — running without flag, restarting');
      const activeBefore = await this.getActiveProfiles();
      log('manager', 'active profiles before close', { activeBefore });

      const closeResult = await this.closeAll();
      if (!closeResult.closed) {
        const e = new Error('Failed to close Chrome gracefully within timeout');
        error('manager', 'ensureReady abort — close failed', e);
        return {
          action: 'abort',
          launched: [],
          reason: 'graceful close timed out; remaining=' + closeResult.remaining.join(','),
        };
      }

      const launchSet = this._uniq([...activeBefore, ...reqProfiles]);
      const launched = this._launchProfiles(launchSet);
      log('manager', 'ensureReady — restart complete', { launched });
      return {
        action: 'restart',
        launched,
        reason: 'chrome was running without flag; restarted with active ∪ required profiles',
      };
    }

    // Case 4: not running — launch requested profiles fresh
    log('manager', 'ensureReady — chrome not running, launching');
    const launched = this._launchProfiles(reqProfiles);
    log('manager', 'ensureReady — launch complete', { launched });
    return {
      action: 'launch',
      launched,
      reason: 'chrome was not running; launched required profiles',
    };
  }

  // ---- internals ----

  _isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      log('manager', 'cached pid no longer alive', { pid, err: e.message });
      return false;
    }
  }

  _pathsEqual(a, b) {
    if (!a || !b) return false;
    if (process.platform === 'win32') {
      return a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '');
    }
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }

  _uniq(arr) {
    return Array.from(new Set(arr));
  }

  _launchProfiles(profiles) {
    const launched = [];
    for (const p of profiles) {
      try {
        const res = launchChromeProfile({
          chromePath: this.chromePath,
          userDataDir: this.userDataDir,
          profileDirectory: p,
          withFlag: true,
        });
        launched.push({ profileDirectory: p, pid: res.pid });
      } catch (e) {
        error('manager', 'failed to launch profile ' + p, e);
      }
    }
    return launched;
  }
}

function createChromeManager(opts) {
  return new ChromeManager(opts);
}

module.exports = { ChromeManager, createChromeManager };
