'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVICE_NAME = 'WebPilotServer';
const SERVICE_LABEL = 'com.webpilot.server';
const SERVICE_DESCRIPTION = 'WebPilot MCP Server';
const DEFAULT_PORT = 3456;

/**
 * Detect whether we are running as a pkg-compiled binary.
 * pkg sets process.pkg at runtime; we also check that execPath is a
 * standalone .exe (not node.exe) on Windows.
 */
function isPkgBinary() {
  if (process.pkg) return true;
  if (process.platform === 'win32') {
    const exe = path.basename(process.execPath).toLowerCase();
    return exe.endsWith('.exe') && exe !== 'node.exe';
  }
  return false;
}

/**
 * Return the platform-appropriate userData-equivalent directory.
 * Mirrors what Electron's `app.getPath('userData')` resolves to for
 * productName "WebPilot" on each OS, so the daemon and the Electron
 * shell end up at the same path whether the env var is set or not.
 */
function platformUserDataDir() {
  if (process.platform === 'win32') {
    // Electron's app.getPath('userData') on Windows resolves to
    // %APPDATA%\<app.getName()>, and app.getName() returns the
    // package.json "name" field ("@webpilot/onboarding"), which takes
    // precedence over electron-builder's productName for the userData
    // path. Hardcode that exact path so the autostart-launched daemon
    // (no WEBPILOT_DATA_DIR env var) reads the SAME dir as the
    // Electron-spawned daemon. Do not change this string without also
    // moving existing user data — see packages/electron/package.json.
    const appData = process.env.APPDATA
      || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, '@webpilot', 'onboarding');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'WebPilot');
  }
  const configHome = process.env.XDG_CONFIG_HOME
    || path.join(os.homedir(), '.config');
  return path.join(configHome, 'WebPilot');
}

/**
 * Resolve the user-data directory the daemon should read/write.
 *
 * Resolution order:
 *   1. WEBPILOT_DATA_DIR env var (Electron main passes
 *      `app.getPath('userData')` here when it spawns the daemon).
 *   2. Platform userData-equivalent path. On Windows that's
 *      %APPDATA%\WebPilot — the same path Electron itself would pick,
 *      so the autostart-launched daemon (no env var, started via the
 *      HKCU Run key) lands on the same dir.
 *
 * Both branches survive a WebPilot upgrade — neither lives inside the
 * install dir.
 */
function getDataDir() {
  if (process.env.WEBPILOT_DATA_DIR) {
    return process.env.WEBPILOT_DATA_DIR;
  }
  return platformUserDataDir();
}

function getLogDir() {
  return path.join(getDataDir(), 'logs');
}

function getLogPath() {
  return path.join(getLogDir(), 'server.log');
}

function getErrorLogPath() {
  return path.join(getLogDir(), 'server-error.log');
}

function getDaemonLogPath() {
  return path.join(getDataDir(), 'daemon.log');
}

function getConfigPath() {
  return path.join(getDataDir(), 'config', 'server.json');
}

function getPidPath() {
  return path.join(getDataDir(), 'server.pid');
}

function getPortPath() {
  return path.join(getDataDir(), 'server.port');
}

function getBinaryPath() {
  return process.execPath;
}

function getFormatterDir() {
  return path.join(getDataDir(), 'formatters');
}

function loadConfig() {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    // Ignore parse errors, use defaults
  }
  return {};
}

function getPort() {
  const config = loadConfig();
  return config.port || process.env.PORT || DEFAULT_PORT;
}

module.exports = {
  SERVICE_NAME,
  SERVICE_LABEL,
  SERVICE_DESCRIPTION,
  DEFAULT_PORT,
  getDataDir,
  getLogDir,
  getLogPath,
  getErrorLogPath,
  getDaemonLogPath,
  getConfigPath,
  getPidPath,
  getPortPath,
  getBinaryPath,
  loadConfig,
  getPort,
  getFormatterDir,
  // Exposed for diagnostics / tests:
  isPkgBinary,
  platformUserDataDir,
};
