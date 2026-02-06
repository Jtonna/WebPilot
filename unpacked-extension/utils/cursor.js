/**
 * Visual cursor utilities for path-based animation.
 *
 * The cursor follows the WindMouse path point-by-point,
 * synchronized with CDP mouseMoved events.
 */

/**
 * Generate code to create and show the cursor at a starting position.
 *
 * @param {number} x - Starting X coordinate
 * @param {number} y - Starting Y coordinate
 * @returns {string} JavaScript code to execute
 */
export function generateCursorCreateCode(x, y) {
  return `
    (function() {
      // Remove existing cursor if present
      const existing = document.getElementById('__mcp_cursor__');
      if (existing) existing.remove();

      // Create cursor container with flexbox for horizontal layout
      const cursor = document.createElement('div');
      cursor.id = '__mcp_cursor__';
      cursor.style.cssText = 'position:fixed;top:${y}px;left:${x}px;display:flex;align-items:center;z-index:2147483647;pointer-events:none;transform:translate(-2px,-2px);opacity:0;';

      // Create SVG cursor using createElementNS (bypasses Trusted Types)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.style.flexShrink = '0';

      const cursorPathD = 'M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.86a.5.5 0 0 0-.85.35z';

      // Outer RGB glow path (rendered first, behind the main cursor)
      const outerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      outerPath.setAttribute('d', cursorPathD);
      outerPath.setAttribute('fill', 'none');
      outerPath.setAttribute('stroke', '#ff0000');
      outerPath.setAttribute('stroke-width', '4');
      outerPath.id = '__mcp_outer_stroke__';
      svg.appendChild(outerPath);

      // Inner path (main cursor - black fill, white stroke)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', cursorPathD);
      path.setAttribute('fill', '#000');
      path.setAttribute('stroke', '#fff');
      path.setAttribute('stroke-width', '1.5');
      svg.appendChild(path);

      // Create text SVG for "VantageFeed" label
      const textSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      textSvg.setAttribute('width', '90');
      textSvg.setAttribute('height', '20');
      textSvg.setAttribute('viewBox', '0 0 90 20');
      textSvg.style.marginLeft = '4px';
      textSvg.style.flexShrink = '0';

      // Outer RGB glow text (rendered first)
      const textOuter = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textOuter.setAttribute('x', '0');
      textOuter.setAttribute('y', '15');
      textOuter.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
      textOuter.setAttribute('font-size', '14');
      textOuter.setAttribute('font-weight', '600');
      textOuter.setAttribute('fill', 'none');
      textOuter.setAttribute('stroke', '#ff0000');
      textOuter.setAttribute('stroke-width', '4');
      textOuter.id = '__mcp_text_outer__';
      textOuter.textContent = 'VantageFeed';
      textSvg.appendChild(textOuter);

      // Middle white stroke text
      const textMiddle = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textMiddle.setAttribute('x', '0');
      textMiddle.setAttribute('y', '15');
      textMiddle.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
      textMiddle.setAttribute('font-size', '14');
      textMiddle.setAttribute('font-weight', '600');
      textMiddle.setAttribute('fill', 'none');
      textMiddle.setAttribute('stroke', '#fff');
      textMiddle.setAttribute('stroke-width', '2');
      textMiddle.textContent = 'VantageFeed';
      textSvg.appendChild(textMiddle);

      // Inner black fill text
      const textInner = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textInner.setAttribute('x', '0');
      textInner.setAttribute('y', '15');
      textInner.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
      textInner.setAttribute('font-size', '14');
      textInner.setAttribute('font-weight', '600');
      textInner.setAttribute('fill', '#000');
      textInner.textContent = 'VantageFeed';
      textSvg.appendChild(textInner);

      // Add RGB color shifting animation for outer strokes (cursor and text)
      const style = document.createElement('style');
      style.textContent = \`
        @keyframes rgbShift {
          0% { stroke: #ff0000; }
          16.67% { stroke: #ff8800; }
          33.33% { stroke: #ffff00; }
          50% { stroke: #00ff00; }
          66.67% { stroke: #0088ff; }
          83.33% { stroke: #8800ff; }
          100% { stroke: #ff0000; }
        }
        #__mcp_outer_stroke__, #__mcp_text_outer__ {
          animation: rgbShift 3s linear infinite;
        }
      \`;
      cursor.appendChild(style);
      cursor.appendChild(svg);
      cursor.appendChild(textSvg);

      document.body.appendChild(cursor);

      // Fade in cursor
      requestAnimationFrame(() => {
        cursor.style.transition = 'opacity 0.15s ease-out';
        cursor.style.opacity = '1';
      });

      return { created: true, x: ${x}, y: ${y} };
    })();
  `;
}

/**
 * Generate code to move the cursor to a new position.
 * No transition - instant move for smooth path following.
 *
 * @param {number} x - New X coordinate
 * @param {number} y - New Y coordinate
 * @returns {string} JavaScript code to execute
 */
export function generateCursorMoveCode(x, y) {
  return `
    (function() {
      const cursor = document.getElementById('__mcp_cursor__');
      if (cursor) {
        cursor.style.top = '${y}px';
        cursor.style.left = '${x}px';
      }
      return { moved: true, x: ${x}, y: ${y} };
    })();
  `;
}

/**
 * Generate code to play the Twitter-like particle burst animation on click.
 *
 * @returns {string} JavaScript code to execute
 */
