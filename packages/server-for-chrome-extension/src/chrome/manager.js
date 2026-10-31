'use strict';

const { log, error } = require('./logger');
const { detectChromeBrowsers } = require('./detector');
const { closeChromeGracefully } = require('./closer');
const { launchChromeProfile } = require('./launcher');
const { readProfiles } = require('./local-state');
const { getActiveProfiles } = require('./profile-activity');
const { getDefaultChromePath, getDefaultUserDataDir } = require('./paths');

// Minimum gap between forced re-verifications of a cached-but-suspect status
// (cached hasFlag:false, or extension disconnected) so we don't hammer
// PowerShell process scans.
const FORCED_REFRESH_MIN_INTERVAL_MS = 5000;

// ensureReady connect budgets (issue #132). One coordinated wait per call,
// owned here; callers must not add their own.
//   RUNNING: Chrome already up with the flag, a profile's extension missing
//            (includes the grace period below).
//   LAUNCH:  Chrome had to be launched or restarted (cold start + extension
//            service-worker boot takes longer).
const CONNECT_BUDGET_RUNNING_MS = 10000;
const CONNECT_BUDGET_LAUNCH_MS = 15000;
// Case 2 grace: wait this long for a sleeping extension service worker to
// reconnect on its own before spawning anything.
const EXTENSION_GRACE_MS = 3000;
const CONNECT_POLL_INTERVAL_MS = 250;
// Passed on the restart-to-add-flag relaunch so the user's prior session
// (windows/tabs closed by closeAll) comes back.
const RESTORE_SESSION_FLAG = '--restore-last-session';

/**
 * Normalize a URL for passing to chrome.exe on the command line. Mirrors the
 * extension's create_tab normalization: http(s) only, scheme-less values get
 * https://. Returns the normalized href, or null when the value is missing,
 * not http(s), or unparseable (callers must then NOT pass it to Chrome).
 */
