'use strict';

const fs = require('fs');
const path = require('path');
const { getFormatterDir } = require('./service/paths');

// GitHub raw content base URL — hardcoded to this repo
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Jtonna/WebPilot/main/accessibility-tree-formatters';

let formatterManager = null;

function init(manager) {
  formatterManager = manager;
}

async function checkForUpdates() {
  const formatterDir = getFormatterDir();
  const localManifestPath = path.join(formatterDir, 'manifest.json');

  // Read local manifest version
  let localVersion = '0';
  if (fs.existsSync(localManifestPath)) {
    try {
      const localManifest = JSON.parse(fs.readFileSync(localManifestPath, 'utf8'));
      localVersion = localManifest.version;
    } catch (err) {
      console.warn('[formatter-updater] Failed to read local manifest:', err.message);
    }
  }

  // Fetch remote manifest with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${GITHUB_RAW_BASE}/manifest.json`, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Failed to fetch remote manifest: HTTP ${res.status}`);
    }

    const remoteManifest = await res.json();

    if (remoteManifest.version === localVersion) {
      console.log(`[formatter-updater] Already up to date (version ${localVersion})`);
      return { updated: false, currentVersion: localVersion };
    }

    console.log(`[formatter-updater] Update available: ${localVersion} -> ${remoteManifest.version}`);

    // Download all files listed in manifest, plus the manifest itself
    const files = remoteManifest.files || [remoteManifest.default];
    const allFiles = ['manifest.json', ...files];

    for (const file of allFiles) {
      const fileController = new AbortController();
      const fileTimeout = setTimeout(() => fileController.abort(), 10000);

      const fileRes = await fetch(`${GITHUB_RAW_BASE}/${file}`, { signal: fileController.signal });
      clearTimeout(fileTimeout);

      if (!fileRes.ok) {
        throw new Error(`Failed to fetch ${file}: HTTP ${fileRes.status}`);
      }

      const content = await fileRes.text();
      const destPath = path.join(formatterDir, file);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, content, 'utf8');
    }

    console.log(`[formatter-updater] Updated from version ${localVersion} to ${remoteManifest.version}`);

    // Reload formatters in memory
    if (formatterManager) {
      formatterManager.reload();
    }

    return { updated: true, fromVersion: localVersion, toVersion: remoteManifest.version };

  } catch (err) {
    clearTimeout(timeout);
    console.error('[formatter-updater] Update check failed:', err.message);
    return { updated: false, error: err.message };
  }
}

module.exports = { init, checkForUpdates };
