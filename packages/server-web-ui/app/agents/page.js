'use client';

import { useEffect, useRef, useState } from 'react';
import AgentRow from '../../components/AgentRow';
import ConfirmModal from '../../components/ConfirmModal';
import RevealSection from '../../components/RevealSection';
import { createSequencedFetcher, getStatus, renameAgent, revokeAgent } from '../../lib/api';
import { createUiEventsClient } from '../../lib/ws';

export default function AgentsPage() {
  const [agents, setAgents] = useState([]);
  const [port, setPort] = useState(null);
  const [error, setError] = useState(null);
  // Pending revoke confirmation. `null` = modal closed; otherwise the agent
  // whose key is about to be revoked.
  const [revokeTarget, setRevokeTarget] = useState(null);
  // Set of agent keys that are currently playing the leave animation. While
  // a key is here we keep the row mounted but with the `wp-row-leave` class,
  // then unmount it once the keyframe finishes (~220ms).
  const [leavingKeys, setLeavingKeys] = useState(() => new Set());
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
    // Play the leave animation before the row disappears. We mark the key
    // as leaving, fire the actual revoke + refresh, and the row will unmount
    // naturally when the refresh completes — by which time the keyframe will
    // already be visible.
    setLeavingKeys((prev) => {
      const next = new Set(prev);
      next.add(agent.key);
      return next;
    });
    try {
      // Wait one frame for the class flip to paint before the network call.
      await new Promise((r) => setTimeout(r, 220));
      await revokeAgent(agent.key);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      // Drop the key from the leaving set even if the row is now unmounted —
      // keeps the set bounded.
      setLeavingKeys((prev) => {
        if (!prev.has(agent.key)) return prev;
        const next = new Set(prev);
        next.delete(agent.key);
        return next;
      });
    }
  }

  return (
    <>
      <header className="wp-page-head">
        <div className="wp-page-kicker">
          <span className="wp-page-kicker-accent">§ 04</span>
          <span style={{ marginLeft: 12 }}>authorized api keys</span>
        </div>
        <h1 className="wp-page-title">Agents.</h1>
        <p className="wp-page-sub">
          MCP agents currently authorized to talk to this WebPilot server.
          Each row binds an API key to a Chrome profile.
        </p>
      </header>

      {error ? (
        <div className="wp-card">
          <div className="wp-section-head" style={{ marginBottom: 8 }}>
            <span className="wp-section-num">!!</span>
            <span style={{ color: 'var(--wp-danger)' }}>ERROR</span>
          </div>
          <div className="wp-mono wp-secondary">{error.message}</div>
        </div>
      ) : null}

      <section className="wp-section">
        <div className="wp-section-head">
          <span className="wp-section-num">§ 01</span>
          <span>ACTIVE AGENTS</span>
          <span className="wp-section-rule" />
          <span className="wp-section-aside">
            {agents.length > 0 ? `${agents.length} PAIRED` : 'EMPTY'}
          </span>
        </div>
        <div className="wp-card">
          {agents.length === 0 ? (
            <div className="wp-empty">no agents paired — waiting</div>
          ) : (
            agents.map((a) => (
              <AgentRow
                key={a.key}
                agent={a}
                onRename={handleRename}
                onRevoke={handleRevoke}
                port={port}
                leaving={leavingKeys.has(a.key)}
              />
            ))
          )}
        </div>
      </section>

      <FirstTimeSetupCard port={port} />

      <RevealSection className="wp-section">
        <div className="wp-section-head">
          <span className="wp-section-num">§ 03</span>
          <span>EXISTING KEY · MANUAL WIRE-UP</span>
          <span className="wp-section-rule" />
          <span className="wp-section-aside">reference</span>
        </div>
        <div className="wp-card">
          <p className="wp-secondary" style={{ marginTop: 0, maxWidth: '60ch' }}>
            For an agent that already has a key, use its <strong>COPY .MCP.JSON</strong> button
            above to copy a ready-to-paste snippet. The shape is:
          </p>
          <div className="wp-code-wrap">
            <pre className="wp-code-block">
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
          </div>
          <ol style={{ paddingLeft: 20, margin: '20px 0 0', color: 'var(--wp-fg-secondary)', fontSize: 14, lineHeight: 1.7 }}>
            <li>
              Copy the snippet above (<strong>COPY .MCP.JSON</strong> button next
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
      </RevealSection>

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
// brand-new MCP client that does not yet have a paired API key.

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
    <section className="wp-section">
      <div className="wp-section-head">
        <span className="wp-section-num">§ 02</span>
        <span>FIRST-TIME SETUP</span>
        <span className="wp-section-rule" />
        <span className="wp-section-aside">new agent · no key</span>
      </div>
      <div className="wp-card">
        <p className="wp-secondary" style={{ marginTop: 0, maxWidth: '60ch' }}>
          For an MCP client that has never paired with this server. The agent
          will pair itself using the tools the server exposes — you only need
          to approve the request when it appears here.
        </p>

        <div className="wp-mono" style={{ marginTop: 24, marginBottom: 6, color: 'var(--wp-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: 11 }}>
          STEP 01 · ADD WEBPILOT TO .MCP.JSON
        </div>
        <CopyableBlock text={urlOnlyConfig} />

        <div className="wp-mono" style={{ marginTop: 24, marginBottom: 6, color: 'var(--wp-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: 11 }}>
          STEP 02 · PASTE PROMPT INTO AGENT
        </div>
        <CopyableBlock text={agentPrompt} />

        <div className="wp-mono" style={{ marginTop: 24, color: 'var(--wp-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: 11 }}>
          STEP 03 · APPROVE
        </div>
        <p className="wp-secondary" style={{ margin: '4px 0 0', maxWidth: '60ch' }}>
          A pairing request appears at the top of the Pairings page (with a
          system notification + sound). Approve it, picking the Chrome profile
          the agent is allowed to drive.
        </p>

        <div className="wp-mono" style={{ marginTop: 20, color: 'var(--wp-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.14em', fontSize: 11 }}>
          STEP 04 · KEY MATERIALIZES
        </div>
        <p className="wp-secondary" style={{ margin: '4px 0 0', maxWidth: '60ch' }}>
          Once approved, the agent appears under <strong>Active agents</strong>{' '}
          above. Use its <strong>COPY .MCP.JSON</strong> button for the keyed
          snippet that lets future sessions skip step 2.
        </p>
      </div>
    </section>
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
    <div className="wp-code-wrap">
      <pre className="wp-code-block">{text}</pre>
      <button
        type="button"
        onClick={handleCopy}
        className={`wp-btn wp-btn-ghost wp-code-copy${copied ? ' is-copied' : ''}`}
      >
        {copied ? 'COPIED' : 'COPY'}
      </button>
    </div>
  );
}
