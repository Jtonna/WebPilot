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

/**
 * Build the `.mcp.json` snippet a user can paste into a project to wire this
 * WebPilot server as an MCP server for their agent. The URL hardcodes
 * `localhost`; users editing for a remote WebPilot server can swap the host
 * after pasting. See Wave 6 H6.
 */
function buildMcpConfigSnippet({ port, apiKey }) {
  const config = {
    mcpServers: {
      webpilot: {
        url: `http://localhost:${port}/sse`,
        headers: {
          'X-API-Key': apiKey,
        },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

export default function AgentRow({ agent, onRename, onRevoke, port }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name || '');
  // 'idle' | 'copied' | 'error' — drives the inline "Copied!" confirmation.
  const [copyState, setCopyState] = useState('idle');

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

  const handleCopyMcpConfig = async () => {
    if (!port || !agent.key) {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2000);
      return;
    }
    const snippet = buildMcpConfigSnippet({ port, apiKey: agent.key });
    try {
      await navigator.clipboard.writeText(snippet);
      setCopyState('copied');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log('[agent] clipboard write failed:', err && err.message);
      setCopyState('error');
    }
    setTimeout(() => setCopyState('idle'), 2000);
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
      <button
        type="button"
        className="wp-btn"
        onClick={handleCopyMcpConfig}
        disabled={!port || !agent.key}
        title={port ? 'Copy a .mcp.json snippet for this agent' : 'Server port unknown — refresh the page'}
      >
        {copyState === 'copied' ? 'Copied!' : copyState === 'error' ? 'Copy failed' : 'Copy MCP config'}
      </button>
      <button type="button" className="wp-btn wp-btn-danger" onClick={handleRevoke}>
        Revoke
      </button>
    </div>
  );
}
