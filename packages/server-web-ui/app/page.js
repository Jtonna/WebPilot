'use client';

import { useEffect, useRef, useState } from 'react';
import { GlobeAltIcon, SignalIcon, ServerIcon } from '@heroicons/react/24/outline';
import PairingPromptCard from '../components/PairingPromptCard';
import StatusRow from '../components/StatusRow';
import Skeleton from '../components/Skeleton';
import { useToast } from '../components/ToastRegion';
import { createSequencedFetcher, getStatus, approvePairing, denyPairing, restartChrome } from '../lib/api';
import { createUiEventsClient } from '../lib/ws';

/**
 * Dashboard — per UX §Dashboard.
 *
 * Two sections:
 *   1. Action items   — inline pending pairings (PairingPromptCard).
 *   2. System status  — single card, three rows (Chrome / Extension / Server).
 *
 * Truly-empty state (no Chrome, no agents, never paired) shows a Welcome card
 * in place of the System status card.
 */
export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }
  const toast = useToast();

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getStatus());
      if (isStale) return;
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
      toast.success(`Paired. ${pairing.agentName || 'agent'} is bound to ${selectedProfile === '__new__' ? newProfileName : selectedProfile}.`);
      await refresh();
    } catch (e) {
      toast.error(e.message || 'Couldn’t approve.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeny(pairing) {
    setBusy(true);
    try {
      await denyPairing(pairing.pairingId);
      toast.info(`Denied ${pairing.agentName || 'agent'}.`);
      await refresh();
    } catch (e) {
      toast.error(e.message || 'Couldn’t deny.');
    } finally {
      setBusy(false);
    }
  }

  async function handleChromeAction() {
    setBusy(true);
    try {
      const result = await restartChrome();
      // The server reports the outcome via `action`:
      //   'launch'  — Chrome wasn't running; we started it.
      //   'restart' — Chrome was running without the flag; we killed + relaunched.
      //   'noop'    — Chrome was already running with the debug flag.
      const action = result && result.action;
      if (action === 'launch') {
        toast.success('Chrome launched.');
      } else if (action === 'restart') {
        toast.success('Chrome restarted.');
      } else if (action === 'noop') {
        toast.info('Chrome is already running with the debug flag.');
      } else {
        toast.success('Chrome is running with the debug flag.');
      }
      // ensureReady is mostly synchronous; small delay lets the new Chrome
      // PID register so `/api/ui/status` reflects it.
      setTimeout(() => { refresh(); }, 750);
    } catch (e) {
      toast.error(e.message || 'Chrome action failed.');
    } finally {
      setBusy(false);
    }
  }

  const pendingPairings = status?.pendingPairings ?? [];
  const chrome = status?.chrome ?? {};
  const chromeRunning = !!chrome.running;
  const chromeHasFlag = !!chrome.hasFlag;
  const profiles = status?.profiles ?? [];
  const connectedProfiles = status?.connectedProfiles ?? [];
  const activeProfiles = profiles.filter((p) => p.webPilotStatus === 'active' || p.webPilotStatus === 'ready');
  const port = status?.port ?? null;
  const networkMode = !!status?.networkMode;
  const pairedAgents = status?.pairedAgents ?? [];

  // Build profile picker options for inline pairing approval.
  const profileOptions = [
    ...profiles.map((p) => ({ value: p.directoryName, label: p.displayName || p.directoryName })),
    { value: '__new__', label: '+ New sandbox profile' },
  ];
  if (profileOptions.length === 1) {
    profileOptions.unshift({ value: 'Default', label: 'Default' });
  }

  // Truly-empty: no Chrome, no agents, no pending. Replace System status with
  // a single Welcome card.
  const trulyEmpty =
    !loading && pendingPairings.length === 0 && pairedAgents.length === 0 && !chromeRunning;

  // ---- Chrome row state ----
  let chromeState = 'unknown';
  let chromeValue = 'Not detected';
  let chromeAction = null;
  if (chromeRunning && chromeHasFlag) {
    chromeState = 'ok';
    chromeValue = 'Running · debug flag enabled';
  } else if (chromeRunning && !chromeHasFlag) {
    chromeState = 'warn';
    chromeValue = 'Running · debug flag missing';
    chromeAction = { label: 'Restart Chrome', onClick: () => handleChromeAction() };
  } else {
    chromeState = 'unknown';
    chromeValue = 'Not detected';
    chromeAction = { label: 'Launch Chrome', onClick: () => handleChromeAction() };
  }

  // ---- Extension row state ----
  let extState = 'unknown';
  let extValue;
  if (activeProfiles.length === 0) {
    extState = 'unknown';
    extValue = 'No profiles configured.';
  } else {
    const X = connectedProfiles.length;
    const Y = activeProfiles.length;
    extState = X === Y && Y > 0 ? 'ok' : 'warn';
    extValue = `${X} of ${Y} ${Y === 1 ? 'profile' : 'profiles'} connected`;
  }

  // ---- Server row state ----
  let serverState = 'ok';
  let serverValue;
  if (networkMode) {
    serverValue = `LAN · 0.0.0.0:${port ?? '—'}`;
  } else {
    serverValue = `Localhost · port ${port ?? '—'}`;
  }

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Dashboard</h1>
        <p className="wp-page-sub">
          A glance at what WebPilot is doing and what, if anything, needs you.
        </p>
      </header>

      {loading ? (
        <div className="wp-card" style={{ minHeight: 200, display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
          <Skeleton width="40%" height={18} />
          <Skeleton width="100%" height={14} />
          <Skeleton width="80%" height={14} />
          <Skeleton width="65%" height={14} />
          <Skeleton width="55%" height={14} />
        </div>
      ) : null}

      {!loading && error ? (
        <div className="wp-card">
          <div style={{ color: 'var(--wp-danger)', fontWeight: 500, marginBottom: 6 }}>
            Couldn’t reach the server.
          </div>
          <div className="wp-secondary" style={{ fontSize: 14 }}>{error.message}</div>
        </div>
      ) : null}

      {!loading && !error ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Action items</h2>
            <span className="wp-section-aside">
              {pendingPairings.length > 0
                ? `${pendingPairings.length} pending`
                : 'All clear.'}
            </span>
          </div>
          <div className="wp-card">
            {pendingPairings.length === 0 ? (
              <div className="wp-empty">Nothing pending right now.</div>
            ) : (
              pendingPairings.map((p) => (
                <PairingPromptCard
                  key={p.pairingId}
                  pairing={p}
                  profileOptions={profileOptions}
                  onApprove={handleApprove}
                  onDeny={handleDeny}
                  disabled={busy}
                />
              ))
            )}
          </div>
        </section>
      ) : null}

      {!loading && !error && trulyEmpty ? (
        <section className="wp-section">
          <div className="wp-card wp-card-lg">
            <h3 style={{
              margin: 0,
              marginBottom: 'var(--s-2)',
              fontSize: 'var(--fs-section)',
              fontWeight: 500,
              letterSpacing: '-0.01em',
              color: 'var(--wp-fg)',
            }}>
              Welcome to WebPilot.
            </h3>
            <p style={{
              margin: 0,
              marginBottom: 'var(--s-4)',
              color: 'var(--wp-fg-secondary)',
              maxWidth: '60ch',
            }}>
              Pair your first agent to get started.
            </p>
            <a href="/ui/agents/" className="wp-btn wp-btn-primary wp-btn-cta">
              Pair an agent
            </a>
          </div>
        </section>
      ) : null}

      {!loading && !error && !trulyEmpty ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">System status</h2>
          </div>
          <div className="wp-card">
            <StatusRow
              label="Chrome"
              icon={GlobeAltIcon}
              state={chromeState}
              value={chromeValue}
              actionLabel={chromeAction?.label}
              onAction={chromeAction?.onClick}
            />
            <StatusRow
              label="Extension"
              icon={SignalIcon}
              state={extState}
              value={extValue}
            />
            <StatusRow
              label="Server"
              icon={ServerIcon}
              state={serverState}
              value={serverValue}
            />
          </div>
        </section>
      ) : null}
    </>
  );
}
