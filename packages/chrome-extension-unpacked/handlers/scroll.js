/**
 * Scroll handler - smooth incremental scrolling with easing.
 * Duration calculated automatically: 75ms per 50px of distance.
 */

import { getSession } from '../utils/debugger.js';
import { getBackendNodeId } from '../accessibility-storage.js';
import { animateScroll, calculateScrollDuration } from '../utils/scroll.js';

/**
 * Scroll to bring an element into view OR scroll by pixel amount.
 *
 * @param {Object} params
 * @param {number} params.tab_id - Target tab ID
 * @param {string} [params.ref] - Accessibility tree ref (mutually exclusive with pixels)
 * @param {string} [params.selector] - CSS selector (mutually exclusive with pixels)
 * @param {number} [params.pixels] - Pixels to scroll, positive=down (mutually exclusive with ref/selector)
 * @returns {Promise<Object>} Scroll result
 */
export async function scroll(params) {
  const { tab_id, ref, selector, pixels } = params;

  if (!tab_id) throw new Error('tab_id is required');

  const hasElement = ref || selector;
  const hasPixels = pixels !== undefined && pixels !== null;

  if (!hasElement && !hasPixels) {
    throw new Error('Either ref/selector OR pixels is required');
  }
  if (hasElement && hasPixels) {
    throw new Error('Cannot specify both element target and pixels - use one or the other');
  }

  const target = await getSession(tab_id);

  let scrollDelta;

  if (hasPixels) {
    scrollDelta = pixels;
  } else {
    // Get element's absolute Y position
    let elementAbsoluteY;

    if (ref) {
      const backendNodeId = getBackendNodeId(tab_id, ref);
      if (!backendNodeId) {
        throw new Error(`Ref "${ref}" not found. Fetch accessibility tree first.`);
      }

      const boxModel = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', {
        backendNodeId
      });

      if (!boxModel?.model) {
        throw new Error(`Element for ref "${ref}" no longer exists`);
      }

      const quad = boxModel.model.content;
      const elementViewportY = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);

      const scrollResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: 'window.scrollY',
        returnByValue: true
      });
      const currentScrollY = scrollResult.result?.value || 0;
      elementAbsoluteY = elementViewportY + currentScrollY;
    } else if (selector) {
      const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { y: rect.top + rect.height / 2 + window.scrollY };
          })()
        `,
        returnByValue: true
      });
      elementAbsoluteY = result.result?.value?.y;
    }

    if (elementAbsoluteY === undefined || elementAbsoluteY === null) {
      throw new Error('Could not determine element position');
    }

    // Calculate scroll delta to center element in viewport
    const viewportResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: '({ height: window.innerHeight, scrollY: window.scrollY })',
      returnByValue: true
    });
    const viewport = viewportResult.result?.value;
    const targetScrollY = elementAbsoluteY - viewport.height / 2;
    scrollDelta = targetScrollY - viewport.scrollY;
  }

  // If scroll is negligible, skip
  if (Math.abs(scrollDelta) < 10) {
    return { success: true, scrolled: false, reason: 'already in view' };
  }

  const duration = calculateScrollDuration(scrollDelta);

  // Perform smooth animated scroll
  await animateScroll(target, scrollDelta, duration);

  return {
    success: true,
    scrolled: true,
    tab_id,
    ref,
    selector,
    pixels: hasPixels ? pixels : undefined,
    scrollDelta: Math.round(scrollDelta),
    duration
  };
}
