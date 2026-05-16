'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AgentRow from '../../components/AgentRow';
import BackLink from '../../components/BackLink';
import ConfirmModal from '../../components/ConfirmModal';
import ErrorCard from '../../components/ErrorCard';
import PairAgentModal from '../../components/PairAgentModal';
import { SkeletonRow } from '../../components/Skeleton';
import { useToast } from '../../components/ToastRegion';
import {
  createSequencedFetcher,
  getStatus,
  renameAgent,
  revokeAgent,
  updateAgentProfile,
} from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

/**
 * Agents — pairing-first layout.
 *
 * Sections (top → bottom):
 *   1. Pair a new agent  — slim bar with a single CTA button. Clicking opens
 *                          PairAgentModal, which holds the instructions text
 *                          + Copy button. Used rarely, so it stays out of the
 *                          way until invoked.
 *   2. Paired agents     — list. Filtered by ?profile=<directoryName> when
 *                          set (with a small "Clear" banner above).
 */

export default function AgentsPage() {
  // useSearchParams() requires a Suspense boundary for static export. The
  // page body lives inside <AgentsPageInner>.
  return (
    <Suspense fallback={<AgentsSkeleton />}>
      <AgentsPageInner />
    </Suspense>
  );
}

function AgentsSkeleton() {
  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Agents</h1>
      </header>
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Paired agents</h2>
        </div>
        <div className="wp-inset-group">
          <SkeletonRow titleWidth="40%" subWidth="50%" showTrailing />
          <SkeletonRow titleWidth="48%" subWidth="45%" showTrailing />
        </div>
      </section>
    </>
  );
}

function AgentsPageInner() {
  const searchParams = useSearchParams();
  const profileFilter = searchParams.get('profile') || '';

  const [agents, setAgents]   = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [port, setPort]       = useState(null);
  const [error, setError]     = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [pairOpen, setPairOpen] = useState(false);
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }
  const toast = useToast();

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getStatus());
      if (isStale) return;
      const normalized = (data.pairedAgents || []).map((a) => ({
        key: a.key,
        name: a.agentName,
        createdAt: a.createdAt,
        lastActive: a.lastAccessed,
        profileId: a.profileId || null,
      }));
      setAgents(normalized);
      setProfiles(data.profiles || []);
      setPort(data.port || null);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setAgentsLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const client = createUiEventsClient();
    client.connect();
    const u1 = client.subscribe('agents_changed', () => refresh());
    const u2 = client.subscribe('pairing_approved', () => refresh());
    return () => {
      u1 && u1();
      u2 && u2();
      client.disconnect();
    };
  }, []);

  async function handleRename(agent, newName) {
    try {
      await renameAgent(agent.key, newName);
      toast.success(`Renamed to ${newName}.`);
      await refresh();
    } catch (e) {
      toast.error(e.message || 'Couldn’t rename.');
    }
  }

  async function handleRebind(agent, nextProfileId) {
    // Optimistic UI: flip the row's profileId immediately so the user sees
    // the change without waiting for the round-trip. The server broadcast
    // (agents_changed) will trigger a refresh that confirms or corrects it.
    const prev = agents;
    setAgents((list) => list.map((a) => (
      a.key === agent.key ? { ...a, profileId: nextProfileId } : a
    )));
    try {
      await updateAgentProfile(agent.key, nextProfileId);
      const match = profiles.find((p) => p.directoryName === nextProfileId);
      const label = (match && (match.displayName || match.directoryName)) || nextProfileId;
      toast.success(`Bound ${agent.name || 'agent'} to ${label}.`);
      await refresh();
    } catch (e) {
      // Roll back the optimistic update on failure.
      setAgents(prev);
      toast.error(e.message || 'Couldn’t change profile.');
    }
  }

  function handleRevoke(agent) { setRevokeTarget(agent); }

  async function confirmRevoke() {
    const agent = revokeTarget;
    setRevokeTarget(null);
    if (!agent) return;
    try {
      await revokeAgent(agent.key);
      toast.info(`Revoked ${agent.name || 'agent'}.`);
      await refresh();
    } catch (e) {
      toast.error(e.message || 'Couldn’t revoke.');
    }
  }

  // Resolve the filter's display name from the loaded profile list. Fall back
  // to the raw directoryName when the profile isn't (yet) known.
  const filterDisplayName = useMemo(() => {
    if (!profileFilter) return '';
    const match = profiles.find((p) => p.directoryName === profileFilter);
    return (match && (match.displayName || match.directoryName)) || profileFilter;
  }, [profileFilter, profiles]);

  const filteredAgents = profileFilter
    ? agents.filter((a) => a.profileId === profileFilter)
    : agents;

  return (
    <>
      {profileFilter ? <BackLink href="/ui/profiles/" label="Profiles" /> : null}
      <header className="wp-page-head">
        <h1 className="wp-page-title">Agents</h1>
        <p className="wp-page-sub">
          MCP agents authorized to drive your browser. Each holds an API key
          bound to a Chrome profile.
        </p>
      </header>

      {error ? <ErrorCard error={error} /> : null}

      {/* Slim pair-agent bar — opens PairAgentModal with the instructions. */}
      <div
        className="wp-card"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s-4)',
          padding: 'var(--s-3) var(--s-4)',
        }}
      >
        <span style={{ fontWeight: 500, color: 'var(--wp-fg)' }}>
          Pair a new agent
        </span>
        <button
          type="button"
          className="wp-btn wp-btn-primary"
          onClick={() => setPairOpen(true)}
        >
          Pair a new agent
        </button>
      </div>

      {/* Paired agents */}
      {agentsLoading ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Paired agents</h2>
          </div>
          <div className="wp-inset-group">
            <SkeletonRow titleWidth="40%" subWidth="50%" showTrailing />
            <SkeletonRow titleWidth="48%" subWidth="45%" showTrailing />
          </div>
        </section>
      ) : (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Paired agents</h2>
            <span className="wp-section-aside">
              {filteredAgents.length} {filteredAgents.length === 1 ? 'agent' : 'agents'}
            </span>
          </div>
          {profileFilter ? (
            <div
              className="wp-secondary"
              style={{
                padding: '0 var(--s-4)',
                fontSize: 'var(--fs-small)',
                lineHeight: 1.6,
              }}
            >
              Showing agents on profile <strong style={{ color: 'var(--wp-fg)' }}>{filterDisplayName}</strong>
              {' · '}
              <a href="/ui/agents/" className="wp-link">Clear</a>
            </div>
          ) : null}
          {filteredAgents.length === 0 ? (
            <div className="wp-card">
              <div className="wp-empty" style={{ padding: 0 }}>
                {profileFilter
                  ? `No agents paired to ${filterDisplayName} yet.`
                  : 'No agents paired yet. Use “Pair a new agent” above to copy the setup prompt for your AI agent.'}
              </div>
            </div>
          ) : (
            <div className="wp-row-list">
              {filteredAgents.map((a) => (
                <AgentRow
                  key={a.key}
                  agent={a}
                  profiles={profiles}
                  onRename={handleRename}
                  onRevoke={handleRevoke}
                  onRebind={handleRebind}
                  port={port}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <ConfirmModal
        open={!!revokeTarget}
        title="Revoke API key?"
        body={
          revokeTarget
            ? `${revokeTarget.name || 'Agent'}’s API key stops working immediately. They can re-pair to come back.`
            : ''
        }
        confirmLabel="Revoke"
        confirmDanger
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
      />

      <PairAgentModal
        open={pairOpen}
        onClose={() => setPairOpen(false)}
        port={port}
        profiles={profiles}
      />
    </>
  );
}
