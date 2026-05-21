'use client';

import { useEffect, useRef, useState } from 'react';
import { GlobeAltIcon, SignalIcon, ServerIcon } from '@heroicons/react/24/outline';
import PairingPromptCard from '../components/PairingPromptCard';
import FormatterErrorCard from '../components/FormatterErrorCard';
import ProfileStatusBadge from '../components/ProfileStatusBadge';
import StatusRow from '../components/StatusRow';
import Skeleton from '../components/Skeleton';
import ErrorCard from '../components/ErrorCard';
import { useToast } from '../components/ToastRegion';
import EmptyState from '../components/EmptyState';
import { createSequencedFetcher, getStatus, approvePairing, denyPairing, restartChrome, dismissIncident, dismissAllForFormatter } from '../lib/api';
import { createUiEventsClient } from '../lib/ws';
import { profileOptions } from '../lib/format';

/**
 * Dashboard — per UX §Dashboard.
 *
 * Sections:
 *   1. Action items     — inline pending pairings (PairingPromptCard).
 *   2. Chrome profiles  — every known profile with status + paired-agent count;
 *                         each row links to /agents?profile=<dir>.
 *   3. System status    — single card, three rows (Chrome / Extension / Server).
 *
 * Truly-empty state (no Chrome, no agents, never paired) shows a Welcome card
 * in place of the System status + Chrome profiles sections.
 */

const PROFILE_STATUS_ORDER = { needs_setup: 0, ready: 1, active: 2, unknown: 3 };
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
      // Formatter health flips — surface new errors and clear dismissed rows
      // in realtime. See P1 #1.
      client.subscribe('formatter_status_changed', () => !cancelled && refresh()),
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

  async function handleDismissFormatter({ incidentId, name }) {
    setBusy(true);
    try {
      // P2 phase 3: dismiss is per-incident. If the card lacks an incident id
      // (e.g. the row was synthesized in a DB-down fallback), fall back to
      // the bulk endpoint so the user can still clear the card from the list.
      if (incidentId != null) {
        await dismissIncident(incidentId);
      } else {
        await dismissAllForFormatter(name);
      }
      toast.info(`Dismissed error from "${name}".`);
      await refresh();
    } catch (e) {
      toast.error(e.message || `Couldn’t dismiss error from "${name}".`);
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
  // New action-item variant: unhealthy formatters. The server discriminates
  // these via `type: 'formatter_error'`; we filter defensively here so
  // unknown future variants do not blow up the render. See P1 #1.
  const formatterActionItems = (status?.actionItems ?? []).filter(
    (it) => it && it.type === 'formatter_error'
  );
  const actionItemsCount = pendingPairings.length + formatterActionItems.length;
  const chrome = status?.chrome ?? {};
  const chromeRunning = !!chrome.running;
  const chromeHasFlag = !!chrome.hasFlag;
  const profiles = status?.profiles ?? [];
  const connectedProfiles = status?.connectedProfiles ?? [];
  const activeProfiles = profiles.filter((p) => p.webPilotStatus === 'active' || p.webPilotStatus === 'ready');
  const port = status?.port ?? null;
  const networkMode = !!status?.networkMode;
  const pairedAgents = status?.pairedAgents ?? [];

  // Per-profile agent count, keyed by directoryName. pairedAgents carries a
  // `profileId` field (see paired-keys.listKeys) — when the field is
  // populated, it matches the profile's directoryName.
  const agentCountByProfile = pairedAgents.reduce((acc, a) => {
    const k = a && a.profileId;
    if (!k) return acc;
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  const sortedProfiles = [...profiles].sort((a, b) => {
    const ra = PROFILE_STATUS_ORDER[a.webPilotStatus] ?? PROFILE_STATUS_ORDER.unknown;
    const rb = PROFILE_STATUS_ORDER[b.webPilotStatus] ?? PROFILE_STATUS_ORDER.unknown;
    if (ra !== rb) return ra - rb;
    return (a.directoryName || '').localeCompare(b.directoryName || '');
  });

  // Build profile picker options for inline pairing approval.
  const profileOptionsList = profileOptions(profiles);

  // Truly-empty: no Chrome, no agents, no pending. Replace System status with
  // a single Welcome card.
  const trulyEmpty =
    !loading &&
    pendingPairings.length === 0 &&
    formatterActionItems.length === 0 &&
    pairedAgents.length === 0 &&
    !chromeRunning;

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

      {!loading && error ? <ErrorCard error={error} /> : null}

      {!loading && !error ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Action items</h2>
            <span className="wp-section-aside">
              {actionItemsCount > 0
                ? `${actionItemsCount} pending`
                : 'All clear'}
            </span>
          </div>
          <div className="wp-inset-group">
            {actionItemsCount === 0 ? (
              <EmptyState variant="bare" body="Nothing pending right now." />
            ) : (
              <>
                {pendingPairings.map((p) => (
                  <PairingPromptCard
                    key={`pairing-${p.pairingId}`}
                    pairing={p}
                    profileOptions={profileOptionsList}
                    onApprove={handleApprove}
                    onDeny={handleDeny}
                    disabled={busy}
                  />
                ))}
                {formatterActionItems.map((f) => (
                  <FormatterErrorCard
                    key={`formatter-${f.name}`}
                    formatter={f}
                    onDismiss={handleDismissFormatter}
                  />
                ))}
              </>
            )}
          </div>
        </section>
      ) : null}

      {!loading && !error && !trulyEmpty ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Chrome profiles</h2>
            <span className="wp-section-aside">
              {sortedProfiles.length > 0
                ? `${sortedProfiles.length} ${sortedProfiles.length === 1 ? 'profile' : 'profiles'}`
                : ''}
            </span>
          </div>
          {sortedProfiles.length === 0 ? (
            <EmptyState body="No Chrome profiles found yet. Launch Chrome once on this machine." />
          ) : (
            <div className="wp-row-list">
              {sortedProfiles.map((p) => {
                const count = agentCountByProfile[p.directoryName] || 0;
                const countText = `${count} ${count === 1 ? 'agent' : 'agents'}`;
                const dim = count === 0 && p.webPilotStatus === 'needs_setup';
                return (
                  <a
                    key={p.directoryName}
                    href={`/ui/agents/?profile=${encodeURIComponent(p.directoryName)}`}
                    className="wp-row wp-row-link"
                  >
                    <div className="wp-row-grow">
                      <div className="wp-row-title">{p.displayName || p.directoryName}</div>
                      <div className="wp-row-sub">
                        <span className="wp-mono">{p.directoryName}</span>
                      </div>
                    </div>
                    <div
                      className="wp-row-actions"
                      style={{ gap: 'var(--s-3)' }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--wp-font-sans)',
                          fontSize: 'var(--fs-small)',
                          color: dim ? 'var(--wp-fg-muted)' : 'var(--wp-fg-secondary)',
                          fontVariantNumeric: 'tabular-nums',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {countText}
                      </span>
                      <ProfileStatusBadge status={p.webPilotStatus} />
                    </div>
                  </a>
                );
              })}
            </div>
          )}
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
              Welcome to WebPilot
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
          <div className="wp-inset-group">
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
