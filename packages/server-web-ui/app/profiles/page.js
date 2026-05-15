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
        <div className="wp-page-kicker">
          <span className="wp-page-kicker-accent">§ 03</span>
          <span style={{ marginLeft: 12 }}>chrome user-data inventory</span>
        </div>
        <h1 className="wp-page-title">Profiles.</h1>
        <p className="wp-page-sub">
          Chrome profiles WebPilot knows about, plus a launcher for fresh
          sandbox profiles you can hand to a new agent.
        </p>
      </header>

      {error ? (
        <div className="wp-card">
          <div className="wp-section-head" style={{ marginBottom: 8 }}>
            <span className="wp-section-num">!!</span>
            <span style={{ color: 'var(--wp-danger)' }}>ERROR</span>
          </div>
          <div className="wp-mono wp-secondary">{error.message}</div>
        </div>
      ) : null}

      <section className="wp-section">
        <div className="wp-section-head">
          <span className="wp-section-num">§ 01</span>
          <span>KNOWN PROFILES</span>
          <span className="wp-section-rule" />
          <span className="wp-section-aside">
            {profiles.length > 0 ? `${profiles.length} TOTAL` : 'EMPTY'}
          </span>
        </div>
        <div className="wp-card">
          {profiles.length === 0 ? (
            <div className="wp-empty">no profiles — waiting</div>
          ) : (
            profiles.map((p) => (
              <div className="wp-row" key={p.directoryName}>
                <div className="wp-row-grow">
                  <div className="wp-row-title">{p.displayName || p.directoryName}</div>
                  <div className="wp-row-sub">
                    {p.gaiaEmail || 'NO GOOGLE ACCOUNT'} · DIR {p.directoryName}
                  </div>
                  {p.webPilotStatus === 'needs_setup' ? (
                    <div className="wp-mono wp-muted" style={{ marginTop: 6, fontSize: 11, letterSpacing: '0.04em' }}>
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
          <span className="wp-section-num">§ 02</span>
          <span>NEW SANDBOX</span>
          <span className="wp-section-rule" />
          <span className="wp-section-aside">spawn</span>
        </div>
        <div className="wp-card">
          <p className="wp-secondary" style={{ marginTop: 0, marginBottom: 20, maxWidth: '60ch' }}>
            Launches Chrome with a fresh <code>--profile-directory</code>. After
            Chrome opens, load the WebPilot unpacked extension via
            chrome://extensions (Developer mode → Load unpacked).
          </p>
          <div className="wp-row">
            <input
              className="wp-input wp-row-grow"
              value={newName}
              placeholder='Profile directory name (e.g. "WebPilot Sandbox")'
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
              className="wp-mono"
              style={{
                marginTop: 16,
                fontSize: 12,
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
