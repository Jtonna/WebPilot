'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  SERVICE_LABEL,
  getBinaryPath,
  getDataDir,
  getDaemonLogPath,
  getPidPath,
  getPortPath,
} = require('./paths');

function getPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function install() {
  try {
    // Ensure data directory exists (for PID/port files)
    fs.mkdirSync(getDataDir(), { recursive: true });

    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(launchAgentsDir, { recursive: true });

    // Unload existing if present
    const plistPath = getPlistPath();
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    } catch (e) { /* not loaded */ }

    const binaryPath = getBinaryPath();

    // Server reads its own config from the data directory — no env vars needed
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${binaryPath}</string>
        <string>--foreground</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>WorkingDirectory</key>
    <string>${path.dirname(binaryPath)}</string>
</dict>
</plist>`;

    fs.writeFileSync(plistPath, plist, 'utf8');
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });

    return {
      success: true,
      message: `Auto-start registered (WebPilotServer on macos).`,
    };
  } catch (err) {
    return { success: false, message: `Failed to install service: ${err.message}` };
  }
}

function uninstall() {
  try {
    const plistPath = getPlistPath();

    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    } catch (e) { /* may not be loaded */ }

    try {
      fs.unlinkSync(plistPath);
    } catch (e) {
      return { success: false, message: `Service is not registered (plist not found at ${plistPath}).` };
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
    const plistPath = getPlistPath();
    const registered = fs.existsSync(plistPath);

    let launchdRunning = false;
    if (registered) {
      try {
        const output = execSync(`launchctl list "${SERVICE_LABEL}"`, {
          stdio: 'pipe',
          encoding: 'utf8',
        });
        launchdRunning = !output.includes('"PID" = 0;') && output.includes('"PID"');
      } catch (e) { /* not loaded */ }
    }

    // Check PID file and validate PID is alive
    let pid = null;
    try { pid = fs.readFileSync(getPidPath(), 'utf8').trim(); } catch (e) { /* no file */ }

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
      try { port = fs.readFileSync(getPortPath(), 'utf8').trim(); } catch (e) { /* no file */ }
    }

    // Check if server is listening on the port (only if we have a port)
    let portListening = false;
    if (port) {
      try {
        execSync(`lsof -i :${port} -sTCP:LISTEN -t`, { stdio: 'pipe' });
        portListening = true;
      } catch (e) { /* port not in use */ }
    }

    const running = pidAlive && (launchdRunning || portListening || !!pid);

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
