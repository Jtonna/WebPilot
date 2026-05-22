// Shared formatters for the WebPilot UI.
//
// `formatRelativeTime` is used by AgentRow (Last active) and the Pairings
// History list. Returns a short, human relative time for events within the
// last week; falls back to an absolute date for anything older.

/**
 * Format a Date / ISO-string / millis as a relative time:
 *
 *   < 60s   → "Just now"
 *   < 60m   → "<N>m ago"
 *   < 24h   → "<N>h ago"
 *   = 1d    → "Yesterday"
 *   ≤ 7d    → "<N>d ago"
 *   else    → "May 14"   (locale month + day)
 *
 * Invalid/empty input → "never".
 */
export function formatRelativeTime(value) {
  if (!value) return 'never';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr  = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr  < 24) return `${diffHr}h ago`;
  if (diffDay < 2)  return 'Yesterday';
  if (diffDay <= 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Resolve a profile's display label from a list and a directoryName.
 *
 * Used by AgentRow, PairAgentModal, and the agents/pairings/profiles pages
 * to render a friendly "Bound to <name>" / approval-history label without
 * each call site repeating the `find + (displayName || directoryName)` dance.
 *
 *   profileLabel(profiles, 'WebPilotSandbox')            → 'WebPilot Sandbox'
 *   profileLabel(profiles, 'unknown-dir')                → 'unknown-dir'
 *   profileLabel(profiles, '', 'no profile')             → 'no profile'
 */
export function profileLabel(profiles, id, fallback = id || '') {
  if (!id) return fallback;
  const match = (profiles || []).find((p) => p.directoryName === id);
  return (match && (match.displayName || match.directoryName)) || fallback;
}

/**
 * Build the {value,label}[] list for a profile dropdown.
 *
 * Default behavior appends a `+ New sandbox profile` option (used by the
 * pairing approval card to let the user spin up a fresh profile inline).
 * Pass `{ includeNewSandbox: false }` to suppress.
 *
 * If only the "+ New sandbox" option exists (no real profiles loaded yet),
 * prepends a `Default` so the dropdown is never functionally empty —
 * matches the inline implementations on the Home and Pairings pages.
 */
export function profileOptions(profiles, { includeNewSandbox = true } = {}) {
  const options = (profiles || []).map((p) => ({
    value: p.directoryName,
    label: p.displayName || p.directoryName,
  }));
  if (includeNewSandbox) {
    options.push({ value: '__new__', label: '+ New sandbox profile' });
  }
  if (options.length === 1) {
    options.unshift({ value: 'Default', label: 'Default' });
  }
  return options;
}
