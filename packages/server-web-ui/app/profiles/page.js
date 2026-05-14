'use client';

import { useState } from 'react';

const PLACEHOLDER_PROFILES = [
  { id: 'Default', displayName: 'Default', gaiaEmail: null, lastActive: Date.now() - 60_000 },
  { id: 'Profile 2', displayName: 'Profile 2', gaiaEmail: null, lastActive: null },
];

export default function ProfilesPage() {
  const [profiles] = useState(PLACEHOLDER_PROFILES);

  const handleCreate = () => {
    // eslint-disable-next-line no-console
    console.log('[profiles] create sandbox profile (stub)');
  };

  return (
    <>
      <div>
        <h1 className="wp-page-title">Chrome profiles</h1>
        <p className="wp-page-sub">
          Profiles WebPilot knows about, plus sandbox profiles you can create.
        </p>
      </div>

      <div className="wp-card">
        <h2>Known profiles</h2>
        {profiles.length === 0 ? (
          <div className="wp-muted">No profiles found.</div>
        ) : (
          profiles.map((p) => (
            <div className="wp-row" key={p.id}>
              <div className="wp-row-grow">
                <div style={{ fontWeight: 600 }}>{p.displayName}</div>
                <div className="wp-muted">
                  {p.gaiaEmail || 'No Google account linked'}
                  {' • last active '}
                  {p.lastActive ? new Date(p.lastActive).toLocaleString() : 'never'}
                </div>
              </div>
              <span className="wp-mono wp-muted">{p.id}</span>
            </div>
          ))
        )}
      </div>

      <div className="wp-card">
        <h2>Create new sandbox profile</h2>
        <p className="wp-muted" style={{ marginTop: 0 }}>
          Launches Chrome with a fresh <code>--profile-directory</code>. Useful
          for isolating an agent from your daily browsing.
        </p>
        <button type="button" className="wp-btn wp-btn-primary" onClick={handleCreate}>
          Create sandbox profile
        </button>
      </div>
    </>
  );
}
