'use client';

import { useState } from 'react';

function shortKey(key) {
  if (!key) return '';
  return `${String(key).slice(0, 8)}...`;
}

function formatDate(value) {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

export default function AgentRow({ agent, onRename, onRevoke }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name || '');

  const commitRename = () => {
    setEditing(false);
    if (name === agent.name) return;
    if (onRename) {
      onRename(agent, name);
    } else {
      // eslint-disable-next-line no-console
      console.log('[agent] rename (stub)', { agent, newName: name });
    }
  };

  const handleRevoke = () => {
    if (onRevoke) {
      onRevoke(agent);
    } else {
      // eslint-disable-next-line no-console
      console.log('[agent] revoke (stub)', { agent });
    }
  };

  return (
    <div className="wp-row">
      <div className="wp-row-grow">
        {editing ? (
          <input
            className="wp-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setName(agent.name || '');
                setEditing(false);
              }
            }}
          />
        ) : (
          <span
            style={{ fontWeight: 600, cursor: 'text' }}
            title="Click to rename"
            onClick={() => setEditing(true)}
          >
            {agent.name || '(unnamed)'}
          </span>
        )}
      </div>
      <span className="wp-mono wp-muted" title={agent.key}>{shortKey(agent.key)}</span>
      <span className="wp-muted" style={{ minWidth: 140 }}>
        created {formatDate(agent.createdAt)}
      </span>
      <span className="wp-muted" style={{ minWidth: 140 }}>
        last active {formatDate(agent.lastActive)}
      </span>
      <button type="button" className="wp-btn wp-btn-danger" onClick={handleRevoke}>
        Revoke
      </button>
    </div>
  );
}
