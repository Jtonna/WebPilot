/**
 * Click handler - CDP mouse simulation with WindMouse human-like movement.
 */

import { getBackendNodeId, getRefContext, findRefByAncestry } from '../accessibility-storage.js';
import { getAccessibilityTree } from './accessibility.js';
import { getSession } from '../utils/debugger.js';
import { getWeightedRandomDelay } from '../utils/timing.js';
import { generateWindMousePath, getPathStats } from '../utils/windmouse.js';
import { getStartPosition, setLastPosition } from '../utils/mouse-state.js';
import {
  generateCursorCreateCode,
  generateCursorMoveCode,
  generateRippleCode,
  generateCursorRemoveCode
} from '../utils/cursor.js';
import { generateViewportCheckCode, animateScroll, calculateScrollDelta, scrollElementIntoView } from '../utils/scroll.js';

/**
 * Click at coordinates, CSS selector, or accessibility tree ref.
 * Uses WindMouse algorithm for human-like mouse movement.
 *
 * @param {Object} params
 * @param {number} params.tab_id - Target tab ID
 * @param {string} [params.ref] - Accessibility tree ref (e.g., "e1")
 * @param {string} [params.selector] - CSS selector
 * @param {number} [params.x] - X coordinate
 * @param {number} [params.y] - Y coordinate
 * @param {string} [params.button='left'] - Mouse button (left/right/middle)
 * @param {number} [params.clickCount=1] - Number of clicks
 * @param {number} [params.delay] - Override press/release delay
 * @param {boolean} [params.showCursor=true] - Show visual cursor
 * @returns {Promise<Object>} Click result
 */
