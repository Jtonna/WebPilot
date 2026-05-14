'use client';

import { useState } from 'react';

export default function SettingsPage() {
  const [networkMode, setNetworkMode] = useState(false);

  const handleToggle = () => {
    const next = !networkMode;
    setNetworkMode(next);
    // eslint-disable-next-line no-console
    console.log('[settings] toggle network mode (stub)', { networkMode: next });
  };

  return (
    <>
      <div>
        <h1 className="wp-page-title">Settings</h1>
        <p className="wp-page-sub">Server-wide preferences.</p>
      </div>

      <div className="wp-card">
        <h2>Network mode</h2>
        <p className="wp-muted" style={{ marginTop: 0 }}>
          When enabled, the WebPilot server binds to all interfaces so other
          devices on your LAN can connect. Toggling this restarts the server.
        </p>
        <div className="wp-row">
          <div className="wp-row-grow">
            <div style={{ fontWeight: 600 }}>
              {networkMode ? 'Network mode: ON' : 'Network mode: OFF (localhost only)'}
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
          >
            {networkMode ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>
    </>
  );
}
