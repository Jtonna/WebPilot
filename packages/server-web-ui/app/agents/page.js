'use client';

import { useEffect, useRef, useState } from 'react';
import AgentRow from '../../components/AgentRow';
import ConfirmModal from '../../components/ConfirmModal';
import { createSequencedFetcher, getStatus, renameAgent, revokeAgent } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [port, setPort] = useState(null);
  const [error, setError] = useState(null);
  // Pending revoke confirmation. `null` = modal closed; otherwise the agent
  // whose key is about to be revoked.
  const [revokeTarget, setRevokeTarget] = useState(null);
  // See QOL Wave 6 H2 — REST/WS refresh race guard.
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getStatus());
      if (isStale) return;
      // Normalize server shape (agentName/key/createdAt/lastAccessed) -> UI shape (name/key/createdAt/lastActive)
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
      await refresh();
    } catch (e) {
      setError(e);
    }
  }

  function handleRevoke(agent) {
    // Custom themed modal — see ConfirmModal & QOL fix-up F7.
    console.log('[agents] queueing revoke confirmation for', agent && agent.name);
    setRevokeTarget(agent);
  }

  async function confirmRevoke() {
    const agent = revokeTarget;
    setRevokeTarget(null);
    if (!agent) return;
    try {
      await revokeAgent(agent.key);
      await refresh();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <div>
        <h1 className="wp-page-title">Paired agents</h1>
        <p className="wp-page-sub">
          Agents currently authorized to talk to this WebPilot server.
        </p>
      </div>

      {error ? (
        <div className="wp-card">
          <div className="wp-muted">Error: {error.message}</div>
        </div>
      ) : null}

      <div className="wp-card">
        <h2>Active agents</h2>
        {agents.length === 0 ? (
          <div className="wp-muted">No agents paired yet.</div>
        ) : (
          agents.map((a) => (
            <AgentRow
              key={a.key}
              agent={a}
              onRename={handleRename}
              onRevoke={handleRevoke}
              port={port}
            />
          ))
        )}
      </div>

      <div className="wp-card">
        <h2>Wire WebPilot into your project</h2>
        <p className="wp-muted" style={{ marginTop: 0 }}>
          Use a paired agent's <strong>Copy MCP config</strong> button to copy a
          ready-to-paste <code>.mcp.json</code> snippet. The snippet uses the
          current server port (
          <span className="wp-mono">{port ? String(port) : 'unknown'}</span>) and
          the agent's API key as <code>X-API-Key</code>.
        </p>
        <pre className="wp-mono wp-code-block" style={{
          background: 'var(--wp-bg-elevated)',
          border: '1px solid var(--wp-border)',
          borderRadius: 6,
          padding: 12,
          overflowX: 'auto',
          margin: '12px 0',
          color: 'var(--wp-fg)',
        }}>
{`{
  "mcpServers": {
    "webpilot": {
      "url": "http://localhost:${port || '<port>'}/sse",
      "headers": {
        "X-API-Key": "<your-agent-api-key>"
      }
    }
  }
}`}
        </pre>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            Copy the snippet above (<strong>Copy MCP config</strong> button next
            to the agent).
          </li>
          <li>
            In your project root, create or merge into <code>.mcp.json</code>
            {' '}(project-level only — do <strong>not</strong> put your API key
            in user-level config).
          </li>
          <li>
            Restart your MCP client (Claude Code, Cursor, etc.) so it picks up
            the new server.
          </li>
          <li>
            Verify by asking the agent to call{' '}
            <code>browser_get_tabs</code>.
          </li>
        </ol>
      </div>

      <ConfirmModal
        open={!!revokeTarget}
        title="Revoke API key?"
        body={
          revokeTarget
            ? `This permanently revokes the API key for "${revokeTarget.name || '(unnamed)'}". The agent will need to re-pair to reconnect.`
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
