'use client';

import { useEffect, useRef, useState } from 'react';
import StatusCard from '../components/StatusCard';
import ProfileStatusBadge, { NEEDS_SETUP_HINT } from '../components/ProfileStatusBadge';
import RevealSection from '../components/RevealSection';
import { createSequencedFetcher, getStatus } from '../lib/api';
import { createUiEventsClient } from '../lib/ws';

export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  // Guards against stale REST refresh responses arriving AFTER a newer
  // WS-event-triggered refresh has already updated state. See QOL Wave 6 H2.
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }

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

  const pendingPairings = status?.pendingPairings?.length ?? 0;
  const chromeRunning = status?.chrome?.running;
  const chromePid = status?.chrome?.browserPid;
  const chromeHasFlag = status?.chrome?.hasFlag;
  const chromeUserDataDir = status?.chrome?.userDataDir;
  const profiles = status?.profiles ?? [];
  const activeProfiles = profiles.filter((p) => p.webPilotStatus === 'active');
  const extensionsConnected = activeProfiles.length;
  const pairedAgentCount = status?.pairedAgents?.length ?? 0;

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
          <div className="wp-instruments">
            <StatusCard
              title="Server"
              value="Online"
              state="ok"
              detail={status?.networkMode ? 'Bound to 0.0.0.0 · LAN' : 'Bound to 127.0.0.1'}
            />
            <StatusCard
              title="Chrome"
              value={chromeRunning === undefined ? 'Unknown' : chromeRunning ? 'Running' : 'Idle'}
              state={chromeRunning === undefined ? 'unknown' : chromeRunning ? 'ok' : 'warn'}
              detail={chromeRunning
                ? (chromeHasFlag ? 'Debug flag enabled' : 'Debug flag missing')
                : 'Not detected'}
            />
            <StatusCard
              title="Extensions"
              value={extensionsConnected}
              state={extensionsConnected > 0 ? 'ok' : 'warn'}
              detail={extensionsConnected > 0
                ? `${extensionsConnected} profile${extensionsConnected === 1 ? '' : 's'} connected`
                : 'No profiles connected'}
            />
            <StatusCard
              title="Pairings"
              value={pendingPairings}
              state={pendingPairings > 0 ? 'accent' : 'ok'}
              detail={pendingPairings > 0 ? 'Awaiting approval' : 'Nothing pending'}
            />
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

      {!loading ? (
        <RevealSection className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Pairings</h2>
            <span className="wp-section-aside">
              {pendingPairings > 0 ? `${pendingPairings} pending` : 'None pending'}
            </span>
          </div>
          <div className="wp-card">
            {pendingPairings === 0 ? (
              <div className="wp-empty">Nothing waiting for approval.</div>
            ) : (
              <>
                <div className="wp-secondary" style={{ marginBottom: 16 }}>
                  {pendingPairings} agent{pendingPairings === 1 ? ' is' : 's are'} awaiting approval.
                </div>
                <a href="/ui/pairings/" className="wp-btn wp-btn-primary" style={{ textDecoration: 'none' }}>
                  Review pairings
                </a>
              </>
            )}
          </div>
        </RevealSection>
      ) : null}
    </>
  );
}
