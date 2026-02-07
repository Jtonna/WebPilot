#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Argument parsing (Node 18+ built-in util.parseArgs)
// ---------------------------------------------------------------------------
const options = {
  install:   { type: 'boolean', default: false },
  uninstall: { type: 'boolean', default: false },
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
  --install     Register as a background service
  --uninstall   Remove the background service
  --status      Check service status
  --help        Show this help message
  --version     Show version number

Running with no options starts the MCP server.
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
// Service action stubs  (--install | --uninstall | --status)
// ---------------------------------------------------------------------------

/**
 * Stub for service registration. Logs the detected platform and a
 * "not yet implemented" message. Will be replaced in a future ticket.
 */
function handleInstall() {
  const platform = process.platform;
  console.log(`Detected platform: ${platform}`);
  console.log(`Service registration not yet implemented for ${platform}`);
}

/**
 * Stub for service removal. Logs the detected platform and a
 * "not yet implemented" message. Will be replaced in a future ticket.
 */
function handleUninstall() {
  const platform = process.platform;
  console.log(`Detected platform: ${platform}`);
  console.log(`Service removal not yet implemented for ${platform}`);
}

/**
 * Stub for service status check. Logs the detected platform and a
 * "not yet implemented" message. Will be replaced in a future ticket.
 */
function handleStatus() {
  const platform = process.platform;
  console.log(`Detected platform: ${platform}`);
  console.log(`Service status check not yet implemented for ${platform}`);
}

if (flags.install) {
  handleInstall();
  process.exit(0);
}

if (flags.uninstall) {
  handleUninstall();
  process.exit(0);
}

if (flags.status) {
  handleStatus();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Default: start the MCP server
// ---------------------------------------------------------------------------
// index.js calls createServer() at the top level, so simply requiring it
// boots the server. The --network flag is already on process.argv and will
// be picked up by index.js.
require('./index.js');
