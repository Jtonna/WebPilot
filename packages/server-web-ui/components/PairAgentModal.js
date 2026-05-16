'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createAgent } from '../lib/api';
import { useToast } from './ToastRegion';

/**
 * PairAgentModal — dialog that produces the copy-text an AI agent pastes to
 * connect to this WebPilot instance. Two flows, gated by the "Include API
 * key" toggle:
 *
 *   ON (default): operator picks an agent name + Chrome profile in the modal,
 *     clicks "Generate & copy"; the server mints a paired-keys entry via
 *     POST /api/ui/agents and returns an api_key. The modal swaps the
 *     `<API_KEY>` placeholder for the real key and copies the result. The AI
 *     agent only has to set url + X-API-Key in .mcp.json — no request_pairing.
 *
 *   OFF: copy-text instructs the agent through the classic request_pairing
 *     flow, with explicit guidance to write the returned api_key into
 *     .mcp.json immediately and poll check_pairing_status every 10s up to
 *     12 attempts (2 minutes). No backend call.
 *
 * Scaffolding (backdrop, is-closing animation, Esc / backdrop close) mirrors
 * ProfileSetupModal.
 */

const URL_PLACEHOLDER = '<port>';
const KEY_PLACEHOLDER = '<API_KEY>';
const AGENT_NAME_MAX = 60;

function buildPromptWithKey(port, apiKey) {
  const portStr = port ? String(port) : URL_PLACEHOLDER;
  const keyStr = apiKey || KEY_PLACEHOLDER;
  return (
`Connect to my WebPilot MCP server at http://localhost:${portStr}/sse with API key ${keyStr}.

Set both in your .mcp.json:

{
  "mcpServers": {
    "webpilot": {
      "url": "http://localhost:${portStr}/sse",
      "headers": { "X-API-Key": "${keyStr}" }
    }
  }
}

You're already paired — no request_pairing or approval needed. Start using tools right away.`
  );
}

function buildPromptNoKey(port) {
  const portStr = port ? String(port) : URL_PLACEHOLDER;
  return (
`Connect to my WebPilot MCP server at http://localhost:${portStr}/sse.

Set the url in your .mcp.json (no key yet):

{
  "mcpServers": {
    "webpilot": {
      "url": "http://localhost:${portStr}/sse"
    }
  }
}

You don't have an API key yet. Steps:

1. Call request_pairing with a memorable agent_name (e.g. project or client name). It returns an api_key and pairing_id.
2. Immediately set headers."X-API-Key" to that api_key in your .mcp.json — I may approve at any future moment, and the key will activate then.
3. Surface the approval URL to me, then poll check_pairing_status(pairing_id) once every 10 seconds, up to 12 attempts (2 minutes total). If unapproved after 12 tries, stop — I'll approve when ready and the key will work on the next tool call.
4. Once check_pairing_status returns approved, you're paired. Include the api_key on every tool call from then on.`
  );
}

