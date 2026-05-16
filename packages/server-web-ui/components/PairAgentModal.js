'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle } from '@phosphor-icons/react';
import PairingPromptCard from './PairingPromptCard';
import { createUiEventsClient } from '../lib/ws';
import { approvePairing, denyPairing, getStatus } from '../lib/api';

/**
 * PairAgentModal — three-step walkthrough for pairing a new MCP agent.
 *
 * Per UX §Agents-modal: 640px wide, three steps with copyable blocks. Step 3
 * is a live region — when a pairing_requested event arrives it renders a
 * PairingPromptCard inline so the user can approve without leaving. After
 * approve, the modal flips to a success view.
 */
export default function PairAgentModal({ open, port, onClose, onPaired }) {
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(open);
  const [pending, setPending] = useState([]); // freshly arrived pairings (live)
  const [profiles, setProfiles] = useState([]);
  const [busy, setBusy] = useState(false);
  // Success state: when a pairing is approved through this modal we flip
  // to a "Paired — <name>" view until the user closes.
  const [paired, setPaired] = useState(null);

  // Track open → closing transition for exit animation.
  useEffect(() => {
    if (wasOpen.current && !open) {
      setClosing(true);
      const id = setTimeout(() => {
        setClosing(false);
        setPaired(null); // reset for next open
      }, 240);
      wasOpen.current = open;
      return () => clearTimeout(id);
    }
    wasOpen.current = open;
    return undefined;
  }, [open]);

  // While open, subscribe to pairing events & fetch profile list.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    async function refresh() {
      try {
        const data = await getStatus();
        if (cancelled) return;
        setPending(data.pendingPairings || []);
        setProfiles(data.profiles || []);
      } catch (_e) { /* ignore — modal stays usable */ }
    }
    refresh();

    const client = createUiEventsClient();
    client.connect();
    const unsubs = [
      client.subscribe('pairing_requested', () => !cancelled && refresh()),
      client.subscribe('pairing_approved', () => !cancelled && refresh()),
      client.subscribe('pairing_denied', () => !cancelled && refresh()),
    ];
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u && u());
      client.disconnect();
    };
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (typeof onClose === 'function') onClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open && !closing) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onClose === 'function') onClose();
  };

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

  const profileOptions = [
    ...profiles.map((p) => ({ value: p.directoryName, label: p.displayName || p.directoryName })),
    { value: '__new__', label: '+ New sandbox profile' },
  ];
  if (profileOptions.length === 1) {
    profileOptions.unshift({ value: 'Default', label: 'Default' });
  }

  async function handleApprove(pairing, selectedProfile, newProfileName) {
    setBusy(true);
    try {
      await approvePairing(pairing.pairingId, selectedProfile, newProfileName);
      setPaired({ name: pairing.agentName || 'agent' });
      if (typeof onPaired === 'function') onPaired(pairing);
    } catch (_e) { /* ignore — toast at page level if wired */ }
    finally { setBusy(false); }
  }

  async function handleDeny(pairing) {
    setBusy(true);
    try {
      await denyPairing(pairing.pairingId);
    } catch (_e) { /* ignore */ }
    finally { setBusy(false); }
  }

  return (
    <div
      className={`wp-modal-backdrop${closing && !open ? ' is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wp-pair-modal-title"
      onClick={handleBackdrop}
    >
      <div className="wp-modal wp-modal-lg">
        <h2 id="wp-pair-modal-title" className="wp-modal-title">
          {paired ? 'Paired.' : 'Pair a new agent'}
        </h2>
        {paired ? (
          <SuccessView agentName={paired.name} />
        ) : (
          <div className="wp-modal-body">
            <p style={{ margin: 0, marginBottom: 'var(--s-4)' }}>
              Three steps. You can leave this open — pairing requests show up
              live below.
            </p>
            <div className="wp-stepper">
              <Step
                n={1}
                title="Tell your client about WebPilot."
                sub="Project-level config only. Never put API keys in user-level config."
                code={urlOnlyConfig}
              />
              <Step
                n={2}
                title="Ask the agent to pair."
                sub="The agent will call request_pairing on its own."
                code={agentPrompt}
              />
              <Step
                n={3}
                title="Approve here."
                sub={
                  pending.length === 0
                    ? 'Waiting for a pairing request — it will appear right here.'
                    : null
                }
                live
              >
                {pending.length > 0 ? (
                  <div style={{
                    marginTop: 'var(--s-3)',
                    border: '1px solid var(--wp-separator)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--wp-bg)',
                  }}>
                    {pending.map((p) => (
                      <PairingPromptCard
                        key={p.pairingId}
                        pairing={p}
                        profileOptions={profileOptions}
                        onApprove={handleApprove}
                        onDeny={handleDeny}
                        disabled={busy}
                      />
                    ))}
                  </div>
                ) : null}
              </Step>
            </div>
          </div>
        )}
        <div className="wp-modal-actions">
          <button
            type="button"
            className={paired ? 'wp-btn wp-btn-primary' : 'wp-btn'}
            onClick={onClose}
            autoFocus
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SuccessView({ agentName }) {
  return (
    <div className="wp-modal-body" style={{ textAlign: 'center', paddingTop: 'var(--s-3)' }}>
      <div style={{ color: 'var(--wp-success)', display: 'flex', justifyContent: 'center', marginBottom: 'var(--s-3)' }}>
        <CheckCircle size={32} weight="regular" />
      </div>
      <p style={{ margin: 0, color: 'var(--wp-fg)' }}>
        <strong>{agentName}</strong> is now in your agent list. You can close this.
      </p>
    </div>
  );
}

function Step({ n, title, sub, code, children, live = false }) {
  return (
    <div className="wp-step">
      <span className="wp-step-num">{n}</span>
      <div className="wp-step-body">
        <span style={{ fontWeight: 500 }}>{title}</span>
        {sub ? <span className="wp-step-sub">{sub}</span> : null}
        {code ? <CodeBlock text={code} /> : null}
        {children}
        {live && !children ? null : null}
      </div>
    </div>
  );
}

function CodeBlock({ text }) {
  const [copied, setCopied] = useState(false);
  async function handle() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_e) { /* ignore */ }
  }
  return (
    <div className="wp-code-wrap">
      <pre className="wp-code">{text}</pre>
      <button
        type="button"
        className="wp-btn wp-btn-compact wp-code-copy"
        onClick={handle}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
