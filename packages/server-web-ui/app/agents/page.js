'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AgentRow from '../../components/AgentRow';
import ConfirmModal from '../../components/ConfirmModal';
import { SkeletonRow } from '../../components/Skeleton';
import { useToast } from '../../components/ToastRegion';
import { createSequencedFetcher, getStatus, renameAgent, revokeAgent } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

/**
 * Agents — pairing-first layout.
 *
 * Sections (top → bottom):
 *   1. Pair a new agent  — always-visible single bar. One block of natural-
 *                          language instructions (with the actual MCP server
 *                          URL inline) + one Copy button. Self-sufficient for
 *                          both AI-driven pairing and manual .mcp.json setup.
 *   2. Paired agents     — list. Filtered by ?profile=<directoryName> when
 *                          set (with a small "Clear" banner above).
 */

// The pairing instructions the user copies and pastes into their AI agent.
// Includes the actual MCP server URL inline so a human reading it can also
// drop it into .mcp.json by hand without needing a separate snippet.
function buildAgentPrompt(port) {
  const portStr = port ? String(port) : '<port>';
  return (
    `Connect to my WebPilot MCP server at http://localhost:${portStr}/sse — ` +
    `that's the URL for your .mcp.json if you need it.\n\n` +
    `You don't have an API key yet. Call request_pairing with a memorable ` +
    `agent_name (e.g. the project or client name). The tool returns a ` +
    `pairing_id and instructions; follow them — surface the approval URL ` +
    `to me, wait for me to approve, then call check_pairing_status with ` +
    `the pairing_id to retrieve your api_key. Once you have the key, ` +
    `include it as the api_key parameter on each tool call, or tell me to ` +
    `paste it into .mcp.json under headers."X-API-Key" and restart this client.`
  );
}

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

  const agentPrompt = buildAgentPrompt(port);

  return (
    <>
      <header className="wp-page-head">
        <h1 className="wp-page-title">Agents</h1>
        <p className="wp-page-sub">
          MCP agents authorized to drive your browser. Each holds an API key
          bound to a Chrome profile.
        </p>
      </header>

      {error ? (
        <div className="wp-card">
          <div style={{ color: 'var(--wp-danger)', fontWeight: 500, marginBottom: 6 }}>
            Couldn’t reach the server.
          </div>
          <div className="wp-secondary" style={{ fontSize: 14 }}>{error.message}</div>
        </div>
      ) : null}

      {/* Single pair-agent bar — self-sufficient for both AI and manual setup. */}
      <section className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Pair a new agent</h2>
        </div>
        <PairingPromptHero prompt={agentPrompt} />
      </section>

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
                  : 'No agents paired yet. Copy the prompt above into your AI agent to get started.'}
              </div>
            </div>
          ) : (
            <div className="wp-row-list">
              {filteredAgents.map((a) => (
                <AgentRow
                  key={a.key}
                  agent={a}
                  onRename={handleRename}
                  onRevoke={handleRevoke}
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
    </>
  );
}

/**
 * Single pair-agent bar. One heading, one subhead, the copy-text in a
 * <pre class="wp-code"> with an overlay Copy button. Self-sufficient for
 * both AI-driven pairing (copy → paste into agent) and manual setup
 * (read the URL out of the copy-text and drop it into .mcp.json).
 */
function PairingPromptHero({ prompt }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_e) { /* ignore */ }
  }
  return (
    <div className="wp-card wp-card-lg">
      <p
        style={{
          margin: 0,
          marginBottom: 'var(--s-4)',
          color: 'var(--wp-fg-secondary)',
          maxWidth: '62ch',
        }}
      >
        Copy this and paste it into your AI agent — or use the URL to set it up manually.
      </p>
      <div className="wp-code-wrap">
        <pre className="wp-code" style={{ whiteSpace: 'pre-wrap' }}>{prompt}</pre>
        <button
          type="button"
          className="wp-btn wp-btn-primary wp-btn-compact wp-code-copy"
          onClick={handleCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
