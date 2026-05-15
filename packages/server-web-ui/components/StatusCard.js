'use client';

import Ticker from './Ticker';

/**
 * StatusCard — a Mission Control "instrument" tile. Used in a grid so the
 * surrounding `.wp-instruments` container provides the outer hairline and
 * the cells share inner hairlines. Each tile reads top to bottom:
 *
 *   LABEL                (mono, uppercase, muted)
 *   VALUE                (italic serif, large; numeric values tick up)
 *   detail               (mono, uppercase, secondary)
 *
 * `state` controls the dot color; falls back to muted for unknown.
 * If `value` is numeric (number or all-digit string) the value tickers from
 * 0 → target on mount. Non-numeric values render straight through.
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
