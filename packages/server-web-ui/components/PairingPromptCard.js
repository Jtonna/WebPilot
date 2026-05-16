'use client';

import { useState } from 'react';

const DEFAULT_PROFILE_OPTIONS = [
  { value: 'Default', label: 'Default' },
  { value: 'Profile 2', label: 'Profile 2' },
  { value: '__new__', label: '+ New sandbox profile' },
];

function shortPairingId(id) {
  if (!id) return '';
  const s = String(id);
  return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

/**
 * PairingPromptCard — inline approve/deny card for a single pending pairing.
 *
 * Layout:
 *   [agent name              ]  [profile <select>] [Approve] [Deny]
 *   [short pairing id · time ]
 *   [optional new-profile name input expanded under the dropdown]
 *
 * Phase 2 refresh:
 *   - "+ New sandbox profile" expands an inline input beneath the dropdown.
 *   - Approve label flips to "Approve and create" when __new__ is selected.
 *   - Deny is a ghost-danger button (transparent bg, danger text, danger
 *     bg-tint on hover) — see .wp-btn-danger in globals.css.
 */
export default function PairingPromptCard({
  pairing,
  profileOptions = DEFAULT_PROFILE_OPTIONS,
  onApprove,
  onDeny,
  disabled = false,
}) {
  const [selectedProfile, setSelectedProfile] = useState(profileOptions[0]?.value || 'Default');
  const [newProfileName, setNewProfileName] = useState('');

  const isNew = selectedProfile === '__new__';
  const trimmedNewName = newProfileName.trim();
  const approveDisabled = disabled || (isNew && trimmedNewName.length === 0);

  const handleApprove = () => {
    if (onApprove) onApprove(pairing, selectedProfile, isNew ? trimmedNewName : undefined);
  };

  const handleDeny = () => {
    if (onDeny) onDeny(pairing);
  };

  return (
    <div
      className="wp-row"
      style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
    >
      <div className="wp-row-grow">
        <div className="wp-row-title">{pairing.agentName || 'Unnamed agent'}</div>
        <div className="wp-row-sub">
          <span className="wp-mono" title={pairing.pairingId}>{shortPairingId(pairing.pairingId)}</span>
          <span className="wp-row-sep">·</span>
          <span>
            Requested {pairing.createdAt ? new Date(pairing.createdAt).toLocaleTimeString() : 'just now'}
          </span>
        </div>
        {isNew ? (
          <div style={{ marginTop: 'var(--s-3)', maxWidth: 320 }}>
            <input
              type="text"
              className="wp-input"
              placeholder="New profile name"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              disabled={disabled}
            />
          </div>
        ) : null}
      </div>
      <div className="wp-row-actions" style={{ flexWrap: 'wrap' }}>
        <select
          className="wp-select"
          style={{ width: 'auto', minWidth: 200 }}
          value={selectedProfile}
          onChange={(e) => setSelectedProfile(e.target.value)}
          disabled={disabled}
        >
          {profileOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="wp-btn wp-btn-primary"
          onClick={handleApprove}
          disabled={approveDisabled}
        >
          {disabled ? 'Pairing…' : (isNew ? 'Approve and create' : 'Approve')}
        </button>
        <button
          type="button"
          className="wp-btn wp-btn-danger"
          onClick={handleDeny}
          disabled={disabled}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