function normalizeLaunchUrl(raw) {
  if (typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (candidate === '') return null;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):(?!\d+(\/|$))/i.exec(candidate);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') return null;
  } else {
    candidate = 'https://' + candidate.replace(/^\/\//, '');
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (e) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.href;
}

function isDetectionFailure(e) {
  return !!e && e.code === 'CHROME_DETECTION_FAILED';
}

/**
 * ChromeManager — orchestrates Chrome detection, graceful close, and relaunch.
 *
 * The cache holds the last-known browser-parent that controls our managed
 * user-data-dir along with whether it has the --silent-debugger-extension-api
 * flag. getStatus() performs a cheap PID liveness check via
 * `process.kill(pid, 0)` and only triggers a full refresh on cache miss.
 */
class ChromeManager {
  constructor(opts) {
    const options = opts || {};
    this.userDataDir = options.userDataDir || getDefaultUserDataDir();
    this.chromePath = options.chromePath || getDefaultChromePath();
    this.activityWindowSeconds = options.activityWindowSeconds || 30;
    this.extensionBridge = options.extensionBridge || null;
    // connectTimeoutMs: budget when Chrome is already running (Case 2).
    // launchConnectTimeoutMs: budget after a launch or restart.
    this.connectTimeoutMs = options.connectTimeoutMs || CONNECT_BUDGET_RUNNING_MS;
    this.launchConnectTimeoutMs = options.launchConnectTimeoutMs || CONNECT_BUDGET_LAUNCH_MS;
    this.extensionGraceMs = typeof options.extensionGraceMs === 'number'
      ? options.extensionGraceMs
      : EXTENSION_GRACE_MS;
    this.connectPollIntervalMs = options.connectPollIntervalMs || CONNECT_POLL_INTERVAL_MS;
    this._cache = {
      browserPid: null,
      hasFlag: false,
      profileDirectory: null,
      lastFullCheck: 0,
    };
    this._lastForcedRefreshAt = 0;

    log('manager', 'ChromeManager constructed', {
      userDataDir: this.userDataDir,
      chromePath: this.chromePath,
      activityWindowSeconds: this.activityWindowSeconds,
    });
  }

  /**
   * Status read. The cache is trusted only when the cached PID is alive AND
   * hasFlag is true (a flagless cache entry can be stale: the user may have
   * restarted Chrome since). A cached flagless entry, or an
   * `extensionDisconnected` hint, forces a re-verify via refresh(),
   * rate-limited to one per FORCED_REFRESH_MIN_INTERVAL_MS; inside the window
   * the cached entry is returned (fromCache:true, rateLimited:true).
   *
   * opts.extensionDisconnected: caller hint that the extension is not
   * connected, so a cached hasFlag:true should be re-verified too.
   *
   * Returns: { running, browserPid, hasFlag, userDataDir, knownProfiles }
   * or, if the process scan failed: { running:null, unknown:true, hasFlag:null,
   * browserPid:null, reason, userDataDir, knownProfiles }
   */
  async getStatus(opts) {
    const options = opts || {};
    log('manager', 'getStatus called', { cachedPid: this._cache.browserPid });

    if (this._cache.browserPid && this._isAlive(this._cache.browserPid)) {
      const suspect = !this._cache.hasFlag || !!options.extensionDisconnected;
      let rateLimited = false;
      if (suspect) {
        const now = Date.now();
        if (now - this._lastForcedRefreshAt >= FORCED_REFRESH_MIN_INTERVAL_MS) {
          this._lastForcedRefreshAt = now;
          log('manager', 'getStatus — cached entry suspect, forcing refresh', {
            hasFlag: this._cache.hasFlag,
            extensionDisconnected: !!options.extensionDisconnected,
          });
          return await this.refresh();
        }
        rateLimited = true;
      }
      const knownProfiles = readProfiles(this.userDataDir);
      log('manager', 'getStatus cache-hit', {
        browserPid: this._cache.browserPid,
        hasFlag: this._cache.hasFlag,
        rateLimited,
      });
      const hit = {
        running: true,
        browserPid: this._cache.browserPid,
        hasFlag: this._cache.hasFlag,
        userDataDir: this.userDataDir,
        knownProfiles,
        fromCache: true,
      };
      if (rateLimited) hit.rateLimited = true;
      return hit;
    }

    log('manager', 'getStatus cache-miss — running refresh');
    return await this.refresh();
  }

  /**
   * Full re-detection. Enumerates Chrome browser-parents, picks the one
   * matching our user-data-dir (or the first one without --user-data-dir if
   * we're using the OS default), updates cache. If the process scan fails,
   * the cache is left untouched and the result is
   * { running:null, unknown:true, hasFlag:null, browserPid:null, reason, ... }.
   */
  async refresh() {
    log('manager', 'refresh called');
    const startedAt = Date.now();

    let browsers;
    try {
      browsers = await detectChromeBrowsers();
    } catch (e) {
      if (!isDetectionFailure(e)) throw e;
      error('manager', 'refresh — detection failed, state unknown (cache untouched)', e);
      return {
        running: null,
        unknown: true,
        browserPid: null,
        hasFlag: null,
        reason: e.message,
        userDataDir: this.userDataDir,
        knownProfiles: readProfiles(this.userDataDir),
        fromCache: false,
        durationMs: Date.now() - startedAt,
      };
    }
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
      // Prefer the flagged parent when several match (a flagless one may be a
      // stray earlier process).
      const first = ours.find((b) => b.hasFlag) || ours[0];
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
   * If the process scan fails: { closed:false, unknown:true, remaining:[],
   * reason, durationMs } and nothing is closed.
   */
  async closeAll(opts) {
    const options = opts || {};
    const timeoutMs = options.timeoutMs || 20000;
    log('manager', 'closeAll called', { timeoutMs });

    const startedAt = Date.now();
    let browsers;
    try {
      browsers = await detectChromeBrowsers();
    } catch (e) {
      if (!isDetectionFailure(e)) throw e;
      error('manager', 'closeAll — detection failed, refusing to claim closed', e);
      return { closed: false, unknown: true, remaining: [], reason: e.message, durationMs: Date.now() - startedAt };
    }
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
   * are open, then (by default) wait for their extension connections.
   *
   * opts:
   *   url             — optional target URL. When it is a valid http(s) URL it
   *                     is passed to chrome.exe for each required profile that
   *                     gets spawned, so Chrome opens it instead of a blank
   *                     window. Invalid / non-http(s) values are not passed.
   *   waitForConnect  — default true. Run the single coordinated wait for the
   *                     required profiles' extension connections after any
   *                     spawn (budget: connectTimeoutMs when Chrome was already
   *                     running, launchConnectTimeoutMs after a launch or
   *                     restart). false: return right after spawning; Case 2
   *                     then skips the grace wait too.
   *
   * Algorithm:
   *   1. getStatus() — fast path
   *   2. running && hasFlag — profiles whose extension is missing get a grace
   *      wait (extensionGraceMs) to reconnect on their own; still missing →
   *      spawn those profiles (with the URL), keep waiting the rest of the
   *      budget. Grace reconnect → 'noop'; spawn + connected →
   *      'launch-additional'; timeout → 'partial'.
   *   3. running && !hasFlag — getActiveProfiles → closeAll → relaunch
   *      active ∪ required with --restore-last-session (+ URL for required) →
   *      'restart'
   *   4. !running — launch required profiles (+ URL) → 'launch'
   *
   * Returns: { action, browserPid?, launched: [{profileDirectory, pid, url?}],
   *   reason, urlLaunched, connected (true|false|null when no wait ran),
   *   stillMissing?, waitedMs?, budgetMs? }
   * action 'abort' with reason 'chrome_state_unknown' (and unknown:true) means
   * the process scan failed: nothing was launched or closed.
   */
  async ensureReady(requiredProfiles, opts) {
    const options = opts || {};
    const waitForConnect = options.waitForConnect !== false;
    const launchUrl = normalizeLaunchUrl(options.url);
    const reqProfiles = Array.isArray(requiredProfiles) && requiredProfiles.length > 0
      ? requiredProfiles
      : ['Default'];

    log('manager', 'ensureReady called', {
      requiredProfiles: reqProfiles,
      waitForConnect,
      hasLaunchUrl: !!launchUrl,
    });
    if (options.url != null && !launchUrl) {
      log('manager', 'ensureReady — url is not a launchable http(s) URL; it will not be passed to Chrome');
    }

    const bridge = this.extensionBridge;
    const canGate = !!(bridge && typeof bridge.isConnected === 'function');
    const extensionDisconnected = canGate && reqProfiles.some((p) => !bridge.isConnected(p));
    const status = await this.getStatus({ extensionDisconnected });

    if (status.unknown) {
      error('manager', 'ensureReady abort — chrome state unknown', new Error(status.reason || 'detection failed'));
      return {
        action: 'abort',
        launched: [],
        unknown: true,
        reason: 'chrome_state_unknown',
        message: 'could not determine whether Chrome is running (process scan failed): ' + (status.reason || 'unknown error'),
      };
    }

    const urlLaunched = (launched) => launched.some((l) => !!l.url);

    // Case 2: running with flag — verify each required profile has a live
    // extension WS connection. Chrome being alive with the debugger flag is
    // necessary but NOT sufficient: a profile we need may simply not have a
    // window open, or its extension service worker may be asleep.
    if (status.running && status.hasFlag) {
      // If the bridge wasn't injected we can't gate on connection — preserve
      // legacy behavior so we don't regress callers that don't wire it up.
      if (!canGate) {
        log('manager', 'ensureReady — already running with flag, no bridge to gate on, no action', { browserPid: status.browserPid });
        return {
          action: 'noop',
          browserPid: status.browserPid,
          launched: [],
          urlLaunched: false,
          connected: null,
          reason: 'chrome already running with flag',
        };
      }

      const missing = reqProfiles.filter((p) => !bridge.isConnected(p));
      if (missing.length === 0) {
        log('manager', 'ensureReady — already running with flag, all required profiles connected', {
          browserPid: status.browserPid,
          requiredProfiles: reqProfiles,
        });
        return {
          action: 'noop',
          browserPid: status.browserPid,
          launched: [],
          urlLaunched: false,
          connected: true,
          reason: 'chrome already running with flag; all required profiles have extension connected',
        };
      }

      if (!waitForConnect) {
        log('manager', 'ensureReady — profiles missing extension connection; launching windows (no wait)', {
          browserPid: status.browserPid,
          missing,
        });
        const launched = this._launchProfiles(missing, { url: launchUrl });
        return {
          action: 'launch-additional',
          browserPid: status.browserPid,
          launched,
          urlLaunched: urlLaunched(launched),
          connected: null,
          stillMissing: missing,
          reason: 'chrome already running; opened window(s) for profile(s) missing extension connection (not waiting for connect)',
        };
      }

      const budgetMs = this.connectTimeoutMs;
      log('manager', 'ensureReady — profiles missing extension connection; grace wait before spawning', {
        browserPid: status.browserPid,
        missing,
        graceMs: this.extensionGraceMs,
        budgetMs,
      });
      let launched = [];
      const waitResult = await this._waitForProfileConnections(missing, budgetMs, {
        spawnAfterMs: this.extensionGraceMs,
        spawn: (stillMissing) => {
          log('manager', 'ensureReady — grace expired; launching windows for profiles still missing', {
            stillMissing,
          });
          launched = this._launchProfiles(stillMissing, { url: launchUrl });
        },
      });

      if (waitResult.allConnected && !waitResult.spawned) {
        log('manager', 'ensureReady — extension reconnected during grace wait; nothing spawned', {
          waitedMs: waitResult.waitedMs,
        });
        return {
          action: 'noop',
          browserPid: status.browserPid,
          launched: [],
          urlLaunched: false,
          connected: true,
          reconnected: true,
          waitedMs: waitResult.waitedMs,
          budgetMs,
          reason: 'chrome already running with flag; extension reconnected without opening a window',
        };
      }

      if (waitResult.allConnected) {
        log('manager', 'ensureReady — launch-additional complete; all missing profiles connected', {
          launched,
          waitedMs: waitResult.waitedMs,
        });
        return {
          action: 'launch-additional',
          browserPid: status.browserPid,
          launched,
          urlLaunched: urlLaunched(launched),
          connected: true,
          waitedMs: waitResult.waitedMs,
          budgetMs,
          reason: 'chrome already running; opened additional window(s) for profile(s) missing extension connection',
        };
      }

      const stillMissingList = waitResult.stillMissing.join(', ');
      error(
        'manager',
        'ensureReady — extension never reported in for profile(s)',
        new Error('extension connect timeout: ' + stillMissingList)
      );
      return {
        action: 'partial',
        browserPid: status.browserPid,
        launched,
        urlLaunched: urlLaunched(launched),
        connected: false,
        stillMissing: waitResult.stillMissing,
        waitedMs: waitResult.waitedMs,
        budgetMs,
        reason:
          'the WebPilot extension did not report in within ' +
          Math.round(budgetMs / 1000) +
          's for: ' +
          stillMissingList +
          '. Open chrome://extensions on that profile and confirm WebPilot is installed + enabled.',
      };
    }

    // Case 3: running without flag — close + relaunch preserving active
    // profiles, with session restore so the user's windows come back.
    if (status.running && !status.hasFlag) {
      log('manager', 'ensureReady — running without flag, restarting');
      const activeBefore = await this.getActiveProfiles();
      log('manager', 'active profiles before close', { activeBefore });

      const closeResult = await this.closeAll();
      if (closeResult.unknown) {
        error('manager', 'ensureReady abort — chrome state unknown during close', new Error(closeResult.reason || 'detection failed'));
        return {
          action: 'abort',
          launched: [],
          unknown: true,
          reason: 'chrome_state_unknown',
          message: 'could not determine whether Chrome is running (process scan failed): ' + (closeResult.reason || 'unknown error'),
        };
      }
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
      const launched = this._launchProfiles(launchSet, {
        url: launchUrl,
        urlProfiles: reqProfiles,
        restoreSession: true,
      });
      log('manager', 'ensureReady — restart spawned', { launched });
      return await this._finishSpawn({
        action: 'restart',
        launched,
        urlLaunched: urlLaunched(launched),
        reason: 'chrome was running without flag; restarted with active ∪ required profiles (session restored)',
      }, reqProfiles, waitForConnect);
    }

    // Case 4: not running — launch requested profiles fresh
    log('manager', 'ensureReady — chrome not running, launching');
    const launched = this._launchProfiles(reqProfiles, { url: launchUrl });
    log('manager', 'ensureReady — launch spawned', { launched });
    return await this._finishSpawn({
      action: 'launch',
      launched,
      urlLaunched: urlLaunched(launched),
      reason: 'chrome was not running; launched required profiles',
    }, reqProfiles, waitForConnect);
  }

  // ---- internals ----

  /**
   * Shared tail for the launch/restart paths: run the single coordinated wait
   * (launchConnectTimeoutMs) for the required profiles, unless the caller
   * opted out or no bridge is wired. Never changes `action`; sets
   * connected / stillMissing / waitedMs / budgetMs.
   */
  async _finishSpawn(result, reqProfiles, waitForConnect) {
    const bridge = this.extensionBridge;
    if (!waitForConnect || !bridge || typeof bridge.isConnected !== 'function') {
      return { ...result, connected: null };
    }
    const budgetMs = this.launchConnectTimeoutMs;
    const waitResult = await this._waitForProfileConnections(reqProfiles, budgetMs);
    if (!waitResult.allConnected) {
      error(
        'manager',
        'ensureReady — extension never reported in after ' + result.action,
        new Error('extension connect timeout: ' + waitResult.stillMissing.join(', '))
      );
    }
    return {
      ...result,
      connected: waitResult.allConnected,
      stillMissing: waitResult.stillMissing,
      waitedMs: waitResult.waitedMs,
      budgetMs,
    };
  }


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

  /**
   * The single coordinated wait. Polls the extension bridge until every
   * profile in `profiles` reports a live WS connection, or until timeoutMs
   * elapses. Polls every connectPollIntervalMs.
   *
   * opts.spawn(stillMissing): optional; called at most once, as soon as
   *   opts.spawnAfterMs (default 0) has elapsed with profiles still missing.
   *   Lets Case 2 run grace + spawn + post-spawn wait inside one budget.
   *
   * Returns: { allConnected, stillMissing: string[], waitedMs, spawned }
   */
  async _waitForProfileConnections(profiles, timeoutMs, opts) {
    const options = opts || {};
    const startedAt = Date.now();
    const interval = this.connectPollIntervalMs;
    const spawnAfterMs = options.spawnAfterMs || 0;
    let spawned = false;

    const check = () => profiles.filter((p) => !this.extensionBridge.isConnected(p));
    const maybeSpawn = (stillMissing) => {
      if (spawned || typeof options.spawn !== 'function') return;
      if (Date.now() - startedAt < spawnAfterMs) return;
      spawned = true;
      options.spawn(stillMissing);
    };

    let stillMissing = check();
    if (stillMissing.length === 0) {
      return { allConnected: true, stillMissing: [], waitedMs: 0, spawned };
    }

    log('manager', 'waiting for extension to connect for profiles', { profiles, timeoutMs, spawnAfterMs });
    maybeSpawn(stillMissing);

    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      stillMissing = check();
      if (stillMissing.length === 0) {
        const waitedMs = Date.now() - startedAt;
        log('manager', 'all required profiles connected', { profiles, waitedMs, spawned });
        return { allConnected: true, stillMissing: [], waitedMs, spawned };
      }
      maybeSpawn(stillMissing);
    }

    const waitedMs = Date.now() - startedAt;
    log('manager', 'wait-for-connect timed out', { stillMissing, waitedMs, spawned });
    return { allConnected: false, stillMissing, waitedMs, spawned };
  }

  /**
   * Spawn chrome.exe once per profile.
   * opts.url            — launchable URL (already normalized) or null
   * opts.urlProfiles    — profiles that get the URL (default: all)
   * opts.restoreSession — pass --restore-last-session
   */
  _launchProfiles(profiles, opts) {
    const options = opts || {};
    const urlProfiles = Array.isArray(options.urlProfiles) ? options.urlProfiles : null;
    const launched = [];
    for (const p of profiles) {
      const extraArgs = [];
      if (options.restoreSession) extraArgs.push(RESTORE_SESSION_FLAG);
      const url = options.url && (!urlProfiles || urlProfiles.includes(p)) ? options.url : null;
      if (url) extraArgs.push(url);
      try {
        const res = launchChromeProfile({
          chromePath: this.chromePath,
          userDataDir: this.userDataDir,
          profileDirectory: p,
          withFlag: true,
          extraArgs,
        });
        const entry = { profileDirectory: p, pid: res.pid };
        if (url) entry.url = url;
        launched.push(entry);
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

module.exports = {
  ChromeManager,
  createChromeManager,
  normalizeLaunchUrl,
  FORCED_REFRESH_MIN_INTERVAL_MS,
  CONNECT_BUDGET_RUNNING_MS,
  CONNECT_BUDGET_LAUNCH_MS,
  EXTENSION_GRACE_MS,
  CONNECT_POLL_INTERVAL_MS,
  RESTORE_SESSION_FLAG,
};
