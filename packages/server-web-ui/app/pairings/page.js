'use client';

import { useEffect, useRef, useState } from 'react';
import PairingPromptCard from '../../components/PairingPromptCard';
import { createSequencedFetcher, getStatus, approvePairing, denyPairing } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

export default function PairingsPage() {
  const [pairings, setPairings] = useState([]);
  const [history, setHistory] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Tracks which pairing IDs have already been seen so we can flag freshly-
  // arrived rows for the slide-in + accent pulse animation. Cleared after the
  // animation duration so re-renders don't loop the effect.
  const [arrivingIds, setArrivingIds] = useState(() => new Set());
  const seenIdsRef = useRef(new Set());
  // See QOL Wave 6 H2 — guards REST refresh against WS-event clobber.
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
      // Clear after the slide-in + pulse duration so subsequent updates don't
      // replay the animation.
      setTimeout(() => {
        setArrivingIds((curr) => {
          // Only clear the IDs we set this round.
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
      const list = data.pendingPairings || [];
      markArrivals(list);
      setPairings(list);
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
        setHistory((h) => [{ ...evt.pairing, decision: 'approved' }, ...h]);
        refresh();
      }),
      client.subscribe('pairing_denied', (evt) => {
        if (cancelled) return;
        setHistory((h) => [{ ...evt.pairing, decision: 'denied' }, ...h]);
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

  return (
    <>
      <header className="wp-page-head">
        <div className="wp-page-kicker">
          <span className="wp-page-kicker-accent">§ 02</span>
          <span style={{ marginLeft: 12 }}>pairing handshake queue</span>
        </div>
        <h1 className="wp-page-title">Pairings.</h1>
        <p className="wp-page-sub">
          Approve or deny pairing requests from MCP agents. Each approval mints
          an API key and binds the agent to a Chrome profile of your choosing.
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
          <span>AWAITING REVIEW</span>
          <span className="wp-section-rule" />
          <span className="wp-section-aside">
            {pairings.length > 0 ? `${pairings.length} PENDING` : 'EMPTY'}
          </span>
        </div>
        <div className="wp-card">
          {pairings.length === 0 ? (
            <div className="wp-empty">no pairings — waiting</div>
          ) : (
            pairings.map((p) => (
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

      <section className="wp-section">
        <div className="wp-section-head">
          <span className="wp-section-num">§ 02</span>
          <span>SESSION LOG</span>
          <span className="wp-section-rule" />
          <span className="wp-section-aside">
            {history.length > 0 ? `${history.length} ENTRIES` : 'EMPTY'}
          </span>
        </div>
        <div className="wp-card">
          {history.length === 0 ? (
            <div className="wp-empty">no decisions yet — this session</div>
          ) : (
            history.map((h, i) => {
              const ok = h.decision === 'approved';
              return (
                <div className="wp-row" key={(h.pairingId || '') + ':' + i}>
                  <div className="wp-row-grow">
                    <div className="wp-row-title">{h.agentName || 'unnamed agent'}</div>
                    <div className="wp-row-sub">{h.decidedAt || 'just now'}</div>
                  </div>
                  <span className="wp-pill" data-state={ok ? 'active' : 'danger'}>
                    <span className="wp-pill-dot" />
                    {ok ? 'Approved' : 'Denied'}
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
