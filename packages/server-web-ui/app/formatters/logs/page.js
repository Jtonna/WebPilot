'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import BackLink from '../../../components/BackLink';
import ErrorCard from '../../../components/ErrorCard';
import { SkeletonRow } from '../../../components/Skeleton';
import { createSequencedFetcher, getFormatterLogs } from '../../../lib/api';
import { formatRelativeTime } from '../../../lib/format';

/**
 * Per-formatter logs page (/ui/formatters/logs/?name=<name>).
 *
 * Reads the formatter name from `?name=` rather than a `[name]` dynamic
 * segment so the page works with Next.js `output: 'export'` (the static
 * file server doesn't fall back to index.html for unmatched routes).
 *
 * Layout:
 *   1. BackLink → /ui/formatters/
 *   2. Page head: title "Logs · <name>" + subhead.
 *   3. Status panel (.wp-inset-group) — health pill + success/error counts
 *      + last-success / last-error timestamps.
 *   4. "Recent errors" section — newest-first list of ring-buffer entries,
 *      each showing phase + workflow, the error message, and (collapsed)
 *      stack + params.
 *
 * Refresh: REST poll every 15s while open (no formatter event in WS yet).
 */

const POLL_INTERVAL_MS = 15 * 1000;

const HEALTH_META = {
  healthy:   { state: 'info',    label: 'Healthy' },
  unhealthy: { state: 'danger',  label: 'Unhealthy' },
  unknown:   { state: 'unknown', label: 'Not yet used' },
};

function HealthPill({ health }) {
  const meta = HEALTH_META[health] || HEALTH_META.unknown;
  return (
    <span className="wp-pill" data-state={meta.state}>
      <span className="wp-pill-dot" />
      <span className="wp-pill-label">{meta.label}</span>
    </span>
  );
}

export default function FormatterLogsPage() {
  return (
    <Suspense fallback={<LogsSkeleton />}>
      <FormatterLogsPageInner />
    </Suspense>
  );
}

function LogsSkeleton({ name = '' }) {
  return (
    <>
      <BackLink href="/ui/formatters/" label="Formatters" />
      <header className="wp-page-head">
        <h1 className="wp-page-title">{name ? `Logs · ${name}` : 'Logs'}</h1>
      </header>
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Status</h2>
        </div>
        <div className="wp-inset-group">
          <SkeletonRow titleWidth="40%" subWidth="60%" />
          <SkeletonRow titleWidth="35%" subWidth="55%" />
        </div>
      </section>
    </>
  );
}

