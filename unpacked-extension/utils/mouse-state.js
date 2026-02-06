/**
 * Per-tab virtual mouse position tracking.
 *
 * Tracks where the virtual cursor last was on each tab,
 * so subsequent clicks can start from that position.
 */

// Map<tabId, {x: number, y: number}>
const tabPositions = new Map();

/**
 * Get the last known virtual mouse position for a tab.
 * Returns null if no position recorded (first interaction).
 *
 * @param {number} tabId
 * @returns {{x: number, y: number} | null}
 */
export function getLastPosition(tabId) {
  return tabPositions.get(tabId) || null;
}

/**
 * Update the virtual mouse position for a tab.
 *
 * @param {number} tabId
 * @param {number} x
 * @param {number} y
 */
export function setLastPosition(tabId, x, y) {
  tabPositions.set(tabId, { x, y });
}

/**
 * Clear the position for a tab (e.g., when tab is closed).
 *
 * @param {number} tabId
 */
export function clearPosition(tabId) {
  tabPositions.delete(tabId);
}

/**
 * Get the starting position for a mouse movement.
 * Returns last position if available, otherwise viewport center.
 *
 * @param {number} tabId
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @returns {{x: number, y: number}}
 */
export function getStartPosition(tabId, viewportWidth, viewportHeight) {
  const last = getLastPosition(tabId);
  if (last) {
    return last;
  }
  // Default to viewport center
  return {
    x: Math.round(viewportWidth / 2),
    y: Math.round(viewportHeight / 2)
  };
}

/**
 * Check if a tab has a recorded position.
 *
 * @param {number} tabId
 * @returns {boolean}
 */
export function hasPosition(tabId) {
  return tabPositions.has(tabId);
}
