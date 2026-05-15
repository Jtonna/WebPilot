'use client';

import { useState } from 'react';
import { useFlashOnChange } from '../lib/reveal';

function shortKey(key) {
  if (!key) return '';
  return `${String(key).slice(0, 10)}…`;
}

function formatDate(value) {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
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

export default function AgentRow({ agent, onRename, onRevoke, port, leaving = false }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.name || '');
  const [copyState, setCopyState] = useState('idle');
  // Briefly highlights the "LAST" timestamp whenever the underlying value
  // changes. Skips the initial mount so static rows don't flash on load.
  const lastActiveFlash = useFlashOnChange(agent.lastActive);

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

  const copyLabel =
    copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy config';

  return (
    <div className={`wp-row${leaving ? ' wp-row-leave' : ''}`}>
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
          <>
            <div
              className="wp-row-title"
              title="Click to rename"
              style={{ cursor: 'text' }}
              onClick={() => setEditing(true)}
            >
              {agent.name || <span className="wp-empty" style={{ fontSize: 15 }}>Unnamed agent</span>}
            </div>
            <div className="wp-row-sub">
              <span className="wp-mono" title={agent.key}>{shortKey(agent.key)}</span>
              <span className="wp-row-sep">·</span>
              <span>Created {formatDate(agent.createdAt)}</span>
              <span className="wp-row-sep">·</span>
              <span className={lastActiveFlash ? 'wp-flash' : undefined}>
                Last active {formatDate(agent.lastActive)}
              </span>
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        className={`wp-btn${copyState === 'copied' ? ' is-copied' : ''}`}
        onClick={handleCopyMcpConfig}
        disabled={!port || !agent.key}
        title={port ? 'Copy a .mcp.json snippet for this agent' : 'Server port unknown — refresh the page'}
      >
        {copyLabel}
      </button>
      <button type="button" className="wp-btn wp-btn-danger" onClick={handleRevoke}>
        Revoke
      </button>
    </div>
  );
}
