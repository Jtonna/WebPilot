'use client';

import Modal from './Modal';
import { buildMcpConfigJson } from '../lib/mcpConfig';
import { useCopyToClipboard } from '../lib/useCopyToClipboard';

/**
 * RevealKeyModal — one-time reveal of a freshly regenerated API key.
 *
 * Mirrors the one-time-reveal UX of PairAgentModal: the real plaintext key is
 * shown exactly once, inside a copyable `.mcp.json` snippet. The parent holds
 * the plaintext only for as long as this modal is open; on close it drops the
 * value so the key cannot be retrieved again.
 *
 * Props:
 *   open    (bool)              — whether the modal is shown
 *   onClose (fn)                — called on Esc / backdrop / Done; parent clears the key
 *   port    (number|string)     — server port, for the snippet URL
 *   agentName (string)          — label for the heading
 *   apiKey  (string)            — the new plaintext key (shown once)
 */
export default function RevealKeyModal({ open, onClose, port, agentName, apiKey }) {
  const [copyState, copyToClipboard] = useCopyToClipboard();
  const copied = copyState === 'copied';

  const portStr = port ? String(port) : '<port>';
  const snippet = buildMcpConfigJson({ port: portStr, apiKey: apiKey || '<API_KEY>' });

  return (
    <Modal open={open} onClose={onClose} titleId="wp-regen-key-title" size="lg">
      <h2 id="wp-regen-key-title" className="wp-modal-title">
        New key for {agentName || 'agent'}
      </h2>
      <div className="wp-modal-body">
        <div
          className="wp-secondary"
          style={{ marginBottom: 'var(--s-3)', fontSize: 'var(--fs-small)', lineHeight: 1.6 }}
        >
          This key is shown once. Copy it into the agent’s <span className="wp-mono">.mcp.json</span> now —
          you won’t be able to see it again. The agent’s previous key has stopped working.
        </div>
        <pre className="wp-code" style={{ whiteSpace: 'pre-wrap' }}>{snippet}</pre>
      </div>
      <div className="wp-modal-actions">
        <button
          type="button"
          className="wp-btn wp-btn-primary"
          onClick={() => copyToClipboard(snippet)}
        >
          {copied ? 'Copied' : 'Copy config'}
        </button>
        <button type="button" className="wp-btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
