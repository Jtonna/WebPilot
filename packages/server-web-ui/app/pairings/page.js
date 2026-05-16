'use client';

import { useEffect, useRef, useState } from 'react';
import PairingPromptCard from '../../components/PairingPromptCard';
import { useToast } from '../../components/ToastRegion';
import { createSequencedFetcher, getStatus, approvePairing, denyPairing } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

/**
 * Pairings — per UX §Pairings.
 *
 * Two sections:
 *   1. Awaiting review — identical inline approve/deny card as Dashboard.
 *   2. History         — session-scoped for Phase 2 (Phase 3 swaps to a
 *                        server-backed paginated endpoint).
 */
export default function PairingsPage() {
  const [pairings, setPairings] = useState([]);
  const [history, setHistory]   = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [error, setError]       = useState(null);
  const [busy, setBusy]         = useState(false);
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }
  const toast = useToast();

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getStatus());
      if (isStale) return;
      setPairings(data.pendingPairings || []);
      setProfiles(data.profiles || []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }

  useEffect(() => {
    let cancelled = false;
    refresh();
    const client = createUiEventsClient();
    client.connect();
    const unsubs = [
      client.subscribe('pairing_requested', () => !cancelled && refresh()),
      client.subscribe('pairing_approved', (evt) => {
        if (cancelled) return;
        setHistory((h) => [{ ...evt.pairing, decision: 'approved', decidedAt: new Date().toISOString() }, ...h]);
        refresh();
      }),
      client.subscribe('pairing_denied', (evt) => {
        if (cancelled) return;
        setHistory((h) => [{ ...evt.pairing, decision: 'denied', decidedAt: new Date().toISOString() }, ...h]);
        refresh();
      }),
    ];
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u && u());
      client.disconnect();
    };
  }, []);

  const profileOptions = [
    ...profiles.map((p) => ({ value: p.directoryName, label: p.displayName || p.directoryName })),
    { value: '__new__', label: '+ New sandbox profile' },
  ];
  if (profileOptions.length === 1) {
    profileOptions.unshift({ value: 'Default', label: 'Default' });
  }

  async function handleApprove(pairing, selectedProfile, newProfileName) {
    setBusy(true);
    try {
      await approvePairing(pairing.pairingId, selectedProfile, newProfileName);
      toast.success(`Paired. ${pairing.agentName || 'agent'} is bound to ${selectedProfile === '__new__' ? newProfileName : selectedProfile}.`);
      await refresh();
    } catch (e) {
      toast.error(e.message || 'Failed to approve.');
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
      toast.error(e.message || 'Failed to deny.');
    } finally {
      setBusy(false);
    }
  }

  function fmtTimestamp(iso) {
    if (!iso) return 'Just now';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Pairings</h1>
        <p className="wp-page-sub">
          Approve or deny pairing requests, and review what you’ve decided.
        </p>
      </header>

      {error ? (
        <div className="wp-card">
          <div style={{ color: 'var(--wp-danger)', fontWeight: 500, marginBottom: 6 }}>
            Something went wrong.
          </div>
          <div className="wp-secondary" style={{ fontSize: 14 }}>{error.message}</div>
        </div>
      ) : null}

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Awaiting review</h2>
          <span className="wp-section-aside">
            {pairings.length > 0 ? `${pairings.length} pending` : 'Nothing pending'}
          </span>
        </div>
        <div className="wp-card">
          {pairings.length === 0 ? (
            <div className="wp-empty">No pairing requests right now.</div>
          ) : (
            pairings.map((p) => (
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

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">History</h2>
          <span className="wp-section-aside">
            {history.length > 0
              ? `${history.length} ${history.length === 1 ? 'decision' : 'decisions'}`
              : 'No decisions yet'}
          </span>
        </div>
        <div className="wp-card">
          {history.length === 0 ? (
            <div className="wp-empty">No pairings yet. They’ll appear here after you approve or deny your first request.</div>
          ) : (
            history.map((h, i) => {
              const ok = h.decision === 'approved';
              return (
                <div className="wp-row" key={(h.pairingId || '') + ':' + i}>
                  <div className="wp-row-grow">
                    <div className="wp-row-title">{h.agentName || 'Unnamed agent'}</div>
                    <div className="wp-row-sub">{fmtTimestamp(h.decidedAt)}</div>
                  </div>
                  <span className="wp-pill" data-state={ok ? 'ready' : 'danger'}>
                    <span className="wp-pill-dot" />
                    <span className="wp-pill-label">{ok ? 'Approved' : 'Denied'}</span>
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>
    </>
  );
}
