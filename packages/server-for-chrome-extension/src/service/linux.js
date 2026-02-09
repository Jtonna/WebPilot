'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  SERVICE_DESCRIPTION,
  getBinaryPath,
  getDataDir,
  getPidPath,
  getPortPath,
} = require('./paths');

const UNIT_NAME = 'webpilot-server.service';

function getUnitDir() {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

function getUnitPath() {
  return path.join(getUnitDir(), UNIT_NAME);
}

function install() {
  try {
    // Ensure data directory exists (for PID/port files)
    fs.mkdirSync(getDataDir(), { recursive: true });

    const unitDir = getUnitDir();
    fs.mkdirSync(unitDir, { recursive: true });

    // Stop and disable existing
    try { execSync(`systemctl --user stop ${UNIT_NAME}`, { stdio: 'pipe' }); } catch (e) { /* not running */ }
    try { execSync(`systemctl --user disable ${UNIT_NAME}`, { stdio: 'pipe' }); } catch (e) { /* not enabled */ }

    const binaryPath = getBinaryPath();
    const unitPath = getUnitPath();

    // Server reads its own config from the data directory — no env vars needed
    const unit = `[Unit]
Description=${SERVICE_DESCRIPTION}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${binaryPath} --foreground
Restart=on-failure
RestartSec=10
WorkingDirectory=${path.dirname(binaryPath)}

[Install]
WantedBy=default.target
`;

    fs.writeFileSync(unitPath, unit, 'utf8');

    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync(`systemctl --user enable ${UNIT_NAME}`, { stdio: 'pipe' });
    execSync(`systemctl --user start ${UNIT_NAME}`, { stdio: 'pipe' });

    // Enable lingering for headless support (non-fatal if denied)
    try {
      execSync(`loginctl enable-linger ${os.userInfo().username}`, { stdio: 'pipe' });
    } catch (e) { /* may require admin */ }

    return {
      success: true,
      message: `Auto-start registered (WebPilotServer on linux).`,
    };
  } catch (err) {
    return { success: false, message: `Failed to install service: ${err.message}` };
  }
}

function uninstall() {
  try {
    try { execSync(`systemctl --user stop ${UNIT_NAME}`, { stdio: 'pipe' }); } catch (e) { /* not running */ }
    try { execSync(`systemctl --user disable ${UNIT_NAME}`, { stdio: 'pipe' }); } catch (e) { /* not enabled */ }

    const unitPath = getUnitPath();
    try {
      fs.unlinkSync(unitPath);
    } catch (e) {
      return { success: false, message: `Service is not registered (unit file not found at ${unitPath}).` };
    }

    try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch (e) { /* non-fatal */ }

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
    const unitPath = getUnitPath();
    const registered = fs.existsSync(unitPath);

    let systemdRunning = false;
    if (registered) {
      try {
        const output = execSync(`systemctl --user is-active ${UNIT_NAME}`, {
          stdio: 'pipe',
          encoding: 'utf8',
        });
        systemdRunning = output.trim() === 'active';
      } catch (e) { /* inactive or failed */ }
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

    const running = pidAlive;

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
        `PID:        ${running && pid ? pid : '-'}`,
        `Port:       ${running && port ? port : '-'}`,
        `Health:     ${running && port ? 'http://localhost:' + port + '/health' : '-'}`,
        `SSE:        ${running && port ? 'http://localhost:' + port + '/sse' : '-'}`,
      ].join('\n'),
    };
  } catch (err) {
    return { success: false, message: `Failed to check status: ${err.message}` };
  }
}

module.exports = { install, uninstall, status };
