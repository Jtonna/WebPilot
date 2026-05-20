'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * useReveal — toggle a class once the element scrolls into view.
 *
 * Returns a ref + a boolean. Apply both: ref to the element you want to
 * observe, and use the boolean to conditionally add a `.is-revealed` class
 * (or read it for other purposes).
 *
 * Behavior:
 *   - If `prefers-reduced-motion`, returns `revealed = true` immediately.
 *   - If IntersectionObserver isn't available, returns `revealed = true`.
 *   - Fires exactly once, then disconnects the observer.
 *
 * Use only for sections that may be below the fold on first paint. Pages that
 * fit on screen will see all sections revealed via the existing nth-child
 * cascade in globals.css instead.
 */
export function useReveal({ rootMargin = '0px 0px -10% 0px', once = true } = {}) {
  const ref = useRef(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    // Reduced-motion bypass: skip animation entirely.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mql.matches) {
        setRevealed(true);
        return undefined;
      }
    }

    if (typeof IntersectionObserver === 'undefined') {
      setRevealed(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRevealed(true);
            if (once) observer.disconnect();
          } else if (!once) {
            setRevealed(false);
          }
        }
      },
      { rootMargin, threshold: 0.05 }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [rootMargin, once]);

  return [ref, revealed];
}

/**
 * useFlashOnChange — returns a boolean that is `true` for ~400ms whenever the
 * watched `value` changes (after the first render). Use it to conditionally
 * apply a flash class for a "value just updated" micro-acknowledgment.
 *
 * Skips the flash on mount (initial render) so static rows don't all flash on
 * page load — only true value changes.
 */
export function useFlashOnChange(value, durationMs = 400) {
  const prevRef = useRef(value);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    if (prevRef.current === value) return undefined;
    prevRef.current = value;

    // Reduced motion: skip.
    if (typeof window !== 'undefined' && window.matchMedia) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return undefined;
      }
    }

    setFlashing(true);
    const id = setTimeout(() => setFlashing(false), durationMs);
    return () => clearTimeout(id);
  }, [value, durationMs]);

  return flashing;
}

/**
 * usePrefersReducedMotion — live boolean tracking the user's preference.
 */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mql.matches);
    const handler = (e) => setReduced(e.matches);
    if (mql.addEventListener) mql.addEventListener('change', handler);
    else mql.addListener(handler);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handler);
      else mql.removeListener(handler);
    };
  }, []);
  return reduced;
}
