'use strict';

const { execFile } = require('node:child_process');
const { log, error } = require('./logger');

/**
 * Show a Windows toast notification via WinRT ToastNotificationManager.
 * The title, body and URL are passed in as PowerShell variables (set via
 * --% environment vars on stdin would be safer, but execFile arg-arrays
 * are already shell-safe) — we XML-escape them before splicing into the
 * toast template.
 */

const APP_ID = 'WebPilot.MCPServer';

function xmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// PowerShell single-quoted string escape: ' -> ''
function psSingleQuote(str) {
  return String(str || '').replace(/'/g, "''");
}

function notify(payload) {
  return new Promise((resolve) => {
    const title = payload && payload.title ? payload.title : 'WebPilot';
    const body = payload && payload.body ? payload.body : '';
    const url = payload && payload.url ? payload.url : '';
    const sound = payload && payload.sound === false ? false : true;

    // Toast body: include URL inline as plain text per spec (clickable launch is v1.5)
    const bodyText = url ? body + '\n' + url : body;

    const xmlTitle = xmlEscape(title);
    const xmlBody = xmlEscape(bodyText);

    const silentAttr = sound ? '' : ' silent="true"';

    // If a URL was passed, make the toast clickable: activationType="protocol"
    // hands the launch string to the OS's default protocol handler (i.e., the
    // default browser for http(s) URLs). Without these attributes, clicking
    // the toast just dismisses it.
    const launchAttrs = url
      ? ' activationType="protocol" launch="' + xmlEscape(url) + '"'
      : '';

    const toastXml = [
      '<toast' + launchAttrs + '>',
      '<visual>',
      '<binding template="ToastGeneric">',
      '<text>' + xmlTitle + '</text>',
      '<text>' + xmlBody + '</text>',
      '</binding>',
      '</visual>',
      '<audio' + silentAttr + ' />',
      '</toast>',
    ].join('');

    // Windows 10/11 silently drop toasts whose AppUserModelID is not registered
    // in HKCU\Software\Classes\AppUserModelId\. Self-register on every call —
    // it's a cheap idempotent registry write and means users don't have to run
    // a separate setup step. Without this, Show($toast) returns success but no
    // toast ever appears.
    const psScript = [
      "$ErrorActionPreference = 'Stop';",
      "$appIdPath = 'HKCU:\\Software\\Classes\\AppUserModelId\\" + APP_ID + "';",
      'if (-not (Test-Path $appIdPath)) { New-Item -Path $appIdPath -Force | Out-Null }',
      "Set-ItemProperty -Path $appIdPath -Name 'DisplayName' -Value 'WebPilot' -Type String;",
      "Set-ItemProperty -Path $appIdPath -Name 'ShowInSettings' -Value 1 -Type DWord;",
      '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null;',
      '[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null;',
      "$xml = '" + psSingleQuote(toastXml) + "';",
      '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument;',
      '$doc.LoadXml($xml);',
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($doc);',
      "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + APP_ID + "');",
      '$notifier.Show($toast);',
    ].join(' ');

    const args = ['-NoProfile', '-NonInteractive', '-Command', psScript];

    log('windows', 'showing toast', { title, urlPresent: !!url, sound, scriptLen: psScript.length });

    execFile('powershell.exe', args, { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        error('windows', 'toast show failed', err);
        if (stderr) error('windows', 'stderr', stderr);
      } else {
        log('windows', 'toast shown');
        if (stdout && stdout.trim()) log('windows', 'stdout', stdout.trim());
      }
      resolve();
    });
  });
}

module.exports = { notify };
