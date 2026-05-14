'use client';

import { useState } from 'react';

const DEFAULT_PROFILE_OPTIONS = [
  { value: 'Default', label: 'Default' },
  { value: 'Profile 2', label: 'Profile 2' },
  { value: '__new__', label: '+ New sandbox profile' },
];

export default function PairingPromptCard({
  pairing,
  profileOptions = DEFAULT_PROFILE_OPTIONS,
  onApprove,
  onDeny,
  disabled = false,
}) {
  const [selectedProfile, setSelectedProfile] = useState(profileOptions[0]?.value || 'Default');

  const handleApprove = () => {
    if (onApprove) {
      onApprove(pairing, selectedProfile);
    } else {
      // eslint-disable-next-line no-console
      console.log('[pairing] approve (stub)', { pairing, profileId: selectedProfile });
    }
  };

  const handleDeny = () => {
    if (onDeny) {
      onDeny(pairing);
    } else {
      // eslint-disable-next-line no-console
      console.log('[pairing] deny (stub)', { pairing });
    }
  };

  return (
    <div className="wp-row">
      <div className="wp-row-grow">
        <div style={{ fontWeight: 600 }}>{pairing.agentName}</div>
        <div className="wp-muted">
          Requested {pairing.createdAt ? new Date(pairing.createdAt).toLocaleString() : 'just now'}
        </div>
      </div>
      <select
        className="wp-select"
        value={selectedProfile}
        onChange={(e) => setSelectedProfile(e.target.value)}
        disabled={disabled}
      >
        {profileOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <button type="button" className="wp-btn wp-btn-primary" onClick={handleApprove} disabled={disabled}>
        Approve
      </button>
      <button type="button" className="wp-btn wp-btn-danger" onClick={handleDeny} disabled={disabled}>
        Deny
      </button>
    </div>
  );
}
