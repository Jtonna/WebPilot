'use client';

import { useEffect, useState } from 'react';
import { getStatus, createProfile } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState([]);
  const [connected, setConnected] = useState([]);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createMsg, setCreateMsg] = useState(null);

  async function refresh() {
    try {
      const data = await getStatus();
      setProfiles(data.profiles || []);
      setConnected(data.connectedProfiles || []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }

  useEffect(() => {
    refresh();
    const client = createUiEventsClient();
    client.connect();
    const u1 = client.subscribe('extension_connected', () => refresh());
    const u2 = client.subscribe('extension_disconnected', () => refresh());
    return () => {
      u1 && u1();
      u2 && u2();
      client.disconnect();
    };
  }, []);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      setCreateMsg({ kind: 'err', text: 'Enter a profile directory name (e.g., "WebPilot Sandbox")' });
      return;
    }
    setCreating(true);
    setCreateMsg(null);
    try {
      const result = await createProfile(name);
      setCreateMsg({ kind: 'ok', text: result.instructions || ('Profile "' + name + '" launched. Load the extension via chrome://extensions.') });
      setNewName('');
      setTimeout(refresh, 1000);
    } catch (e) {
      setCreateMsg({ kind: 'err', text: 'Failed: ' + e.message });
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <div>
        <h1 className="wp-page-title">Chrome profiles</h1>
        <p className="wp-page-sub">
          Profiles WebPilot knows about, plus sandbox profiles you can create.
        </p>
      </div>

      {error ? (
        <div className="wp-card">
          <div className="wp-muted">Error: {error.message}</div>
        </div>
      ) : null}

      <div className="wp-card">
        <h2>Known profiles</h2>
        {profiles.length === 0 ? (
          <div className="wp-muted">No profiles found.</div>
        ) : (
          profiles.map((p) => {
            const isConnected = connected.includes(p.directoryName);
            return (
              <div className="wp-row" key={p.directoryName}>
                <div className="wp-row-grow">
                  <div style={{ fontWeight: 600 }}>{p.displayName || p.directoryName}</div>
                  <div className="wp-muted">
                    {p.gaiaEmail || 'No Google account linked'}
                    {' • '}
                    {isConnected ? 'extension connected' : 'extension not connected'}
                  </div>
                </div>
                <span className="wp-mono wp-muted">{p.directoryName}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="wp-card">
        <h2>Create new sandbox profile</h2>
        <p className="wp-muted" style={{ marginTop: 0 }}>
          Launches Chrome with a fresh <code>--profile-directory</code>. After
          Chrome opens, load the WebPilot unpacked extension via
          chrome://extensions (Developer mode → Load unpacked).
        </p>
        <div className="wp-row">
          <input
            className="wp-input wp-row-grow"
            value={newName}
            placeholder="Profile directory name (e.g. WebPilot Sandbox)"
            onChange={(e) => setNewName(e.target.value)}
            disabled={creating}
          />
          <button
            type="button"
            className="wp-btn wp-btn-primary"
            onClick={handleCreate}
            disabled={creating}
          >
            {creating ? 'Launching...' : 'Create sandbox profile'}
          </button>
        </div>
        {createMsg ? (
          <div
            className="wp-muted"
            style={{ marginTop: 8, color: createMsg.kind === 'err' ? '#dc2626' : undefined }}
          >
            {createMsg.text}
          </div>
        ) : null}
      </div>
    </>
  );
}
