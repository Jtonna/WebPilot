'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ErrorCard from '../../components/ErrorCard';
import Toggle from '../../components/Toggle';
import { SkeletonRow } from '../../components/Skeleton';
import { useToast } from '../../components/ToastRegion';
import EmptyState from '../../components/EmptyState';
import Pill from '../../components/Pill';
import SectionToolbar from '../../components/SectionToolbar';
import {
  createSequencedFetcher,
  getStatus,
  getSites,
  createSiteRule,
  deleteSiteRule,
  getAgentSiteOverrides,
  setAgentSiteOverride,
  deleteAgentSiteOverride,
  toggleBaselineBlocklist,
} from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';
import { formatRelativeTime } from '../../lib/format';

/**
 * Sites — admin surface for the WebPilot site policy model.
 *
 * Three sections:
 *   1. Global Blocklist    — bundled-pack toggle, version/last-fetch/domain-count
 *                            metadata, "What's in the pack?" disclosure listing
 *                            baseline domains read-only.
 *   2. Custom rules        — user-set (domain, decision) rows. "+ Add rule"
 *                            opens an inline form. All rows deletable.
 *   3. Per-agent overrides — agent dropdown, then the picked agent's
 *                            agent_site_overrides list. Same +Add / Delete
 *                            pattern; deletes always allowed (overrides only
 *                            exist as user actions).
 *
 * Live updates via the `sites_changed` UI WebSocket event — every successful
 * write on the server side broadcasts it and the page refetches.
 */

// Lightweight domain syntactic check used in the +Add forms to render a
// normalization preview without round-tripping the server. The real
// validation still happens on the server (site-policy.normalizeDomain) — this
// is for the live preview only.
function previewNormalizedDomain(input) {
  if (typeof input !== 'string') return '';
  let raw = input.trim().toLowerCase();
  if (raw.length === 0) return '';
  // Strip a scheme if present.
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Drop everything past the first slash (path) or colon (port).
  raw = raw.split('/')[0].split(':')[0];
  if (raw.startsWith('www.')) raw = raw.slice(4);
  return raw;
}

function decisionPill(decision) {
  if (decision === 'allow') {
    return <Pill state="ready" label="Allow" />;
  }
  return <Pill state="danger" label="Block" />;
}


function AddRuleForm({ onSubmit, onCancel, busy, defaultDecision = 'block' }) {
  const [domain, setDomain] = useState('');
  const [decision, setDecision] = useState(defaultDecision);
  const preview = previewNormalizedDomain(domain);
  const canSubmit = preview.length > 0 && preview.includes('.') && !busy;
  return (
    <form
      className="wp-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit({ domain: preview, decision });
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
        <label htmlFor="wp-sites-add-domain" className="wp-secondary" style={{ fontSize: 'var(--fs-small)' }}>
          Domain
        </label>
        <input
          id="wp-sites-add-domain"
          className="wp-input"
          type="text"
          autoComplete="off"
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          autoFocus
        />
        {preview && preview !== domain.trim().toLowerCase() ? (
          <span className="wp-secondary" style={{ fontSize: 'var(--fs-small)' }}>
            Will be saved as <strong style={{ color: 'var(--wp-fg)' }}>{preview}</strong>
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-4)' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)', cursor: 'pointer' }}>
          <input
            type="radio"
            name="wp-sites-add-decision"
            value="allow"
            checked={decision === 'allow'}
            onChange={() => setDecision('allow')}
          />
          <span>Allow</span>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)', cursor: 'pointer' }}>
          <input
            type="radio"
            name="wp-sites-add-decision"
            value="block"
            checked={decision === 'block'}
            onChange={() => setDecision('block')}
          />
          <span>Block</span>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 'var(--s-2)', justifyContent: 'flex-end' }}>
        <button type="button" className="wp-btn wp-btn-compact" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="wp-btn wp-btn-primary" disabled={!canSubmit}>
          {busy ? 'Saving…' : 'Add rule'}
        </button>
      </div>
    </form>
  );
}

