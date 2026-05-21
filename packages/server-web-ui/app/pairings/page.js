'use client';

import { useEffect, useRef, useState } from 'react';
import ErrorCard from '../../components/ErrorCard';
import PairingPromptCard from '../../components/PairingPromptCard';
import { SkeletonRow } from '../../components/Skeleton';
import { useToast } from '../../components/ToastRegion';
import EmptyState from '../../components/EmptyState';
import Pill from '../../components/Pill';
import {
  createSequencedFetcher,
  getStatus,
  approvePairing,
  denyPairing,
  getPairingHistory,
} from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';
import { formatRelativeTime, profileLabel, profileOptions } from '../../lib/format';

/**
 * Pairings — pending approvals + decision history.
 *
 * Two sections:
 *   1. Awaiting review — identical inline approve/deny card as Dashboard.
 *   2. History         — server-backed, cursor-paginated. Initial page is the
 *                        most recent 50 terminal decisions; "Load 50 more"
 *                        button appears when more exist.
 */
const HISTORY_PAGE_SIZE = 50;

export default function PairingsPage() {
  const [pairings, setPairings] = useState([]);
  const [pairingsLoading, setPairingsLoading] = useState(true);
  const [history, setHistory]   = useState([]);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState(null);
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
    } finally {
      setPairingsLoading(false);
    }
  }

  async function loadInitialHistory() {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const { entries, nextCursor } = await getPairingHistory({ limit: HISTORY_PAGE_SIZE });
      setHistory(entries || []);
      setHistoryCursor(nextCursor || null);
    } catch (err) {
      setHistoryError(err);
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadMoreHistory() {
    if (!historyCursor || historyLoadingMore) return;
    setHistoryLoadingMore(true);
    try {
      const { entries, nextCursor } = await getPairingHistory({
        cursor: historyCursor,
        limit: HISTORY_PAGE_SIZE,
      });
      setHistory((h) => [...h, ...(entries || [])]);
      setHistoryCursor(nextCursor || null);
    } catch (err) {
      toast.error(err.message || 'Couldn’t load more history.');
    } finally {
      setHistoryLoadingMore(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    refresh();
    loadInitialHistory();
    const client = createUiEventsClient();
    client.connect();
    const unsubs = [
      client.subscribe('pairing_requested', () => !cancelled && refresh()),
      client.subscribe('pairing_approved', (evt) => {
        if (cancelled) return;
        // Prepend the new entry to local history; trim to the first page size
        // to avoid the in-memory list ballooning. Cursor unchanged.
        if (evt && evt.pairing) {
          setHistory((h) => [evt.pairing, ...h].slice(0, HISTORY_PAGE_SIZE));
        }
        refresh();
      }),
      client.subscribe('pairing_denied', (evt) => {
        if (cancelled) return;
        if (evt && evt.pairing) {
          setHistory((h) => [evt.pairing, ...h].slice(0, HISTORY_PAGE_SIZE));
        }
        refresh();
      }),
    ];
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u && u());
      client.disconnect();
    };
  }, []);

  const profileOptionsList = profileOptions(profiles);

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

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Pairings</h1>
        <p className="wp-page-sub">
          Approve or deny pairing requests, and review what you’ve decided.
        </p>
      </header>

      {error ? <ErrorCard error={error} /> : null}

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Awaiting review</h2>
          <span className="wp-section-aside">
            {pairingsLoading
              ? ''
              : pairings.length > 0
                ? `${pairings.length} pending`
                : 'Nothing pending'}
          </span>
        </div>
        <div className="wp-inset-group">
          {pairingsLoading ? (
            <>
              <SkeletonRow titleWidth="55%" subWidth="35%" showTrailing />
              <SkeletonRow titleWidth="48%" subWidth="42%" showTrailing />
            </>
          ) : pairings.length === 0 ? (
            <EmptyState variant="bare" body="Nothing pending right now." />
          ) : (
            pairings.map((p) => (
              <PairingPromptCard
                key={p.pairingId}
                pairing={p}
                profileOptions={profileOptionsList}
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
            {historyLoading
              ? ''
              : history.length > 0
                ? `${history.length} ${history.length === 1 ? 'decision' : 'decisions'}${historyCursor ? '+' : ''}`
                : 'No decisions yet'}
          </span>
        </div>
        {historyError ? (
          <ErrorCard
            title="Couldn’t load history."
            error={historyError}
            onRetry={loadInitialHistory}
          />
        ) : historyLoading ? (
          <div className="wp-inset-group">
            <SkeletonRow titleWidth="50%" subWidth="30%" showTrailing />
            <SkeletonRow titleWidth="42%" subWidth="28%" showTrailing />
            <SkeletonRow titleWidth="55%" subWidth="35%" showTrailing />
            <SkeletonRow titleWidth="38%" subWidth="32%" showTrailing />
          </div>
        ) : history.length === 0 ? (
          <EmptyState body="No pairings yet. They’ll appear here after you approve or deny your first request." />
        ) : (
          <>
            <div className="wp-row-list">
              {history.map((h, i) => {
                const denied = h.status === 'denied';
                const expired = h.status === 'expired';
                let label = 'Approved';
                let state = 'ready';
                if (denied) { label = 'Denied'; state = 'danger'; }
                else if (expired) { label = 'Expired'; state = 'warn'; }
                // Only approved entries are ever bound to a profile. Denied
                // and expired pairings were never minted into an API key, so
                // there's no profile association to surface.
                const profileText = h.status === 'approved' && h.profileId
                  ? profileLabel(profiles, h.profileId)
                  : null;
                return (
                  <div className="wp-row" key={(h.pairingId || '') + ':' + i}>
                    <div className="wp-row-grow">
                      <div className="wp-row-title">{h.agentName || 'Unnamed agent'}</div>
                      <div className="wp-row-sub">
                        <span>{formatRelativeTime(h.decidedAt || h.createdAt)}</span>
                        {profileText ? (
                          <>
                            <span className="wp-row-sep">·</span>
                            <span>
                              paired to{' '}
                              <strong style={{ color: 'var(--wp-fg)', fontWeight: 500 }}>
                                {profileText}
                              </strong>
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <Pill state={state} label={label} />
                  </div>
                );
              })}
            </div>
            {historyCursor ? (
              <div style={{ marginTop: 'var(--s-3)', display: 'flex', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="wp-btn wp-btn-compact"
                  onClick={loadMoreHistory}
                  disabled={historyLoadingMore}
                >
                  {historyLoadingMore ? 'Loading…' : 'Load 50 more'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}
