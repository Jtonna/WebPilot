'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ErrorCard from '../../components/ErrorCard';
import Toggle from '../../components/Toggle';
import { SkeletonRow } from '../../components/Skeleton';
import { useToast } from '../../components/ToastRegion';
import {
  createSequencedFetcher,
  getStatus,
  getSites,
  createSiteRule,
  deleteSiteRule,
  getAgentSiteRules,
  setAgentSiteRule,
  deleteAgentSiteRule,
  toggleGlobalTier,
  getSiteEvents,
  allowSiteForAgent,
  revokeSiteForAgent,
} from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';
import GlobalListModal, { apiErrorMessage, relTime } from './GlobalListModal';
import AgentRulesPanel from './AgentRulesPanel';
import SiteEventLog, { eventKey } from './SiteEventLog';

/**
 * Sites — admin surface for the WebPilot site policy model.
 *
 *   - Enable Global Block List (left card): global tier toggle, signed list
 *     facts, and "View / manage list" opening GlobalListModal (your global
 *     allows / blocks plus the signed list; add + delete your own rules).
 *   - Per-agent rules (right card): agent picker + that agent's rules,
 *     including a `*` default.
 *   - Site access log (below): one row per agent + domain with per-agent
 *     Allow (typed confirm) / Revoke actions.
 *
 * Live updates: `sites_changed` (any reason) refetches sites, the selected
 * agent's rules and the log; `site_policy_events_changed` refetches the log;
 * `agents_changed` refetches agents + log; `reconnected` refetches all.
 */

const EVENTS_PAGE_SIZE = 50;
const EVENTS_MAX_REFETCH = 200;
const EVENTS_COALESCE_MS = 250;

function makeFetcher(ref) {
  if (ref.current === null) ref.current = createSequencedFetcher();
  return ref.current;
}

