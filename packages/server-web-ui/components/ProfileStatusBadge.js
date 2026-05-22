'use client';

import Pill from './Pill';

/**
 * ProfileStatusBadge — a small, quiet pill showing a profile's WebPilot
 * status. Thin wrapper that maps the server's `webPilotStatus` field onto
 * the shared `Pill` primitive (`.wp-pill` markup). State + label are the
 * only per-domain variation here, so the wrapper exists only to keep the
 * Profile → status mapping in one place.
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
  return <Pill state={state} label={meta.label} />;
}

export const NEEDS_SETUP_HINT =
  'Open chrome://extensions, turn on Developer mode, and load the WebPilot extension folder.';
