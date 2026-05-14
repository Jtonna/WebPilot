'use client';

const STATE_COLORS = {
  ok: 'var(--wp-success)',
  warn: 'var(--wp-warning)',
  error: 'var(--wp-danger)',
  unknown: 'var(--wp-fg-muted)',
};

export default function StatusCard({ title, value, state = 'unknown', detail }) {
  const dotColor = STATE_COLORS[state] || STATE_COLORS.unknown;
  return (
    <div className="wp-card" style={{ flex: 1, minWidth: 200 }}>
      <div className="wp-muted" style={{ marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: '1.2rem', fontWeight: 600 }}>
        <span className="wp-status-dot" style={{ backgroundColor: dotColor }} />
        {value}
      </div>
      {detail ? (
        <div className="wp-muted" style={{ marginTop: 6 }}>{detail}</div>
      ) : null}
    </div>
  );
}
