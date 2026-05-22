'use client';

import Pill from './Pill';

/**
 * HealthPill — small status pill for formatter health rendering. Thin
 * wrapper that maps the server's `/api/ui/formatters` `health` field onto
 * the shared `Pill` primitive (`.wp-pill` markup).
 *
 * Three states (matching `formatter-logs.js` `computeHealth`):
 *   - "healthy"   The last N invocations succeeded (or the formatter has
 *                 been called fewer than the minimum number of times).
 *   - "unhealthy" At least one of the last N invocations threw.
 *   - "unknown"   The formatter has never been invoked yet. Server returns
 *                 this for newly-loaded formatters that haven't run.
 */

const HEALTH_META = {
  healthy:   { state: 'info',    label: 'Healthy' },
  unhealthy: { state: 'danger',  label: 'Unhealthy' },
  unknown:   { state: 'unknown', label: 'Not yet used' },
};

export default function HealthPill({ health }) {
  const meta = HEALTH_META[health] || HEALTH_META.unknown;
  return <Pill state={meta.state} label={meta.label} />;
}
