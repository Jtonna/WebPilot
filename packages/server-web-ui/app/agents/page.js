'use client';

import { useState } from 'react';
import AgentRow from '../../components/AgentRow';

const PLACEHOLDER_AGENTS = [
  {
    key: 'a1b2c3d4e5f6g7h8i9j0',
    name: 'claude-code (laptop)',
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 3,
    lastActive: Date.now() - 1000 * 60 * 5,
  },
  {
    key: 'z9y8x7w6v5u4t3s2r1q0',
    name: 'cursor (desktop)',
    createdAt: Date.now() - 1000 * 60 * 60 * 24 * 14,
    lastActive: Date.now() - 1000 * 60 * 60 * 6,
  },
];

export default function AgentsPage() {
  const [agents] = useState(PLACEHOLDER_AGENTS);

  return (
    <>
      <div>
        <h1 className="wp-page-title">Paired agents</h1>
        <p className="wp-page-sub">
          Agents currently authorized to talk to this WebPilot server.
        </p>
      </div>

      <div className="wp-card">
        <h2>Active agents</h2>
        {agents.length === 0 ? (
          <div className="wp-muted">No agents paired yet.</div>
        ) : (
          agents.map((a) => <AgentRow key={a.key} agent={a} />)
        )}
      </div>
    </>
  );
}
