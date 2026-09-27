'use client';

import { useId, useState } from 'react';
import ConfirmModal from '../../components/ConfirmModal';
import TypedConfirmModal from '../../components/TypedConfirmModal';
import EmptyState from '../../components/EmptyState';
import ErrorCard from '../../components/ErrorCard';
import Pill from '../../components/Pill';
import SectionToolbar from '../../components/SectionToolbar';
import { SkeletonRow } from '../../components/Skeleton';
import { formatRelativeTime } from '../../lib/format';

const SOURCE_LABELS = {
  agent_rule: 'Agent rule',
  global_user: 'Your global rule',
  global_site_blocklist: 'Signed block list',
  default: 'No rule (allowed by default)',
};

export function eventKey(entry) {
  return `${entry.agentKey}|${entry.domain}`;
}

function toIso(value) {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/**
 * SiteEventLog — "Site access log" table: one row per agent + domain,
 * newest last-seen first, with per-agent Allow / Revoke actions.
 *
 * Allow asks for a typed random confirmation code (it can punch through a
 * global block); Revoke is a plain confirm and only affects that agent.
 *
 * Props:
 *   agents                 — [{ key, name }] for the agent filter
 *   agentFilter, decisionFilter, onAgentFilterChange, onDecisionFilterChange
 *   entries, loading, error, onRetry
 *   hasMore, loadingMore, onLoadMore
 *   eventBusyKey           — `${agentKey}|${domain}` of the row being written
 *   onAllow(entry), onRevoke(entry) → Promise
 */
export default function SiteEventLog({
  agents,
  agentFilter,
  decisionFilter,
  onAgentFilterChange,
  onDecisionFilterChange,
  entries,
  loading,
  error,
  onRetry,
  hasMore,
  loadingMore,
  onLoadMore,
  eventBusyKey,
  onAllow,
  onRevoke,
}) {
  const reactId = useId();
  const agentSelectId = `wp-site-events-agent-${reactId}`;
  const decisionSelectId = `wp-site-events-decision-${reactId}`;
  const [pendingAllow, setPendingAllow] = useState(null);
  const [pendingRevoke, setPendingRevoke] = useState(null);

  const filtered = !!(agentFilter || decisionFilter);
  const hasRows = entries.length > 0;

  let content;
  if (loading && !hasRows) {
    content = (
      <div className="wp-row-list">
        <SkeletonRow titleWidth="45%" subWidth="35%" showTrailing />
        <SkeletonRow titleWidth="52%" subWidth="40%" showTrailing />
        <SkeletonRow titleWidth="38%" subWidth="32%" showTrailing />
      </div>
    );
  } else if (!hasRows && !error) {
    content = (
      <EmptyState
        body={filtered
          ? 'No entries match these filters.'
          : 'No site checks yet. They’ll appear here after an agent opens a site.'}
      />
    );
  } else if (hasRows) {
    content = (
      <table className="wp-table wp-site-events">
        <thead>
          <tr>
            <th scope="col" className="wp-site-events-col-domain">Domain</th>
            <th scope="col" className="wp-site-events-col-agent">Agent</th>
            <th scope="col" className="wp-site-events-col-status">Status</th>
            <th scope="col" className="wp-site-events-col-seen">Last seen</th>
            <th scope="col" className="wp-site-events-col-action">Action</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const key = eventKey(entry);
            const name = entry.agentName || 'Unnamed agent';
            const pending = entry.agentRuleDecision || entry.decision;
            const ruleDiffers = !!entry.agentRuleDecision && entry.agentRuleDecision !== entry.decision;
            const rowBusy = eventBusyKey === key;
            const sourceLabel = SOURCE_LABELS[entry.source] || entry.source || 'Unknown';
            const showMatched = entry.matchedDomain && entry.matchedDomain !== entry.domain;
            return (
              <tr key={key}>
                <td data-label="Domain">
                  <div className="wp-site-events-domain">{entry.domain}</div>
                  <div className="wp-site-events-sub">
                    {sourceLabel}
                    {showMatched ? <> · matched <span className="wp-mono">{entry.matchedDomain}</span></> : null}
                    {typeof entry.hitCount === 'number'
                      ? ` · ${entry.hitCount} ${entry.hitCount === 1 ? 'hit' : 'hits'}`
                      : null}
                  </div>
                </td>
                <td data-label="Agent">
                  <a href={`/ui/agents/?agent=${encodeURIComponent(entry.agentKey)}`} className="wp-link">
                    {name}
                  </a>
                </td>
                <td data-label="Status">
                  <span className="wp-site-events-status">
                    {entry.decision === 'allow'
                      ? <Pill state="active" label="Approved" />
                      : <Pill state="danger" label="Blocked" />}
                  </span>
                  {ruleDiffers ? (
                    <div className="wp-site-events-hint">
                      Agent rule: {entry.agentRuleDecision === 'allow' ? 'Allow' : 'Block'} · applies on next visit
                    </div>
                  ) : null}
                </td>
                <td data-label="Last seen" className="wp-site-events-seen">
                  <span title={toIso(entry.lastSeenAt)}>{formatRelativeTime(entry.lastSeenAt)}</span>
                </td>
                <td data-label="Action" className="wp-site-events-action">
                  {entry.actionable === false ? (
                    <span className="wp-muted">IP or local host · use a * rule</span>
                  ) : pending === 'allow' ? (
                    <button
                      type="button"
                      className="wp-btn wp-btn-compact"
                      onClick={() => setPendingRevoke(entry)}
                      disabled={rowBusy}
                    >
                      {rowBusy ? 'Saving…' : 'Revoke for this agent'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="wp-btn wp-btn-compact"
                      onClick={() => setPendingAllow(entry)}
                      disabled={rowBusy}
                    >
                      {rowBusy ? 'Saving…' : 'Allow for this agent'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  } else {
    content = null;
  }

  const allowName = pendingAllow ? (pendingAllow.agentName || 'Unnamed agent') : '';
  const revokeName = pendingRevoke ? (pendingRevoke.agentName || 'Unnamed agent') : '';

  return (
    <section className="wp-section">
      <div className="wp-section-head">
        <h2 className="wp-section-title">Site access log</h2>
        <span className="wp-section-aside">
          {hasRows ? `${entries.length}${hasMore ? '+' : ''} ${entries.length === 1 ? 'entry' : 'entries'}` : ''}
        </span>
      </div>

      <SectionToolbar
        left={(
          <div className="wp-site-policy-actions" style={{ gap: 'var(--s-3)' }}>
            <label htmlFor={agentSelectId} className="wp-site-policy-field-label">Agent</label>
            <select
              id={agentSelectId}
              className="wp-select"
              style={{ width: 'auto' }}
              value={agentFilter}
              onChange={(e) => onAgentFilterChange(e.target.value)}
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.key} value={a.key}>{a.name}</option>
              ))}
            </select>
            <label htmlFor={decisionSelectId} className="wp-site-policy-field-label">Decision</label>
            <select
              id={decisionSelectId}
              className="wp-select"
              style={{ width: 'auto' }}
              value={decisionFilter}
              onChange={(e) => onDecisionFilterChange(e.target.value)}
            >
              <option value="">All</option>
              <option value="allow">Allowed</option>
              <option value="block">Blocked</option>
            </select>
          </div>
        )}
        right={null}
      />

      {error ? (
        <ErrorCard title="Couldn’t load the site access log." error={error} onRetry={onRetry} />
      ) : null}

      {content}

      {hasRows && hasMore ? (
        <div className="wp-site-events-footer">
          <button
            type="button"
            className="wp-btn"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}

      <TypedConfirmModal
        open={!!pendingAllow}
        title={pendingAllow ? `Allow ${pendingAllow.domain} for ${allowName}?` : ''}
        body={pendingAllow
          ? `${allowName} will be able to open ${pendingAllow.domain} even if a global rule blocks it. Other agents are unaffected; revoke it from this log or Per-agent rules.`
          : ''}
        confirmLabel="Allow for this agent"
        confirmDanger
        onConfirm={() => {
          const entry = pendingAllow;
          setPendingAllow(null);
          if (entry) onAllow(entry);
        }}
        onCancel={() => setPendingAllow(null)}
      />

      <ConfirmModal
        open={!!pendingRevoke}
        title={pendingRevoke ? `Revoke ${pendingRevoke.domain} for this agent?` : ''}
        body={pendingRevoke
          ? `Only ${revokeName} will be blocked from ${pendingRevoke.domain}; other agents and global rules are unchanged. You can allow it again from this log.`
          : ''}
        confirmLabel="Revoke for this agent"
        confirmDanger
        onConfirm={() => {
          const entry = pendingRevoke;
          setPendingRevoke(null);
          if (entry) onRevoke(entry);
        }}
        onCancel={() => setPendingRevoke(null)}
      />
    </section>
  );
}