function StatusPanel({ status }) {
  if (!status) return null;
  const successCount = status.successCount || 0;
  const errorCount = status.errorCount || 0;
  const total = successCount + errorCount;
  const errorRate = total > 0 ? Math.round((errorCount / total) * 100) : 0;
  return (
    <section className="wp-section">
      <div className="wp-section-head">
        <h2 className="wp-section-title">Status</h2>
      </div>
      <div className="wp-inset-group">
        <div className="wp-inset-row">
          <div className="wp-inset-row-grow">
            <div className="wp-inset-row-title">Health</div>
          </div>
          <HealthPill health={status.health} />
        </div>
        <div className="wp-inset-row">
          <div className="wp-inset-row-grow">
            <div className="wp-inset-row-title">Invocations</div>
            <div className="wp-inset-row-sub">
              {successCount} {successCount === 1 ? 'success' : 'successes'} ·
              {' '}{errorCount} {errorCount === 1 ? 'error' : 'errors'}
              {total > 0 ? ` · ${errorRate}% error rate` : ''}
            </div>
          </div>
        </div>
        <div className="wp-inset-row">
          <div className="wp-inset-row-grow">
            <div className="wp-inset-row-title">Last success</div>
            <div className="wp-inset-row-sub">
              {formatRelativeTime(status.lastSuccessAt)}
            </div>
          </div>
        </div>
        <div className="wp-inset-row">
          <div className="wp-inset-row-grow">
            <div className="wp-inset-row-title">Last error</div>
            <div className="wp-inset-row-sub">
              {formatRelativeTime(status.lastErrorAt)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function LogEntry({ log }) {
  const [paramsOpen, setParamsOpen] = useState(false);
  const [stackOpen, setStackOpen] = useState(false);
  const phaseLabel = log.workflow
    ? `${log.phase || 'workflow'} · ${log.workflow}`
    : (log.phase || 'format');

  return (
    <div className="wp-row" style={{ alignItems: 'flex-start', cursor: 'default' }}>
      <div className="wp-row-grow" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        <div
          style={{
            display: 'flex',
            gap: 'var(--s-3)',
            alignItems: 'baseline',
            flexWrap: 'wrap',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--wp-font-sans)',
              fontSize: 'var(--fs-small)',
              color: 'var(--wp-fg-muted)',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {formatRelativeTime(log.timestamp)}
          </span>
          <span
            style={{
              fontFamily: 'var(--wp-font-mono)',
              fontSize: 'var(--fs-mono-small)',
              color: 'var(--wp-fg-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {phaseLabel}
          </span>
        </div>
        {log.message ? (
          <code className="wp-code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {log.message}
          </code>
        ) : null}
        {(log.stack || log.params) ? (
          <div
            style={{
              display: 'flex',
              gap: 'var(--s-3)',
              fontSize: 'var(--fs-small)',
            }}
          >
            {log.stack ? (
              <button
                type="button"
                className="wp-link"
                onClick={() => setStackOpen((v) => !v)}
              >
                {stackOpen ? 'Hide stack' : 'Show stack'}
              </button>
            ) : null}
            {log.params ? (
              <button
                type="button"
                className="wp-link"
                onClick={() => setParamsOpen((v) => !v)}
              >
                {paramsOpen ? 'Hide params' : 'Show params'}
              </button>
            ) : null}
          </div>
        ) : null}
        {stackOpen && log.stack ? (
          <code
            className="wp-code"
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--wp-fg-secondary)',
            }}
          >
            {log.stack}
          </code>
        ) : null}
        {paramsOpen && log.params ? (
          <code className="wp-code" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {JSON.stringify(log.params, null, 2)}
          </code>
        ) : null}
      </div>
    </div>
  );
}

function FormatterLogsPageInner() {
  const searchParams = useSearchParams();
  const name = searchParams.get('name') || '';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }

  async function refresh() {
    if (!name) {
      setLoading(false);
      return;
    }
    try {
      const { data: payload, isStale } = await fetcherRef.current.fetch(
        () => getFormatterLogs(name, 50)
      );
      if (isStale) return;
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    if (!name) return undefined;
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  if (!name) {
    return (
      <>
        <BackLink href="/ui/formatters/" label="Formatters" />
        <header className="wp-page-head">
          <h1 className="wp-page-title">Logs</h1>
        </header>
        <ErrorCard
          title="No formatter selected."
          error="Open this page from /ui/formatters/ to pick a formatter."
        />
      </>
    );
  }

  if (loading && !data) return <LogsSkeleton name={name} />;

  const status = data && data.status;
  const logs = Array.isArray(data && data.logs) ? data.logs : [];

  return (
    <>
      <BackLink href="/ui/formatters/" label="Formatters" />
      <header className="wp-page-head">
        <h1 className="wp-page-title">Logs · {name}</h1>
        <p className="wp-page-sub">
          Recent errors and success metrics for the {name} formatter.
        </p>
      </header>

      {error ? <ErrorCard title="Couldn’t load logs." error={error} onRetry={refresh} /> : null}

      <StatusPanel status={status} />

      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Recent errors</h2>
          <span className="wp-section-aside">
            {logs.length} {logs.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        {logs.length === 0 ? (
          <div className="wp-card">
            <div className="wp-empty" style={{ padding: 0 }}>
              No errors recorded yet. Healthy formatters won’t appear here
              until something throws.
            </div>
          </div>
        ) : (
          <div className="wp-row-list">
            {logs.map((log, i) => (
              <LogEntry key={`${log.timestamp || 'i'}-${i}`} log={log} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
