'use client';

/**
 * StatusCard — a Mission Control "instrument" tile. Used in a grid so the
 * surrounding `.wp-instruments` container provides the outer hairline and
 * the cells share inner hairlines. Each tile reads top to bottom:
 *
 *   LABEL                (mono, uppercase, muted)
 *   VALUE                (italic serif, large)
 *   detail               (mono, uppercase, secondary)
 *
 * `state` controls the dot color; falls back to muted for unknown.
 */

const STATE_VAR = {
  ok: 'var(--wp-success)',
  warn: 'var(--wp-warning)',
  error: 'var(--wp-danger)',
  accent: 'var(--wp-accent)',
  unknown: 'var(--wp-fg-muted)',
};

export default function StatusCard({ title, value, state = 'unknown', detail, mono = false }) {
  const dotColor = STATE_VAR[state] || STATE_VAR.unknown;
  return (
    <div className="wp-instrument">
      <div className="wp-instrument-label">{title}</div>
      <div className={`wp-instrument-value${mono ? ' wp-instrument-value-mono' : ''}`}>
        <span className="wp-instrument-dot" style={{ backgroundColor: dotColor }} />
        <span>{value}</span>
      </div>
      {detail ? (
        <div className="wp-instrument-detail">{detail}</div>
      ) : null}
    </div>
  );
}
