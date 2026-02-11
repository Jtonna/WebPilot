/**
 * Scroll utilities for ensuring elements are visible before clicking.
 */

/**
 * Calculate scroll duration based on distance.
 *
 * @param {number} scrollDelta - Pixels to scroll
 * @param {number} [msPerStep=50] - Milliseconds per 50px of distance (50 for window, 75 for container)
 * @returns {number} Duration in ms
 */
export function calculateScrollDuration(scrollDelta, msPerStep = 50) {
  const distance = Math.abs(scrollDelta);
  return Math.max(100, Math.round((distance / 50) * msPerStep));
}

/**
 * Generate JavaScript code for a smooth scroll animation with easeInOutCubic easing.
 * Intended for injection into page context via Runtime.evaluate.
 *
 * Expects `startPos`, `delta`, `duration` variables to be defined in the calling scope.
 *
 * @param {string} setScroll - JS statement to apply scroll. Use `scrollPos` for the computed position.
 * @param {string} onComplete - JS statement to execute on completion.
 * @returns {string} JavaScript code for the animation loop
 */
function generateScrollAnimationCode(setScroll, onComplete) {
  return `
    const startTime = performance.now();
    const maxTime = duration + 2000;

    function easeInOutCubic(t) {
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function step(currentTime) {
      const elapsed = currentTime - startTime;

      if (elapsed > maxTime) {
        const scrollPos = startPos + delta;
        ${setScroll};
        ${onComplete};
        return;
      }

      const progress = Math.min(elapsed / duration, 1);
      const eased = easeInOutCubic(progress);
      const scrollPos = startPos + delta * eased;
      ${setScroll};

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        ${onComplete};
      }
    }

    requestAnimationFrame(step);
  `;
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

  await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `
      new Promise(resolve => {
        const startPos = window.scrollY;
        const delta = ${scrollDelta};
        const duration = ${actualDuration};
        ${generateScrollAnimationCode(
          'window.scrollTo(0, scrollPos)',
          'resolve()'
        )}
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

/**
 * Scroll an element into view, handling scrollable containers correctly.
 * If the element is inside a scrollable container (e.g., dropdown, modal),
 * smoothly scrolls the container using the same easeInOutCubic animation
 * as the main page scroll (75ms per 50px).
 *
 * @param {Object} target - Chrome debugger target
 * @param {string} elementExpression - JS expression that resolves to the DOM element
 * @returns {Promise<{scrolled: boolean, containerScrolled: boolean, scrollDelta: number, duration: number}>}
 */
export async function scrollElementIntoView(target, elementExpression) {
  const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
    expression: `
      new Promise(resolve => {
        const el = ${elementExpression};
        if (!el) {
          resolve({ scrolled: false, containerScrolled: false, error: 'Element not found' });
          return;
        }

        // Walk up the DOM to find the nearest scrollable ancestor
        function getScrollableParent(element) {
          let parent = element.parentElement;
          while (parent && parent !== document.documentElement && parent !== document.body) {
            const style = window.getComputedStyle(parent);
            const overflowY = style.overflowY;
            if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
              return parent;
            }
            parent = parent.parentElement;
          }
          return null;
        }

        const container = getScrollableParent(el);

        if (!container) {
          resolve({ scrolled: false, containerScrolled: false });
          return;
        }

        // Calculate scroll delta to center element within the container's visible area
        const elRect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const elRelativeTop = elRect.top - containerRect.top + container.scrollTop;
        const targetScrollTop = elRelativeTop - container.clientHeight / 2 + elRect.height / 2;
        const delta = targetScrollTop - container.scrollTop;

        // Skip if already visible enough
        if (Math.abs(delta) < 10) {
          resolve({ scrolled: false, containerScrolled: false });
          return;
        }

        const startPos = container.scrollTop;
        const distance = Math.abs(delta);
        const duration = Math.max(100, Math.round((distance / 50) * 75));
        ${generateScrollAnimationCode(
          'container.scrollTop = scrollPos',
          'resolve({ scrolled: true, containerScrolled: true, scrollDelta: Math.round(delta), duration })'
        )}
      })
    `,
    awaitPromise: true,
    returnByValue: true
  });

  return result.result?.value || { scrolled: false, containerScrolled: false };
}
