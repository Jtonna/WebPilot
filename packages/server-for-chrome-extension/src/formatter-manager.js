'use strict';

const fs = require('fs');
const path = require('path');
const { getFormatterDir, getBundledFormatterDir } = require('./service/paths');

let manifest = null;
let formatterCache = {}; // path -> loaded module

function init() {
  const formatterDir = getFormatterDir();
  const manifestPath = path.join(formatterDir, 'manifest.json');

  // First run: copy bundled formatters to data dir
  if (!fs.existsSync(manifestPath)) {
    const bundledDir = getBundledFormatterDir();
    if (fs.existsSync(path.join(bundledDir, 'manifest.json'))) {
      copyDirSync(bundledDir, formatterDir);
      console.log('[formatter-manager] Copied bundled formatters to', formatterDir);
    } else {
      console.warn('[formatter-manager] No bundled formatters found at', bundledDir);
      return;
    }
  }

  // Load manifest
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log('[formatter-manager] Loaded manifest version', manifest.version);
}

function formatTree(url, rawNodes) {
  if (!manifest) {
    // Fallback: try loading default from bundled
    const { formatAccessibilityTree } = require(path.join(getBundledFormatterDir(), 'default.js'));
    return formatAccessibilityTree(rawNodes);
  }

  const formatterDir = getFormatterDir();

  // Match URL to platform
  if (url) {
    try {
      const hostname = new URL(url).hostname;
      for (const [platformName, platformConfig] of Object.entries(manifest.platforms)) {
        if (hostname.includes(platformConfig.match)) {
          const entryPath = path.join(formatterDir, platformConfig.entry);
          try {
            const formatter = loadFormatter(entryPath);
            // Platform formatters export a single format function (the main exported function)
            const formatFn = Object.values(formatter)[0]; // Get the first exported function
            const result = formatFn(rawNodes);
            return result;
          } catch (err) {
            console.warn(`[formatter-manager] Platform formatter ${platformName} failed:`, err.message);
            // Fall through to default
          }
        }
      }
    } catch (err) {
      console.warn('[formatter-manager] URL parsing failed:', err.message);
    }
  }

  // Default formatter
  const defaultPath = path.join(formatterDir, manifest.default);
  const defaultFormatter = loadFormatter(defaultPath);
  return defaultFormatter.formatAccessibilityTree(rawNodes);
}

function loadFormatter(filePath) {
  if (!formatterCache[filePath]) {
    formatterCache[filePath] = require(filePath);
  }
  return formatterCache[filePath];
}

function reload() {
  // Clear require cache for all loaded formatter files
  for (const filePath of Object.keys(formatterCache)) {
    const resolved = require.resolve(filePath);
    delete require.cache[resolved];
  }
  formatterCache = {};

  // Re-read manifest
  const manifestPath = path.join(getFormatterDir(), 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    console.log('[formatter-manager] Reloaded manifest version', manifest.version);
  }
}

// Helper: recursively copy directory
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = { init, formatTree, reload };
