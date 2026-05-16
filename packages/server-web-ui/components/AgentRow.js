'use client';

import { useState } from 'react';
import {
  DocumentDuplicateIcon,
  PencilSquareIcon,
  TrashIcon,
  CheckIcon,
} from '@heroicons/react/20/solid';
import { formatRelativeTime } from '../lib/format';

function shortKey(key) {
  if (!key) return '';
  return `${String(key).slice(0, 10)}…`;
}

function buildMcpConfigSnippet({ port, apiKey }) {
  const config = {
    mcpServers: {
      webpilot: {
        url: `http://localhost:${port}/sse`,
        headers: { 'X-API-Key': apiKey },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

export default function AgentRow({ agent, onRename, onRevoke, port }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name || '');
  const [copyState, setCopyState] = useState('idle');

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
      await navigator.clipboard.writeText(buildMcpConfigSnippet({ port, apiKey: agent.key }));
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
