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
