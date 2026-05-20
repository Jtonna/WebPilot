const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = !app.isPackaged;

let win = null;
let tray = null;
let serverChild = null;

// ---------------------------------------------------------------------------
// Path resolvers (unchanged contract from prior main.js)
// ---------------------------------------------------------------------------

function getServerBinaryPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  if (isDev) {
    return path.join(__dirname, '..', '..', 'server-for-chrome-extension', 'dist', `webpilot-server-for-chrome-extension${ext}`);
  }
  return path.join(process.resourcesPath, 'server', `webpilot-server-for-chrome-extension${ext}`);
}

function getDataDir() {
  // Single source of truth for user data: Electron's userData path.
  // - Windows: %APPDATA%\WebPilot
  // - macOS:   ~/Library/Application Support/WebPilot
  // - Linux:   ~/.config/WebPilot (or $XDG_CONFIG_HOME/WebPilot)
  // This path survives upgrades because it lives OUTSIDE the install
  // dir that electron-builder wipes during a version bump. We pass the
  // same value to the spawned daemon via WEBPILOT_DATA_DIR so both
  // processes agree on the data location.
  //
  // (Dev mode previously used %LOCALAPPDATA%\WebPilot; we now align dev
  // with prod so behaviour is consistent and you can test the upgrade
  // path locally.)
  return app.getPath('userData');
}

function getExtensionPath() {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'chrome-extension-unpacked');
  }
  return path.join(process.resourcesPath, 'chrome-extension');
}

function getAssetsDir() {
  // In dev, assets sit alongside the electron/ source directory.
  // When packaged, electron-builder.yml's extraResources copies the whole
  // assets/ folder to <resourcesPath>/assets/.
  return isDev
    ? path.join(__dirname, '..', 'assets')
    : path.join(process.resourcesPath, 'assets');
}

function ensureDataDir() {
  fs.mkdirSync(getDataDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function startServer() {
  const serverPath = getServerBinaryPath();
  if (!fs.existsSync(serverPath)) {
    console.log('Server binary not found at ' + serverPath + '; skipping server start');
    return;
  }
  const { spawn } = require('child_process');
  // Keep the handle (no detached/unref) so we can kill on Exit.
  // WEBPILOT_NO_OPEN suppresses the server's default-browser pop. The
  // dashboard renders inside our BrowserWindow instead.
  // WEBPILOT_DATA_DIR tells the standalone daemon where to read/write
  // user data (DB, paired-key state, formatter config, PID/port files).
  // We pin it to Electron's userData path so the daemon and the shell
  // agree, and so user data lives OUTSIDE the install dir that gets
  // wiped on every upgrade.
  serverChild = spawn(serverPath, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBPILOT_NO_OPEN: '1',
      WEBPILOT_DATA_DIR: getDataDir(),
    },
  });
  serverChild.on('exit', () => { serverChild = null; });
  console.log('Server process launched (pid=' + (serverChild.pid || 'n/a') + ').');
}

function killServer() {
  // Two paths: handle to our spawned child, and the PID file the server
  // writes to its data dir for the auto-started case. Always try both —
  // tray Exit must take everything down even if the server we see is one
  // we didn't spawn (Registry Run key auto-start).
  if (serverChild && !serverChild.killed) {
    try { serverChild.kill(); } catch { /* ignore */ }
  }
  try {
    const pidStr = fs.readFileSync(path.join(getDataDir(), 'server.pid'), 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid); } catch { /* already dead */ }
    }
  } catch { /* no pid file */ }
}

// ---------------------------------------------------------------------------
// Window: splash -> dashboard
// ---------------------------------------------------------------------------

function createWindow() {
  const iconPath = path.join(
    getAssetsDir(),
    process.platform === 'win32' ? 'icon.ico' : 'logo.png'
  );

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0e0e10',
    icon: iconPath,
    title: 'WebPilot',
    webPreferences: {
      // No preload: the splash is pure CSS and the dashboard runs against
      // its own server; neither needs the legacy onboarding IPC bridge.
      // preload.js is kept on disk for now in case a future Electron-only
      // affordance wants it back; tracked as a follow-up cleanup.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);

  if (isDev) {
    // Dev mode: load the splash, then swap to the local dev dashboard once
    // the dev server is up. The repo-level `npm run dev` runs both at once.
    win.loadFile(path.join(__dirname, 'splash.html'));
  } else {
    win.loadFile(path.join(__dirname, 'splash.html'));
  }

  waitForServerHealthThenSwap();

  // Hide-to-tray on window close — only an explicit tray Exit (or
  // app.isQuitting flag) actually quits the app.
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // External links (e.g. GitHub) should open in the user's default browser,
  // not navigate the dashboard window away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

async function waitForServerHealthThenSwap() {
  const portFile = path.join(getDataDir(), 'server.port');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const port = fs.readFileSync(portFile, 'utf8').trim();
      if (port) {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok && win && !win.isDestroyed()) {
          await win.loadURL(`http://127.0.0.1:${port}/ui/`);
          return;
        }
      }
    } catch {
      // Server not ready yet; keep polling.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Fallback: show an inline error page if the server never came up.
  if (win && !win.isDestroyed()) {
    const errHtml = `
      <!doctype html>
      <html><head><meta charset="utf-8"><title>WebPilot</title>
      <style>
        body { background:#0e0e10; color:#f5f5f7; font:14px -apple-system,Segoe UI,Roboto;
               display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
        .box { max-width:480px; text-align:center; padding:24px; }
        h1 { font-size:18px; margin:0 0 8px; }
        p { color:#8b8b94; margin:0; line-height:1.5; }
      </style></head><body>
      <div class="box">
        <h1>WebPilot server didn't start.</h1>
        <p>The local server didn't come online within 30 seconds.
        Try quitting from the tray and relaunching WebPilot.</p>
      </div></body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(errHtml));
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function createTray() {
  // Windows: use a multi-resolution .ico. Passing a PNG to Tray() on Windows
  // gets composited onto a white square at non-100% DPI scales (#tray-icon).
  // macOS/Linux: PNG is the right format.
  const trayIconName = process.platform === 'win32' ? 'tray-icon.ico' : 'tray-icon.png';
  const trayIconPath = path.join(getAssetsDir(), trayIconName);
  const icon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('WebPilot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open WebPilot', click: showWindow },
    { type: 'separator' },
    { label: 'Exit', click: quitFully },
  ]));
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) win.hide();
    else showWindow();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitFully() {
  app.isQuitting = true;
  killServer();
  app.quit();
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Single-instance guard: launching a second copy focuses the first one
// instead of spawning a second server + tray icon.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) showWindow();
  });

  app.whenReady().then(() => {
    ensureDataDir();
    startServer();
    createTray();
    createWindow();

    app.on('activate', () => {
      // macOS dock-click behavior. The current build doesn't ship on Mac
      // (#48) but the handler is harmless.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    killServer();
  });

  // The previous main.js had `window-all-closed -> app.quit()` here.
  // Removed intentionally: closing the last window now means hide-to-tray.
}
