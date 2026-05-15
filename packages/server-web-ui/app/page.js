'use client';

import { useEffect, useRef, useState } from 'react';
import StatusCard from '../components/StatusCard';
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
  const extensionsConnected = (status?.connectedProfiles?.length) ?? 0;

  return (
    <>
      <div>
        <h1 className="wp-page-title">Dashboard</h1>
        <p className="wp-page-sub">Overview of the WebPilot server.</p>
      </div>

      {loading ? (
        <div className="wp-card">Loading...</div>
      ) : null}

      {!loading && error ? (
        <div className="wp-card">
          <div className="wp-muted">
            Live status unavailable: <code>{error.message}</code>
          </div>
        </div>
      ) : null}

      {!loading ? (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <StatusCard
            title="Server"
            value="Running"
            state="ok"
            detail={status?.networkMode ? 'LAN reachable' : 'Localhost only'}
          />
          <StatusCard
            title="Chrome"
            value={chromeRunning === undefined ? 'Unknown' : chromeRunning ? 'Running' : 'Not running'}
            state={chromeRunning === undefined ? 'unknown' : chromeRunning ? 'ok' : 'warn'}
            detail={status?.chrome?.hasFlag ? 'Launched with debug flag' : (chromeRunning ? 'Missing debug flag' : 'Flag status unknown')}
          />
          <StatusCard
            title="Connected extensions"
            value={String(extensionsConnected)}
            state={extensionsConnected > 0 ? 'ok' : 'warn'}
            detail={status?.connectedProfiles?.join(', ') || 'No profiles connected'}
          />
          <StatusCard
            title="Pending pairings"
            value={String(pendingPairings)}
            state={pendingPairings > 0 ? 'warn' : 'ok'}
            detail={pendingPairings > 0 ? 'Review on the Pairings page' : 'Nothing waiting'}
          />
        </div>
      ) : null}

      <div className="wp-card">
        <h2>Quick links</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li><a href="/ui/pairings/">Review pending pairings</a></li>
          <li><a href="/ui/profiles/">Manage Chrome profiles</a></li>
          <li><a href="/ui/agents/">Paired agents</a></li>
          <li><a href="/ui/settings/">Server settings</a></li>
        </ul>
      </div>
    </>
  );
}
