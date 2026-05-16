'use client';

import { useEffect, useRef, useState } from 'react';
import AgentRow from '../../components/AgentRow';
import ConfirmModal from '../../components/ConfirmModal';
import PairAgentModal from '../../components/PairAgentModal';
import RevealSection from '../../components/RevealSection';
import { useToast } from '../../components/ToastRegion';
import { createSequencedFetcher, getStatus, renameAgent, revokeAgent } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

/**
 * Agents — per UX §Agents.
 *
 * Sections (order depends on whether any agents are paired):
 *   - Pair a new agent     — primary CTA → PairAgentModal.
 *                            Promoted to top when list empty; demoted below
 *                            when list has items.
 *   - Paired agents        — AgentRow list.
 *   - Manual setup (advanced) — RevealSection, collapsed by default. Holds
 *                            the URL-only .mcp.json + agent prompt + steps.
 */
export default function AgentsPage() {
  const [agents, setAgents]   = useState([]);
  const [port, setPort]       = useState(null);
  const [error, setError]     = useState(null);
  const [pairOpen, setPairOpen] = useState(false);
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
      }));
      setAgents(normalized);
      setPort(data.port || null);
      setError(null);
    } catch (err) {
      setError(err);
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
      toast.error(e.message || 'Rename failed.');
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
      toast.error(e.message || 'Revoke failed.');
    }
  }

  const empty = agents.length === 0;

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
            Something went wrong.
          </div>
          <div className="wp-secondary" style={{ fontSize: 14 }}>{error.message}</div>
        </div>
      ) : null}

      {empty ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Pair a new agent</h2>
          </div>
          <div className="wp-card wp-card-lg">
            <p className="wp-secondary" style={{ marginTop: 0, marginBottom: 'var(--s-4)', maxWidth: '60ch' }}>
              No agents paired yet. Walk through three short steps to get your
              first client talking to WebPilot.
            </p>
            <button
              type="button"
              className="wp-btn wp-btn-primary wp-btn-cta"
              onClick={() => setPairOpen(true)}
            >
              Pair a new agent
            </button>
          </div>
        </section>
      ) : null}

      {!empty ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Paired agents</h2>
            <span className="wp-section-aside">
              {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
            </span>
          </div>
          <div className="wp-card">
            {agents.map((a) => (
              <AgentRow
                key={a.key}
                agent={a}
                onRename={handleRename}
                onRevoke={handleRevoke}
                port={port}
              />
            ))}
          </div>
        </section>
      ) : null}

      {!empty ? (
        <section className="wp-section">
          <div className="wp-section-head">
            <h2 className="wp-section-title">Pair a new agent</h2>
          </div>
          <div className="wp-card">
            <p className="wp-secondary" style={{ marginTop: 0, marginBottom: 'var(--s-3)', maxWidth: '60ch' }}>
              Add another client. Same three-step walkthrough.
            </p>
            <button
              type="button"
              className="wp-btn wp-btn-primary"
              onClick={() => setPairOpen(true)}
            >
              Pair a new agent
            </button>
          </div>
        </section>
      ) : null}

      <RevealSection className="wp-section">
        <div className="wp-section-head">
          <h2 className="wp-section-title">Manual setup (advanced)</h2>
        </div>
        <ManualSetupCard port={port} />
      </RevealSection>

      <PairAgentModal
        open={pairOpen}
        port={port}
        onClose={() => setPairOpen(false)}
        onPaired={() => { refresh(); }}
      />

      <ConfirmModal
        open={!!revokeTarget}
        title="Revoke API key?"
        body={
          revokeTarget
            ? `Their API key stops working immediately. They can re-pair to come back.`
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

function ManualSetupCard({ port }) {
  const portStr = port ? String(port) : '<port>';
  const urlOnlyConfig = `{
  "mcpServers": {
    "webpilot": {
      "url": "http://localhost:${portStr}/sse"
    }
  }
}`;
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(urlOnlyConfig);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_e) { /* ignore */ }
  }
  return (
    <div className="wp-card">
      <p className="wp-secondary" style={{ marginTop: 0, marginBottom: 'var(--s-4)', maxWidth: '60ch' }}>
        For users who prefer to paste the config themselves.
      </p>
      <div className="wp-code-wrap">
        <pre className="wp-code">{urlOnlyConfig}</pre>
        <button
          type="button"
          className="wp-btn wp-btn-compact wp-code-copy"
          onClick={handleCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <ol style={{
        paddingLeft: 20,
        margin: 'var(--s-4) 0 0',
        color: 'var(--wp-fg-secondary)',
        fontSize: 14,
        lineHeight: 1.7,
      }}>
        <li>Paste the snippet above into your project’s <code>.mcp.json</code>.</li>
        <li>Restart your MCP client so it picks up the new server.</li>
        <li>Ask the agent to call <code>request_pairing</code> with a memorable name.</li>
        <li>Approve the request on the Pairings page when it appears.</li>
      </ol>
    </div>
  );
}
