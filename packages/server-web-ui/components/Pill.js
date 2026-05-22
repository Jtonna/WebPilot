'use client';

/**
 * Pill — the shared `.wp-pill` primitive. Tiny dot + label, coloured by
 * `data-state`. This is the underlying building block; domain-specific
 * pills (`ProfileStatusBadge`, `HealthPill`, decision / source pills on
 * `/sites`, history pills on `/pairings`) are thin wrappers that map a
 * domain status onto a Pill state.
 *
 * Available states (matched to globals.css `.wp-pill[data-state="…"]`):
 *   - "active"      success-green dot
 *   - "ready"       accent dot
 *   - "needs_setup" warning dot
 *   - "warn"        warning dot
 *   - "danger"      danger dot
 *   - "info"        info dot
 *   - "unknown"     muted-fg dot (fallback)
 *
 * The `label` span is re-keyed on state change so `.wp-pill-label`'s mount
 * opacity keyframe replays on every state transition.
 */
export default function Pill({ state = 'unknown', label }) {
  return (
    <span className="wp-pill" data-state={state}>
      <span className="wp-pill-dot" />
      <span className="wp-pill-label" key={state}>{label}</span>
    </span>
  );
}
