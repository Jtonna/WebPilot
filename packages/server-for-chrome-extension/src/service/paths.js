'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SERVICE_NAME = 'WebPilotServer';
const SERVICE_LABEL = 'com.webpilot.server';
const SERVICE_DESCRIPTION = 'WebPilot MCP Server';
const DEFAULT_PORT = 3456;
const DEFAULT_API_KEY = 'dev-123-test';

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

function getDataDir() {
  if (isPkgBinary()) {
    // The server exe lives at e.g.
    //   C:\...\Programs\WebPilot\resources\server\webpilot-server-for-chrome-extension.exe
    // We want the data dir at:
    //   C:\...\Programs\WebPilot\data\
    return path.resolve(path.dirname(process.execPath), '..', '..', 'data');
  }

  // Dev mode — use platform-specific user-local config directory
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA, 'WebPilot');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'WebPilot');
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, 'WebPilot');
  }
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

function getApiKey() {
  const config = loadConfig();
  return config.apiKey || process.env.API_KEY || DEFAULT_API_KEY;
}

module.exports = {
  SERVICE_NAME,
  SERVICE_LABEL,
  SERVICE_DESCRIPTION,
  DEFAULT_PORT,
  DEFAULT_API_KEY,
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
  getApiKey,
};
