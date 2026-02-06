/**
 * Timing utilities for human-like interactions.
 */

/**
 * Generate a weighted random delay favoring longer delays.
 * Uses inverted exponential curve: 1 - (1-x)²
 * ~75% of values fall in the upper half of the range.
 *
 * @param {number} min - Minimum delay in ms (default: 10)
 * @param {number} max - Maximum delay in ms (default: 90)
 * @returns {number} Random delay in ms
 */
export function getWeightedRandomDelay(min = 10, max = 90) {
  const random = 1 - Math.pow(1 - Math.random(), 2);
  return Math.floor(min + random * (max - min));
}

/**
 * Generate random timing values for cursor animation.
 *
 * @returns {Object} Object with spawnDelay, moveDuration, lingerDelay
 */
export function generateCursorTimings() {
  return {
    spawnDelay: Math.floor(200 + Math.random() * 150),    // 200-350ms
    moveDuration: Math.floor(700 + Math.random() * 400),  // 700-1100ms
    lingerDelay: Math.floor(400 + Math.random() * 350)    // 400-750ms
  };
}

/**
 * Simple delay helper.
 *
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
