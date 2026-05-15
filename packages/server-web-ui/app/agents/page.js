'use client';

import { useEffect, useRef, useState } from 'react';
import AgentRow from '../../components/AgentRow';
import ConfirmModal from '../../components/ConfirmModal';
import { createSequencedFetcher, getStatus, renameAgent, revokeAgent } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [port, setPort] = useState(null);
  const [error, setError] = useState(null);
  // Pending revoke confirmation. `null` = modal closed; otherwise the agent
  // whose key is about to be revoked.
  const [revokeTarget, setRevokeTarget] = useState(null);
  // See QOL Wave 6 H2 — REST/WS refresh race guard.
  const fetcherRef = useRef(null);
  if (fetcherRef.current === null) {
    fetcherRef.current = createSequencedFetcher();
  }

  async function refresh() {
    try {
      const { data, isStale } = await fetcherRef.current.fetch(() => getStatus());
      if (isStale) return;
      // Normalize server shape (agentName/key/createdAt/lastAccessed) -> UI shape (name/key/createdAt/lastActive)
      const normalized = (data.pairedAgents || []).map((a) => ({
        key: a.key,
        name: a.agentName,
        createdAt: a.createdAt,
        lastActive: a.lastAccessed,
      }));
      setAgents(normalized);
      setPort(data.port || null);
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
            <AgentRow
              key={a.key}
              agent={a}
              onRename={handleRename}
              onRevoke={handleRevoke}
              port={port}
            />
          ))
        )}
      </div>

      <FirstTimeSetupCard port={port} />

      <div className="wp-card">
        <h2>Already-paired agents</h2>
        <p className="wp-muted" style={{ marginTop: 0 }}>
          For an agent that already has a key, use its <strong>Copy MCP config</strong> button
          above to copy a ready-to-paste <code>.mcp.json</code> snippet. The snippet uses the
          current server port (
          <span className="wp-mono">{port ? String(port) : 'unknown'}</span>) and
          the agent's API key as <code>X-API-Key</code>.
        </p>
        <pre className="wp-mono wp-code-block" style={{
          background: 'var(--wp-bg-elevated)',
          border: '1px solid var(--wp-border)',
          borderRadius: 6,
          padding: 12,
          overflowX: 'auto',
          margin: '12px 0',
          color: 'var(--wp-fg)',
        }}>
{`{
  "mcpServers": {
    "webpilot": {
      "url": "http://localhost:${port || '<port>'}/sse",
      "headers": {
        "X-API-Key": "<your-agent-api-key>"
      }
    }
  }
}`}
        </pre>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          <li>
            Copy the snippet above (<strong>Copy MCP config</strong> button next
            to the agent).
          </li>
          <li>
            In your project root, create or merge into <code>.mcp.json</code>
            {' '}(project-level only — do <strong>not</strong> put your API key
            in user-level config).
          </li>
          <li>
            Restart your MCP client (Claude Code, Cursor, etc.) so it picks up
            the new server.
          </li>
          <li>
            Verify by asking the agent to call{' '}
            <code>browser_get_tabs</code>.
          </li>
        </ol>
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

// ---- First-time-setup card -------------------------------------------------
// Shows the URL-only .mcp.json snippet plus a copyable agent prompt for a
// brand-new MCP client that does not yet have a paired API key. The flow:
//   1. user drops the URL-only config into their project
//   2. user pastes the agent prompt into their AI client
//   3. agent calls request_pairing → pairing request appears in this UI
//   4. user approves → agent retrieves api_key via check_pairing_status
//   5. agent stores key (either as a tool argument or via .mcp.json header)

function FirstTimeSetupCard({ port }) {
  const portStr = port ? String(port) : '<port>';

  const urlOnlyConfig = `{
  "mcpServers": {
    "webpilot": {
      "url": "http://localhost:${portStr}/sse"
    }
  }
}`;

  const agentPrompt =
    "You have access to a WebPilot MCP server but no API key yet. " +
    "Call request_pairing with a memorable agent_name (e.g. the project " +
    "or your client name). The tool returns a pairing_id and instructions; " +
    "follow them — surface the approval URL to me, wait for me to approve, " +
    "then call check_pairing_status with the pairing_id to retrieve your " +
    "api_key. Once you have the key, include it as the api_key parameter on " +
    "each tool call, or tell me to paste it into .mcp.json under " +
    "headers.\"X-API-Key\" and restart this client.";

  return (
    <div className="wp-card">
      <h2>First-time setup (new agent, no key yet)</h2>
      <p className="wp-muted" style={{ marginTop: 0 }}>
        For an MCP client that has never paired with this server. The agent
        will pair itself using the tools the server exposes — you only need
        to approve the request when it appears here.
      </p>

      <p style={{ marginBottom: 6 }}>
        <strong>1.</strong> Add WebPilot to your project&apos;s
        {' '}<code>.mcp.json</code> (URL only, no key yet):
      </p>
      <CopyableBlock text={urlOnlyConfig} />

      <p style={{ marginTop: 16, marginBottom: 6 }}>
        <strong>2.</strong> Paste this prompt into the agent to kick off pairing:
      </p>
      <CopyableBlock text={agentPrompt} />

      <p style={{ marginTop: 16 }}>
        <strong>3.</strong> A pairing request will appear at the top of this
        page (with a system notification + sound). Approve it, picking the
        Chrome profile the agent is allowed to drive.
      </p>

      <p>
        <strong>4.</strong> Once approved, the agent appears under{' '}
        <strong>Active agents</strong> above. Use its{' '}
        <strong>Copy MCP config</strong> button for the keyed snippet that
        lets future sessions skip step 2.
      </p>
    </div>
  );
}

// ---- Inline copyable code block --------------------------------------------
// Renders a <pre> with a small "Copy" button that flips to "Copied!" for 2s.

function CopyableBlock({ text }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('[agents] clipboard write failed', e);
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <pre
        className="wp-mono wp-code-block"
        style={{
          background: 'var(--wp-bg-elevated)',
          border: '1px solid var(--wp-border)',
          borderRadius: 6,
          padding: 12,
          paddingRight: 88,
          overflowX: 'auto',
          margin: '4px 0',
          color: 'var(--wp-fg)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="wp-btn"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          fontSize: '0.75rem',
          padding: '4px 10px',
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}
