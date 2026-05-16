'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createAgent } from '../lib/api';
import { useToast } from './ToastRegion';
import Toggle from './Toggle';

/**
 * PairAgentModal — dialog that produces the copy-text an AI agent pastes to
 * connect to this WebPilot instance. Two flows, gated by the "Include API
 * key" toggle in the action row:
 *
 *   ON (default): operator picks an agent name + Chrome profile in the modal,
 *     clicks Copy; the server mints a paired-keys entry via
 *     POST /api/ui/agents and returns an api_key. The modal swaps the
 *     `<API_KEY>` placeholder for the real key and copies the result.
 *
 *   OFF: copy-text instructs the agent through the classic request_pairing
 *     flow. No backend call.
 *
 * Layout (mono palette / value-over-hue):
 *   - Title + subhead that mirrors the toggle state in one short line.
 *   - Collapsible name + profile fields (underline-style inputs), visible
 *     when the toggle is ON.
 *   - Code block, clean edges (no overlay copy button).
 *   - Action row anchored to the code block: [Toggle] ... [Copy button].
 *   - Modal-actions hosts a single Done button.
 */

const URL_PLACEHOLDER = '<port>';
const KEY_PLACEHOLDER = '<API_KEY>';
const AGENT_NAME_MAX = 60;

const SUBHEAD_ON = 'Generates a key now — agent skips approval.';
const SUBHEAD_OFF = "Agent will request pairing — you'll approve it.";
const TOGGLE_HELP =
  'On — generate a key now and skip the approval step. ' +
  "Off — agent will request pairing and you'll approve it.";

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
  const [confirmFlash, setConfirmFlash] = useState(null); // string | null
  const wasOpen = useRef(open);
  const flashTimerRef = useRef(null);
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
    setConfirmFlash(null);
    // Default to the first known profile so the dropdown is never blank on
    // open. The operator can change it before clicking Copy.
    if (profileList.length > 0) {
      setSelectedProfile(profileList[0].directoryName);
    } else {
      setSelectedProfile('');
    }
  }, [open, profileList]);

  // Clear the pending flash timer if the modal unmounts.
  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  if (!open && !closing) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onClose === 'function') onClose();
  };

  // The pre-block preview. With toggle ON, shows the real key once generated;
  // otherwise the `<API_KEY>` placeholder so the user can see the shape.
  const previewText = includeKey
    ? buildPromptWithKey(port, generated ? generated.apiKey : null)
    : buildPromptNoKey(port);

  const subhead = confirmFlash
    ? confirmFlash
    : (includeKey ? SUBHEAD_ON : SUBHEAD_OFF);

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

  function scheduleConfirmFlash(message) {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setConfirmFlash(message);
    flashTimerRef.current = setTimeout(() => {
      setConfirmFlash(null);
      flashTimerRef.current = null;
    }, 3000);
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
        // Briefly swap the subhead to a confirmation line. The key in the
        // code block is the persistent proof; this just acknowledges the
        // creation without adding a permanent paragraph.
        const profMatch = profileList.find((p) => p.directoryName === (minted.profileId || selectedProfile));
        const profLabel = (profMatch && (profMatch.displayName || profMatch.directoryName)) || (minted.profileId || selectedProfile);
        scheduleConfirmFlash(`Created — bound to ${profLabel}.`);
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
    ? (copied ? 'Copied' : (submitting ? 'Generating…' : 'Copy'))
    : (copied ? 'Copied' : 'Copy');

  // Reference the generated state to keep the lint/flow honest — the bound
  // profile label is exposed for future use (e.g. a footnote under the code
  // block), but the modal no longer renders the standalone "Created agent"
  // paragraph: the key in the code block + the toast + the subhead flash
  // carry that load.
  void boundProfileLabel;
  void generated;

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
              marginTop: 'calc(var(--s-2) * -1)',
              marginBottom: 'var(--s-4)',
              color: 'var(--wp-fg-secondary)',
              fontSize: 'var(--fs-small)',
              lineHeight: 1.5,
              transition: 'color var(--dur-quick) var(--ease-quart-out)',
            }}
            aria-live="polite"
          >
            {subhead}
          </p>

          <div
            className={`wp-pair-fields${includeKey ? '' : ' is-collapsed'}`}
            aria-hidden={!includeKey}
          >
            <div className="wp-pair-fields-inner">
              <div className="wp-pair-field-row">
                <label
                  htmlFor="wp-pair-agent-name"
                  className="wp-pair-field-label"
                >
                  Agent name
                </label>
                <input
                  id="wp-pair-agent-name"
                  type="text"
                  className="wp-input wp-input--underline"
                  autoFocus
                  value={agentName}
                  maxLength={AGENT_NAME_MAX}
                  placeholder="e.g. Claude Code – my-project"
                  onChange={(e) => {
                    setAgentName(e.target.value);
                    if (nameError) setNameError(null);
                  }}
                  disabled={submitting || !includeKey}
                  tabIndex={includeKey ? 0 : -1}
                />
                {nameError ? (
                  <p className="wp-pair-field-error">{nameError}</p>
                ) : null}
              </div>
              <div className="wp-pair-field-row">
                <label
                  htmlFor="wp-pair-agent-profile"
                  className="wp-pair-field-label"
                >
                  Chrome profile
                </label>
                <select
                  id="wp-pair-agent-profile"
                  className="wp-select wp-input--underline"
                  value={selectedProfile}
                  onChange={(e) => {
                    setSelectedProfile(e.target.value);
                    if (profileError) setProfileError(null);
                  }}
                  disabled={submitting || !includeKey || profileList.length === 0}
                  tabIndex={includeKey ? 0 : -1}
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
                  <p className="wp-pair-field-error">{profileError}</p>
                ) : null}
              </div>
            </div>
          </div>

          <pre className="wp-code" style={{ whiteSpace: 'pre-wrap' }}>{previewText}</pre>

          <div className="wp-pair-actions">
            <Toggle
              checked={includeKey}
              label="Include API key"
              title={TOGGLE_HELP}
              onChange={(next) => {
                setIncludeKey(next);
                setCopied(false);
                // Clear any prior generation when flipping — the preview
                // text reverts to placeholder, and the toggle-OFF path
                // doesn't need it.
                setGenerated(null);
                setNameError(null);
                setProfileError(null);
              }}
            />
            <span className="wp-pair-actions-spacer" />
            <button
              type="button"
              className="wp-btn wp-btn-primary wp-btn-compact"
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