export default function PairAgentModal({ open, onClose, port, profiles }) {
  const [closing, setClosing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [includeKey, setIncludeKey] = useState(true);
  const [agentName, setAgentName] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [generated, setGenerated] = useState(null); // { apiKey, agentName, profileId } | null
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState(null);
  const [profileError, setProfileError] = useState(null);
  const wasOpen = useRef(open);
  const toast = useToast();

  const profileList = useMemo(() => (Array.isArray(profiles) ? profiles : []), [profiles]);

  const boundProfileLabel = useMemo(() => {
    if (!generated) return '';
    const match = profileList.find((p) => p.directoryName === generated.profileId);
    return (match && (match.displayName || match.directoryName)) || generated.profileId;
  }, [generated, profileList]);

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

  // Reset transient state each time the modal is re-opened.
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setIncludeKey(true);
    setAgentName('');
    setGenerated(null);
    setSubmitting(false);
    setNameError(null);
    setProfileError(null);
    // Default to the first known profile so the dropdown is never blank on
    // open. The operator can change it before clicking "Generate & copy".
    if (profileList.length > 0) {
      setSelectedProfile(profileList[0].directoryName);
    } else {
      setSelectedProfile('');
    }
  }, [open, profileList]);

  if (!open && !closing) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onClose === 'function') onClose();
  };

  // The pre-block preview. With toggle ON, shows the real key once generated;
  // otherwise the `<API_KEY>` placeholder so the user can see the shape.
  const previewText = includeKey
    ? buildPromptWithKey(port, generated ? generated.apiKey : null)
    : buildPromptNoKey(port);

  function validate() {
    let ok = true;
    if (!agentName.trim()) {
      setNameError('Agent name is required.');
      ok = false;
    } else if (agentName.trim().length > AGENT_NAME_MAX) {
      setNameError(`Agent name must be ${AGENT_NAME_MAX} characters or fewer.`);
      ok = false;
    } else {
      setNameError(null);
    }
    if (!selectedProfile) {
      setProfileError('Pick a Chrome profile to bind the key to.');
      ok = false;
    } else {
      setProfileError(null);
    }
    return ok;
  }

  async function handleCopy() {
    if (includeKey) {
      if (submitting) return;
      if (!validate()) return;
      setSubmitting(true);
      try {
        const trimmedName = agentName.trim();
        const minted = await createAgent(trimmedName, selectedProfile);
        setGenerated({
          apiKey: minted.apiKey,
          agentName: minted.agentName || trimmedName,
          profileId: minted.profileId || selectedProfile,
        });
        const finalText = buildPromptWithKey(port, minted.apiKey);
        try {
          await navigator.clipboard.writeText(finalText);
        } catch (_e) { /* clipboard rejected; toast still wins */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        toast.success('Copied — agent created.');
      } catch (e) {
        // Reset preview to placeholder shape so the stale (no key) text isn't
        // misleading after a failure.
        setGenerated(null);
        const serverReason =
          (e && e.payload && (e.payload.reason || e.payload.error)) || null;
        toast.error(serverReason || (e && e.message) || 'Couldn’t create agent.');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    // Toggle OFF: just copy the static URL-only instructions.
    try {
      await navigator.clipboard.writeText(buildPromptNoKey(port));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('Copied.');
    } catch (_e) { /* ignore */ }
  }

  const copyLabel = includeKey
    ? (copied ? 'Copied' : (submitting ? 'Generating…' : 'Generate & copy'))
    : (copied ? 'Copied' : 'Copy');

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
          {/* Toggle row — hairline separator below it. */}
          <div
            style={{
              paddingBottom: 'var(--s-4)',
              marginBottom: 'var(--s-4)',
              borderBottom: '1px solid var(--wp-separator)',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s-2)',
                fontWeight: 500,
                color: 'var(--wp-fg)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={includeKey}
                onChange={(e) => {
                  setIncludeKey(e.target.checked);
                  setCopied(false);
                  // Clear any prior generation when flipping — the preview
                  // text reverts to placeholder and the toggle-OFF path
                  // doesn't need it anyway.
                  setGenerated(null);
                  setNameError(null);
                  setProfileError(null);
                }}
              />
              Include API key
            </label>
            <p
              className="wp-muted"
              style={{ margin: '6px 0 0 0', lineHeight: 1.5 }}
            >
              On — generate a key now and skip the approval step. Off — agent
              will request pairing and you'll approve it.
            </p>
          </div>

          {includeKey ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--s-3)',
                marginBottom: 'var(--s-4)',
              }}
            >
              <div>
                <label
                  htmlFor="wp-pair-agent-name"
                  className="wp-muted"
                  style={{ display: 'block', marginBottom: 4 }}
                >
                  Agent name
                </label>
                <input
                  id="wp-pair-agent-name"
                  type="text"
                  className="wp-input"
                  autoFocus
                  value={agentName}
                  maxLength={AGENT_NAME_MAX}
                  placeholder="e.g. Claude Code – my-project"
                  onChange={(e) => {
                    setAgentName(e.target.value);
                    if (nameError) setNameError(null);
                  }}
                  disabled={submitting}
                />
                {nameError ? (
                  <p
                    className="wp-muted"
                    style={{ color: 'var(--wp-danger)', margin: '4px 0 0 0' }}
                  >
                    {nameError}
                  </p>
                ) : null}
              </div>
              <div>
                <label
                  htmlFor="wp-pair-agent-profile"
                  className="wp-muted"
                  style={{ display: 'block', marginBottom: 4 }}
                >
                  Chrome profile
                </label>
                <select
                  id="wp-pair-agent-profile"
                  className="wp-select"
                  value={selectedProfile}
                  onChange={(e) => {
                    setSelectedProfile(e.target.value);
                    if (profileError) setProfileError(null);
                  }}
                  disabled={submitting || profileList.length === 0}
                >
                  {profileList.length === 0 ? (
                    <option value="">(no profiles — open Chrome first)</option>
                  ) : null}
                  {profileList.map((p) => (
                    <option key={p.directoryName} value={p.directoryName}>
                      {p.displayName || p.directoryName}
                    </option>
                  ))}
                </select>
                {profileError ? (
                  <p
                    className="wp-muted"
                    style={{ color: 'var(--wp-danger)', margin: '4px 0 0 0' }}
                  >
                    {profileError}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          {generated ? (
            <p
              style={{
                margin: '0 0 var(--s-3) 0',
                color: 'var(--wp-fg-secondary)',
                lineHeight: 1.55,
              }}
            >
              Created agent: <strong style={{ color: 'var(--wp-fg)' }}>{generated.agentName}</strong>
              {' '}bound to <strong style={{ color: 'var(--wp-fg)' }}>{boundProfileLabel}</strong>.
            </p>
          ) : (
            <p
              style={{
                margin: 0,
                marginBottom: 'var(--s-3)',
                color: 'var(--wp-fg-secondary)',
              }}
            >
              Copy this and paste it into your AI agent.
            </p>
          )}

          <div className="wp-code-wrap">
            <pre className="wp-code" style={{ whiteSpace: 'pre-wrap' }}>{previewText}</pre>
            <button
              type="button"
              className="wp-btn wp-btn-primary wp-btn-compact wp-code-copy"
              onClick={handleCopy}
              disabled={submitting}
            >
              {copyLabel}
            </button>
          </div>
        </div>
        <div className="wp-modal-actions">
          <button
            type="button"
            className="wp-btn wp-btn-primary"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
