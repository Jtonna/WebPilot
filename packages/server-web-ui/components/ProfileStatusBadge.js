'use client';

/**
 * ProfileStatusBadge — a hairline pill showing a profile's WebPilot status.
 * Mirrors the runtime telemetry idiom: mono uppercase, tiny dot prefix.
 *
 * Three states (matching the server's /api/ui/status `webPilotStatus`):
 *   - "active"      Profile is currently holding a live WebSocket.
 *                   Green dot (pulses), label "Active".
 *   - "ready"       Profile has completed a hello in the past but isn't
 *                   currently connected. Accent-orange dot, label "Ready".
 *   - "needs_setup" Profile exists in Local State but has never registered
 *                   an extension install. Muted dot, label "Needs Setup".
 *
 * Anything else falls back to a muted "Unknown" badge so a future server
 * value doesn't blow up the UI.
 */

const STATE_META = {
  active: { label: 'Active' },
  ready: { label: 'Ready' },
  needs_setup: { label: 'Needs Setup' },
};

export default function ProfileStatusBadge({ status }) {
  const meta = STATE_META[status] || { label: 'Unknown' };
  const state = STATE_META[status] ? status : 'unknown';
  return (
    <span className="wp-pill" data-state={state}>
      <span className="wp-pill-dot" />
      {meta.label}
    </span>
  );
}

export const NEEDS_SETUP_HINT =
  'Enable: chrome://extensions → Developer Mode → Load unpacked';