export function generateRippleCode() {
  return `
    (function() {
      const cursor = document.getElementById('__mcp_cursor__');
      if (!cursor) return { particles: false };

      // Create particle container at cursor position
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;top:' + cursor.style.top + ';left:' + cursor.style.left + ';width:0;height:0;pointer-events:none;z-index:2147483647;';
      document.body.appendChild(container);

      // Twitter-like heart burst colors
      const colors = ['#ff4d6d', '#ff758f', '#ff8fa3', '#ffb3c1', '#ffd166', '#ef476f', '#9b5de5', '#f72585'];
      const particleCount = 12;
      const particles = [];

      // Create particles centered at the click point
      for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        const angle = (i / particleCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
        const distance = 20 + Math.random() * 25;
        const color = colors[Math.floor(Math.random() * colors.length)];
        const size = 3 + Math.random() * 4;

        particle.style.cssText = 'position:absolute;top:0;left:0;width:' + size + 'px;height:' + size + 'px;background:' + color + ';border-radius:50%;pointer-events:none;opacity:1;transform:translate(-50%,-50%);';
        particle.dataset.dx = Math.cos(angle) * distance;
        particle.dataset.dy = Math.sin(angle) * distance;

        container.appendChild(particle);
        particles.push(particle);
      }

      // Animate particles outward
      requestAnimationFrame(() => {
        particles.forEach(p => {
          p.style.transition = 'transform 0.35s ease-out, opacity 0.35s ease-out';
          p.style.transform = 'translate(calc(-50% + ' + p.dataset.dx + 'px), calc(-50% + ' + p.dataset.dy + 'px)) scale(0.2)';
          p.style.opacity = '0';
        });
      });

      // Clean up particles after animation
      setTimeout(() => {
        container.remove();
      }, 400);

      return { particles: true, count: particleCount };
    })();
  `;
}

/**
 * Generate code to fade out and remove the cursor.
 *
 * @param {number} lingerDelay - Time to wait before fading (ms)
 * @returns {string} JavaScript code to execute
 */
export function generateCursorRemoveCode(lingerDelay) {
  return `
    (function() {
      const cursor = document.getElementById('__mcp_cursor__');
      if (cursor) {
        // Linger, then fade out
        setTimeout(() => {
          cursor.style.transition = 'opacity 0.2s ease-out';
          cursor.style.opacity = '0';
          // Remove after fade
          setTimeout(() => {
            cursor.remove();
          }, 200);
        }, ${lingerDelay});
      }
      return { removing: true, lingerDelay: ${lingerDelay} };
    })();
  `;
}

// Keep the old function for backwards compatibility if needed
export function generateCursorAnimationCode(targetX, targetY, spawnDelay, moveDuration, lingerDelay) {
  return `
    (function() {
      const targetX = ${targetX};
      const targetY = ${targetY};
      const spawnDelay = ${spawnDelay};
      const moveDuration = ${moveDuration};
      const lingerDelay = ${lingerDelay};

      const startX = Math.round(window.innerWidth / 2);
      const startY = Math.round(window.innerHeight / 2);

      const existing = document.getElementById('__mcp_cursor__');
      if (existing) existing.remove();

      const cursor = document.createElement('div');
      cursor.id = '__mcp_cursor__';
      cursor.style.cssText = 'position:fixed;top:' + startY + 'px;left:' + startX + 'px;width:24px;height:24px;z-index:2147483647;pointer-events:none;transform:translate(-2px,-2px);opacity:0;transition:opacity 0.2s ease-out;';

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87a.5.5 0 0 0 .35-.85L6.35 2.86a.5.5 0 0 0-.85.35z');
      path.setAttribute('fill', '#000');
      path.setAttribute('stroke', '#fff');
      path.setAttribute('stroke-width', '1.5');
      svg.appendChild(path);
      cursor.appendChild(svg);

      const ripple = document.createElement('div');
      ripple.id = '__mcp_ripple__';
      ripple.style.cssText = 'position:absolute;top:0;left:0;width:20px;height:20px;border-radius:50%;background:rgba(59,130,246,0.5);transform:translate(-50%,-50%) scale(0);pointer-events:none;';
      cursor.appendChild(ripple);

      document.body.appendChild(cursor);

      setTimeout(() => { cursor.style.opacity = '1'; }, 20);

      setTimeout(() => {
        cursor.style.transition = 'top ' + moveDuration + 'ms ease-out, left ' + moveDuration + 'ms ease-out, opacity 0.3s ease-out';
        cursor.style.top = targetY + 'px';
        cursor.style.left = targetX + 'px';
      }, spawnDelay);

      setTimeout(() => {
        const r = document.getElementById('__mcp_ripple__');
        if (r) {
          r.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
          r.style.transform = 'translate(-50%, -50%) scale(2)';
          r.style.opacity = '0';
        }
      }, spawnDelay + moveDuration);

      setTimeout(() => {
        const el = document.getElementById('__mcp_cursor__');
        if (el) el.style.opacity = '0';
      }, spawnDelay + moveDuration + lingerDelay);

      setTimeout(() => {
        const el = document.getElementById('__mcp_cursor__');
        if (el) el.remove();
      }, spawnDelay + moveDuration + lingerDelay + 300);

      return { startX, startY, targetX, targetY, spawnDelay, moveDuration, lingerDelay };
    })();
  `;
}
