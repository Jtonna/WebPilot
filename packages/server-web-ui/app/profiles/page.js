'use client';

import { useEffect, useRef, useState } from 'react';
import ProfileStatusBadge, { NEEDS_SETUP_HINT } from '../../components/ProfileStatusBadge';
import { createSequencedFetcher, getStatus, createProfile } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState([]);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createMsg, setCreateMsg] = useState(null);
  // See QOL Wave 6 H2 — guards REST refresh against WS-event clobber.
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getStatus());
      if (isStale) return;
      setProfiles(data.profiles || []);
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
      <header className="wp-page-head">
        <h1 className="wp-page-title">Profiles</h1>
        <p className="wp-page-sub">
          Chrome profiles WebPilot knows about, plus a launcher for fresh
          sandbox profiles you can hand to a new agent.
        </p>
      </header>

      {error ? (
        <div className="wp-card">
          <div style={{ color: 'var(--wp-danger)', fontWeight: 500, marginBottom: 6 }}>
            Something went wrong
          </div>
          <div className="wp-secondary" style={{ fontSize: 14 }}>{error.message}</div>
        </div>
      ) : null}

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Known profiles</h2>
          <span className="wp-section-aside">
            {profiles.length > 0
              ? `${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'}`
              : 'None found'}
          </span>
        </div>
        <div className="wp-card">
          {profiles.length === 0 ? (
            <div className="wp-empty">No profiles found.</div>
          ) : (
            profiles.map((p) => (
              <div className="wp-row" key={p.directoryName}>
                <div className="wp-row-grow">
                  <div className="wp-row-title">{p.displayName || p.directoryName}</div>
                  <div className="wp-row-sub">
                    {p.gaiaEmail || 'No Google account'}
                    <span className="wp-row-sep">·</span>
                    <span className="wp-mono">{p.directoryName}</span>
                  </div>
                  {p.webPilotStatus === 'needs_setup' ? (
                    <div className="wp-secondary" style={{ marginTop: 8, fontSize: 13, maxWidth: '52ch' }}>
                      {NEEDS_SETUP_HINT}
                    </div>
                  ) : null}
                </div>
                <ProfileStatusBadge status={p.webPilotStatus} />
              </div>
            ))
          )}
        </div>
      </section>

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">New sandbox profile</h2>
        </div>
        <div className="wp-card">
          <p className="wp-secondary" style={{ marginTop: 0, marginBottom: 20, maxWidth: '60ch' }}>
            Launches Chrome with a fresh <code>--profile-directory</code>. After
            Chrome opens, load the WebPilot unpacked extension via
            chrome://extensions (Developer mode → Load unpacked).
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input
              className="wp-input"
              style={{ flex: 1, minWidth: 0 }}
              value={newName}
              placeholder='e.g. "WebPilot Sandbox"'
              onChange={(e) => setNewName(e.target.value)}
              disabled={creating}
            />
            <button
              type="button"
              className="wp-btn wp-btn-primary"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? 'Launching…' : 'Create sandbox'}
            </button>
          </div>
          {createMsg ? (
            <div
              style={{
                marginTop: 14,
                fontSize: 13,
                color: createMsg.kind === 'err' ? 'var(--wp-danger)' : 'var(--wp-success)',
              }}
            >
              {createMsg.text}
            </div>
          ) : null}
        </div>
      </section>
    </>
  );
}
