'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ErrorCard from '../../components/ErrorCard';
import Toggle from '../../components/Toggle';
import { SkeletonRow } from '../../components/Skeleton';
import { useToast } from '../../components/ToastRegion';
import {
  createSequencedFetcher,
  getStatus,
  getGlobalRules,
  createGlobalRule,
  deleteGlobalRule,
  getAgentSiteRules,
  setAgentSiteRule,
  deleteAgentSiteRule,
  toggleGlobalTier,
  getSitePolicyEvents,
  allowSiteForAgent,
  revokeSiteForAgent,
} from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';
import RulesModal, { apiErrorMessage, relTime } from './RulesModal';
import AgentRulesPanel from './AgentRulesPanel';
import SiteEventLog, { eventKey } from './SiteEventLog';

/**
 * Site Policy — admin surface for the WebPilot site policy model.
 *
 *   - Global block list (left card): global tier toggle, one facts line,
 *     and a Manage button opening RulesModal (scope="global") — your
 *     global allows / blocks plus the signed list; add + delete your own
 *     rules there.
 *   - Per-agent rules (right card): agent picker + a one-line summary, and
 *     a Manage button opening RulesModal (scope="agent") for that agent.
 *   - Site access log (below, the dominant element): one row per agent +
 *     domain with per-agent Allow (typed confirm) / Revoke actions.
 *
 * Live updates: `site_policy_changed` (any reason) refetches global rules,
 * the selected agent's rules and the log; `site_policy_events_changed`
 * refetches the log; `agents_changed` refetches agents + log; `reconnected`
 * refetches all.
 */

const EVENTS_PAGE_SIZE = 50;
const EVENTS_MAX_REFETCH = 200;
const EVENTS_COALESCE_MS = 250;

function makeFetcher(ref) {
  if (ref.current === null) ref.current = createSequencedFetcher();
  return ref.current;
}

