'use client';

import { useEffect, useRef, useState } from 'react';
import StatusCard from '../components/StatusCard';
import ProfileStatusBadge, { NEEDS_SETUP_HINT } from '../components/ProfileStatusBadge';
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
        <div className="wp-page-kicker">
          <span className="wp-page-kicker-accent">§ HOME</span>
          <span style={{ marginLeft: 12 }}>real-time runtime telemetry</span>
        </div>
        <h1 className="wp-page-title">Mission Control.</h1>
        <p className="wp-page-sub">
          Live readout of the WebPilot server, the Chrome process it watches,
          and the agents currently authorized to drive your browser.
        </p>
      </header>

      {loading ? (
        <div className="wp-card">
          <div className="wp-empty">acquiring signal…</div>
        </div>
      ) : null}

      {!loading && error ? (
        <div className="wp-card">
          <div className="wp-section-head" style={{ marginBottom: 8 }}>
            <span className="wp-section-num">!!</span>
            <span style={{ color: 'var(--wp-danger)' }}>SIGNAL LOST</span>
          </div>
          <div className="wp-mono wp-secondary">{error.message}</div>
        </div>
      ) : null}

      {!loading ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <span className="wp-section-num">§ 01</span>
            <span>STATUS</span>
            <span className="wp-section-rule" />
            <span className="wp-section-aside">snapshot</span>
          </div>
          <div className="wp-instruments">
            <StatusCard
              title="SERVER"
              value="ONLINE"
              state="ok"
              detail={status?.networkMode ? 'BIND 0.0.0.0 · LAN' : 'BIND 127.0.0.1 · LOCAL'}
            />
            <StatusCard
              title="CHROME"
              value={chromeRunning === undefined ? '???' : chromeRunning ? 'RUN' : 'IDLE'}
              state={chromeRunning === undefined ? 'unknown' : chromeRunning ? 'ok' : 'warn'}
              mono
              detail={chromeRunning
                ? (chromeHasFlag ? 'DEBUG FLAG · ENABLED' : 'DEBUG FLAG · MISSING')
                : 'PROCESS · NOT DETECTED'}
            />
            <StatusCard
              title="EXTENSIONS"
              value={String(extensionsConnected).padStart(2, '0')}
              state={extensionsConnected > 0 ? 'ok' : 'warn'}
              mono
              detail={extensionsConnected > 0
                ? `${extensionsConnected} PROFILE${extensionsConnected === 1 ? '' : 'S'} · LIVE WS`
                : 'NO PROFILES · CONNECTED'}
            />
            <StatusCard
              title="PAIRINGS"
              value={String(pendingPairings).padStart(2, '0')}
              state={pendingPairings > 0 ? 'accent' : 'ok'}
              mono
              detail={pendingPairings > 0 ? 'AWAITING · APPROVAL' : 'QUEUE · EMPTY'}
            />
          </div>
        </section>
      ) : null}

      {!loading ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <span className="wp-section-num">§ 02</span>
            <span>CHROME PROCESS</span>
            <span className="wp-section-rule" />
            <span className="wp-section-aside">os-level</span>
          </div>
          <div className="wp-card">
            <div className="wp-kv">
              <div className="wp-kv-label">PROCESS</div>
              <div className="wp-kv-value">
                {chromeRunning
                  ? <>CHROME <span className="wp-kv-value-accent">PID {chromePid ?? 'unknown'}</span></>
                  : 'NOT DETECTED'}
              </div>
              <div className="wp-kv-label">DEBUG FLAG</div>
              <div className="wp-kv-value">
                {chromeRunning
                  ? (chromeHasFlag
                      ? <span style={{ color: 'var(--wp-success)' }}>ENABLED</span>
                      : <span style={{ color: 'var(--wp-warning)' }}>MISSING — extension cannot connect</span>)
                  : '—'}
              </div>
              <div className="wp-kv-label">USER DATA</div>
              <div className="wp-kv-value">{chromeUserDataDir || '—'}</div>
              <div className="wp-kv-label">PAIRED AGENTS</div>
              <div className="wp-kv-value">{String(pairedAgentCount).padStart(2, '0')}</div>
            </div>
          </div>
        </section>
      ) : null}

      {!loading && activeProfiles.length > 0 ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <span className="wp-section-num">§ 03</span>
            <span>ACTIVE PROFILES</span>
            <span className="wp-section-rule" />
            <span className="wp-section-aside">{activeProfiles.length} LIVE</span>
          </div>
          <div className="wp-card">
            {activeProfiles.map((p) => (
              <div className="wp-row" key={p.directoryName}>
                <div className="wp-row-grow">
                  <div className="wp-row-title">{p.displayName || p.directoryName}</div>
                  <div className="wp-row-sub">
                    {p.gaiaEmail || 'NO GOOGLE ACCOUNT'} · DIR {p.directoryName}
                  </div>
                </div>
                <ProfileStatusBadge status={p.webPilotStatus} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading && profiles.length > 0 ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <span className="wp-section-num">§ 04</span>
            <span>ALL PROFILES</span>
            <span className="wp-section-rule" />
            <span className="wp-section-aside">{profiles.length} KNOWN</span>
          </div>
          <div className="wp-card">
            {profiles.map((p) => (
              <div className="wp-row" key={p.directoryName}>
                <div className="wp-row-grow">
                  <div className="wp-row-title">{p.displayName || p.directoryName}</div>
                  <div className="wp-row-sub">{p.gaiaEmail || 'NO GOOGLE ACCOUNT'}</div>
                  {p.webPilotStatus === 'needs_setup' ? (
                    <div className="wp-muted" style={{ marginTop: 6, fontFamily: 'var(--wp-font-mono)', fontSize: 11, letterSpacing: '0.04em' }}>
                      {NEEDS_SETUP_HINT}
                    </div>
                  ) : null}
                </div>
                <ProfileStatusBadge status={p.webPilotStatus} />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {!loading ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <span className="wp-section-num">§ 05</span>
            <span>PAIRINGS</span>
            <span className="wp-section-rule" />
            <span className="wp-section-aside">
              {pendingPairings > 0 ? `${pendingPairings} PENDING` : 'NONE'}
            </span>
          </div>
          <div className="wp-card">
            {pendingPairings === 0 ? (
              <div className="wp-empty">no pairings — waiting</div>
            ) : (
              <>
                <div className="wp-muted" style={{ marginBottom: 12 }}>
                  {pendingPairings} agent{pendingPairings === 1 ? ' is' : 's are'} awaiting approval.
                </div>
                <a href="/ui/pairings/" className="wp-btn wp-btn-primary" style={{ textDecoration: 'none' }}>
                  Review pairings →
                </a>
              </>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
