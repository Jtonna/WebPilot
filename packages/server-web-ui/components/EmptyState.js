'use client';

/**
 * EmptyState — the single canonical "this list/section has nothing in it
 * yet" block. Consolidates the seven hand-rolled
 * `<div className="wp-card"><div className="wp-empty" style={{ padding: 0 }}>…`
 * copies that were sprinkled across the dashboard, formatters, pairings,
 * profiles, agents and sites pages.
 *
 * Two visual variants:
 *   - "card"  (default) — wraps the message in `.wp-card` so it sits flush
 *     with surrounding cards. The inner `.wp-empty` zeroes its own
 *     padding because the card already supplies it.
 *   - "bare"           — renders just `.wp-empty` (no card chrome). Used
 *     inside `.wp-inset-group`s where the parent already supplies the
 *     card surface (dashboard "Action items" + pairings inbox).
 *
 * Optional `title` renders as a small label above the body. `action`
 * accepts a single JSX node (typically a button) and sits beneath the body
 * with the gap the rest of the UI uses for inset-row spacing.
 */
export default function EmptyState({ title, body, action, variant = 'card' }) {
  const innerStyle = variant === 'card' ? { padding: 0 } : undefined;
  const inner = (
    <div className="wp-empty" style={innerStyle}>
      {title ? (
        <div
          style={{
            color: 'var(--wp-fg)',
            fontWeight: 500,
            marginBottom: 'var(--s-1)',
          }}
        >
          {title}
        </div>
      ) : null}
      {body}
      {action ? (
        <div style={{ marginTop: 'var(--s-3)' }}>{action}</div>
      ) : null}
    </div>
  );

  if (variant === 'bare') return inner;
  return <div className="wp-card">{inner}</div>;
}
