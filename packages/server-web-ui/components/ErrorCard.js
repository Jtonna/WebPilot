'use client';

/**
 * ErrorCard — uniform error display for the "we couldn't talk to the server"
 * shape that recurs on every top-level page. Two variants:
 *
 *   <ErrorCard error={err} />                      // simple
 *   <ErrorCard title="Couldn't load history."      // custom title + retry
 *              error={err}
 *              onRetry={handleRetry} />
 *
 * Uses CSS tokens (--wp-danger, --fs-small) rather than literal pixel sizes
 * so colors and type-scale stay in lockstep with the rest of the UI.
 */
export default function ErrorCard({
  title = 'Couldn’t reach the server.',
  error,
  onRetry,
}) {
  const message =
    typeof error === 'string'
      ? error
      : (error && error.message) || '';

  return (
    <div className="wp-card">
      <div style={{ color: 'var(--wp-danger)', fontWeight: 500, marginBottom: 6 }}>
        {title}
      </div>
      {message ? (
        <div
          className="wp-secondary"
          style={{
            fontSize: 'var(--fs-small)',
            marginBottom: onRetry ? 'var(--s-3)' : 0,
          }}
        >
          {message}
        </div>
      ) : null}
      {onRetry ? (
        <button
          type="button"
          className="wp-link"
          onClick={onRetry}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
