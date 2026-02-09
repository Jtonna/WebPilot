const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const isDev = !app.isPackaged;

function getServerBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (isDev) {
    // In dev, use the built binary from the server package dist
    return path.join(__dirname, '..', '..', 'server-for-chrome-extension', 'dist', `webpilot-server-for-chrome-extension${ext}`);
  }
  // In production, use the binary from app resources
  return path.join(process.resourcesPath, 'server', `webpilot-server-for-chrome-extension${ext}`);
}

function getDataDir() {
  if (isDev) {
    // Dev mode — use platform-specific user-local config directory
    if (process.platform === 'win32') {
      return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'WebPilot');
    } else if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'WebPilot');
    } else {
      const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      return path.join(configHome, 'WebPilot');
    }
  }
  // In production, data dir lives next to resources/ inside the install dir
  return path.join(path.dirname(process.resourcesPath), 'data');
}

function ensureDataDir() {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
}

function startServer() {
  const serverPath = getServerBinaryPath();
  if (!fs.existsSync(serverPath)) {
    console.log('Server binary not found; skipping server start');
    return;
  }
  const { spawn } = require('child_process');
  // Spawn with detached + windowsHide to prevent console window flash.
  // The server exe handles everything internally: already-running check,
  // auto-register, background daemon spawn, health check.
  const child = spawn(serverPath, [], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log('Server process launched.');
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
  ensureDataDir();
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
