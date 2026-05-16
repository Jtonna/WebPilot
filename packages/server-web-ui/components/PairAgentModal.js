'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * PairAgentModal — small dialog showing the AI-pairing instructions and a
 * Copy button. Replaces the always-visible hero card on /agents; the page
 * shows a slim bar with a button that opens this modal on demand.
 *
 * This is a leaner recreation of the file deleted in 49d1254 — kept focused
 * on a single job: display the instructions text + Copy button.
 *
 * Scaffolding (backdrop, is-closing animation, Esc/backdrop close) mirrors
 * ProfileSetupModal.
 */
function buildAgentPrompt(port) {
  const portStr = port ? String(port) : '<port>';
  return (
    `Connect to my WebPilot MCP server at http://localhost:${portStr}/sse — ` +
    `that's the URL for your .mcp.json if you need it.\n\n` +
    `You don't have an API key yet. Call request_pairing with a memorable ` +
    `agent_name (e.g. the project or client name). The tool returns a ` +
    `pairing_id and instructions; follow them — surface the approval URL ` +
    `to me, wait for me to approve, then call check_pairing_status with ` +
    `the pairing_id to retrieve your api_key. Once you have the key, ` +
    `include it as the api_key parameter on each tool call, or tell me to ` +
    `paste it into .mcp.json under headers."X-API-Key" and restart this client.`
  );
}

export default function PairAgentModal({ open, onClose, port }) {
  const [closing, setClosing] = useState(false);
  const [copied, setCopied] = useState(false);
  const wasOpen = useRef(open);

  // Mirror open → closing animation. Stay mounted until the exit anim finishes.
  useEffect(() => {
    if (wasOpen.current && !open) {
      setClosing(true);
      const id = setTimeout(() => setClosing(false), 240);
      wasOpen.current = open;
      return () => clearTimeout(id);
    }
    wasOpen.current = open;
    return undefined;
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

  // Reset the "Copied" pill when the modal is re-opened.
  useEffect(() => {
    if (open) setCopied(false);
  }, [open]);

  if (!open && !closing) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onClose === 'function') onClose();
  };

  const prompt = buildAgentPrompt(port);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_e) { /* ignore */ }
  }

  return (
    <div
      className={`wp-modal-backdrop${closing && !open ? ' is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wp-pair-agent-title"
      onClick={handleBackdrop}
    >
      <div className="wp-modal wp-modal-lg">
        <h2 id="wp-pair-agent-title" className="wp-modal-title">
          Pair a new agent
        </h2>
        <div className="wp-modal-body">
          <p
            style={{
              margin: 0,
              marginBottom: 'var(--s-4)',
              color: 'var(--wp-fg-secondary)',
            }}
          >
            Copy this and paste it into your AI agent. The URL doubles as your
            manual <span className="wp-mono">.mcp.json</span> connection if you
            ever need it.
          </p>
          <div className="wp-code-wrap">
            <pre className="wp-code" style={{ whiteSpace: 'pre-wrap' }}>{prompt}</pre>
            <button
              type="button"
              className="wp-btn wp-btn-primary wp-btn-compact wp-code-copy"
              onClick={handleCopy}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <div className="wp-modal-actions">
          <button
            type="button"
            className="wp-btn wp-btn-primary"
            onClick={onClose}
            autoFocus
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
