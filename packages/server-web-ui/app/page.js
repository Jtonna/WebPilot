'use client';

import { useEffect, useState } from 'react';
import StatusCard from '../components/StatusCard';
import { apiFetch } from '../lib/api';

export default function HomePage() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await apiFetch('/api/ui/status');
        if (!cancelled) {
          setStatus(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          // Endpoint doesn't exist yet — show a friendly placeholder.
          setError(err);
          setStatus(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingPairings = status?.pendingPairings?.length ?? 0;
  const chromeRunning = status?.chrome?.running;
  const extensionsConnected = status?.connectedExtensions ?? 0;

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
            Live status unavailable (the <code>/api/ui/status</code> endpoint
            isn&apos;t wired up yet). Showing placeholder values.
          </div>
        </div>
      ) : null}

      {!loading ? (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <StatusCard
            title="Server"
            value="Running"
            state="ok"
            detail="Listening on localhost"
          />
          <StatusCard
            title="Chrome"
            value={chromeRunning === undefined ? 'Unknown' : chromeRunning ? 'Running' : 'Not running'}
            state={chromeRunning === undefined ? 'unknown' : chromeRunning ? 'ok' : 'warn'}
            detail={status?.chrome?.hasFlag ? 'Launched with debug flag' : 'Flag status unknown'}
          />
          <StatusCard
            title="Connected extensions"
            value={String(extensionsConnected)}
            state={extensionsConnected > 0 ? 'ok' : 'warn'}
            detail="One per Chrome profile"
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
