'use client';

import { useId, useMemo, useRef, useState } from 'react';
import ConfirmModal from '../../components/ConfirmModal';
import EmptyState from '../../components/EmptyState';
import ErrorCard from '../../components/ErrorCard';
import { SkeletonRow } from '../../components/Skeleton';
import { AddRuleForm, DecisionPill, relTime } from './GlobalListModal';

/**
 * AgentRulesPanel — the "Per-agent rules" card.
 *
 * Agent picker, then the picked agent's rules (`*` pinned first as "All
 * sites", the rest sorted by domain). Each rule has a Delete action behind a
 * ConfirmModal. The add form accepts `*` so an agent can get a default for
 * every site.
 *
 * Props:
 *   agents             — [{ key, name }]
 *   agentsLoading      — bool
 *   selectedAgentKey   — string ('' when none)
 *   onSelectAgent(key)
 *   rules              — [{ domain, decision, createdAt }]
 *   rulesLoading, rulesError, onRetry
 *   busy               — a per-agent write is in flight
 *   onAddRule({domain, decision}) → Promise<boolean>
 *   onDeleteRule(domain)          → Promise<boolean>
 */
export default function AgentRulesPanel({
  agents,
  agentsLoading,
  selectedAgentKey,
  onSelectAgent,
  rules,
  rulesLoading,
  rulesError,
  onRetry,
  busy,
  onAddRule,
  onDeleteRule,
}) {
  const reactId = useId();
  const selectId = `wp-agent-rules-select-${reactId}`;
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const addBtnRef = useRef(null);

  const selectedAgent = agents.find((a) => a.key === selectedAgentKey) || null;
  const agentName = selectedAgent ? selectedAgent.name : 'This agent';

  const sortedRules = useMemo(() => {
    const list = Array.isArray(rules) ? [...rules] : [];
    list.sort((a, b) => {
      if (a.domain === '*') return -1;
      if (b.domain === '*') return 1;
      return a.domain.localeCompare(b.domain);
    });
    return list;
  }, [rules]);

  async function handleAdd(values) {
    const ok = await onAddRule(values);
    if (ok) {
      setAddOpen(false);
      setTimeout(() => { try { addBtnRef.current && addBtnRef.current.focus(); } catch (_) { /* ignore */ } }, 0);
    }
    return ok;
  }

  async function handleConfirmDelete() {
    const rule = pendingDelete;
    setPendingDelete(null);
    if (rule) await onDeleteRule(rule.domain);
  }

  let body;
  if (!agentsLoading && agents.length === 0) {
    body = (
      <EmptyState
        variant="bare"
        body="No agents paired yet."
        action={<a href="/ui/agents/" className="wp-link">Go to Agents</a>}
      />
    );
  } else if (rulesError) {
    body = <ErrorCard title="Couldn’t load rules." error={rulesError} onRetry={onRetry} />;
  } else if (agentsLoading || (rulesLoading && sortedRules.length === 0)) {
    body = (
      <div>
        <SkeletonRow titleWidth="42%" subWidth="30%" showTrailing />
        <SkeletonRow titleWidth="50%" subWidth="35%" showTrailing />
      </div>
    );
  } else if (sortedRules.length === 0) {
    body = (
      <EmptyState variant="bare" body="No rules for this agent. Global rules and defaults apply." />
    );
  } else {
    body = (
      <div className="wp-sites-rule-list">
        {sortedRules.map((rule) => {
          const isAll = rule.domain === '*';
          return (
            <div key={rule.domain} className="wp-row">
              <div className="wp-row-grow">
                <div className="wp-row-title">
                  {isAll ? (
                    <>All sites <span className="wp-mono wp-secondary">*</span></>
                  ) : (
                    <span className="wp-sites-rule-domain">{rule.domain}</span>
                  )}
                </div>
                <div className="wp-row-sub">
                  <DecisionPill decision={rule.decision} />
                  {rule.createdAt ? (
                    <>
                      <span className="wp-row-sep">·</span>
                      <span>added {relTime(rule.createdAt)}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="wp-row-actions">
                <button
                  type="button"
                  className="wp-btn wp-btn-compact"
                  onClick={() => setPendingDelete(rule)}
                  disabled={busy}
                  aria-label={`Delete rule for ${isAll ? 'all sites' : rule.domain}`}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const hasAgents = agents.length > 0;

  return (
    <section className="wp-card wp-sites-card" aria-labelledby={`${selectId}-title`}>
      <div>
        <h2 id={`${selectId}-title`} className="wp-sites-card-title">Per-agent rules</h2>
        <p className="wp-sites-card-sub">Rules for one agent. They beat global rules for that agent only.</p>
      </div>

      {hasAgents ? (
        <div className="wp-sites-field">
          <label htmlFor={selectId} className="wp-sites-field-label">Agent</label>
          <select
            id={selectId}
            className="wp-select"
            value={selectedAgentKey}
            onChange={(e) => {
              setAddOpen(false);
              onSelectAgent(e.target.value);
            }}
          >
            {agents.map((a) => (
              <option key={a.key} value={a.key}>{a.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      {body}

      {hasAgents && selectedAgentKey && !rulesError ? (
        addOpen ? (
          <AddRuleForm
            allowWildcard
            hint="Use * to set this agent's default for every site."
            onSubmit={handleAdd}
            onCancel={() => {
              setAddOpen(false);
              setTimeout(() => { try { addBtnRef.current && addBtnRef.current.focus(); } catch (_) { /* ignore */ } }, 0);
            }}
            busy={busy}
            defaultDecision="allow"
            submitLabel="Add rule"
          />
        ) : (
          <div className="wp-sites-actions">
            <button
              ref={addBtnRef}
              type="button"
              className="wp-btn"
              onClick={() => setAddOpen(true)}
              disabled={busy}
            >
              + Add rule
            </button>
          </div>
        )
      ) : null}

      <ConfirmModal
        open={!!pendingDelete}
        title={pendingDelete ? `Remove rule for ${pendingDelete.domain === '*' ? 'all sites (*)' : pendingDelete.domain}?` : ''}
        body={`${agentName} falls back to global rules and defaults for this site. You can add it again here.`}
        confirmLabel="Delete"
        confirmDanger
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
