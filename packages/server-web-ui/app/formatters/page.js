'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ErrorCard from '../../components/ErrorCard';
import HealthPill from '../../components/HealthPill';
import { SkeletonRow } from '../../components/Skeleton';
import { createSequencedFetcher, getFormatters } from '../../lib/api';
import { formatRelativeTime } from '../../lib/format';

/**
 * Formatters — observability list for accessibility-tree formatters.
 *
 * Two sections grouped by `source`:
 *   - "Loaded from remote"  → formatters fetched from the GitHub manifest.
 *   - "Custom"              → formatters loaded from the user's local
 *                             custom-formatters directory.
 *
 * Each row links to /ui/formatters/logs/?name=<name>, which renders the
 * per-formatter status panel + recent error ring-buffer entries.
 *
 * Refresh strategy: REST poll every 30s. The server doesn't broadcast a
 * `formatter_logs_updated` event yet (Wave B didn't ship one), so the
 * cheapest way to surface a freshly-flipped `unhealthy` is to re-fetch on
 * a quiet interval. The endpoint is trivial and localhost-only, so the
 * polling cost is negligible.
 */

const POLL_INTERVAL_MS = 30 * 1000;

function FormattersSkeleton() {
  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Formatters</h1>
        <p className="wp-page-sub">
          Accessibility-tree formatters and their workflows.
        </p>
      </header>
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Loaded from remote</h2>
        </div>
        <div className="wp-row-list">
          <SkeletonRow titleWidth="35%" subWidth="50%" showTrailing />
          <SkeletonRow titleWidth="40%" subWidth="45%" showTrailing />
        </div>
      </section>
    </>
  );
}

function FormatterRow({ f }) {
  const workflowCount = Array.isArray(f.workflows) ? f.workflows.length : 0;
  const workflowText = `${workflowCount} ${workflowCount === 1 ? 'workflow' : 'workflows'}`;
  const subParts = [];
  if (f.match) subParts.push(f.match);
  subParts.push(workflowText);

  const showLastError =
    f.health === 'unhealthy' && (f.lastErrorAt || (f.lastError && f.lastError.timestamp));
  const lastErrorAt = f.lastErrorAt || (f.lastError && f.lastError.timestamp);

  return (
    <a
      key={f.name}
      href={`/ui/formatters/logs/?name=${encodeURIComponent(f.name)}`}
      className="wp-row wp-row-link"
    >
      <div className="wp-row-grow">
        <div className="wp-row-title">
          {f.name}
          {f.version ? (
            <span
              style={{
                marginLeft: 'var(--s-2)',
                color: 'var(--wp-fg-muted)',
                fontWeight: 400,
                fontSize: 'var(--fs-small)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              v{f.version}
            </span>
          ) : null}
        </div>
        <div className="wp-row-sub">
          {subParts.map((part, i) => (
            <span key={i}>
              {i > 0 ? <span className="wp-row-sep">·</span> : null}
              {i === 0 && f.match ? <span className="wp-mono">{part}</span> : part}
            </span>
          ))}
        </div>
      </div>
      <div className="wp-row-actions" style={{ gap: 'var(--s-3)' }}>
        {showLastError ? (
          <span
            style={{
              fontFamily: 'var(--wp-font-sans)',
              fontSize: 'var(--fs-small)',
              color: 'var(--wp-fg-muted)',
              whiteSpace: 'nowrap',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            Last error: {formatRelativeTime(lastErrorAt)}
          </span>
        ) : null}
        <HealthPill health={f.health} />
      </div>
    </a>
  );
}

function FormattersSection({ title, items, emptyText }) {
  return (
    <section className="wp-section">
      <div className="wp-section-head">
        <h2 className="wp-section-title">{title}</h2>
        <span className="wp-section-aside">
          {items.length} {items.length === 1 ? 'formatter' : 'formatters'}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="wp-card">
          <div className="wp-empty" style={{ padding: 0 }}>
            {emptyText}
          </div>
        </div>
      ) : (
        <div className="wp-row-list">
          {items.map((f) => <FormatterRow key={f.name} f={f} />)}
        </div>
      )}
    </section>
  );
}

export default function FormattersPage() {
  const [formatters, setFormatters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getFormatters());
      if (isStale) return;
      setFormatters(Array.isArray(data && data.formatters) ? data.formatters : []);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const { remote, custom } = useMemo(() => {
    const r = [];
    const c = [];
    for (const f of formatters) {
      if (f.source === 'custom') c.push(f);
      else r.push(f);
    }
    // Sort each group: unhealthy first, then healthy, then unknown.
    // Within each health bucket, alpha by name.
    const healthRank = { unhealthy: 0, healthy: 1, unknown: 2 };
    const cmp = (a, b) => {
      const ra = healthRank[a.health] ?? 3;
      const rb = healthRank[b.health] ?? 3;
      if (ra !== rb) return ra - rb;
      return String(a.name).localeCompare(String(b.name));
    };
    r.sort(cmp);
    c.sort(cmp);
    return { remote: r, custom: c };
  }, [formatters]);

  if (loading) return <FormattersSkeleton />;

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Formatters</h1>
        <p className="wp-page-sub">
          Accessibility-tree formatters and their workflows.
        </p>
      </header>

      {error ? <ErrorCard title="Couldn’t load formatters." error={error} onRetry={refresh} /> : null}

      <FormattersSection
        title="Loaded from remote"
        items={remote}
        emptyText="No remote formatters loaded."
      />
      <FormattersSection
        title="Custom"
        items={custom}
        emptyText="No custom formatters loaded."
      />
    </>
  );
}
