const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

// Deployment paths
function getDeploymentDir() {
  if (process.platform === 'win32') {
    // %LOCALAPPDATA%\WebPilot
    return path.join(process.env.LOCALAPPDATA, 'WebPilot');
  } else if (process.platform === 'darwin') {
    // ~/Library/Application Support/WebPilot
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'WebPilot');
  } else {
    // ~/.config/WebPilot (respects XDG_CONFIG_HOME)
    const configHome = process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config');
    return path.join(configHome, 'WebPilot');
  }
}

function getExtensionDir() {
  return path.join(getDeploymentDir(), 'chrome extension', 'unpacked-extension');
}

function getServerBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(getDeploymentDir(), `webpilot-server${ext}`);
}

// Copy directory recursively
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

function deployFiles() {
  const deployDir = getDeploymentDir();
  fs.mkdirSync(deployDir, { recursive: true });

  if (isDev) {
    // In dev mode, resources are in the repo
    const serverDistDir = path.join(__dirname, '..', '..', 'server-for-chrome-extension', 'dist');
    const extensionDir = path.join(__dirname, '..', '..', 'chrome-extension-unpacked');

    // Deploy extension (always available in dev)
    if (fs.existsSync(extensionDir)) {
      copyDirSync(extensionDir, getExtensionDir());
      console.log('Deployed extension to:', getExtensionDir());
    }

    // Deploy server binary (only if built)
    if (fs.existsSync(serverDistDir)) {
      // Only deploy the server binary for the current platform
      const platformSuffix = process.platform === 'win32' ? '-win.exe'
        : process.platform === 'darwin' ? '-macos'
        : '-linux';

      const files = fs.readdirSync(serverDistDir).filter(f => f.endsWith(platformSuffix) || !f.includes('-'));
      for (const file of files) {
        fs.copyFileSync(
          path.join(serverDistDir, file),
          path.join(deployDir, file)
        );
      }
      console.log('Deployed server binary to:', deployDir);
    } else {
      console.log('Server binary not built yet — skipping server deployment');
    }
  } else {
    // In production, resources are in the app's resources directory
    const resourcesPath = process.resourcesPath;
    const serverResourceDir = path.join(resourcesPath, 'server');
    const extensionResourceDir = path.join(resourcesPath, 'chrome-extension');

    // Deploy extension
    if (fs.existsSync(extensionResourceDir)) {
      copyDirSync(extensionResourceDir, getExtensionDir());
      console.log('Deployed extension to:', getExtensionDir());
    }

    // Deploy server binary
    if (fs.existsSync(serverResourceDir)) {
      // Only deploy the server binary for the current platform
      const platformSuffix = process.platform === 'win32' ? '-win.exe'
        : process.platform === 'darwin' ? '-macos'
        : '-linux';

      const files = fs.readdirSync(serverResourceDir).filter(f => f.endsWith(platformSuffix) || !f.includes('-'));
      for (const file of files) {
        fs.copyFileSync(
          path.join(serverResourceDir, file),
          path.join(deployDir, file)
        );
      }
      console.log('Deployed server binary to:', deployDir);
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.setMenuBarVisibility(false);

  if (isDev) {
    win.loadURL('http://localhost:3000');
  } else {
    // Load the exported Next.js static files
    win.loadFile(path.join(__dirname, '..', 'out', 'index.html'));
  }
}

app.whenReady().then(() => {
  deployFiles();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
