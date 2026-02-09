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
  getPort,
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

    // Check PID/port files
    let pid = null;
    try { pid = fs.readFileSync(getPidPath(), 'utf8').trim(); } catch (e) { /* no file */ }

    let port = null;
    try { port = fs.readFileSync(getPortPath(), 'utf8').trim(); } catch (e) { /* no file */ }

    let portListening = false;
    const checkPort = port || getPort();
    try {
      execSync(`lsof -i :${checkPort} -sTCP:LISTEN -t`, { stdio: 'pipe' });
      portListening = true;
    } catch (e) { /* port not in use */ }

    const running = launchdRunning || portListening;

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
