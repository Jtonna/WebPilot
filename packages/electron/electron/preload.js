const { contextBridge } = require('electron');
const path = require('path');
const fs = require('fs');

// Compute deployment paths based on platform (app module is not available in preload)
function getDeploymentDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA, 'WebPilot');
  } else if (process.platform === 'darwin') {
    return path.join(process.env.HOME, 'Library', 'Application Support', 'WebPilot');
  } else {
    return path.join(
      process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'),
      'WebPilot'
    );
  }
}

function getServerBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getDeploymentDir(), `webpilot-server-for-chrome-extension${ext}`);
}

contextBridge.exposeInMainWorld('webpilot', {
  getDeploymentPath: () => getDeploymentDir(),
  isDeployed: () => {
    const dir = getDeploymentDir();
    const extensionExists = fs.existsSync(
      path.join(dir, 'chrome extension', 'unpacked-extension', 'manifest.json')
    );
    return { extensionExists, deploymentPath: dir };
  },
  installService: () => {
    const { execFileSync } = require('child_process');
    const binaryPath = getServerBinaryPath();
    try {
      const output = execFileSync(binaryPath, ['--install'], {
        encoding: 'utf8',
        timeout: 15000,
      });
      return { success: true, message: output };
    } catch (err) {
      return { success: false, message: err.stderr || err.message };
    }
  },
  uninstallService: () => {
    const { execFileSync } = require('child_process');
    const binaryPath = getServerBinaryPath();
    try {
      const output = execFileSync(binaryPath, ['--uninstall'], {
        encoding: 'utf8',
        timeout: 15000,
      });
      return { success: true, message: output };
    } catch (err) {
      return { success: false, message: err.stderr || err.message };
    }
  },
  getServiceStatus: () => {
    const { execFileSync } = require('child_process');
    const binaryPath = getServerBinaryPath();
    try {
      const output = execFileSync(binaryPath, ['--status'], {
        encoding: 'utf8',
        timeout: 10000,
      });
      return { success: true, message: output };
    } catch (err) {
      return { success: false, message: err.stderr || err.message };
    }
  },
});