export async function click(params) {
  const { tab_id, selector, ref, button = 'left', clickCount = 1, showCursor = true } = params;
  let { x, y } = params;

  const clickDelay = params.delay ?? getWeightedRandomDelay();
  const lingerDelay = Math.floor(800 + Math.random() * 700); // 800-1500ms (doubled)

  if (!tab_id) throw new Error('tab_id is required');
  if (!selector && !ref && (x === undefined || y === undefined)) {
    throw new Error('Either selector, ref, or x,y coordinates are required');
  }
  if (!['left', 'right', 'middle'].includes(button)) {
    throw new Error('button must be left, right, or middle');
  }

  // ---------------------------------------------------------------------------
  // Detach watch.
  //
  // When a click triggers SPA navigation (e.g. Discord, GitHub PR pages, gmail
  // — anything that swaps the document via pushState + DOM replacement), the
  // CDP target attached to this tab can be torn down mid-flight. Any
  // `chrome.debugger.sendCommand` call in progress at that moment may neither
  // resolve nor reject — the await hangs forever. The mouse events have
  // already fired (the click "worked" from the user's POV), but the handler
  // never reaches its `return`, no response is sent back to the server, and
  // the server's COMMAND_TIMEOUT (30s) eventually fires with a misleading
  // "Command timeout" error.
  //
  // We listen for chrome.debugger.onDetach scoped to this tab. If it fires
  // partway through the click, we short-circuit at the next checkpoint and
  // return success with `navigated: true` so the caller knows the click
  // landed AND triggered a context teardown.
  // ---------------------------------------------------------------------------
  let detached = false;
  let detachReason = null;
  const onDetach = (source, reason) => {
    if (source && source.tabId === tab_id) {
      detached = true;
      detachReason = reason || 'unknown';
    }
  };
  chrome.debugger.onDetach.addListener(onDetach);

  try {
  const target = await getSession(tab_id);

  // Get viewport dimensions for start position calculation
  const viewportResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: '({ width: window.innerWidth, height: window.innerHeight })',
      returnByValue: true
    });
    const viewport = viewportResult.result?.value || { width: 1920, height: 1080 };

    // Track backendNodeId for potential scroll + re-fetch
    let backendNodeId = null;

    // Resolve ref to coordinates
    if (ref) {
      backendNodeId = getBackendNodeId(tab_id, ref);
      if (!backendNodeId) {
        throw new Error(`Ref "${ref}" not found. Fetch accessibility tree first.`);
      }

      const boxModel = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', {
        backendNodeId: backendNodeId
      });

      if (!boxModel || !boxModel.model) {
        throw new Error(`Element for ref "${ref}" no longer exists in DOM`);
      }

      const quad = boxModel.model.content;
      x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
      y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
    }

    // Resolve selector to coordinates
    if (selector) {
      const evalResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'Element not found: ' + ${JSON.stringify(selector)} };
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return { error: 'Element has no dimensions' };
            return {
              x: Math.round(rect.x + rect.width / 2),
              y: Math.round(rect.y + rect.height / 2)
            };
          })()
        `,
        returnByValue: true
      });

      if (evalResult.result?.value?.error) {
        throw new Error(evalResult.result.value.error);
      }
      if (!evalResult.result?.value?.x) {
        throw new Error('Failed to get element coordinates');
      }

      x = evalResult.result.value.x;
      y = evalResult.result.value.y;
    }

    // Check if target is in viewport and scroll if needed
    const viewportCheck = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: generateViewportCheckCode(x, y),
      returnByValue: true
    });

    const inViewport = viewportCheck.result?.value?.inViewport;
    let scrolled = false;

    // If off-screen, scroll element into view with smooth animation
    if (!inViewport && (ref || selector)) {
      // First, check if element is inside a scrollable container (e.g., dropdown, modal)
      // If so, scroll the container instead of the main page
      let containerHandled = false;

      if (selector) {
        const containerResult = await scrollElementIntoView(
          target,
          `document.querySelector(${JSON.stringify(selector)})`
        );
        if (containerResult.containerScrolled) {
          scrolled = true;
          containerHandled = true;
          await sleep(150);
        }
      } else if (ref && backendNodeId) {
        // Resolve backendNodeId to a JS object, tag it temporarily, then check for scrollable container
        try {
          const resolved = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', {
            backendNodeId: backendNodeId
          });
          if (resolved?.object?.objectId) {
            // Tag the element so we can find it from in-page JS
            await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
              objectId: resolved.object.objectId,
              functionDeclaration: 'function() { this.setAttribute("data-webpilot-scroll-target", "1"); }',
              returnByValue: true
            });

            const containerResult = await scrollElementIntoView(
              target,
              `document.querySelector('[data-webpilot-scroll-target]')`
            );

            // Clean up the temporary attribute
            await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
              objectId: resolved.object.objectId,
              functionDeclaration: 'function() { this.removeAttribute("data-webpilot-scroll-target"); }',
              returnByValue: true
            }).catch(() => {});

            if (containerResult.containerScrolled) {
              scrolled = true;
              containerHandled = true;
              await sleep(150);
            }
          }
        } catch (e) {
          // If resolving fails, fall through to window scroll
        }
      }

      // If not handled by container scroll, use window scroll with custom easing
      if (!containerHandled) {
        // Calculate element's absolute Y position (document coordinates)
        const scrollYResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: 'window.scrollY',
          returnByValue: true
        });
        const currentScrollY = scrollYResult.result?.value || 0;
        const elementAbsoluteY = y + currentScrollY;

        // Calculate scroll delta to center element in viewport
        const scrollDelta = await calculateScrollDelta(target, elementAbsoluteY);

        // Perform smooth animated scroll (75ms per 50px)
        if (Math.abs(scrollDelta) >= 50) {
          await animateScroll(target, scrollDelta);
          scrolled = true;

          // Let page settle after scroll (layout shifts, lazy loading, React re-renders)
          await sleep(150);
        }
      }

      // Re-fetch coordinates after scroll with element verification
      if (ref && backendNodeId) {
        let elementValid = true;
        const storedContext = getRefContext(tab_id, ref);

        // Verify element is still correct
        if (storedContext) {
          try {
            const nodeInfo = await chrome.debugger.sendCommand(target, 'DOM.describeNode', {
              backendNodeId: backendNodeId
            });

            // Basic validation: check if node type makes sense
            const currentNodeName = nodeInfo.node?.nodeName?.toLowerCase();
            const roleMatches = (
              (storedContext.role === 'button' && (currentNodeName === 'button' || currentNodeName === 'div' || currentNodeName === 'span')) ||
              (storedContext.role === 'link' && currentNodeName === 'a') ||
              currentNodeName !== undefined
            );

            if (!roleMatches) {
              elementValid = false;
            }
          } catch (e) {
            // Node no longer exists in DOM
            elementValid = false;
          }
        }

        if (!elementValid && storedContext) {
          console.log('Element changed after scroll, attempting re-identification...');

          // Re-fetch accessibility tree
          await getAccessibilityTree({ tab_id, usePlatformOptimizer: true });

          // Find new ref by matching ancestry context
          const newRef = findRefByAncestry(tab_id, storedContext);

          if (newRef) {
            const newBackendNodeId = getBackendNodeId(tab_id, newRef);
            if (newBackendNodeId) {
              const newBoxModel = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', {
                backendNodeId: newBackendNodeId
              });
              if (newBoxModel?.model) {
                const newQuad = newBoxModel.model.content;
                x = Math.round((newQuad[0] + newQuad[2] + newQuad[4] + newQuad[6]) / 4);
                y = Math.round((newQuad[1] + newQuad[3] + newQuad[5] + newQuad[7]) / 4);
                backendNodeId = newBackendNodeId;
                console.log(`Re-identified element: ${ref} -> ${newRef}`);
              }
            }
          } else {
            throw new Error('Element no longer exists after scroll. Re-fetch accessibility tree and try again.');
          }
        } else {
          // Element is valid, just re-fetch coordinates
          const newBoxModel = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', {
            backendNodeId: backendNodeId
          });
          if (newBoxModel && newBoxModel.model) {
            const newQuad = newBoxModel.model.content;
            x = Math.round((newQuad[0] + newQuad[2] + newQuad[4] + newQuad[6]) / 4);
            y = Math.round((newQuad[1] + newQuad[3] + newQuad[5] + newQuad[7]) / 4);
          }
        }
      } else if (selector) {
        // Re-fetch selector coordinates
        const newEvalResult = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: `
            (function() {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
            })()
          `,
          returnByValue: true
        });
        if (newEvalResult.result?.value) {
          x = newEvalResult.result.value.x;
          y = newEvalResult.result.value.y;
        }
      }
    }

    // Get start position (last virtual position or viewport center)
    const startPos = getStartPosition(tab_id, viewport.width, viewport.height);

    // Generate WindMouse path
    const path = generateWindMousePath(startPos.x, startPos.y, x, y);
    const stats = getPathStats(path);

    // Create visual cursor at start position
    if (showCursor) {
      await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: generateCursorCreateCode(startPos.x, startPos.y),
        returnByValue: true,
        awaitPromise: true
      });
      // Brief delay for cursor to fade in
      await sleep(150);
    }

    // Dispatch initial mouseMoved at start position
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startPos.x,
      y: startPos.y
    });

    // Follow the path - dispatch mouseMoved and update visual cursor for each point
    for (const point of path) {
      // Dispatch CDP mouseMoved event
      await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y
      });

      // Update visual cursor position
      if (showCursor) {
        await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: generateCursorMoveCode(point.x, point.y),
          returnByValue: true
        });
      }

      // Wait for the calculated interval (variable Hz based on velocity)
      if (point.dt > 0) {
        await sleep(point.dt);
      }
    }

    // Play ripple animation (skip if already detached)
    if (showCursor && !detached) {
      await raceWithDetach(
        chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
          expression: generateRippleCode(),
          returnByValue: true
        }),
        () => detached
      );
    }

    // Mouse press — race against detach because Discord-style SPAs can swap
    // the document on mousedown.
    if (!detached) {
      await raceWithDetach(
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button,
          clickCount
        }),
        () => detached
      );
    }

    // Delay between press and release
    if (clickDelay > 0 && !detached) {
      await sleep(clickDelay);
    }

    // Mouse release — same detach-watch reasoning. By the time we reach this
    // line on a navigating page, the press has already triggered the SPA
    // transition, the target may be tearing down, and `sendCommand` could
    // hang indefinitely.
    if (!detached) {
      await raceWithDetach(
        chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button,
          clickCount
        }),
        () => detached
      );
    }

    // Update last position for this tab (local-only, always safe)
    setLastPosition(tab_id, x, y);

    // Schedule cursor removal (non-blocking, fire-and-forget). Skip if
    // detached — the target is gone and the eval would just throw.
    if (showCursor && !detached) {
      chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
        expression: generateCursorRemoveCode(lingerDelay),
        returnByValue: true
      }).catch(() => {}); // Ignore errors during cleanup
    }

    return {
      success: true,
      tab_id,
      selector,
      ref,
      x,
      y,
      button,
      clickCount,
      delay: clickDelay,
      lingerDelay,
      scrolled,
      // navigated=true means the click triggered a context teardown
      // (SPA navigation, full-page load, tab close, etc.). The mouse events
      // were dispatched before the detach. Callers can treat this as a
      // success signal — the page has moved on. detachReason is whichever
      // string Chrome's onDetach API supplied ('target_closed',
      // 'replaced_with_devtools', etc.).
      navigated: detached,
      detachReason: detached ? detachReason : null,
      path: {
        points: stats.points,
        duration: stats.duration,
        avgHz: stats.avgHz,
        minHz: stats.minHz,
        maxHz: stats.maxHz
      },
      startPosition: startPos
    };
  } finally {
    chrome.debugger.onDetach.removeListener(onDetach);
  }
}

/**
 * Race a CDP promise against a "detached" flag. If the promise resolves or
 * rejects normally, that result wins. If `getDetached()` flips true while the
 * promise is still pending, we resolve with a sentinel so the caller's
 * `await` returns and control can fall through to the function's detach
 * check — instead of hanging on a promise that will never settle.
 *
 * 25 ms poll interval keeps the overhead negligible (most clicks complete in
 * < 1 ms once they reach this layer; the polling fires at most a couple of
 * times before the underlying promise settles).
 *
 * @param {Promise} promise — CDP promise we'd normally await
 * @param {() => boolean} getDetached — closure over the detach flag
 * @returns {Promise<*>} the promise's value, or { __detached: true } sentinel
 */
function raceWithDetach(promise, getDetached) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const tick = setInterval(() => {
      if (settled) return;
      if (getDetached()) {
        settled = true;
        clearInterval(tick);
        resolve({ __detached: true });
      }
    }, 25);
    promise.then(
      (v) => { if (!settled) { settled = true; clearInterval(tick); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearInterval(tick); reject(e); } }
    );
  });
}

/**
 * Simple sleep helper.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
