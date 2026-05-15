'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Ticker — animates a numeric value from 0 → target on first mount, then
 * smoothly tweens between subsequent value changes. ~700ms ease-out-quart.
 *
 * Non-numeric values pass straight through (no animation). On
 * `prefers-reduced-motion`, the final value is rendered immediately and no
 * RAF loop runs.
 *
 * Props:
 *   value     — the target. May be a number, a numeric string like "03", or
 *               an arbitrary string ("Default", "RUN", etc.).
 *   pad       — optional minimum integer width; pads the rendered number with
 *               leading zeros (e.g. pad=2 → "07").
 *   duration  — animation length in ms (default 700).
 */
function easeOutQuart(t) {
  return 1 - Math.pow(1 - t, 4);
}

function tryParseNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  }
  return null;
}

function pad(n, width) {
  if (!width) return String(n);
  const s = String(n);
  if (s.length >= width) return s;
  return '0'.repeat(width - s.length) + s;
}

export default function Ticker({ value, pad: padWidth, duration = 700 }) {
  const numeric = tryParseNumber(value);
  const [display, setDisplay] = useState(() => (numeric === null ? value : 0));
  const rafRef = useRef(null);
  const fromRef = useRef(0);

  useEffect(() => {
    // Non-numeric — render straight through.
    if (numeric === null) {
      setDisplay(value);
      return undefined;
    }

    // Reduced motion — skip animation.
    if (typeof window !== 'undefined' && window.matchMedia) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setDisplay(numeric);
        fromRef.current = numeric;
        return undefined;
      }
    }

    const from = fromRef.current;
    const to = numeric;
    if (from === to) {
      setDisplay(to);
      return undefined;
    }

    const start = performance.now();
    const tick = (now) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / duration);
      const eased = easeOutQuart(t);
      const current = Math.round(from + (to - from) * eased);
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(to);
        fromRef.current = to;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [numeric, value, duration]);

  if (numeric === null) {
    return <span>{display}</span>;
  }

  return <span>{pad(display, padWidth)}</span>;
}
