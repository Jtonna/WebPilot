/**
 * Scroll utilities for ensuring elements are visible before clicking.
 */

/**
 * Calculate scroll duration based on distance.
 * Formula: 50ms per 50px of scroll distance.
 *
 * @param {number} scrollDelta - Pixels to scroll
 * @returns {number} Duration in ms
 */
export function calculateScrollDuration(scrollDelta) {
  const distance = Math.abs(scrollDelta);
  return Math.max(100, Math.round((distance / 50) * 50));
}

/**
 * Perform smooth scroll animation using in-page requestAnimationFrame.
 * Much smoother than multiple CDP calls.
 *
 * @param {Object} target - Chrome debugger target
 * @param {number} scrollDelta - Pixels to scroll (positive = down, negative = up)
 * @param {number} [duration] - Animation duration in ms (auto-calculated if not provided)
 */
export async function animateScroll(target, scrollDelta, duration) {
  const actualDuration = duration ?? calculateScrollDuration(scrollDelta);

  // Run entire animation in-page for smoothness
  // Includes hard timeout to prevent RAF hangs on inactive/throttled tabs
  await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `
      new Promise(resolve => {
        const startY = window.scrollY;
        const delta = ${scrollDelta};
        const duration = ${actualDuration};
        const startTime = performance.now();
        const maxTime = duration + 2000; // Hard limit: animation + 2s safety margin

        function easeInOutCubic(t) {
          return t < 0.5
            ? 4 * t * t * t
            : 1 - Math.pow(-2 * t + 2, 3) / 2;
        }

        function step(currentTime) {
          const elapsed = currentTime - startTime;

          // Safety timeout: if animation hangs, jump to final position
          if (elapsed > maxTime) {
            window.scrollTo(0, startY + delta);
            resolve();
            return;
          }

          const progress = Math.min(elapsed / duration, 1);
          const eased = easeInOutCubic(progress);

          window.scrollTo(0, startY + delta * eased);

          if (progress < 1) {
            requestAnimationFrame(step);
          } else {
            resolve();
          }
        }

        requestAnimationFrame(step);
      })
    `,
    awaitPromise: true,
    returnByValue: true
  });
}

/**
 * Calculate scroll delta needed to center element in viewport.
 *
 * @param {Object} target - Chrome debugger target
 * @param {number} elementAbsoluteY - Element's absolute Y position (document coordinates)
 * @returns {Promise<number>} Scroll delta (positive = scroll down)
 */
export async function calculateScrollDelta(target, elementAbsoluteY) {
  const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: '({ height: window.innerHeight, scrollY: window.scrollY })',
    returnByValue: true
  });
  const viewport = result.result?.value;

  // Target: center element in viewport
  const targetScrollY = elementAbsoluteY - viewport.height / 2;
  return targetScrollY - viewport.scrollY;
}

/**
 * Generate code to check if coordinates are visible in viewport.
 *
 * @param {number} x - X coordinate to check
 * @param {number} y - Y coordinate to check
 * @returns {string} JavaScript code to execute
 */
export function generateViewportCheckCode(x, y) {
  return `
    (function() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inViewport = ${x} >= 0 && ${x} <= vw && ${y} >= 0 && ${y} <= vh;
      return { inViewport, viewport: { width: vw, height: vh }, target: { x: ${x}, y: ${y} } };
    })();
  `;
}

/**
 * Generate code to scroll element into view by CSS selector.
 * Used as fallback when we don't have backendNodeId.
 *
 * @param {string} selector - CSS selector for the element
 * @returns {string} JavaScript code to execute
 */
export function generateScrollIntoViewCode(selector) {
  return `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { scrolled: false, error: 'Element not found' };

      const rect = el.getBoundingClientRect();
      const wasOffScreen = rect.top < 0 || rect.bottom > window.innerHeight;

      if (wasOffScreen) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        return { scrolled: true, originalY: rect.top };
      }
      return { scrolled: false };
    })();
  `;
}
