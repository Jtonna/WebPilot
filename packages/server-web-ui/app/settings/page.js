'use client';

import { useEffect, useRef, useState } from 'react';
import { DocumentDuplicateIcon } from '@heroicons/react/20/solid';
import ConfirmModal from '../../components/ConfirmModal';
import Skeleton, { SkeletonRow } from '../../components/Skeleton';
import Toggle from '../../components/Toggle';
import { useToast } from '../../components/ToastRegion';
import {
  getStatus,
  setNetworkMode as apiSetNetworkMode,
  setNotificationSettings,
  restartServer,
} from '../../lib/api';
import { getTheme, setTheme } from '../../lib/theme';
import { useCopyToClipboard } from '../../lib/useCopyToClipboard';

/**
 * Settings — Apple-style grouped inset cards.
 *
 * Four groups:
 *   1. General        — Theme, About (version + links).
 *   2. Notifications  — System notifications, sound.
 *   3. Network        — LAN toggle.
 *   4. Advanced       — Server paths + Restart server.
 *
 * Each group is a single .wp-inset-group containing hairline-separated rows.
 * Group headers (mono nano caps) sit OUTSIDE the card, above it.
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
  const [theme, setThemeState] = useState('system');
  const [notifOn, setNotifOn] = useState(true);
  const [soundOn, setSoundOn] = useState(true);
  const toast = useToast();
  // The settings copy buttons toast success/failure with a per-call label.
  // We close over `pendingLabelRef` so the hook's onSuccess/onError handlers
  // see the label that was active when the click fired.
  const pendingLabelRef = useRef('');
  const [, copy] = useCopyToClipboard({
    onSuccess: () => {
      const label = pendingLabelRef.current;
      if (label) toast.success(`${label} copied.`);
    },
    onError: () => toast.error('Clipboard write failed.'),
  });

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
    const storedTheme = getTheme();
    setThemeState(storedTheme || 'system');
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
      toast.error(e.message || 'Couldn’t save notification setting.');
    }
  }
  async function handleSoundChange(on) {
    const previous = soundOn;
    setSoundOn(on);
    try {
      await setNotificationSettings({ sound: on });
    } catch (e) {
      setSoundOn(previous);
      toast.error(e.message || 'Couldn’t save sound setting.');
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
      toast.info('Restarting…');
    } catch (e) {
      toast.error(e.message || 'Couldn’t update network mode.');
    } finally { setBusy(false); }
  };

  const confirmRestart = async () => {
    setPendingRestart(false);
    setBusy(true);
    try {
      restartServer().catch(() => { /* expected: connection dropped */ });
      toast.info('Restarting…');
      setTimeout(() => {
        try { window.location.reload(); } catch (_e) { /* ignore */ }
      }, 2000);
    } catch (e) {
      toast.error(e.message || 'Couldn’t restart server.');
      setBusy(false);
    }
  };

  function copyToClipboard(text, label) {
    pendingLabelRef.current = label;
    copy(text);
  }

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Settings</h1>
        <p className="wp-page-sub">
          Configuration for the WebPilot server. Some changes restart the server.
        </p>
      </header>

      {/* ---- General (Appearance + About) ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">General</h2>
        </div>
        <div className="wp-inset-group">
          <div className="wp-inset-row">
            <div className="wp-inset-row-grow">
              <div className="wp-inset-row-title">Theme</div>
              <div className="wp-inset-row-sub">Follow your system, or pin to light or dark.</div>
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

          <div className="wp-inset-row">
            <div className="wp-inset-row-grow">
              <div className="wp-inset-row-title">WebPilot v1.0.0</div>
              <div className="wp-inset-row-sub">A local-first browser bridge for MCP agents.</div>
            </div>
          </div>

          <div className="wp-inset-row">
            <div className="wp-inset-row-grow">
              <div style={{ display: 'flex', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
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
          </div>
        </div>
      </section>

      {/* ---- Notifications ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Notifications</h2>
        </div>
        <div className="wp-inset-group">
          <div className="wp-inset-row">
            <div className="wp-inset-row-grow">
              <div className="wp-inset-row-title">System notifications for pairing requests</div>
              <div className="wp-inset-row-sub">Show a system notification when an agent requests pairing.</div>
            </div>
            <Toggle
              checked={notifOn}
              onChange={handleNotifChange}
              ariaLabel="System notifications"
            />
          </div>

          <div className="wp-inset-row">
            <div className="wp-inset-row-grow">
              <div className="wp-inset-row-title" style={{ opacity: notifOn ? 1 : 0.5 }}>
                Play a sound
              </div>
              <div className="wp-inset-row-sub" style={{ opacity: notifOn ? 1 : 0.5 }}>
                A short chime alongside the system notification.
              </div>
            </div>
            <Toggle
              checked={soundOn}
              disabled={!notifOn}
              onChange={handleSoundChange}
              ariaLabel="Notification sound"
            />
          </div>
        </div>
      </section>

      {/* ---- Network ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Network</h2>
        </div>
        <div className="wp-inset-group">
          <div className="wp-inset-row">
            <div className="wp-inset-row-grow">
              <div className="wp-inset-row-title">
                {loading
                  ? <Skeleton width="40%" height={14} />
                  : (networkMode ? 'LAN access' : 'Localhost only')}
              </div>
              <div className="wp-inset-row-sub">
                Other devices on your network can reach this server. The server will restart.
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
            <Toggle
              checked={networkMode}
              disabled={busy || loading}
              onChange={(next) => setPendingToggle(next)}
              ariaLabel="LAN access"
            />
          </div>
        </div>
      </section>

      {/* ---- Advanced (Server paths + Restart) ---- */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Advanced</h2>
        </div>
        <div className="wp-inset-group">
          {loading ? (
            <div className="wp-inset-row">
              <div className="wp-inset-row-grow" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
                <SkeletonRow titleWidth="20%" subWidth="35%" padded={false} />
                <SkeletonRow titleWidth="35%" subWidth="75%" padded={false} />
                <SkeletonRow titleWidth="30%" subWidth="70%" padded={false} />
              </div>
            </div>
          ) : (
            <>
              <div className="wp-inset-row">
                <div className="wp-inset-row-grow">
                  <div className="wp-inset-row-title">Port</div>
                </div>
                <span className="wp-mono">{port ?? '—'}</span>
              </div>

              <div className="wp-inset-row">
                <div className="wp-inset-row-grow" style={{ minWidth: 0 }}>
                  <div className="wp-inset-row-title">Data directory</div>
                  <div style={{ marginTop: 'var(--s-1)', display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap', minWidth: 0 }}>
                    <span className="wp-path" style={{ flex: '1 1 auto', minWidth: 0 }}>
                      {paths.dataDir || '—'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="wp-btn wp-btn-compact"
                  onClick={() => copyToClipboard(paths.dataDir || '', 'Data directory')}
                  disabled={!paths.dataDir}
                >
                  <DocumentDuplicateIcon style={{ width: 16, height: 16 }} /> Copy
                </button>
              </div>

              <div className="wp-inset-row">
                <div className="wp-inset-row-grow" style={{ minWidth: 0 }}>
                  <div className="wp-inset-row-title">Log file</div>
                  <div style={{ marginTop: 'var(--s-1)', display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap', minWidth: 0 }}>
                    <span className="wp-path" style={{ flex: '1 1 auto', minWidth: 0 }}>
                      {paths.logPath || '—'}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="wp-btn wp-btn-compact"
                  onClick={() => copyToClipboard(paths.logPath || '', 'Log file path')}
                  disabled={!paths.logPath}
                >
                  <DocumentDuplicateIcon style={{ width: 16, height: 16 }} /> Copy
                </button>
              </div>

              <div className="wp-inset-row">
                <div className="wp-inset-row-grow">
                  <div className="wp-inset-row-title">Restart server</div>
                  <div className="wp-inset-row-sub">Active agents will reconnect automatically.</div>
                </div>
                <button
                  type="button"
                  className="wp-btn wp-btn-primary"
                  onClick={() => setPendingRestart(true)}
                  disabled={busy}
                >
                  {busy ? 'Restarting…' : 'Restart'}
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      <ConfirmModal
        open={pendingToggle !== null}
        title={pendingToggle ? 'Enable network mode?' : 'Disable network mode?'}
        body={
          pendingToggle
            ? 'Other devices on your network can reach this server. The server will restart.'
            : 'Only this machine can reach this server. The server will restart.'
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

