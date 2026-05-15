'use client';

import Ticker from './Ticker';

/**
 * StatusCard — a quiet KPI tile. Used in a grid with `.wp-instruments`.
 * Reads top to bottom:
 *
 *   Label                (small, secondary)
 *   Value                (large, weight-500, optionally tabular numerals)
 *   detail               (secondary)
 *
 * `state` controls the dot color (Apple system palette). Numeric values
 * tick up from 0 → target on mount via the shared Ticker component.
 */

const STATE_VAR = {
  ok: 'var(--wp-success)',
  warn: 'var(--wp-warning)',
  error: 'var(--wp-danger)',
  accent: 'var(--wp-accent)',
  unknown: 'var(--wp-fg-muted)',
};

function isNumericLike(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return true;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return true;
  return false;
}

export default function StatusCard({ title, value, state = 'unknown', detail, mono = false, padWidth }) {
  const dotColor = STATE_VAR[state] || STATE_VAR.unknown;
  const numeric = isNumericLike(value);
  return (
    <div className="wp-instrument">
      <div className="wp-instrument-label">{title}</div>
      <div className={`wp-instrument-value${mono ? ' wp-instrument-value-mono' : ''}`}>
        <span className="wp-instrument-dot" style={{ backgroundColor: dotColor }} />
        <span>
          {numeric ? <Ticker value={value} pad={padWidth} /> : value}
        </span>
      </div>
      {detail ? (
        <div className="wp-instrument-detail">{detail}</div>
      ) : null}
    </div>
  );
}
