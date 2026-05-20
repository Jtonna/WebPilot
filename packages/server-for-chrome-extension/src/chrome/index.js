'use strict';

/**
 * Public entry point for the Chrome management module.
 * Wave 2 will wire this into mcp-handler.js's browser_create_tab readiness gate.
 */

const { ChromeManager, createChromeManager } = require('./manager');
const { detectChromeBrowsers } = require('./detector');
const { closeChromeGracefully } = require('./closer');
const { launchChromeProfile } = require('./launcher');
const { readProfiles } = require('./local-state');
const { getActiveProfiles } = require('./profile-activity');
const { getDefaultChromePath, getDefaultUserDataDir } = require('./paths');

module.exports = {
  ChromeManager,
  createChromeManager,
  detectChromeBrowsers,
  closeChromeGracefully,
  launchChromeProfile,
  readProfiles,
  getActiveProfiles,
  getDefaultChromePath,
  getDefaultUserDataDir,
};
