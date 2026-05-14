'use strict';

const { execFile } = require('node:child_process');
const { log, error } = require('./logger');

/**
 * Graceful close of all Chrome browser processes.
 *
 * On Windows: PostMessage(WM_CLOSE) to every visible Chrome HWND. CloseMainWindow
 * only sends to one window per process; multi-window browser parents need raw
 * PostMessage to each HWND so Chrome runs its normal shutdown path (which saves
 * session state).
 *
 * On macOS: `osascript -e 'tell application "Google Chrome" to quit'` first,
 * SIGTERM fallback.
 *
 * On Linux: SIGTERM.
 *
 * After signalling, polls until all given PIDs have exited or timeout elapses.
 * Returns:
 *   { closed: bool, remaining: number[], durationMs: number }
 */
async function closeChromeGracefully(pids, timeoutMs) {
  const timeout = typeof timeoutMs === 'number' ? timeoutMs : 20000;
  const platform = process.platform;
  const startedAt = Date.now();

  log('closer', 'closeChromeGracefully called', { platform, pids, timeoutMs: timeout });

  if (!Array.isArray(pids) || pids.length === 0) {
    log('closer', 'no pids supplied — nothing to do');
    return { closed: true, remaining: [], durationMs: 0 };
  }

  try {
    if (platform === 'win32') {
      await sendWmCloseWindows(pids);
    } else if (platform === 'darwin') {
      await macosQuit(pids);
    } else if (platform === 'linux') {
      await sigTerm(pids);
    } else {
      log('closer', 'unsupported platform — attempting SIGTERM as best-effort', { platform });
      await sigTerm(pids);
    }
  } catch (e) {
    error('closer', 'graceful-close signal failed', e);
  }

  const remaining = await waitForExit(pids, timeout);
  const durationMs = Date.now() - startedAt;
  const closed = remaining.length === 0;
  log('closer', 'closeChromeGracefully complete', { closed, remaining, durationMs });
  return { closed, remaining, durationMs };
}

/**
 * Send WM_CLOSE via Win32 PostMessage to every visible window owned by any
 * of the given Chrome PIDs. Built as an inline PowerShell script using
 * Add-Type to bring in user32 entry points.
 */
function sendWmCloseWindows(pids) {
  return new Promise((resolve) => {
    const pidList = pids.map((p) => Number(p)).filter(Number.isFinite).join(',');

    const psScript = `
$ErrorActionPreference = 'SilentlyContinue';
$sig = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinApi {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  public const uint WM_CLOSE = 0x0010;
}
"@;
Add-Type -TypeDefinition $sig -PassThru | Out-Null;
$pids = @(${pidList});
$matched = New-Object System.Collections.Generic.List[IntPtr];
$cb = [WinApi+EnumWindowsProc] {
  param($hWnd, $lParam)
  if (-not [WinApi]::IsWindowVisible($hWnd)) { return $true }
  $procId = 0
  [void][WinApi]::GetWindowThreadProcessId($hWnd, [ref]$procId)
  if ($pids -contains [int]$procId) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][WinApi]::GetWindowText($hWnd, $sb, 256)
    Write-Output ("hwnd=" + $hWnd.ToInt64() + " pid=" + $procId + " title=" + $sb.ToString())
    $matched.Add($hWnd)
  }
  return $true
}
[void][WinApi]::EnumWindows($cb, [IntPtr]::Zero);
foreach ($h in $matched) {
  [void][WinApi]::PostMessage($h, [WinApi]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
}
Write-Output ("posted_wm_close_count=" + $matched.Count)
`;

    const args = ['-NoProfile', '-NonInteractive', '-Command', psScript];
    log('closer', 'invoking powershell WM_CLOSE script', { pids, scriptLen: psScript.length });

    execFile('powershell.exe', args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        error('closer', 'WM_CLOSE script failed', err);
        if (stderr) error('closer', 'stderr', stderr);
      }
      if (stdout) {
        // Echo PS output as log lines so we have a record of every HWND we hit
        for (const line of String(stdout).split(/\r?\n/)) {
          const t = line.trim();
          if (t) log('closer', 'ps:' + t);
        }
      }
      resolve();
    });
  });
}

function macosQuit(pids) {
  return new Promise((resolve) => {
    log('closer', 'osascript quit Google Chrome');
    execFile(
      'osascript',
      ['-e', 'tell application "Google Chrome" to quit'],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          error('closer', 'osascript failed — falling back to SIGTERM', err);
          if (stderr) error('closer', 'stderr', stderr);
          sigTerm(pids).then(resolve);
          return;
        }
        resolve();
      },
    );
  });
}

async function sigTerm(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      log('closer', 'sent SIGTERM', { pid });
    } catch (e) {
      log('closer', 'SIGTERM failed (process may already be gone)', { pid, err: e.message });
    }
  }
}

/**
 * Poll process liveness via `process.kill(pid, 0)` until all pids exit
 * or timeout. Returns the still-alive pids.
 */
function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 250;

  return new Promise((resolve) => {
    const tick = () => {
      const alive = pids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          return false;
        }
      });
      if (alive.length === 0) {
        log('closer', 'all pids exited');
        resolve([]);
        return;
      }
      if (Date.now() >= deadline) {
        log('closer', 'timeout waiting for exit', { remaining: alive });
        resolve(alive);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

module.exports = { closeChromeGracefully };
