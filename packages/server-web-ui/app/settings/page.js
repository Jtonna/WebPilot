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
    // Open the themed confirm modal — replaces window.confirm() per F7.
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
      // The server is now restarting; show a friendly message
      setError(new Error('Server is restarting — refresh this page in a few seconds.'));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div>
        <h1 className="wp-page-title">Settings</h1>
        <p className="wp-page-sub">Server-wide preferences.</p>
      </div>

      {error ? (
        <div className="wp-card">
          <div className="wp-muted">{error.message}</div>
        </div>
      ) : null}

      <div className="wp-card">
        <h2>Network mode</h2>
        <p className="wp-muted" style={{ marginTop: 0 }}>
          When enabled, the WebPilot server binds to all interfaces so other
          devices on your LAN can connect. Toggling this restarts the server.
        </p>
        <div className="wp-row">
          <div className="wp-row-grow">
            <div style={{ fontWeight: 600 }}>
              {loading
                ? 'Loading…'
                : networkMode
                ? 'Network mode: ON'
                : 'Network mode: OFF (localhost only)'}
            </div>
            <div className="wp-muted">
              {networkMode
                ? 'Bind address: 0.0.0.0 (LAN reachable)'
                : 'Bind address: 127.0.0.1 (this machine only)'}
            </div>
          </div>
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
