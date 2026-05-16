'use client';

/**
 * StatusRow — a row inside the Dashboard's "System status" card.
 *
 * Props:
 *   label       — string label (e.g. "Chrome").
 *   icon        — Heroicon component (rendered at 20px).
 *   state       — 'ok' | 'warn' | 'danger' | 'unknown'. Drives dot color.
 *   value       — string shown on the right.
 *   actionLabel — optional inline action label (e.g. "Restart Chrome").
 *   onAction    — optional click handler for the action.
 */
export default function StatusRow({
  label,
  icon: Icon,
  state = 'unknown',
  value,
  actionLabel,
  onAction,
}) {
  return (
    <div className="wp-status-row" data-state={state}>
      <span className="wp-status-row-icon" aria-hidden="true">
        {Icon ? <Icon style={{ width: 20, height: 20 }} /> : null}
      </span>
      <div className="wp-status-row-body">
        <span className="wp-status-row-label">{label}</span>
        {actionLabel ? (
          <button
            type="button"
            className="wp-status-row-action"
            onClick={onAction}
          >
            {actionLabel}
          </button>
        ) : null}
      </div>
      <span className="wp-status-row-right">
        <span>{value}</span>
        <span className="wp-status-row-dot" aria-hidden="true" />
      </span>
    </div>
  );
}
