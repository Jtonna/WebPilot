const { contextBridge } = require('electron');
const path = require('path');
const fs = require('fs');

// Paths are passed from main.js via webPreferences.additionalArguments
// because process.resourcesPath is not available in preload context.
function getArg(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const dataDir = getArg('data-dir');
const serverBinaryPath = getArg('server-binary');
const extensionPath = getArg('extension-path');

contextBridge.exposeInMainWorld('webpilot', {
  getServerPort: () => {
    if (!dataDir) return null;
    try {
      return fs.readFileSync(path.join(dataDir, 'server.port'), 'utf8').trim() || null;
    } catch {
      return null;
    }
  },

  getDataDir: () => dataDir,

  getExtensionPath: () => extensionPath,

  isExtensionAvailable: () => {
    if (!extensionPath) return { extensionExists: false, extensionPath: '' };
    const extensionExists = fs.existsSync(path.join(extensionPath, 'manifest.json'));
    return { extensionExists, extensionPath };
  },

  installService: () => {
    if (!serverBinaryPath) return { success: false, message: 'Server binary path not available' };
    const { execFileSync } = require('child_process');
    try {
      const output = execFileSync(serverBinaryPath, ['--install'], {
        encoding: 'utf8',
        timeout: 15000,
      });
      return { success: true, message: output };
    } catch (err) {
      return { success: false, message: err.stderr || err.message };
    }
  },

  uninstallService: () => {
    if (!serverBinaryPath) return { success: false, message: 'Server binary path not available' };
    const { execFileSync } = require('child_process');
    try {
      const output = execFileSync(serverBinaryPath, ['--uninstall'], {
        encoding: 'utf8',
        timeout: 15000,
      });
      return { success: true, message: output };
    } catch (err) {
      return { success: false, message: err.stderr || err.message };
    }
  },

  getServiceStatus: () => {
    if (!serverBinaryPath) return { success: false, message: 'Server binary path not available' };
    const { execFileSync } = require('child_process');
    try {
      const output = execFileSync(serverBinaryPath, ['--status'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      return { success: true, message: output };
    } catch (err) {
      return { success: false, message: err.stderr || err.message };
    }
  },
});
