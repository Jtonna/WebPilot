'use client';

import { useEffect, useState } from 'react';
import ConfirmModal from '../../components/ConfirmModal';
import { getStatus, setNetworkMode as apiSetNetworkMode } from '../../lib/api';

export default function SettingsPage() {
  const [networkMode, setNetworkMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // null = modal closed; otherwise the next target value (true/false).
  const [pendingToggle, setPendingToggle] = useState(null);

  async function refresh() {
    try {
      const data = await getStatus();
      setNetworkMode(!!data.networkMode);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const handleToggle = () => {
    const next = !networkMode;
    console.log(`[settings] queueing network-mode toggle confirmation: next=${next}`);
    setPendingToggle(next);
  };

  const confirmToggle = async () => {
    const next = pendingToggle;
    setPendingToggle(null);
    if (next === null || next === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await apiSetNetworkMode(next);
      setNetworkMode(next);
      setError(new Error('Server is restarting — refresh this page in a few seconds.'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Settings</h1>
        <p className="wp-page-sub">
          Configuration that affects the whole WebPilot server. Some changes
          require a server restart.
        </p>
      </header>

      {error ? (
        <div className="wp-card">
          <div className="wp-secondary" style={{ fontSize: 14 }}>{error.message}</div>
        </div>
      ) : null}

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Network</h2>
        </div>
        <div className="wp-card">
          <p className="wp-secondary" style={{ marginTop: 0, maxWidth: '60ch' }}>
            When enabled, WebPilot binds to all interfaces so other devices on
            your LAN can connect. Toggling this restarts the server.
          </p>
          <div className="wp-row">
            <div className="wp-row-grow">
              <div className="wp-row-title">
                {loading
                  ? 'Loading…'
                  : networkMode
                  ? 'LAN access'
                  : 'Localhost only'}
              </div>
              <div className="wp-row-sub">
                {networkMode
                  ? 'Bound to 0.0.0.0 — reachable on your network'
                  : 'Bound to 127.0.0.1 — this machine only'}
              </div>
            </div>
            <span className="wp-pill" data-state={networkMode ? 'warn' : 'active'}>
              <span className="wp-pill-dot" />
              <span className="wp-pill-label">{networkMode ? 'LAN' : 'Local'}</span>
            </span>
            <button
              type="button"
              className={networkMode ? 'wp-btn wp-btn-danger' : 'wp-btn wp-btn-primary'}
              onClick={handleToggle}
              disabled={busy || loading}
            >
              {busy ? 'Restarting…' : networkMode ? 'Disable' : 'Enable'}
            </button>
          </div>
        </div>
      </section>

      <ConfirmModal
        open={pendingToggle !== null}
        title={pendingToggle ? 'Enable network mode?' : 'Disable network mode?'}
        body={
          pendingToggle
            ? 'This restarts the WebPilot server and binds it to 0.0.0.0 so other devices on your LAN can connect. Continue?'
            : 'This restarts the WebPilot server and binds it to 127.0.0.1 (localhost only). Continue?'
        }
        confirmLabel={pendingToggle ? 'Enable' : 'Disable'}
        confirmDanger={!pendingToggle}
        onConfirm={confirmToggle}
        onCancel={() => setPendingToggle(null)}
      />
    </>
  );
}