export default function SitesPage() {
  const toast = useToast();

  // --- Global rules + signed list summary (/api/ui/sites) -------------------
  const [sitesData, setSitesData] = useState({ globalRules: [], globalSiteBlocklist: null });
  const [sitesLoading, setSitesLoading] = useState(true);
  const [sitesError, setSitesError] = useState(null);
  const [globalBusy, setGlobalBusy] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const viewListBtnRef = useRef(null);
  const sitesFetcherRef = useRef(null);

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

  async function refreshSites() {
    try {
      const { data, isStale } = await makeFetcher(sitesFetcherRef).fetch(() => getSites());
      if (isStale || unmountedRef.current) return;
      setSitesData({
        globalRules: Array.isArray(data && data.globalRules) ? data.globalRules : [],
        globalSiteBlocklist: (data && data.globalSiteBlocklist) || null,
      });
      setSitesError(null);
    } catch (err) {
      if (!unmountedRef.current) setSitesError(err);
    } finally {
      if (!unmountedRef.current) setSitesLoading(false);
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
      const { data, isStale } = await makeFetcher(eventsFetcherRef).fetch(() => getSiteEvents({
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
      const data = await getSiteEvents({
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
    refreshSites();
    refreshAgents();
    refreshEvents();
    const client = createUiEventsClient();
    client.connect();
    const unsubs = [
      // Every reason (global/agent rule writes, tier toggle, popup toggle,
      // log allow/revoke) is handled the same way: full refetch.
      client.subscribe('sites_changed', () => {
        refreshSites();
        if (selectedAgentKeyRef.current) refreshAgentRules(selectedAgentKeyRef.current);
        scheduleEventsRefetch();
      }),
      client.subscribe('site_policy_events_changed', () => scheduleEventsRefetch()),
      client.subscribe('agents_changed', () => {
        refreshAgents();
        scheduleEventsRefetch();
      }),
      client.subscribe('reconnected', () => {
        refreshSites();
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
    const prev = sitesData.globalSiteBlocklist;
    setSitesData((d) => ({ ...d, globalSiteBlocklist: { ...(d.globalSiteBlocklist || {}), enabled: next } }));
    try {
      const result = await toggleGlobalTier(next);
      setSitesData((d) => ({
        ...d,
        globalSiteBlocklist: (result && result.globalSiteBlocklist) || d.globalSiteBlocklist,
      }));
      toast.info(`Global block list ${next ? 'enabled' : 'disabled'}.`);
    } catch (err) {
      setSitesData((d) => ({ ...d, globalSiteBlocklist: prev }));
      toast.error(apiErrorMessage(err, 'Couldn’t update the global block list.'));
    }
  }

  async function handleAddGlobalRule({ domain, decision }) {
    if (domain.includes('*')) return false; // wildcards are per-agent only
    setGlobalBusy(true);
    try {
      await createSiteRule({ domain, decision });
      toast.success(`Added ${decision} rule for ${domain}.`);
      await refreshSites();
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
      await deleteSiteRule(domain);
      toast.info(`Removed rule for ${domain}.`);
      await refreshSites();
      return true;
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Couldn’t remove rule.'));
      return false;
    } finally {
      setGlobalBusy(false);
    }
  }

  function closeGlobalList() {
    setListOpen(false);
    // Modal does not restore focus on close.
    try { viewListBtnRef.current && viewListBtnRef.current.focus(); } catch (_) { /* ignore */ }
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

  const globalSiteBlocklist = sitesData.globalSiteBlocklist;
  const tierEnabled = !!(globalSiteBlocklist && globalSiteBlocklist.enabled);
  const userRuleCount = useMemo(
    () => sitesData.globalRules.reduce((n, r) => (r.source === 'user' ? n + 1 : n), 0),
    [sitesData.globalRules]
  );
  const signedCount = (globalSiteBlocklist && globalSiteBlocklist.domainCount) || 0;
  const hasSitesData = !!globalSiteBlocklist || sitesData.globalRules.length > 0;

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Sites</h1>
        <p className="wp-page-sub">
          Control which sites your agents can open: per-agent rules beat global rules, and anything unmatched is allowed.
        </p>
      </header>

      <div className="wp-sites-cols">
        <section className="wp-card wp-sites-card" aria-labelledby="wp-sites-global-title">
          <div className="wp-sites-card-head">
            <div>
              <h2 id="wp-sites-global-title" className="wp-sites-card-title">Enable Global Block List</h2>
              <p className="wp-sites-card-sub">Applies to all agents regardless of their custom rules.</p>
            </div>
            {hasSitesData ? (
              <Toggle
                checked={tierEnabled}
                onChange={handleToggleGlobalTier}
                ariaLabel="Enable global block list"
              />
            ) : null}
          </div>

          {sitesError ? (
            <ErrorCard title="Couldn’t load global rules." error={sitesError} onRetry={refreshSites} />
          ) : null}

          {sitesLoading && !hasSitesData ? (
            <SkeletonRow titleWidth="70%" subWidth="45%" padded={false} />
          ) : hasSitesData ? (
            <>
              <div className="wp-sites-facts">
                {signedCount} signed domains · {userRuleCount} custom {userRuleCount === 1 ? 'rule' : 'rules'} · updated {relTime(globalSiteBlocklist && globalSiteBlocklist.lastFetchedAt)}
              </div>
              {!tierEnabled ? (
                <div className="wp-sites-note">Global rules are off. Only per-agent rules and defaults apply.</div>
              ) : null}
              <div className="wp-sites-actions">
                <button
                  ref={viewListBtnRef}
                  type="button"
                  className="wp-btn"
                  onClick={() => setListOpen(true)}
                >
                  View / manage list
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
          rulesError={agentRulesError}
          onRetry={() => refreshAgentRules(selectedAgentKeyRef.current)}
          busy={agentRulesBusy}
          onAddRule={handleAddAgentRule}
          onDeleteRule={handleDeleteAgentRule}
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

      <GlobalListModal
        open={listOpen}
        onClose={closeGlobalList}
        globalRules={sitesData.globalRules}
        globalSiteBlocklist={globalSiteBlocklist}
        busy={globalBusy}
        onAddRule={handleAddGlobalRule}
        onDeleteRule={handleDeleteGlobalRule}
      />
    </>
  );
}
