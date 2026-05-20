'use client';

/**
 * ProfileStatusBadge — a small, quiet pill showing a profile's WebPilot
 * status. Sentence-case, tiny dot prefix, no border.
 *
 * Three states (matching the server's /api/ui/status `webPilotStatus`):
 *   - "active"      Profile is holding a live WebSocket. Accent dot, faint
 *                   accent bg.
 *   - "ready"       Profile has completed a hello but isn't connected now.
 *                   Secondary-grey dot, no bg.
 *   - "needs_setup" Profile exists in Local State but has never registered
 *                   an extension install. Muted dot, no bg.
 *
 * Anything else falls back to a muted "Unknown" badge.
 */

const STATE_META = {
  active: { label: 'Active' },
  ready: { label: 'Ready' },
  needs_setup: { label: 'Needs setup' },
};

export default function ProfileStatusBadge({ status }) {
  const meta = STATE_META[status] || { label: 'Unknown' };
  const state = STATE_META[status] ? status : 'unknown';
  // Re-key the label span on state change so the small fade-in keyframe runs.
  // This is the "fade out, swap, fade in" trick — but trimmed to a single
  // fade-in on the new value (the old one disappears in the React unmount).
  return (
    <span className="wp-pill" data-state={state}>
      <span className="wp-pill-dot" />
      <span className="wp-pill-label" key={state}>{meta.label}</span>
    </span>
  );
}

export const NEEDS_SETUP_HINT =
  'Open chrome://extensions, turn on Developer mode, and load the WebPilot extension folder.';
