'use client';

import { useEffect, useState } from 'react';
import AgentRow from '../../components/AgentRow';
import ConfirmModal from '../../components/ConfirmModal';
import { getStatus, renameAgent, revokeAgent } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState(null);
  // Pending revoke confirmation. `null` = modal closed; otherwise the agent
  // whose key is about to be revoked.
  const [revokeTarget, setRevokeTarget] = useState(null);

  async function refresh() {
    try {
      const data = await getStatus();
      // Normalize server shape (agentName/key/createdAt/lastAccessed) -> UI shape (name/key/createdAt/lastActive)
      const normalized = (data.pairedAgents || []).map((a) => ({
        key: a.key,
        name: a.agentName,
        createdAt: a.createdAt,
        lastActive: a.lastAccessed,
      }));
      setAgents(normalized);
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
            <AgentRow key={a.key} agent={a} onRename={handleRename} onRevoke={handleRevoke} />
          ))
        )}
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
