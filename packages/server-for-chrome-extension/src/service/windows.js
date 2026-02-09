'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const {
  SERVICE_NAME,
  getBinaryPath,
  getDataDir,
  getDaemonLogPath,
  getPidPath,
  getPortPath,
  getPort,
} = require('./paths');

// Registry Run key — standard auto-start mechanism, no admin required
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE = SERVICE_NAME;

function install() {
  try {
    // Ensure data directory exists (for PID/port files)
    fs.mkdirSync(getDataDir(), { recursive: true });

    const binaryPath = getBinaryPath();

    // Register via HKCU Run key (runs at user logon, no admin required)
    execSync(
      `reg add "${REG_KEY}" /v "${REG_VALUE}" /t REG_SZ /d "\\"${binaryPath}\\" --foreground" /f`,
      { stdio: 'pipe', windowsHide: true },
    );

    return {
      success: true,
      message: `Auto-start registered (WebPilotServer on windows).`,
    };
  } catch (err) {
    return { success: false, message: `Failed to install service: ${err.message}` };
  }
}

function uninstall() {
  try {
    // Remove registry entry
    try {
      execSync(`reg delete "${REG_KEY}" /v "${REG_VALUE}" /f`, { stdio: 'pipe', windowsHide: true });
    } catch (e) {
      return { success: false, message: `Service is not registered (registry value "${REG_VALUE}" not found).` };
    }

    // Clean up PID/port files
    try { fs.unlinkSync(getPidPath()); } catch (e) { /* non-fatal */ }
    try { fs.unlinkSync(getPortPath()); } catch (e) { /* non-fatal */ }

    return { success: true, message: `Auto-start removed.` };
  } catch (err) {
    return { success: false, message: `Failed to uninstall service: ${err.message}` };
  }
}

function status() {
  try {
    // Check registry registration
    let registered = false;
    try {
      execSync(`reg query "${REG_KEY}" /v "${REG_VALUE}"`, { stdio: 'pipe', windowsHide: true });
      registered = true;
    } catch (e) { /* not registered */ }

    // Check PID file
    let pid = null;
    try {
      pid = fs.readFileSync(getPidPath(), 'utf8').trim();
    } catch (e) { /* no pid file */ }

    // Check port file
    let port = null;
    try {
      port = fs.readFileSync(getPortPath(), 'utf8').trim();
    } catch (e) { /* no port file */ }

    // Check if server is listening on the port
    let portListening = false;
    const checkPort = port || getPort();
    try {
      const netstatOutput = execSync(`netstat -ano | findstr ":${checkPort}"`, {
        stdio: 'pipe',
        encoding: 'utf8',
        windowsHide: true,
      });
      portListening = netstatOutput.includes('LISTENING');
    } catch (e) { /* port not in use */ }

    const running = portListening || !!pid;

    return {
      success: true,
      registered,
      running,
      message: [
        `WebPilot MCP Server Status`,
        `──────────────────────────`,
        `Data dir:   ${getDataDir()}`,
        `Service:    ${registered ? 'Registered (WebPilotServer)' : 'Not registered'}`,
        `Running:    ${running ? 'yes' : 'no'}`,
        pid ? `PID:        ${pid}` : null,
        `Port:       ${checkPort}`,
        running ? `Health:     http://localhost:${checkPort}/health` : null,
        running ? `SSE:        http://localhost:${checkPort}/sse` : null,
      ].filter(Boolean).join('\n'),
    };
  } catch (err) {
    return { success: false, message: `Failed to check status: ${err.message}` };
  }
}

module.exports = { install, uninstall, status };
