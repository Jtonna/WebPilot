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

    // Check PID file and validate PID is alive
    let pid = null;
    try {
      pid = fs.readFileSync(getPidPath(), 'utf8').trim();
    } catch (e) { /* no pid file */ }

    let pidAlive = false;
    if (pid) {
      try {
        process.kill(parseInt(pid, 10), 0);
        pidAlive = true;
      } catch (e) {
        // Process is dead — clean up stale files
        pid = null;
        try { fs.unlinkSync(getPidPath()); } catch (e2) { /* */ }
        try { fs.unlinkSync(getPortPath()); } catch (e2) { /* */ }
      }
    }

    // Check port file — only if PID is alive
    let port = null;
    if (pidAlive) {
      try {
        port = fs.readFileSync(getPortPath(), 'utf8').trim();
      } catch (e) { /* no port file */ }
    }

    // Check if server is listening on the port (only if we have a port)
    let portListening = false;
    if (port) {
      try {
        const netstatOutput = execSync(`netstat -ano | findstr ":${port}"`, {
          stdio: 'pipe',
          encoding: 'utf8',
          windowsHide: true,
        });
        portListening = netstatOutput.includes('LISTENING');
      } catch (e) { /* port not in use */ }
    }

    const running = pidAlive && (portListening || !!pid);

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
        running && pid ? `PID:        ${pid}` : null,
        running && port ? `Port:       ${port}` : null,
        running && port ? `Health:     http://localhost:${port}/health` : null,
        running && port ? `SSE:        http://localhost:${port}/sse` : null,
      ].filter(Boolean).join('\n'),
    };
  } catch (err) {
    return { success: false, message: `Failed to check status: ${err.message}` };
  }
}

module.exports = { install, uninstall, status };
