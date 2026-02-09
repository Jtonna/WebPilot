#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Argument parsing (Node 18+ built-in util.parseArgs)
// ---------------------------------------------------------------------------
const options = {
  foreground: { type: 'boolean', default: false },
  install:   { type: 'boolean', default: false },
  uninstall: { type: 'boolean', default: false },
  stop:      { type: 'boolean', default: false },
  status:    { type: 'boolean', default: false },
  help:      { type: 'boolean', default: false },
  version:   { type: 'boolean', default: false },
  // --network is forwarded to the server (index.js reads process.argv directly)
  network:   { type: 'boolean', default: false },
};

let parsed;
try {
  parsed = parseArgs({ options, strict: true });
} catch (err) {
  console.error(`Error: ${err.message}`);
  console.error('Run with --help for usage information.');
  process.exit(1);
}

const flags = parsed.values;

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------
if (flags.help) {
  const helpText = `
WebPilot MCP Server

Usage: webpilot-mcp [options]

Options:
  --foreground   Run server in the foreground (for development/testing)
  --install      Register as a background service
  --uninstall    Remove the background service
  --stop         Stop the running server
  --status       Check service status
  --help         Show this help message
  --version      Show version number

Running with no options starts the server as a background daemon.
`.trimStart();

  process.stdout.write(helpText);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --version
// ---------------------------------------------------------------------------
if (flags.version) {
  const pkg = require('./package.json');
  console.log(pkg.version);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Service actions  (--install | --uninstall | --status)
// ---------------------------------------------------------------------------

function handleInstall() {
  const service = require('./src/service');
  const result = service.install();
  console.log(result.message);
  if (!result.success) process.exit(1);
}

function handleUninstall() {
  const service = require('./src/service');
  const result = service.uninstall();
  console.log(result.message);
  if (!result.success) process.exit(1);
}

function handleStatus() {
  const service = require('./src/service');
  const result = service.status();
  console.log(result.message);
  if (!result.success) process.exit(1);
}

function handleStop() {
  const { getPidPath, getPortPath } = require('./src/service/paths');
  const pidPath = getPidPath();
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
  } catch (e) {
    console.log('Server is not running (no PID file).');
    process.exit(0);
  }
  try {
    process.kill(pid, 0); // Check if alive
    process.kill(pid, 'SIGTERM');
    // On Windows SIGTERM kills immediately without running exit handlers,
    // so clean up PID/port files ourselves
    try { fs.unlinkSync(pidPath); } catch (e) { /* non-fatal */ }
    try { fs.unlinkSync(getPortPath()); } catch (e) { /* non-fatal */ }
    console.log(`Server stopped (PID ${pid}).`);
  } catch (e) {
    if (e.code === 'ESRCH') {
      console.log(`Server is not running (stale PID ${pid}).`);
      try { fs.unlinkSync(pidPath); } catch (e2) { /* non-fatal */ }
      try { fs.unlinkSync(getPortPath()); } catch (e2) { /* non-fatal */ }
    } else {
      console.error(`Failed to stop server: ${e.message}`);
      process.exit(1);
    }
  }
}

if (flags.install) {
  handleInstall();
  process.exit(0);
}

if (flags.uninstall) {
  handleUninstall();
  process.exit(0);
}

if (flags.stop) {
  handleStop();
  process.exit(0);
}

if (flags.status) {
  handleStatus();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Default: start the MCP server
// ---------------------------------------------------------------------------

const { getPidPath, getPortPath, getDaemonLogPath, getDataDir, getPort } = require('./src/service/paths');

// Check if server is already running
function isAlreadyRunning() {
  const pidPath = getPidPath();
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    if (pid) {
      process.kill(pid, 0); // Throws if process doesn't exist
      return pid;
    }
  } catch (e) {
    // Process doesn't exist or no PID file — clean up stale files
    try { fs.unlinkSync(pidPath); } catch (e2) { /* non-fatal */ }
    try { fs.unlinkSync(getPortPath()); } catch (e2) { /* non-fatal */ }
  }
  return null;
}

// Auto-register service if not already registered
function autoRegister() {
  try {
    const service = require('./src/service');
    const result = service.status();
    if (!result.registered) {
      console.log('Registering auto-start service...');
      const installResult = service.install();
      if (installResult.success) {
        console.log('Auto-start service registered.');
      } else {
        console.warn('Warning: Could not register auto-start:', installResult.message);
      }
    }
  } catch (e) {
    console.warn('Warning: Could not check/register service:', e.message);
  }
}

// Forward --network flag via env var so index.js picks it up
if (flags.network || process.env.NETWORK === '1') {
  process.env.NETWORK = '1';
}

if (flags.foreground || process.env.WEBPILOT_FOREGROUND === '1') {
  // Foreground mode: run server directly in this process
  // Initialize daemon logging
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const { setupLogging } = require('./src/service/logger');
  const logWriter = setupLogging(getDaemonLogPath());

  // Auto-register on first run
  autoRegister();

  // Clean up log writer on exit
  process.on('exit', () => logWriter.close());

  // Start server
  require('./index.js');
} else {
  // Background mode (default): spawn detached process and exit
  const { spawn } = require('node:child_process');
  const http = require('node:http');

  // Check if already running
  const existingPid = isAlreadyRunning();
  if (existingPid) {
    let port = null;
    try {
      port = fs.readFileSync(getPortPath(), 'utf8').trim();
    } catch (e) { /* no port file */ }
    console.log(`Server is already running (PID ${existingPid}${port ? ', port ' + port : ''}).`);
    process.exit(0);
  }

  // Auto-register service
  autoRegister();

  // Spawn self with WEBPILOT_FOREGROUND env var (avoids pkg argument parsing issue)
  // The child process sets up daemon.log via setupLogging() in foreground mode
  const child = spawn(process.execPath, [], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    cwd: path.dirname(process.execPath),
    env: { ...process.env, WEBPILOT_FOREGROUND: '1' },
  });
  child.unref();

  console.log('Starting server in background...');

  // Poll health endpoint to verify startup (up to 3 seconds)
  const port = getPort();
  let attempts = 0;
  const maxAttempts = 6;

  function checkHealth() {
    attempts++;
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 500 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        // Read PID/port files for display
        let pid = null;
        try { pid = fs.readFileSync(getPidPath(), 'utf8').trim(); } catch (e) { /* */ }
        console.log(`Server started successfully (PID ${pid || child.pid}, port ${port}).`);
        process.exit(0);
      });
    });
    req.on('error', () => {
      if (attempts < maxAttempts) {
        setTimeout(checkHealth, 500);
      } else {
        console.log(`Server spawned (PID ${child.pid}) but health check timed out.`);
        console.log(`Check ${getDaemonLogPath()} for details.`);
        process.exit(0);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      if (attempts < maxAttempts) {
        setTimeout(checkHealth, 500);
      } else {
        console.log(`Server spawned (PID ${child.pid}) but health check timed out.`);
        console.log(`Check ${getDaemonLogPath()} for details.`);
        process.exit(0);
      }
    });
  }

  checkHealth();
}
