'use client';

import { useEffect, useState } from 'react';
import PairingPromptCard from '../../components/PairingPromptCard';
import { getStatus, approvePairing, denyPairing } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

export default function PairingsPage() {
  const [pairings, setPairings] = useState([]);
  const [history, setHistory] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const data = await getStatus();
      setPairings(data.pendingPairings || []);
      // History: client-side only — we don't get historical entries from /status
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
    // Only the __new__ option present — add a fallback Default
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
      <div>
        <h1 className="wp-page-title">Pending pairings</h1>
        <p className="wp-page-sub">
          Approve or deny pairing requests from MCP agents.
        </p>
      </div>

      {error ? (
        <div className="wp-card">
          <div className="wp-muted">Error: {error.message}</div>
        </div>
      ) : null}

      <div className="wp-card">
        <h2>Waiting for review</h2>
        {pairings.length === 0 ? (
          <div className="wp-muted">No pairings waiting.</div>
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

      <div className="wp-card">
        <h2>History (this session)</h2>
        {history.length === 0 ? (
          <div className="wp-muted">No prior decisions in this session.</div>
        ) : (
          history.map((h, i) => (
            <div className="wp-row" key={(h.pairingId || '') + ':' + i}>
              <div className="wp-row-grow">
                <div style={{ fontWeight: 600 }}>{h.agentName}</div>
                <div className="wp-muted">{h.decision} at {h.decidedAt || 'just now'}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
