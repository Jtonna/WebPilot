'use client';

/**
 * ProfileStatusBadge — colored dot + label pill for a profile's WebPilot
 * status. Mirrors the visual idiom used in StatusCard (dot + text on the dark
 * theme card background).
 *
 * Three states (matching the server's /api/ui/status `webPilotStatus`):
 *   - "active"      Profile is currently holding a live WebSocket.
 *                   Green dot, label "Active".
 *   - "ready"       Profile has completed a hello in the past but isn't
 *                   currently connected. Yellow dot, label "Ready".
 *   - "needs_setup" Profile exists in Local State but has never registered
 *                   an extension install. Gray dot, label "Needs Setup".
 *
 * Anything else falls back to a muted "Unknown" badge so a future server
 * value doesn't blow up the UI.
 */

const STATE_META = {
  active: {
    label: 'Active',
    color: 'var(--wp-success)',
  },
  ready: {
    label: 'Ready',
    color: 'var(--wp-warning)',
  },
  needs_setup: {
    label: 'Needs Setup',
    color: 'var(--wp-fg-muted)',
  },
};

export default function ProfileStatusBadge({ status }) {
  const meta = STATE_META[status] || { label: 'Unknown', color: 'var(--wp-fg-muted)' };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        border: '1px solid var(--wp-border)',
        backgroundColor: 'var(--wp-bg-elevated)',
        fontSize: '0.8rem',
        fontWeight: 500,
        color: 'var(--wp-fg)',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        className="wp-status-dot"
        style={{ backgroundColor: meta.color, margin: 0 }}
      />
      {meta.label}
    </span>
  );
}

export const NEEDS_SETUP_HINT =
  'Enable: chrome://extensions → Developer Mode → Load unpacked';
