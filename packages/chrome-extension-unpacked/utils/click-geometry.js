/**
 * Pure geometry helpers for ref clicks.
 *
 * DOM.getBoxModel returns the element's full layout box in viewport
 * coordinates and ignores clipping by scroll containers. An element sitting
 * on the edge of a scrollable sidebar can therefore have a "center" that is
 * outside (or on the very edge of) the area the user can actually see, and a
 * click there misses. These helpers clip the box to the visible area first.
 */

/**
 * Axis-aligned bounds of a CDP quad ([x1,y1,x2,y2,x3,y3,x4,y4]).
 * @param {number[]} quad
 * @returns {{left:number, top:number, right:number, bottom:number}}
 */
export function quadBounds(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys)
  };
}

/**
 * Intersect two rects. Returns null when they do not overlap.
 */
export function intersectRects(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/**
 * Center of the part of `box` that lies inside `clip` (and the viewport).
 * Returns null when nothing is visible. Uses finite-number checks only, so a
 * legitimate coordinate of 0 is never treated as a failure.
 *
 * @param {{left,top,right,bottom}} box - element bounds (viewport coords)
 * @param {{left,top,right,bottom}|null} clip - visible clip rect, or null
 * @param {{width:number,height:number}} viewport
 * @returns {{x:number,y:number}|null}
 */
export function visibleCenter(box, clip, viewport) {
  let visible = intersectRects(box, { left: 0, top: 0, right: viewport.width, bottom: viewport.height });
  if (visible && clip) visible = intersectRects(visible, clip);
  if (!visible) return null;
  return {
    x: Math.round((visible.left + visible.right) / 2),
    y: Math.round((visible.top + visible.bottom) / 2)
  };
}

/**
 * Function declaration (for Runtime.callFunctionOn, `this` = the element)
 * that returns the intersection of the bounding rects of every ancestor that
 * clips overflow, i.e. the area of the page where the element can be seen.
 * Waits one animation frame first so layout settles after a scroll.
 */
export const CLIP_RECT_FUNCTION = `function() {
  return new Promise(resolve => requestAnimationFrame(() => {
    let left = -Infinity, top = -Infinity, right = Infinity, bottom = Infinity;
    for (let p = this.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const r = p.getBoundingClientRect();
      left = Math.max(left, r.left); top = Math.max(top, r.top);
      right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
    }
    resolve(isFinite(left) ? { left, top, right, bottom } : null);
  }));
}`;