export default function SitePolicyPage() {
  const toast = useToast();

  // --- Global rules + signed list summary (/api/ui/site-policy/global-rules) -
  const [globalData, setGlobalData] = useState({ globalRules: [], globalSiteBlocklist: null });
  const [globalDataLoading, setGlobalDataLoading] = useState(true);
  const [globalDataError, setGlobalDataError] = useState(null);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [globalModalOpen, setGlobalModalOpen] = useState(false);
  const manageGlobalBtnRef = useRef(null);
  const globalFetcherRef = useRef(null);

  // --- Agents (/api/ui/status) ---------------------------------------------
  const [agents, setAgents] = useState([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [selectedAgentKey, setSelectedAgentKey] = useState('');
  const selectedAgentKeyRef = useRef('');

  // --- Per-agent rules -------------------------------------------------------
  const [agentRules, setAgentRules] = useState([]);
  const [agentRulesLoading, setAgentRulesLoading] = useState(false);
  const [agentRulesError, setAgentRulesError] = useState(null);
  const [agentRulesBusy, setAgentRulesBusy] = useState(false);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const manageAgentBtnRef = useRef(null);
  const agentRulesFetcherRef = useRef(null);

  // --- Site access log -------------------------------------------------------
  const [events, setEvents] = useState([]);
  const eventsRef = useRef([]);
  const [eventsCursor, setEventsCursor] = useState(null);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsLoadingMore, setEventsLoadingMore] = useState(false);
  const [eventsError, setEventsError] = useState(null);
  const [eventBusyKey, setEventBusyKey] = useState(null);
  const [agentFilter, setAgentFilter] = useState('');
  const [decisionFilter, setDecisionFilter] = useState('');
  const agentFilterRef = useRef('');
  const decisionFilterRef = useRef('');
  const eventsFetcherRef = useRef(null);
  // Bumped by every first-page (re)fetch so an in-flight load-more from an
  // older list is discarded instead of appended.
  const eventsGenRef = useRef(0);
  const eventsTimerRef = useRef(null);
  const unmountedRef = useRef(false);

  function commitEvents(list) {
    eventsRef.current = list;
    setEvents(list);
  }

  async function refreshGlobalRules() {
    try {
      const { data, isStale } = await makeFetcher(globalFetcherRef).fetch(() => getGlobalRules());
      if (isStale || unmountedRef.current) return;
      setGlobalData({
        globalRules: Array.isArray(data && data.globalRules) ? data.globalRules : [],
        globalSiteBlocklist: (data && data.globalSiteBlocklist) || null,
      });
      setGlobalDataError(null);
    } catch (err) {
      if (!unmountedRef.current) setGlobalDataError(err);
    } finally {
      if (!unmountedRef.current) setGlobalDataLoading(false);
    }
  }

  async function refreshAgentRules(agentKey) {
    if (!agentKey) {
      setAgentRules([]);
      setAgentRulesError(null);
      setAgentRulesLoading(false);
      return;
    }
    setAgentRulesLoading(true);
    try {
      const { data, isStale } = await makeFetcher(agentRulesFetcherRef).fetch(
        () => getAgentSiteRules(agentKey)
      );
      if (isStale || agentKey !== selectedAgentKeyRef.current || unmountedRef.current) return;
      setAgentRules(Array.isArray(data) ? data : []);
      setAgentRulesError(null);
    } catch (err) {
      if (agentKey === selectedAgentKeyRef.current && !unmountedRef.current) setAgentRulesError(err);
    } finally {
      // Guard on the selection ref (not a locally-scoped `stale` flag) so a
      // fetch that rejects (rather than resolving stale) still leaves the
      // loading flag alone if a newer request has since taken over.
      if (agentKey === selectedAgentKeyRef.current && !unmountedRef.current) setAgentRulesLoading(false);
    }
  }

  function selectAgent(key) {
    selectedAgentKeyRef.current = key;
    setSelectedAgentKey(key);
    setAgentRules([]);
    setAgentRulesError(null);
    refreshAgentRules(key);
  }

  // Fetch the first page of the log. With `preserveSize`, a list of up to
  // 200 loaded rows is refetched at its current length so a live update
  // doesn't collapse what the user already paged through.
  async function refreshEvents({ preserveSize = false } = {}) {
    const gen = ++eventsGenRef.current;
    const loaded = eventsRef.current.length;
    const limit = preserveSize && loaded <= EVENTS_MAX_REFETCH
      ? Math.max(EVENTS_PAGE_SIZE, loaded)
      : EVENTS_PAGE_SIZE;
    setEventsLoading(true);
    setEventsLoadingMore(false);
    try {
      const { data, isStale } = await makeFetcher(eventsFetcherRef).fetch(() => getSitePolicyEvents({
        agentId: agentFilterRef.current || undefined,
        decision: decisionFilterRef.current || undefined,
        limit,
      }));
      if (isStale || gen !== eventsGenRef.current || unmountedRef.current) return;
      commitEvents(Array.isArray(data && data.entries) ? data.entries : []);
      setEventsHasMore(!!(data && data.hasMore));
      setEventsCursor((data && data.nextCursor) || null);
      setEventsError(null);
    } catch (err) {
      if (gen === eventsGenRef.current && !unmountedRef.current) setEventsError(err);
    } finally {
      // Guard on the generation ref (not a locally-scoped `stale` flag) so a
      // fetch that rejects (rather than resolving stale) still leaves the
      // loading flag alone if a newer request has since taken over.
      if (gen === eventsGenRef.current && !unmountedRef.current) setEventsLoading(false);
    }
  }

  // Coalesce bursts of WS events into one refetch.
  function scheduleEventsRefetch() {
    if (eventsTimerRef.current) return;
    eventsTimerRef.current = setTimeout(() => {
      eventsTimerRef.current = null;
      if (!unmountedRef.current) refreshEvents({ preserveSize: true });
    }, EVENTS_COALESCE_MS);
  }

  async function loadMoreEvents() {
    if (!eventsCursor || eventsLoadingMore) return;
    const gen = eventsGenRef.current;
    setEventsLoadingMore(true);
    try {
      const data = await getSitePolicyEvents({
        agentId: agentFilterRef.current || undefined,
        decision: decisionFilterRef.current || undefined,
        limit: EVENTS_PAGE_SIZE,
        cursor: eventsCursor,
      });
      // A first-page refetch started while we were in flight: drop this page.
      if (gen !== eventsGenRef.current || unmountedRef.current) return;
      const seen = new Set(eventsRef.current.map(eventKey));
      const more = (Array.isArray(data && data.entries) ? data.entries : [])
        .filter((e) => !seen.has(eventKey(e)));
      commitEvents([...eventsRef.current, ...more]);
      setEventsHasMore(!!(data && data.hasMore));
      setEventsCursor((data && data.nextCursor) || null);
    } catch (err) {
      if (gen === eventsGenRef.current && !unmountedRef.current) {
        toast.error(apiErrorMessage(err, 'Couldn’t load more entries.'));
      }
    } finally {
      if (gen === eventsGenRef.current && !unmountedRef.current) setEventsLoadingMore(false);
    }
  }

  function changeFilters(next) {
    if ('agent' in next) {
      agentFilterRef.current = next.agent;
      setAgentFilter(next.agent);
    }
    if ('decision' in next) {
      decisionFilterRef.current = next.decision;
      setDecisionFilter(next.decision);
    }
    // Back to page 1.
    commitEvents([]);
    setEventsCursor(null);
    setEventsHasMore(false);
    setEventsError(null);
    refreshEvents();
  }

  async function refreshAgents() {
    try {
      const data = await getStatus();
      if (unmountedRef.current) return;
      const list = ((data && data.pairedAgents) || []).map((a) => ({
        key: a.key,
        name: a.agentName || 'Unnamed agent',
      }));
      setAgents(list);
      const keys = new Set(list.map((a) => a.key));
      const current = selectedAgentKeyRef.current;
      if (!current || !keys.has(current)) {
        selectAgent(list[0] ? list[0].key : '');
      }
      if (agentFilterRef.current && !keys.has(agentFilterRef.current)) {
        changeFilters({ agent: '' });
      }
    } catch (_e) {
      /* Status failures surface through the app shell's connection state. */
    } finally {
      if (!unmountedRef.current) setAgentsLoading(false);
    }
  }

  useEffect(() => {
    unmountedRef.current = false;
    refreshGlobalRules();
    refreshAgents();
    refreshEvents();
    const client = createUiEventsClient();
    client.connect();
    const unsubs = [
      // Every reason (global/agent rule writes, tier toggle, popup toggle,
      // log allow/revoke) is handled the same way: full refetch.
      client.subscribe('site_policy_changed', () => {
        refreshGlobalRules();
        if (selectedAgentKeyRef.current) refreshAgentRules(selectedAgentKeyRef.current);
        scheduleEventsRefetch();
      }),
      client.subscribe('site_policy_events_changed', () => scheduleEventsRefetch()),
      client.subscribe('agents_changed', () => {
        refreshAgents();
        scheduleEventsRefetch();
      }),
      client.subscribe('reconnected', () => {
        refreshGlobalRules();
        refreshAgents();
        if (selectedAgentKeyRef.current) refreshAgentRules(selectedAgentKeyRef.current);
        scheduleEventsRefetch();
      }),
    ];
    return () => {
      unmountedRef.current = true;
      if (eventsTimerRef.current) {
        clearTimeout(eventsTimerRef.current);
        eventsTimerRef.current = null;
      }
      unsubs.forEach((u) => u && u());
      client.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Global tier + global rules -------------------------------------------

  async function handleToggleGlobalTier(next) {
    const prev = globalData.globalSiteBlocklist;
    setGlobalData((d) => ({ ...d, globalSiteBlocklist: { ...(d.globalSiteBlocklist || {}), enabled: next } }));
    try {
      const result = await toggleGlobalTier(next);
      setGlobalData((d) => ({
        ...d,
        globalSiteBlocklist: (result && result.globalSiteBlocklist) || d.globalSiteBlocklist,
      }));
      toast.info(`Global block list ${next ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      setGlobalData((d) => ({ ...d, globalSiteBlocklist: prev }));
      toast.error(apiErrorMessage(err, 'Couldn’t update the global block list.'));
    }
  }

  async function handleAddGlobalRule({ domain, decision }) {
    if (domain.includes('*')) return false; // wildcards are per-agent only
    setGlobalBusy(true);
    try {
      await createGlobalRule({ domain, decision });
      toast.success(`Added ${decision} rule for ${domain}.`);
      await refreshGlobalRules();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Couldn’t add rule.'));
      return false;
    } finally {
      setGlobalBusy(false);
    }
  }

  async function handleDeleteGlobalRule(domain) {
    setGlobalBusy(true);
    try {
      await deleteGlobalRule(domain);
      toast.info(`Removed rule for ${domain}.`);
      await refreshGlobalRules();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Couldn’t remove rule.'));
      return false;
    } finally {
      setGlobalBusy(false);
    }
  }

  function closeGlobalModal() {
    setGlobalModalOpen(false);
    // RulesModal does not restore focus on close.
    try { manageGlobalBtnRef.current && manageGlobalBtnRef.current.focus(); } catch (_) { /* ignore */ }
  }

  // --- Per-agent rules -------------------------------------------------------

  async function handleAddAgentRule({ domain, decision }) {
    const agentKey = selectedAgentKeyRef.current;
    if (!agentKey) return false;
    setAgentRulesBusy(true);
    try {
      await setAgentSiteRule(agentKey, { domain, decision });
      toast.success(`Added ${decision} rule for ${domain}.`);
      await refreshAgentRules(agentKey);
      scheduleEventsRefetch();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Couldn’t add rule.'));
      return false;
    } finally {
      setAgentRulesBusy(false);
    }
  }

  async function handleDeleteAgentRule(domain) {
    const agentKey = selectedAgentKeyRef.current;
    if (!agentKey) return false;
    setAgentRulesBusy(true);
    try {
      await deleteAgentSiteRule(agentKey, domain);
      toast.info(`Removed rule for ${domain}.`);
      await refreshAgentRules(agentKey);
      scheduleEventsRefetch();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Couldn’t remove rule.'));
      return false;
    } finally {
      setAgentRulesBusy(false);
    }
  }

  function closeAgentModal() {
    setAgentModalOpen(false);
    try { manageAgentBtnRef.current && manageAgentBtnRef.current.focus(); } catch (_) { /* ignore */ }
  }

  // --- Site access log actions ----------------------------------------------

  async function runEventAction(entry, action, successText) {
    const key = eventKey(entry);
    setEventBusyKey(key);
    try {
      await action(entry.agentKey, entry.domain);
      toast.success(successText);
      await refreshEvents({ preserveSize: true });
      if (selectedAgentKeyRef.current === entry.agentKey) {
        refreshAgentRules(entry.agentKey);
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Couldn’t update this agent’s rule.'));
    } finally {
      if (!unmountedRef.current) setEventBusyKey((k) => (k === key ? null : k));
    }
  }

  function handleAllowEvent(entry) {
    const name = entry.agentName || 'Unnamed agent';
    return runEventAction(entry, allowSiteForAgent, `Allowed ${entry.domain} for ${name}.`);
  }

  function handleRevokeEvent(entry) {
    const name = entry.agentName || 'Unnamed agent';
    return runEventAction(entry, revokeSiteForAgent, `Blocked ${entry.domain} for ${name}.`);
  }

  // --- Derived ---------------------------------------------------------------

  const globalSiteBlocklist = globalData.globalSiteBlocklist;
  const tierEnabled = !!(globalSiteBlocklist && globalSiteBlocklist.enabled);
  const userRuleCount = useMemo(
    () => globalData.globalRules.reduce((n, r) => (r.source === 'user' ? n + 1 : n), 0),
    [globalData.globalRules]
  );
  const signedCount = (globalSiteBlocklist && globalSiteBlocklist.domainCount) || 0;
  const hasGlobalData = !!globalSiteBlocklist || globalData.globalRules.length > 0;
  const selectedAgent = agents.find((a) => a.key === selectedAgentKey) || null;
  const selectedAgentName = selectedAgent ? selectedAgent.name : 'This agent';

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Site Policy</h1>
        <p className="wp-page-sub">
          Control which sites your agents can open: per-agent rules beat global rules, and anything unmatched is allowed.
        </p>
      </header>

      <div className="wp-site-policy-cols">
        <section className="wp-card wp-site-policy-card" aria-labelledby="wp-site-policy-global-title">
          <div className="wp-site-policy-card-head">
            <div>
              <h2 id="wp-site-policy-global-title" className="wp-site-policy-card-title">Global block list</h2>
              <p className="wp-site-policy-card-sub">Applies to all agents, but can be overridden by custom agent rules.</p>
            </div>
            {hasGlobalData ? (
              <Toggle
                checked={tierEnabled}
                onChange={handleToggleGlobalTier}
                ariaLabel="Enable global block list"
              />
            ) : null}
          </div>

          {globalDataError ? (
            <ErrorCard title="Couldn’t load global rules." error={globalDataError} onRetry={refreshGlobalRules} />
          ) : null}

          {globalDataLoading && !hasGlobalData ? (
            <SkeletonRow titleWidth="70%" subWidth="45%" padded={false} />
          ) : hasGlobalData ? (
            <>
              <div className="wp-site-policy-facts">
                {signedCount} signed domains · {userRuleCount} custom {userRuleCount === 1 ? 'rule' : 'rules'} · updated {relTime(globalSiteBlocklist && globalSiteBlocklist.lastFetchedAt)}
              </div>
              {!tierEnabled ? (
                <div className="wp-site-policy-note">Global rules are off. Only per-agent rules and defaults apply.</div>
              ) : null}
              <div className="wp-site-policy-actions">
                <button
                  ref={manageGlobalBtnRef}
                  type="button"
                  className="wp-btn"
                  onClick={() => setGlobalModalOpen(true)}
                >
                  Manage
                </button>
              </div>
            </>
          ) : null}
        </section>

        <AgentRulesPanel
          agents={agents}
          agentsLoading={agentsLoading}
          selectedAgentKey={selectedAgentKey}
          onSelectAgent={selectAgent}
          rules={agentRules}
          rulesLoading={agentRulesLoading}
          onManage={() => setAgentModalOpen(true)}
        />
      </div>

      <SiteEventLog
        agents={agents}
        agentFilter={agentFilter}
        decisionFilter={decisionFilter}
        onAgentFilterChange={(v) => changeFilters({ agent: v })}
        onDecisionFilterChange={(v) => changeFilters({ decision: v })}
        entries={events}
        loading={eventsLoading}
        error={eventsError}
        onRetry={() => refreshEvents({ preserveSize: true })}
        hasMore={eventsHasMore}
        loadingMore={eventsLoadingMore}
        onLoadMore={loadMoreEvents}
        eventBusyKey={eventBusyKey}
        onAllow={handleAllowEvent}
        onRevoke={handleRevokeEvent}
      />

      <RulesModal
        open={globalModalOpen}
        onClose={closeGlobalModal}
        scope="global"
        globalRules={globalData.globalRules}
        globalSiteBlocklist={globalSiteBlocklist}
        busy={globalBusy}
        onAddRule={handleAddGlobalRule}
        onDeleteRule={handleDeleteGlobalRule}
      />

      <RulesModal
        open={agentModalOpen}
        onClose={closeAgentModal}
        scope="agent"
        agentName={selectedAgentName}
        rules={agentRules}
        rulesLoading={agentRulesLoading}
        rulesError={agentRulesError}
        onRetry={() => refreshAgentRules(selectedAgentKeyRef.current)}
        busy={agentRulesBusy}
        onAddRule={handleAddAgentRule}
        onDeleteRule={handleDeleteAgentRule}
      />
    </>
  );
}
