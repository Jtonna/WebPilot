'use client';

import { useState } from 'react';

// Repo URL is canonical — confirmed via packages/server-web-ui/app/settings/page.js
// which already links to this repo's issues page. P1 #1.
const REPO_ISSUES_NEW_URL = 'https://github.com/Jtonna/WebPilot/issues/new';

// Truncation budgets:
//   - displayed message in the row sub-line       (UI readability)
//   - stack included in the GitHub-issue body URL (URL length sanity)
const MESSAGE_DISPLAY_MAX = 120;
const STACK_BODY_MAX = 1500;

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function buildIssueUrl(formatter) {
  const name = formatter && formatter.name ? String(formatter.name) : 'unknown';
  const lastError = (formatter && formatter.lastError) || {};
  const phase = lastError.phase || 'format';
  const workflow = lastError.workflow || null;
  const timestamp = lastError.timestamp || formatter.lastErrorAt || '';
  const message = lastError.message || 'Unknown error';
  const stack = lastError.stack || '';
  const errorCount = formatter && formatter.errorCount;

  const title = `[formatter:${name}] ${truncate(message, 120)}`;

  // Multi-line markdown body. Newlines become %0A after encodeURIComponent —
  // GitHub renders them as real line breaks in the issue editor.
  const bodyLines = [
    '## Formatter error',
    '',
    `- **Platform / formatter:** \`${name}\``,
    `- **Phase:** \`${phase}\``,
    workflow ? `- **Workflow:** \`${workflow}\`` : null,
    timestamp ? `- **Last error at:** \`${timestamp}\`` : null,
    typeof errorCount === 'number' ? `- **Error count:** ${errorCount}` : null,
    '',
    '### Error message',
    '',
    '```',
    message,
    '```',
    '',
    '### Stack trace',
    '',
    '```',
    truncate(stack, STACK_BODY_MAX),
    '```',
    '',
    '### Environment',
    '',
    '<!-- Please fill in: -->',
    '- OS: ',
    '- Chrome version: ',
    '- WebPilot version: ',
    '',
    '### Additional context',
    '',
    '<!-- What were you doing when this happened? Steps to reproduce? -->',
  ].filter((line) => line !== null);
  const body = bodyLines.join('\n');

  const params = new URLSearchParams();
  params.set('title', title);
  params.set('body', body);
  params.set('labels', 'formatter-error,bug');
  return `${REPO_ISSUES_NEW_URL}?${params.toString()}`;
}

/**
 * FormatterErrorCard — inline dashboard row for an unhealthy formatter.
 *
 * Props:
 *   - formatter: { name, lastError, lastErrorAt, errorCount, ... } from
 *     /api/ui/status `actionItems[]` (type === 'formatter_error').
 *     `lastError` carries the DB incident `id` (P2 phase 3) used for
 *     per-incident dismiss.
 *   - onDismiss({ incidentId, name }) → Promise<void> — caller wires it to
 *     dismissIncident() + refresh(). The card disables both buttons while
 *     the dismiss resolves.
 *
 * Layout deliberately mirrors PairingPromptCard so the two card types sit
 * side by side in the same Action Items list without looking out of place.
 */
export default function FormatterErrorCard({ formatter, onDismiss }) {
  const [dismissing, setDismissing] = useState(false);
  if (!formatter || !formatter.name) return null;

  const lastError = formatter.lastError || {};
  const phase = lastError.phase || 'format';
  const workflow = lastError.workflow || null;
  const message = lastError.message || 'Unknown error';
  const timestamp = lastError.timestamp || formatter.lastErrorAt || null;

  const issueUrl = buildIssueUrl(formatter);

  async function handleDismiss() {
    if (dismissing) return;
    setDismissing(true);
    try {
      if (onDismiss) {
        const incidentId = lastError && lastError.id != null ? lastError.id : null;
        await onDismiss({ incidentId, name: formatter.name });
      }
    } finally {
      setDismissing(false);
    }
  }

  const phaseLabel = workflow
    ? `${phase} · ${workflow}`
    : phase;

  return (
    <div
      className="wp-row"
      style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}
    >
      <div className="wp-row-grow">
        <div className="wp-row-title">
          Formatter error: <span className="wp-mono">{formatter.name}</span>
        </div>
        <div className="wp-row-sub" style={{ marginBottom: 'var(--s-1)' }}>
          <span>{phaseLabel}</span>
          {timestamp ? (
            <>
              <span className="wp-row-sep">·</span>
              <span>{new Date(timestamp).toLocaleTimeString()}</span>
            </>
          ) : null}
          {typeof formatter.errorCount === 'number' ? (
            <>
              <span className="wp-row-sep">·</span>
              <span>{formatter.errorCount} error{formatter.errorCount === 1 ? '' : 's'}</span>
            </>
          ) : null}
        </div>
        <div
          className="wp-row-sub"
          style={{
            color: 'var(--wp-fg-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
          title={message}
        >
          {truncate(message, MESSAGE_DISPLAY_MAX)}
        </div>
        <div style={{ marginTop: 'var(--s-2)' }}>
          <a
            href={`/ui/formatters/logs/?name=${encodeURIComponent(formatter.name)}`}
            className="wp-link"
            style={{ fontSize: 'var(--fs-small)' }}
          >
            View full logs →
          </a>
        </div>
      </div>
      <div className="wp-row-actions" style={{ flexWrap: 'wrap' }}>
        <a
          href={issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="wp-btn wp-btn-primary"
        >
          Report
        </a>
        <button
          type="button"
          className="wp-btn wp-btn-danger"
          onClick={handleDismiss}
          disabled={dismissing}
        >
          {dismissing ? 'Dismissing…' : 'Dismiss'}
        </button>
      </div>
    </div>
  );
}
