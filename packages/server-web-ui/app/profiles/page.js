'use client';

import { useEffect, useRef, useState } from 'react';
import ErrorCard from '../../components/ErrorCard';
import ProfileStatusBadge from '../../components/ProfileStatusBadge';
import ProfileSetupModal from '../../components/ProfileSetupModal';
import { SkeletonRow } from '../../components/Skeleton';
import { useToast } from '../../components/ToastRegion';
import { createSequencedFetcher, getStatus, createProfile } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

/**
 * Profiles — per UX §Profiles.
 *
 * Two sections:
 *   1. Known profiles    — sorted active → ready → needs_setup, then by dir
 *                          name. needs_setup rows expose a primary Set up
 *                          button that opens ProfileSetupModal.
 *   2. + New sandbox     — friendly intro + input + primary "Create profile".
 */
const STATUS_ORDER = { active: 0, ready: 1, needs_setup: 2, unknown: 3 };

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState([]);
  const [agents, setAgents]     = useState([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [extensionPath, setExtensionPath] = useState(null);
  const [error, setError]       = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName]   = useState('');
  const [setupTarget, setSetupTarget] = useState(null);
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }
  const toast = useToast();

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getStatus());
      if (isStale) return;
      setProfiles(data.profiles || []);
      setAgents(data.pairedAgents || []);
      setExtensionPath((data.paths && data.paths.extensionPath) || null);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setProfilesLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const client = createUiEventsClient();
    client.connect();
    const u1 = client.subscribe('extension_connected', () => refresh());
    const u2 = client.subscribe('extension_disconnected', () => refresh());
    const u3 = client.subscribe('agents_changed', () => refresh());
    const u4 = client.subscribe('pairing_approved', () => refresh());
    return () => {
      u1 && u1();
      u2 && u2();
      u3 && u3();
      u4 && u4();
      client.disconnect();
    };
  }, []);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      toast.error('Enter a name first.');
      return;
    }
    setCreating(true);
    try {
      await createProfile(name);
      toast.success(`Profile ${name} created. Load the extension to finish setup.`);
      setNewName('');
      setTimeout(refresh, 1000);
    } catch (e) {
      toast.error(e.message || 'Couldn’t create profile.');
    } finally {
      setCreating(false);
    }
  }

  const sorted = [...profiles].sort((a, b) => {
    const ra = STATUS_ORDER[a.webPilotStatus] ?? STATUS_ORDER.unknown;
    const rb = STATUS_ORDER[b.webPilotStatus] ?? STATUS_ORDER.unknown;
    if (ra !== rb) return ra - rb;
    return (a.directoryName || '').localeCompare(b.directoryName || '');
  });

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Profiles</h1>
        <p className="wp-page-sub">
          Chrome profiles WebPilot knows about. Sandbox a new one for an agent
          to live in.
        </p>
      </header>

      {error ? <ErrorCard error={error} /> : null}

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Known profiles</h2>
          <span className="wp-section-aside">
            {profilesLoading
              ? ''
              : sorted.length > 0
                ? `${sorted.length} ${sorted.length === 1 ? 'profile' : 'profiles'}`
                : 'None found'}
          </span>
        </div>
        {profilesLoading ? (
          <div className="wp-inset-group">
            <SkeletonRow titleWidth="45%" subWidth="60%" showTrailing />
            <SkeletonRow titleWidth="38%" subWidth="55%" showTrailing />
            <SkeletonRow titleWidth="52%" subWidth="50%" showTrailing />
          </div>
        ) : sorted.length === 0 ? (
          <div className="wp-card">
            <div className="wp-empty" style={{ padding: 0 }}>
              No profiles found. Launch Chrome once on this machine to populate the list.
            </div>
          </div>
        ) : (
          <div className="wp-row-list">
            {sorted.map((p) => {
              const needsSetup = p.webPilotStatus === 'needs_setup';
              const agentCount = agents.filter((a) => a.profileId === p.directoryName).length;
              return (
                <div className="wp-row" key={p.directoryName} style={{ alignItems: 'flex-start' }}>
                  <div className="wp-row-grow">
                    <div className="wp-row-title">{p.displayName || p.directoryName}</div>
                    <div className="wp-row-sub">
                      {p.gaiaEmail || 'No Google account'}
                      <span className="wp-row-sep">·</span>
                      <span className="wp-mono">{p.directoryName}</span>
                    </div>
                    {needsSetup ? (
                      <div className="wp-row-inline-hint">
                        Open Chrome’s extensions page in this profile and load
                        the WebPilot extension.
                      </div>
                    ) : null}
                  </div>
                  <div className="wp-row-actions">
                    {/* Agent count is the source of truth for which agents
                        this profile is hosting — clicking it deep-links to
                        the filtered Agents view. Zero counts de-emphasize. */}
                    <a
                      href={`/ui/agents/?profile=${encodeURIComponent(p.directoryName)}`}
                      className="wp-link"
                      style={{
                        fontSize: 'var(--fs-small)',
                        color: agentCount > 0 ? 'var(--wp-fg)' : 'var(--wp-fg-secondary)',
                        fontWeight: agentCount > 0 ? 500 : 400,
                      }}
                      title={`View ${agentCount} ${agentCount === 1 ? 'agent' : 'agents'} bound to this profile`}
                    >
                      {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
                    </a>
                    <ProfileStatusBadge status={p.webPilotStatus} />
                    {needsSetup ? (
                      <button
                        type="button"
                        className="wp-btn wp-btn-primary wp-btn-compact"
                        onClick={() => setSetupTarget(p)}
                      >
                        Set up
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">New sandbox profile</h2>
        </div>
        <div className="wp-card">
          <p className="wp-secondary" style={{ marginTop: 0, marginBottom: 'var(--s-4)', maxWidth: '60ch' }}>
            Launches Chrome with a fresh profile directory. Hand it to an agent
            so it never touches your real browser data.
          </p>
          <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="wp-input"
              style={{ flex: 1, minWidth: 240 }}
              value={newName}
              placeholder="e.g. WebPilot Sandbox"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              disabled={creating}
            />
            <button
              type="button"
              className="wp-btn wp-btn-primary"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? 'Launching…' : 'Create profile'}
            </button>
          </div>
        </div>
      </section>

      <ProfileSetupModal
        open={!!setupTarget}
        profileName={setupTarget ? (setupTarget.displayName || setupTarget.directoryName) : null}
        extensionPath={extensionPath}
        onClose={() => setSetupTarget(null)}
      />
    </>
  );
}