function GlobalRuleRow({ rule, onDelete, busy }) {
  return (
    <div className="wp-row">
      <div className="wp-row-grow">
        <div className="wp-row-title">{rule.domain}</div>
        <div className="wp-row-sub">
          <span>{decisionPill(rule.decision)}</span>
          {rule.updatedAt ? (
            <>
              <span className="wp-row-sep">·</span>
              <span>updated {formatRelativeTime(rule.updatedAt)}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="wp-row-actions">
        <button
          type="button"
          className="wp-btn wp-btn-compact"
          onClick={() => onDelete(rule)}
          disabled={busy}
          title="Remove this rule"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function OverrideRow({ override, onDelete, busy }) {
  return (
    <div className="wp-row">
      <div className="wp-row-grow">
        <div className="wp-row-title">{override.domain}</div>
        <div className="wp-row-sub">
          <span>{decisionPill(override.decision)}</span>
          {override.createdAt ? (
            <>
              <span className="wp-row-sep">·</span>
              <span>added {formatRelativeTime(override.createdAt)}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="wp-row-actions">
        <button
          type="button"
          className="wp-btn wp-btn-compact"
          onClick={() => onDelete(override)}
          disabled={busy}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export default function SitesPage() {
  const toast = useToast();
  // Global rules + baseline summary, from /api/ui/sites.
  const [sitesData, setSitesData] = useState({ globalRules: [], baseline: null });
  const [sitesLoading, setSitesLoading] = useState(true);
  const [sitesError, setSitesError] = useState(null);
  const [addRuleOpen, setAddRuleOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sitesFetcher = useRef(null);
  if (sitesFetcher.current === null) {
    sitesFetcher.current = createSequencedFetcher();
  }

  // Agents list (for the per-agent overrides dropdown), from /api/ui/status.
  const [agents, setAgents] = useState([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedAgentKey, setSelectedAgentKey] = useState('');

  // Overrides for the currently-selected agent.
  const [overrides, setOverrides] = useState([]);
  const [overridesLoading, setOverridesLoading] = useState(false);
  const [overridesError, setOverridesError] = useState(null);
  const [addOverrideOpen, setAddOverrideOpen] = useState(false);
  const overridesFetcher = useRef(null);
  if (overridesFetcher.current === null) {
    overridesFetcher.current = createSequencedFetcher();
  }

  async function refreshSites() {
    try {
      const { data, isStale } = await sitesFetcher.current.fetch(() => getSites());
      if (isStale) return;
      setSitesData({
        globalRules: Array.isArray(data.globalRules) ? data.globalRules : [],
        baseline: data.baseline || null,
      });
      setSitesError(null);
    } catch (err) {
      setSitesError(err);
    } finally {
      setSitesLoading(false);
    }
  }

  async function refreshAgents() {
    try {
      const data = await getStatus();
      const list = (data.pairedAgents || []).map((a) => ({
        key: a.key,
        name: a.agentName || 'Unnamed agent',
        profileId: a.profileId || null,
      }));
      setAgents(list);
      // Default-select first agent on initial load so the section is useful
      // immediately rather than showing an empty dropdown.
      setSelectedAgentKey((prev) => prev || (list[0] ? list[0].key : ''));
    } catch (_e) {
      /* surfaced indirectly via the empty-state copy */
    } finally {
      setAgentsLoading(false);
    }
  }

  async function refreshOverrides(agentKey) {
    if (!agentKey) {
      setOverrides([]);
      setOverridesLoading(false);
      return;
    }
    setOverridesLoading(true);
    try {
      const { data, isStale } = await overridesFetcher.current.fetch(
        () => getAgentSiteOverrides(agentKey)
      );
      if (isStale) return;
      setOverrides(Array.isArray(data) ? data : []);
      setOverridesError(null);
    } catch (err) {
      setOverridesError(err);
    } finally {
      setOverridesLoading(false);
    }
  }

  useEffect(() => {
    refreshSites();
    refreshAgents();
    const client = createUiEventsClient();
    client.connect();
    const unsubs = [
      client.subscribe('sites_changed', () => {
        refreshSites();
        // The currently-selected agent's overrides may have changed too.
        if (selectedAgentKeyRef.current) {
          refreshOverrides(selectedAgentKeyRef.current);
        }
      }),
      client.subscribe('agents_changed', () => refreshAgents()),
    ];
    return () => {
      unsubs.forEach((u) => u && u());
      client.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the selected agent into a ref so the long-lived WS subscription
  // can read its latest value without re-binding on every selection change.
  const selectedAgentKeyRef = useRef(selectedAgentKey);
  useEffect(() => {
    selectedAgentKeyRef.current = selectedAgentKey;
    refreshOverrides(selectedAgentKey);
  }, [selectedAgentKey]);

  async function handleToggleBaseline(next) {
    const prev = sitesData.baseline;
    setSitesData((d) => ({ ...d, baseline: { ...(d.baseline || {}), enabled: next } }));
    try {
      const result = await toggleBaselineBlocklist(next);
      setSitesData((d) => ({ ...d, baseline: result.baseline || d.baseline }));
      toast.info(`Global blocklist ${next ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      // Roll back on failure.
      setSitesData((d) => ({ ...d, baseline: prev }));
      toast.error(e.message || 'Couldn’t update global blocklist setting.');
    }
  }

  async function handleAddRule({ domain, decision }) {
    setBusy(true);
    try {
      await createSiteRule({ domain, decision });
      toast.success(`Added ${decision} rule for ${domain}.`);
      setAddRuleOpen(false);
      await refreshSites();
    } catch (e) {
      const msg = (e && e.payload && (e.payload.reason || e.payload.error)) || e.message;
      toast.error(msg || 'Couldn’t add rule.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRule(rule) {
    setBusy(true);
    try {
      await deleteSiteRule(rule.domain);
      toast.info(`Removed rule for ${rule.domain}.`);
      await refreshSites();
    } catch (e) {
      const msg = (e && e.payload && (e.payload.reason || e.payload.error)) || e.message;
      toast.error(msg || 'Couldn’t delete rule.');
    } finally {
      setBusy(false);
    }
  }

  async function handleAddOverride({ domain, decision }) {
    if (!selectedAgentKey) return;
    setBusy(true);
    try {
      await setAgentSiteOverride(selectedAgentKey, { domain, decision });
      toast.success(`Added ${decision} override for ${domain}.`);
      setAddOverrideOpen(false);
      await refreshOverrides(selectedAgentKey);
    } catch (e) {
      const msg = (e && e.payload && (e.payload.reason || e.payload.error)) || e.message;
      toast.error(msg || 'Couldn’t add override.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteOverride(override) {
    if (!selectedAgentKey) return;
    setBusy(true);
    try {
      await deleteAgentSiteOverride(selectedAgentKey, override.domain);
      toast.info(`Removed override for ${override.domain}.`);
      await refreshOverrides(selectedAgentKey);
    } catch (e) {
      const msg = (e && e.payload && (e.payload.reason || e.payload.error)) || e.message;
      toast.error(msg || 'Couldn’t delete override.');
    } finally {
      setBusy(false);
    }
  }

  const customRules = useMemo(
    () => (sitesData?.globalRules || []).filter((r) => r.source === 'user'),
    [sitesData?.globalRules]
  );

  const userRuleCount = useMemo(
    () => sitesData.globalRules.filter((r) => r.source === 'user').length,
    [sitesData.globalRules]
  );

  const baseline = sitesData.baseline;

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Sites</h1>
        <p className="wp-page-sub">
          Decide which sites WebPilot agents can touch. Per-agent overrides beat custom rules; custom rules beat the bundled global blocklist; everything else is allowed.
        </p>
      </header>

      {sitesError ? <ErrorCard error={sitesError} /> : null}

      {/* Global Blocklist summary */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Global Blocklist</h2>
        </div>
        <div className="wp-card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          {sitesLoading ? (
            <SkeletonRow titleWidth="40%" subWidth="55%" />
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--s-4)' }}>
                <div>
                  <div style={{ fontWeight: 500, color: 'var(--wp-fg)' }}>
                    Global blocklist {baseline && baseline.enabled ? 'enabled' : 'disabled'}
                  </div>
                  <div className="wp-row-sub" style={{ marginTop: 4 }}>
                    {baseline && baseline.version ? (
                      <>
                        <span>version <strong style={{ color: 'var(--wp-fg)' }}>{baseline.version}</strong></span>
                        <span className="wp-row-sep">·</span>
                        <span>last fetched {formatRelativeTime(baseline.lastFetchedAt)}</span>
                        <span className="wp-row-sep">·</span>
                        <span>
                          <strong style={{ color: 'var(--wp-fg)' }}>{baseline.domainCount || 0}</strong>{' '}
                          {((baseline && baseline.domainCount) || 0) === 1 ? 'domain' : 'domains'} in the pack
                        </span>
                      </>
                    ) : (
                      <span>No pack fetched yet.</span>
                    )}
                  </div>
                </div>
                <Toggle
                  checked={!!(baseline && baseline.enabled)}
                  onChange={handleToggleBaseline}
                  label={baseline && baseline.enabled ? 'On' : 'Off'}
                  title="When disabled, WebPilot ignores the bundled blocklist when deciding whether a request is allowed. Per-agent overrides and your custom rules still apply."
                />
              </div>
              <details style={{ marginTop: 'var(--s-3)' }}>
                <summary>What's in the pack?</summary>
                <div className="wp-row-list" style={{ marginTop: 'var(--s-2)' }}>
                  {(() => {
                    const baselineRules = (sitesData?.globalRules || []).filter((r) => r.source === 'baseline');
                    if (baselineRules.length === 0) {
                      return <EmptyState body="No pack domains loaded yet." />;
                    }
                    return baselineRules.map((r) => (
                      <div key={r.domain} className="wp-row">
                        <div className="wp-row-grow">
                          <div className="wp-row-title">{r.domain}</div>
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </details>
            </>
          )}
        </div>
      </section>

      {/* Custom rules */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Custom rules</h2>
          <span className="wp-section-aside">
            {sitesLoading
              ? ''
              : `${userRuleCount} ${userRuleCount === 1 ? 'rule' : 'rules'}`}
          </span>
        </div>

        <SectionToolbar
          left={null}
          right={(
            <button
              type="button"
              className="wp-btn wp-btn-primary"
              onClick={() => setAddRuleOpen((v) => !v)}
              disabled={busy}
            >
              {addRuleOpen ? 'Close' : '+ Add rule'}
            </button>
          )}
        />


        {addRuleOpen ? (
          <div style={{ marginBottom: 'var(--s-3)' }}>
            <AddRuleForm
              onSubmit={handleAddRule}
              onCancel={() => setAddRuleOpen(false)}
              busy={busy}
              defaultDecision="block"
            />
          </div>
        ) : null}

        {sitesLoading ? (
          <div className="wp-inset-group">
            <SkeletonRow titleWidth="45%" subWidth="35%" showTrailing />
            <SkeletonRow titleWidth="52%" subWidth="40%" showTrailing />
            <SkeletonRow titleWidth="38%" subWidth="32%" showTrailing />
          </div>
        ) : customRules.length === 0 ? (
          <EmptyState body="No custom rules yet. Click &quot;+ Add rule&quot; to allow or block a domain." />
        ) : (
          <div className="wp-row-list">
            {customRules.map((rule) => (
              <GlobalRuleRow
                key={`${rule.source}:${rule.domain}`}
                rule={rule}
                onDelete={handleDeleteRule}
                busy={busy}
              />
            ))}
          </div>
        )}
      </section>

      {/* Per-agent overrides */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Per-agent overrides</h2>
          <span className="wp-section-aside">
            {agents.length === 0
              ? agentsLoading ? '' : 'No agents'
              : `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`}
          </span>
        </div>

        <SectionToolbar
          left={(
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s-2)' }}>
              <span className="wp-secondary" style={{ fontSize: 'var(--fs-small)' }}>
                Agent
              </span>
              <select
                className="wp-input"
                value={selectedAgentKey}
                onChange={(e) => setSelectedAgentKey(e.target.value)}
                disabled={agents.length === 0}
              >
                {agents.length === 0 ? (
                  <option value="">No paired agents</option>
                ) : (
                  agents.map((a) => (
                    <option key={a.key} value={a.key}>
                      {a.name}
                      {a.profileId ? ` · ${a.profileId}` : ''}
                    </option>
                  ))
                )}
              </select>
            </label>
          )}
          right={(
            <button
              type="button"
              className="wp-btn wp-btn-primary"
              onClick={() => setAddOverrideOpen((v) => !v)}
              disabled={busy || !selectedAgentKey}
            >
              {addOverrideOpen ? 'Close' : '+ Add override'}
            </button>
          )}
        />


        {addOverrideOpen && selectedAgentKey ? (
          <div style={{ marginBottom: 'var(--s-3)' }}>
            <AddRuleForm
              onSubmit={handleAddOverride}
              onCancel={() => setAddOverrideOpen(false)}
              busy={busy}
              defaultDecision="allow"
            />
          </div>
        ) : null}

        {overridesError ? (
          <ErrorCard error={overridesError} title="Couldn’t load overrides." />
        ) : !selectedAgentKey ? (
          <EmptyState
            body={agentsLoading
              ? 'Loading agents…'
              : 'No paired agents yet. Pair an agent first to give it per-site overrides.'}
          />
        ) : overridesLoading ? (
          <div className="wp-inset-group">
            <SkeletonRow titleWidth="42%" subWidth="30%" showTrailing />
            <SkeletonRow titleWidth="50%" subWidth="35%" showTrailing />
          </div>
        ) : overrides.length === 0 ? (
          <EmptyState body="No overrides for this agent." />
        ) : (
          <div className="wp-row-list">
            {overrides.map((o) => (
              <OverrideRow
                key={o.domain}
                override={o}
                onDelete={handleDeleteOverride}
                busy={busy}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
