'use client';

import { useEffect, useState } from 'react';
import { DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import ConfirmModal from '../../components/ConfirmModal';
import { useToast } from '../../components/ToastRegion';
import {
  getStatus,
  setNetworkMode as apiSetNetworkMode,
  setNotificationSettings,
  restartServer,
} from '../../lib/api';
import { getTheme, setTheme } from '../../lib/theme';

/**
 * Settings — per UX §Settings.
 *
 * Cards (top → bottom):
 *   1. Appearance     — theme: System / Light / Dark segmented control.
 *   2. Network        — LAN toggle (existing behavior).
 *   3. Notifications  — system notifications + sound. Persisted server-side
 *                       (Phase 3 B) so the daemon honors them when firing.
 *   4. Server         — port, data directory, log file paths, Restart server.
 *   5. About          — version + links.
 */

export default function SettingsPage() {
  const [networkMode, setNetworkMode] = useState(false);
  const [port, setPort] = useState(null);
  const [paths, setPaths] = useState({ dataDir: null, logPath: null, extensionPath: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingToggle, setPendingToggle] = useState(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [whatsThisOpen, setWhatsThisOpen] = useState(false);
  // Theme — three-state: 'system' (null in storage), 'light', 'dark'.
  const [theme, setThemeState] = useState('system');
  // Notifications — server-persisted (Phase 3 B). Hydrate from /api/ui/status.
  const [notifOn, setNotifOn] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const toast = useToast();

  async function refresh() {
    try {
      const data = await getStatus();
      setNetworkMode(!!data.networkMode);
      setPort(data.port || null);
      if (data.paths) {
        setPaths({
          dataDir: data.paths.dataDir || null,
          logPath: data.paths.logPath || null,
          extensionPath: data.paths.extensionPath || null,
        });
      }
      if (data.notifications) {
        setNotifOn(data.notifications.systemNotifications !== false);
        setSoundOn(data.notifications.sound !== false);
      }
    } catch (_e) { /* surface via toast below */ }
    finally { setLoading(false); }
  }

  useEffect(() => {
    refresh();
    // Read persisted theme on mount (SSR-safe).
    const stored = getTheme();
    setThemeState(stored || 'system');
  }, []);

  function handleThemeChange(value) {
    setThemeState(value);
    setTheme(value);
  }

  async function handleNotifChange(on) {
    const previous = notifOn;
    setNotifOn(on);
    try {
      await setNotificationSettings({ systemNotifications: on });
    } catch (e) {
      setNotifOn(previous);
      toast.error(e.message || 'Could not save notification setting.');
    }
  }
  async function handleSoundChange(on) {
    const previous = soundOn;
    setSoundOn(on);
    try {
      await setNotificationSettings({ sound: on });
    } catch (e) {
      setSoundOn(previous);
      toast.error(e.message || 'Could not save sound setting.');
    }
  }

  const confirmToggle = async () => {
    const next = pendingToggle;
    setPendingToggle(null);
    if (next === null || next === undefined) return;
    setBusy(true);
    try {
      await apiSetNetworkMode(next);
      setNetworkMode(next);
      toast.info('Server is restarting — refresh in a few seconds.');
    } catch (e) {
      toast.error(e.message || 'Could not update network mode.');
    } finally { setBusy(false); }
  };

  const confirmRestart = async () => {
    setPendingRestart(false);
    setBusy(true);
    try {
      // Fire-and-forget. The connection may drop mid-request, which is fine —
      // we reload the page after a short delay so the UI reconnects to the
      // freshly-spawned daemon.
      restartServer().catch(() => { /* expected: connection dropped */ });
      toast.info('Server is restarting…');
      setTimeout(() => {
        try { window.location.reload(); } catch (_e) { /* ignore */ }
      }, 2000);
    } catch (e) {
      toast.error(e.message || 'Could not restart server.');
      setBusy(false);
    }
  };

  async function copyToClipboard(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied.`);
    } catch (_e) {
      toast.error('Clipboard write failed.');
    }
  }

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Settings</h1>
        <p className="wp-page-sub">
          Configuration for the WebPilot server. Some changes restart the server.
        </p>
      </header>

      {/* ---- Appearance ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Appearance</h2>
        </div>
        <div className="wp-card">
          <div className="wp-row" style={{ alignItems: 'center', borderBottom: 'none', margin: 0 }}>
            <div className="wp-row-grow">
              <div className="wp-row-title">Theme</div>
              <div className="wp-row-sub">Follow your system, or pin to light or dark.</div>
            </div>
            <div className="wp-segmented" role="radiogroup" aria-label="Theme">
              {[
                { v: 'system', label: 'System' },
                { v: 'light',  label: 'Light'  },
                { v: 'dark',   label: 'Dark'   },
              ].map((opt) => (
                <button
                  key={opt.v}
                  type="button"
                  role="radio"
                  aria-checked={theme === opt.v}
                  className={`wp-segmented-btn${theme === opt.v ? ' is-active' : ''}`}
                  onClick={() => handleThemeChange(opt.v)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---- Network ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Network</h2>
        </div>
        <div className="wp-card">
          <div className="wp-row" style={{ alignItems: 'center', borderBottom: 'none', margin: 0 }}>
            <div className="wp-row-grow">
              <div className="wp-row-title">
                {loading ? 'Loading…' : (networkMode ? 'LAN access' : 'Localhost only')}
              </div>
              <div className="wp-row-sub">
                Lets other devices on your network reach this server. The server will restart.
              </div>
              <button
                type="button"
                className="wp-link"
                style={{ marginTop: 'var(--s-1)', fontSize: 'var(--fs-small)' }}
                onClick={() => setWhatsThisOpen((v) => !v)}
              >
                What’s this?
              </button>
              {whatsThisOpen ? (
                <div className="wp-row-inline-hint">
                  Binds to 0.0.0.0:{port ?? '<port>'} instead of 127.0.0.1.
                </div>
              ) : null}
            </div>
            <Switch
              checked={networkMode}
              disabled={busy || loading}
              onChange={(next) => setPendingToggle(next)}
              ariaLabel="LAN access"
            />
          </div>
        </div>
      </section>

      {/* ---- Notifications ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Notifications</h2>
        </div>
        <div className="wp-card">
          <div className="wp-card-section">
            <div className="wp-row" style={{ alignItems: 'center', borderBottom: 'none', margin: 0 }}>
              <div className="wp-row-grow">
                <div className="wp-row-title">System notifications for pairing requests</div>
                <div className="wp-row-sub">Show a system notification when an agent requests pairing.</div>
              </div>
              <Switch
                checked={notifOn}
                onChange={handleNotifChange}
                ariaLabel="System notifications"
              />
            </div>
          </div>
          <div className="wp-card-section">
            <div className="wp-row" style={{ alignItems: 'center', borderBottom: 'none', margin: 0 }}>
              <div className="wp-row-grow">
                <div className="wp-row-title" style={{ opacity: notifOn ? 1 : 0.5 }}>
                  Play sound with notifications
                </div>
                <div className="wp-row-sub" style={{ opacity: notifOn ? 1 : 0.5 }}>
                  A short chime alongside the system notification.
                </div>
              </div>
              <Switch
                checked={soundOn}
                disabled={!notifOn}
                onChange={handleSoundChange}
                ariaLabel="Notification sound"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ---- Server ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Server</h2>
        </div>
        <div className="wp-card">
          <div className="wp-kv">
            <div className="wp-kv-label">Port</div>
            <div className="wp-kv-value">
              <span className="wp-mono">{port ?? '—'}</span>
            </div>

            <div className="wp-kv-label">Data directory</div>
            <div className="wp-kv-value" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <span className="wp-mono wp-secondary" style={{ wordBreak: 'break-all' }}>
                {paths.dataDir || '—'}
              </span>
              <button
                type="button"
                className="wp-btn wp-btn-compact"
                onClick={() => copyToClipboard(paths.dataDir || '', 'Data directory')}
                disabled={!paths.dataDir}
              >
                <DocumentDuplicateIcon style={{ width: 14, height: 14 }} /> Copy
              </button>
            </div>

            <div className="wp-kv-label">Log file</div>
            <div className="wp-kv-value" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <span className="wp-mono wp-secondary" style={{ wordBreak: 'break-all' }}>
                {paths.logPath || '—'}
              </span>
              <button
                type="button"
                className="wp-btn wp-btn-compact"
                onClick={() => copyToClipboard(paths.logPath || '', 'Log file path')}
                disabled={!paths.logPath}
              >
                <DocumentDuplicateIcon style={{ width: 14, height: 14 }} /> Copy
              </button>
            </div>
          </div>
          <div style={{ marginTop: 'var(--s-5)', display: 'flex' }}>
            <button
              type="button"
              className="wp-btn wp-btn-primary"
              onClick={() => setPendingRestart(true)}
              disabled={busy}
            >
              {busy ? 'Restarting…' : 'Restart server'}
            </button>
          </div>
        </div>
      </section>

      {/* ---- About ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">About</h2>
        </div>
        <div className="wp-card">
          <div className="wp-row-title">WebPilot v1.0.0</div>
          <div className="wp-row-sub">A local-first browser bridge for MCP agents.</div>
          <div style={{ display: 'flex', gap: 'var(--s-4)', marginTop: 'var(--s-4)', flexWrap: 'wrap' }}>
            <a href="https://github.com/Jtonna/WebPilot" target="_blank" rel="noopener noreferrer" className="wp-link">
              GitHub
            </a>
            <a href="https://github.com/Jtonna/WebPilot/issues" target="_blank" rel="noopener noreferrer" className="wp-link">
              Report an issue
            </a>
            <a href="https://github.com/Jtonna/WebPilot#readme" target="_blank" rel="noopener noreferrer" className="wp-link">
              Docs
            </a>
          </div>
        </div>
      </section>

      <ConfirmModal
        open={pendingToggle !== null}
        title={pendingToggle ? 'Enable network mode?' : 'Disable network mode?'}
        body={
          pendingToggle
            ? 'Restarts the server bound to 0.0.0.0 so other devices on your LAN can connect. Active agents will reconnect automatically.'
            : 'Restarts the server bound to 127.0.0.1 (this machine only). Active agents will reconnect automatically.'
        }
        confirmLabel={pendingToggle ? 'Enable' : 'Disable'}
        onConfirm={confirmToggle}
        onCancel={() => setPendingToggle(null)}
      />

      <ConfirmModal
        open={pendingRestart}
        title="Restart WebPilot?"
        body="Active agents will reconnect automatically."
        confirmLabel="Restart"
        onConfirm={confirmRestart}
        onCancel={() => setPendingRestart(false)}
      />
    </>
  );
}

/**
 * Switch — accessible toggle. Calls `onChange(next)` with the would-be value
 * — does NOT flip its own state. Lets the parent prompt for confirmation.
 */
function Switch({ checked, disabled = false, onChange, ariaLabel }) {
  return (
    <label className="wp-switch" aria-label={ariaLabel}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange && onChange(e.target.checked)}
      />
      <span className="wp-switch-track" />
      <span className="wp-switch-thumb" />
    </label>
  );
}
