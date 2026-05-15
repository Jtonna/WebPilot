'use client';

import { useReveal } from '../lib/reveal';

/**
 * Wraps a `<section>` so it stays hidden until it scrolls into view, then
 * fades + rises into place. Use this for sections likely to be below the
 * fold on first paint (long pages). Sections at the top of a page should
 * use the plain `<section className="wp-section">` markup and rely on the
 * page-level cascade in globals.css.
 *
 * Props pass through, plus an optional `as` element name (default `section`).
 */
export default function RevealSection({
  as: Tag = 'section',
  className = '',
  children,
  rootMargin,
  ...rest
}) {
  const [ref, revealed] = useReveal({ rootMargin });
  const cls = [
    className,
    'wp-reveal-on-scroll',
    revealed ? 'is-revealed' : '',
  ].filter(Boolean).join(' ');
  return (
    <Tag ref={ref} className={cls} {...rest}>
      {children}
    </Tag>
  );
}
