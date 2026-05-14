'use client';

import { useState } from 'react';
import PairingPromptCard from '../../components/PairingPromptCard';

const PLACEHOLDER_PAIRINGS = [
  {
    pairingId: 'pl-1',
    agentName: 'claude-code (laptop)',
    createdAt: Date.now() - 1000 * 60 * 2,
    status: 'pending',
  },
  {
    pairingId: 'pl-2',
    agentName: 'cursor (desktop)',
    createdAt: Date.now() - 1000 * 60 * 15,
    status: 'pending',
  },
];

const PROFILE_OPTIONS = [
  { value: 'Default', label: 'Default' },
  { value: 'Profile 2', label: 'Profile 2' },
  { value: '__new__', label: '+ New sandbox profile' },
];

export default function PairingsPage() {
  const [pairings] = useState(PLACEHOLDER_PAIRINGS);

  return (
    <>
      <div>
        <h1 className="wp-page-title">Pending pairings</h1>
        <p className="wp-page-sub">
          Approve or deny pairing requests from MCP agents.
        </p>
      </div>

      <div className="wp-card">
        <h2>Waiting for review</h2>
        {pairings.length === 0 ? (
          <div className="wp-muted">No pairings waiting.</div>
        ) : (
          pairings.map((p) => (
            <PairingPromptCard
              key={p.pairingId}
              pairing={p}
              profileOptions={PROFILE_OPTIONS}
            />
          ))
        )}
      </div>

      <div className="wp-card">
        <h2>History</h2>
        <div className="wp-muted">No prior decisions yet.</div>
      </div>
    </>
  );
}
