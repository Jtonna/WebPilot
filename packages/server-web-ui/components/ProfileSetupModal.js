'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
  CheckIcon,
} from '@heroicons/react/24/outline';

/**
 * ProfileSetupModal — walkthrough for loading the WebPilot unpacked extension
 * into a specific Chrome profile.
 *
 * Per UX §Profiles modal: 480px wide, four numbered steps, primary `Done`.
 *
 * Step 3 renders the real extension path passed from /api/ui/status. When the
 * server can't resolve a path (pkg install layout we don't recognize), we show
 * a fallback hint pointing the user at the install's resources directory.
 */
const EXTENSIONS_URL = 'chrome://extensions/';

export default function ProfileSetupModal({ open, profileName, extensionPath, onClose }) {
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(open);

  // Mirror open → closing animation. Stay mounted until exit anim finishes.
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

  if (!open && !closing) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget && typeof onClose === 'function') onClose();
  };

  return (
    <div
      className={`wp-modal-backdrop${closing && !open ? ' is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wp-profile-setup-title"
      onClick={handleBackdrop}
    >
      <div className="wp-modal">
        <h2 id="wp-profile-setup-title" className="wp-modal-title">
          Load the WebPilot extension
        </h2>
        <div className="wp-modal-body">
          <p style={{ margin: 0, marginBottom: 'var(--s-4)' }}>
            Four short steps — most takes about a minute.
          </p>
          <div className="wp-stepper">
            <Step
              n={1}
              text={
                <>
                  Open{' '}
                  <a
                    href={EXTENSIONS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="wp-link"
                  >
                    chrome://extensions
                    <ArrowTopRightOnSquareIcon style={{ width: 14, height: 14, marginLeft: 4, verticalAlign: '-2px', display: 'inline-block' }} />
                  </a>{' '}
                  in {profileName ? <strong>{profileName}</strong> : 'this profile'}.
                </>
              }
              copy={EXTENSIONS_URL}
            />
            <Step n={2} text="Turn on Developer mode (top-right toggle)." />
            {extensionPath ? (
              <Step
                n={3}
                text={'Click "Load unpacked" and pick this folder:'}
                copy={extensionPath}
                mono
              />
            ) : (
              <Step
                n={3}
                text={
                  <>
                    Click <strong>Load unpacked</strong> and pick the WebPilot
                    extension in your installation’s{' '}
                    <span className="wp-mono">resources/chrome-extension</span>{' '}
                    folder.
                  </>
                }
              />
            )}
            <Step
              n={4}
              text="Done — come back here and the status will update to Ready."
            />
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

function Step({ n, text, copy, mono = false }) {
  return (
    <div className="wp-step">
      <span className="wp-step-num">{n}</span>
      <div className="wp-step-body">
        <span>{text}</span>
        {copy ? (
          mono ? (
            <CodeBlock text={copy} />
          ) : (
            <InlineCopy text={copy} />
          )
        ) : null}
      </div>
    </div>
  );
}

function InlineCopy({ text }) {
  const [copied, setCopied] = useState(false);
  async function handle() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_e) { /* ignore */ }
  }
  return (
    <button
      type="button"
      className="wp-btn wp-btn-compact"
      onClick={handle}
      style={{ alignSelf: 'flex-start' }}
    >
      {copied ? (
        <>
          <CheckIcon style={{ width: 14, height: 14 }} /> Copied
        </>
      ) : (
        <>
          <DocumentDuplicateIcon style={{ width: 14, height: 14 }} /> Copy {text}
        </>
      )}
    </button>
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
