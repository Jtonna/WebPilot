'use client';

import { useState } from 'react';
import {
  DocumentDuplicateIcon,
  PencilSquareIcon,
  TrashIcon,
  CheckIcon,
} from '@heroicons/react/20/solid';
import { formatRelativeTime, profileLabel } from '../lib/format';
import { buildMcpConfigJson } from '../lib/mcpConfig';

function shortKey(key) {
  if (!key) return '';
  return `${String(key).slice(0, 10)}…`;
}

export default function AgentRow({ agent, profiles = [], onRename, onRevoke, onRebind, port }) {
  const [editing, setEditing] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [name, setName] = useState(agent.name || '');
  const [copyState, setCopyState] = useState('idle');

  // Resolve the bound profile's display name from the profiles list. Falls
  // back to the raw directoryName so a stale or unknown binding is still
  // surfaced rather than silently rendered as blank.
  const boundLabel = agent.profileId
    ? profileLabel(profiles, agent.profileId)
    : null;

  const commitRename = () => {
    setEditing(false);
    if (name === agent.name) return;
    if (onRename) onRename(agent, name);
  };

  const handleRevoke = () => {
    if (onRevoke) onRevoke(agent);
  };

  const handleCopy = async () => {
    if (!port || !agent.key) {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 1500);
      return;
    }
    try {
      await navigator.clipboard.writeText(buildMcpConfigJson({ port, apiKey: agent.key }));
      setCopyState('copied');
    } catch (_e) {
      setCopyState('error');
    }
    setTimeout(() => setCopyState('idle'), 1500);
  };

  return (
    <div className="wp-row">
      <div className="wp-row-grow">
        {editing ? (
          <input
            className="wp-input"
            value={name}
            autoFocus
            placeholder="Pick a memorable name"
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
          <>
            <div className="wp-row-title">
              {agent.name || <span className="wp-empty" style={{ fontSize: 15 }}>Unnamed agent</span>}
            </div>
            <div className="wp-row-sub">
              <span className="wp-mono" title={agent.key}>{shortKey(agent.key)}</span>
              <span className="wp-row-sep">·</span>
              <span>Last active {formatRelativeTime(agent.lastActive)}</span>
            </div>
            <div className="wp-row-sub" style={{ marginTop: 2 }}>
              {editingProfile ? (
                <select
                  className="wp-input wp-input-compact"
                  defaultValue={agent.profileId || ''}
                  autoFocus
                  disabled={!onRebind}
                  onBlur={() => setEditingProfile(false)}
                  onChange={(e) => {
                    const next = e.target.value;
                    setEditingProfile(false);
                    if (!next || next === agent.profileId) return;
                    if (onRebind) onRebind(agent, next);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditingProfile(false);
                  }}
                >
                  {(!agent.profileId || !profiles.some((p) => p.directoryName === agent.profileId)) && agent.profileId ? (
                    <option value={agent.profileId}>{agent.profileId} (current)</option>
                  ) : null}
                  {profiles.map((p) => (
                    <option key={p.directoryName} value={p.directoryName}>
                      {p.displayName || p.directoryName}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  type="button"
                  className="wp-row-rebind"
                  onClick={() => onRebind && setEditingProfile(true)}
                  disabled={!onRebind || profiles.length === 0}
                  title={onRebind ? 'Change profile' : 'Binding shown for reference'}
                  aria-label="Change profile"
                >
                  <span>
                    Bound to{' '}
                    <strong style={{ color: 'var(--wp-fg)', fontWeight: 500 }}>
                      {boundLabel || 'no profile'}
                    </strong>
                  </span>
                  {onRebind && profiles.length > 0 ? (
                    <PencilSquareIcon
                      style={{
                        width: 14,
                        height: 14,
                        marginLeft: 6,
                        verticalAlign: 'text-bottom',
                        opacity: 0.6,
                      }}
                    />
                  ) : null}
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="wp-row-actions">
        <button
          type="button"
          className="wp-btn wp-btn-compact"
          onClick={handleCopy}
          disabled={!port || !agent.key}
          title={port ? 'Copy a .mcp.json snippet for this agent' : 'Server port unknown — refresh the page'}
        >
          {copyState === 'copied' ? (
            <><CheckIcon style={{ width: 16, height: 16 }} /> Copied</>
          ) : copyState === 'error' ? (
            <>Copy failed</>
          ) : (
            <><DocumentDuplicateIcon style={{ width: 16, height: 16 }} /> Copy config</>
          )}
        </button>
        <button
          type="button"
          className="wp-btn wp-btn-compact"
          onClick={() => setEditing(true)}
          aria-label="Rename"
          title="Rename"
        >
          <PencilSquareIcon style={{ width: 16, height: 16 }} /> Rename
        </button>
        <button
          type="button"
          className="wp-btn wp-btn-compact wp-btn-danger"
          onClick={handleRevoke}
          aria-label="Revoke"
          title="Revoke"
        >
          <TrashIcon style={{ width: 16, height: 16 }} /> Revoke
        </button>
      </div>
    </div>
  );
}
