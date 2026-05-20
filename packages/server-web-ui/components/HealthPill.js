'use client';

/**
 * HealthPill — small status pill for formatter health rendering.
 *
 * Three states (matching the server's `/api/ui/formatters` `health` field
 * and `formatter-logs.js` `computeHealth`):
 *   - "healthy"   The last N invocations succeeded (or the formatter has
 *                 been called fewer than the minimum number of times).
 *   - "unhealthy" At least one of the last N invocations threw.
 *   - "unknown"   The formatter has never been invoked yet. Server returns
 *                 this for newly-loaded formatters that haven't run.
 *
 * Reuses the existing `wp-pill` system (data-state slots: `info`/`danger`/
 * `unknown`) rather than introducing a parallel component, so visual
 * styling stays consistent with `ProfileStatusBadge`.
 */

const HEALTH_META = {
  healthy:   { state: 'info',    label: 'Healthy' },
  unhealthy: { state: 'danger',  label: 'Unhealthy' },
  unknown:   { state: 'unknown', label: 'Not yet used' },
};

export default function HealthPill({ health }) {
  const meta = HEALTH_META[health] || HEALTH_META.unknown;
  return (
    <span className="wp-pill" data-state={meta.state}>
      <span className="wp-pill-dot" />
      <span className="wp-pill-label">{meta.label}</span>
    </span>
  );
}
