'use client';

import Link from 'next/link';
import { useId, useMemo } from 'react';
import EmptyState from '../../components/EmptyState';

/**
 * AgentRulesPanel — the compact "Per-agent rules" card.
 *
 * Just an agent picker and a one-line summary (`N rules` and, if present,
 * the `*` default). Actual rule management (add / delete) lives in
 * RulesModal (scope="agent"), opened via the Manage button.
 *
 * Props:
 *   agents             — [{ key, name }]
 *   agentsLoading      — bool
 *   selectedAgentKey   — string ('' when none)
 *   onSelectAgent(key)
 *   rules              — [{ domain, decision, createdAt }] for the selected agent
 *   rulesLoading       — bool
 *   onManage           — () => void, opens RulesModal for the selected agent
 */
export default function AgentRulesPanel({
  agents,
  agentsLoading,
  selectedAgentKey,
  onSelectAgent,
  rules,
  rulesLoading,
  onManage,
}) {
  const reactId = useId();
  const selectId = `wp-agent-rules-select-${reactId}`;

  const hasAgents = agents.length > 0;

  const summary = useMemo(() => {
    const list = Array.isArray(rules) ? rules : [];
    const count = list.length;
    const wildcard = list.find((r) => r.domain === '*');
    const base = `${count} ${count === 1 ? 'rule' : 'rules'}`;
    return wildcard ? `${base} · * = ${wildcard.decision === 'allow' ? 'Allow' : 'Block'}` : base;
  }, [rules]);

  return (
    <section className="wp-card wp-site-policy-card" aria-labelledby={`${selectId}-title`}>
      <div>
        <h2 id={`${selectId}-title`} className="wp-site-policy-card-title">Per-agent rules</h2>
        <p className="wp-site-policy-card-sub">Rules for one agent. They beat global rules for that agent only.</p>
      </div>

      {!agentsLoading && !hasAgents ? (
        <EmptyState
          variant="bare"
          body="No agents paired yet."
          action={<Link href="/agents/" className="wp-link">Go to Agents</Link>}
        />
      ) : (
        <>
          <div className="wp-site-policy-field">
            <label htmlFor={selectId} className="wp-site-policy-field-label">Agent</label>
            <select
              id={selectId}
              className="wp-select"
              value={selectedAgentKey}
              onChange={(e) => onSelectAgent(e.target.value)}
              disabled={agentsLoading}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          <div className="wp-site-policy-facts">
            {rulesLoading ? 'Loading…' : summary}
          </div>

          <div className="wp-site-policy-actions">
            <button
              type="button"
              className="wp-btn"
              onClick={onManage}
              disabled={!selectedAgentKey}
            >
              Manage
            </button>
          </div>
        </>
      )}
    </section>
  );
}
