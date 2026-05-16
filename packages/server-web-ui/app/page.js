'use client';

import { useEffect, useRef, useState } from 'react';
import PairingPromptCard from '../components/PairingPromptCard';
import ProfileStatusBadge, { NEEDS_SETUP_HINT } from '../components/ProfileStatusBadge';
import RevealSection from '../components/RevealSection';
import { createSequencedFetcher, getStatus, approvePairing, denyPairing } from '../lib/api';
import { createUiEventsClient } from '../lib/ws';

export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Tracks freshly-arrived pairing IDs so PairingPromptCard can play its
  // slide-in / accent pulse animation once. Cleared after the animation
  // duration so subsequent re-renders don't replay.
  const [arrivingIds, setArrivingIds] = useState(() => new Set());
  const seenIdsRef = useRef(new Set());
  // Guards against stale REST refresh responses arriving AFTER a newer
  // WS-event-triggered refresh has already updated state. See QOL Wave 6 H2.
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }

  function markArrivals(newList) {
    const nextSeen = new Set();
    const arrivals = new Set();
    for (const p of newList) {
      if (!p || !p.pairingId) continue;
      nextSeen.add(p.pairingId);
      if (!seenIdsRef.current.has(p.pairingId)) {
        arrivals.add(p.pairingId);
      }
    }
    seenIdsRef.current = nextSeen;
    if (arrivals.size > 0) {
      setArrivingIds(arrivals);
      setTimeout(() => {
        setArrivingIds((curr) => {
          const next = new Set(curr);
          for (const id of arrivals) next.delete(id);
          return next;
        });
      }, 1500);
    }
  }

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getStatus());
      if (isStale) return;
      markArrivals(data.pendingPairings || []);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    refresh();

    const client = createUiEventsClient();
    client.connect();
    const unsubs = [
      client.subscribe('pairing_requested', () => !cancelled && refresh()),
      client.subscribe('pairing_approved', () => !cancelled && refresh()),
      client.subscribe('pairing_denied', () => !cancelled && refresh()),
      client.subscribe('agents_changed', () => !cancelled && refresh()),
      client.subscribe('extension_connected', () => !cancelled && refresh()),
      client.subscribe('extension_disconnected', () => !cancelled && refresh()),
    ];

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u && u());
      client.disconnect();
    };
  }, []);

  async function handleApprove(pairing, selectedProfile, newProfileName) {
    setBusy(true);
    try {
      await approvePairing(pairing.pairingId, selectedProfile, newProfileName);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeny(pairing) {
    setBusy(true);
    try {
      await denyPairing(pairing.pairingId);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const pendingPairings = status?.pendingPairings ?? [];
  const chromeRunning = status?.chrome?.running;
  const chromePid = status?.chrome?.browserPid;
  const chromeHasFlag = status?.chrome?.hasFlag;
  const chromeUserDataDir = status?.chrome?.userDataDir;
  const profiles = status?.profiles ?? [];
  const activeProfiles = profiles.filter((p) => p.webPilotStatus === 'active');
  const pairedAgentCount = status?.pairedAgents?.length ?? 0;

  // Profile dropdown options for inline pairing approval — same shape as
  // /pairings page. The "+ New sandbox profile" sentinel lets the user create
  // a fresh profile during approval.
  const profileOptions = [
    ...profiles.map((p) => ({ value: p.directoryName, label: p.displayName || p.directoryName })),
    { value: '__new__', label: '+ New sandbox profile' },
  ];
  if (profileOptions.length === 1) {
    profileOptions.unshift({ value: 'Default', label: 'Default' });
  }

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Dashboard</h1>
        <p className="wp-page-sub">
          An overview of WebPilot, the Chrome process it watches, and the
          agents currently authorized to drive your browser.
        </p>
      </header>

      {loading ? (
        <div className="wp-card">
          <div className="wp-empty">Loading…</div>
        </div>
      ) : null}

      {!loading && error ? (
        <div className="wp-card">
          <div style={{ color: 'var(--wp-danger)', fontWeight: 500, marginBottom: 6 }}>
            Couldn’t reach the server
          </div>
          <div className="wp-secondary" style={{ fontSize: 14 }}>{error.message}</div>
        </div>
      ) : null}

      {!loading ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Action items</h2>
            <span className="wp-section-aside">
              {pendingPairings.length > 0
                ? `${pendingPairings.length} pending`
                : 'All clear'}
            </span>
          </div>
          <div className="wp-card">
            {pendingPairings.length === 0 ? (
              <div className="wp-empty">No action items waiting.</div>
            ) : (
              pendingPairings.map((p) => (
                <PairingPromptCard
                  key={p.pairingId}
                  pairing={p}
                  profileOptions={profileOptions}
                  onApprove={handleApprove}
                  onDeny={handleDeny}
                  disabled={busy}
                  justArrived={arrivingIds.has(p.pairingId)}
                />
              ))
            )}
          </div>
        </section>
      ) : null}

      {!loading ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Chrome</h2>
          </div>
          <div className="wp-card">
            <div className="wp-kv">
              <div className="wp-kv-label">Process</div>
              <div className="wp-kv-value">
                {chromeRunning ? (
                  <>
                    Chrome{' '}
                    <span className="wp-kv-value-mono wp-secondary">PID {chromePid ?? '—'}</span>
                  </>
                ) : (
                  <span className="wp-secondary">Not detected</span>
                )}
              </div>
              <div className="wp-kv-label">Debug flag</div>
              <div className="wp-kv-value">
                {chromeRunning
                  ? (chromeHasFlag
                      ? <span style={{ color: 'var(--wp-success)' }}>Enabled</span>
                      : <span style={{ color: 'var(--wp-warning)' }}>Missing — the extension can’t connect</span>)
                  : <span className="wp-secondary">—</span>}
              </div>
              <div className="wp-kv-label">User data</div>
              <div className="wp-kv-value wp-kv-value-mono wp-secondary" style={{ fontWeight: 400 }}>
                {chromeUserDataDir || '—'}
              </div>
              <div className="wp-kv-label">Paired agents</div>
              <div className="wp-kv-value">{pairedAgentCount}</div>
            </div>
          </div>
        </section>
      ) : null}

      {!loading && activeProfiles.length > 0 ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Active profiles</h2>
            <span className="wp-section-aside">
              {activeProfiles.length} {activeProfiles.length === 1 ? 'profile' : 'profiles'}
            </span>
          </div>
          <div className="wp-card">
            {activeProfiles.map((p) => (
              <div className="wp-row" key={p.directoryName}>
                <div className="wp-row-grow">
                  <div className="wp-row-title">{p.displayName || p.directoryName}</div>
                  <div className="wp-row-sub">
                    {p.gaiaEmail || 'No Google account'}
                    <span className="wp-row-sep">·</span>
                    <span className="wp-mono">{p.directoryName}</span>
                  </div>
                </div>
                <ProfileStatusBadge status={p.webPilotStatus} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && profiles.length > 0 ? (
        <RevealSection className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">All profiles</h2>
            <span className="wp-section-aside">
              {profiles.length} known
            </span>
          </div>
          <div className="wp-card">
            {profiles.map((p) => (
              <div className="wp-row" key={p.directoryName}>
                <div className="wp-row-grow">
                  <div className="wp-row-title">{p.displayName || p.directoryName}</div>
                  <div className="wp-row-sub">{p.gaiaEmail || 'No Google account'}</div>
                  {p.webPilotStatus === 'needs_setup' ? (
                    <div className="wp-secondary" style={{ marginTop: 8, fontSize: 13, maxWidth: '52ch' }}>
                      {NEEDS_SETUP_HINT}
                    </div>
                  ) : null}
                </div>
                <ProfileStatusBadge status={p.webPilotStatus} />
              </div>
            ))}
          </div>
        </RevealSection>
      ) : null}
    </>
  );
}
