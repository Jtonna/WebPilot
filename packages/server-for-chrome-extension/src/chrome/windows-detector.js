'use strict';

const { execFile } = require('node:child_process');
const { log, error } = require('./logger');
const { ChromeDetectionError } = require('./detector');

const FLAG = '--silent-debugger-extension-api';

/**
 * Parse the `--user-data-dir=...` arg from a command line. Handles
 * both quoted and unquoted values.
 */
function extractUserDataDir(cmdLine) {
  if (!cmdLine) return null;

  // --user-data-dir="C:\path with spaces"
  let m = cmdLine.match(/--user-data-dir=(?:"([^"]*)"|(\S+))/);
  if (m) return m[1] || m[2] || null;

  return null;
}

function extractProfileDirectory(cmdLine) {
  if (!cmdLine) return null;
  const m = cmdLine.match(/--profile-directory=(?:"([^"]*)"|(\S+))/);
  if (m) return m[1] || m[2] || null;
  return null;
}

/**
 * Returns true if the process is a browser-parent (no --type= flag).
 * Chrome child processes (renderer, gpu-process, utility, etc.) all have --type=.
 */
function isBrowserParent(cmdLine) {
  if (!cmdLine) return false;
  return !/--type=/.test(cmdLine);
}

/**
 * Parse the PowerShell JSON output into an array of raw process records.
 * Throws on malformed JSON or a non-object/array payload.
 */
function parseProcessJson(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  throw new Error('unexpected JSON shape: ' + typeof parsed);
}

/**
 * Runs `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"` and
 * filters to browser-parent processes only. Resolves:
 *   [{ pid, commandLine, hasFlag, userDataDir, profileDirectory }]
 * (`[]` means the scan succeeded and found no Chrome). If the scan itself
 * fails (PowerShell error or unparseable output) it REJECTS with a
 * ChromeDetectionError so callers can treat the state as "unknown" rather
 * than "not running".
 */
function detect() {
  log('windows-detector', 'starting detection');

  return new Promise((resolve, reject) => {
    // CRITICAL: join with newlines, not spaces. Earlier versions used
    // .join(' ') which collapsed the script into a single line — any PS `#`
    // comment then ran from the `#` all the way to the end of the script,
    // silently eating the final Write-Output. Result: 0 stdout, exit 0, no
    // error visible — detect() returned `[]` even when Chrome was running.
    const psScript = [
      // Output as JSON; -Depth 2 is enough for ProcessId+CommandLine
      "$ErrorActionPreference='SilentlyContinue';",
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\";",
      'if ($null -eq $procs) { Write-Output "[]"; exit 0 }',
      // Force array form so a single result still serializes as JSON array
      '$arr = @($procs | Select-Object ProcessId,CommandLine);',
      '$json = $arr | ConvertTo-Json -Compress -Depth 2;',
      '# ConvertTo-Json with a single element drops the array brackets — re-add if needed',
      'if ($arr.Count -eq 1) { Write-Output "[$json]" } else { Write-Output $json }',
    ].join('\n');

    const args = ['-NoProfile', '-NonInteractive', '-Command', psScript];
    const startedAt = Date.now();

    execFile('powershell.exe', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const duration = Date.now() - startedAt;

      if (err) {
        error('windows-detector', 'powershell failed', err);
        if (stderr) error('windows-detector', 'stderr', stderr);
        reject(new ChromeDetectionError('powershell process scan failed: ' + (err && err.message), { cause: err }));
        return;
      }

      const trimmed = (stdout || '').trim();
      if (!trimmed) {
        log('windows-detector', 'no chrome processes found', { durationMs: duration });
        resolve([]);
        return;
      }

      let list;
      try {
        list = parseProcessJson(trimmed);
      } catch (e) {
        error('windows-detector', 'failed to parse PS JSON', e);
        log('windows-detector', 'raw stdout (truncated 500)', { snippet: trimmed.slice(0, 500) });
        reject(new ChromeDetectionError('could not parse powershell output: ' + e.message, { cause: e }));
        return;
      }
      log('windows-detector', 'enumerated chrome processes', { total: list.length, durationMs: duration });

      const out = [];
      for (const item of list) {
        const pid = item && (item.ProcessId || item.processId || item.PID);
        const cmd = item && (item.CommandLine || item.commandLine);
        if (!pid) continue;
        if (!isBrowserParent(cmd)) continue;

        const entry = {
          pid: Number(pid),
          commandLine: cmd || '',
          hasFlag: cmd ? cmd.indexOf(FLAG) !== -1 : false,
          userDataDir: extractUserDataDir(cmd),
          profileDirectory: extractProfileDirectory(cmd),
        };
        log('windows-detector', 'browser-parent identified', entry);
        out.push(entry);
      }

      log('windows-detector', 'detection complete', {
        durationMs: duration,
        totalProcs: list.length,
        browserParents: out.length,
      });
      resolve(out);
    });
  });
}

module.exports = {
  detect,
  // Exposed for unit-test stubbing / reuse
  _extractUserDataDir: extractUserDataDir,
  _extractProfileDirectory: extractProfileDirectory,
  _isBrowserParent: isBrowserParent,
  _parseProcessJson: parseProcessJson,
  FLAG,
};
