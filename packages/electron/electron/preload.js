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

contextBridge.exposeInMainWorld('webpilot', {
  getDeploymentPath: () => getDeploymentDir(),
  isDeployed: () => {
    const dir = getDeploymentDir();
    const extensionExists = fs.existsSync(
      path.join(dir, 'chrome extension', 'unpacked-extension', 'manifest.json')
    );
    return { extensionExists, deploymentPath: dir };
  },
});
