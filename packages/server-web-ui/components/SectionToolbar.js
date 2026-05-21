'use client';

/**
 * SectionToolbar — the "label / control on the left, primary action on the
 * right" strip that sits between a section head and its body. Replaces
 * three near-identical inline flex blocks that lived on the sites + agents
 * pages.
 *
 * Variants:
 *   - "plain" (default) — bare flex strip with `padding: 0 var(--s-2)` and
 *     `marginBottom: var(--s-2)`. Used between a section head and its
 *     body (sites global-rules and per-agent overrides toolbars).
 *   - "card"            — wraps the flex strip in `.wp-card` with the
 *     thicker `var(--s-3) var(--s-4)` padding the agents pair-bar uses
 *     when it's the standalone CTA above a list.
 *
 * Both slots are JSX nodes; pass `null` for the right slot if you only
 * need the left. The component supplies the flex layout + spacing; slot
 * contents own their own typography and button classes.
 */
export default function SectionToolbar({ left, right, variant = 'plain' }) {
  const isCard = variant === 'card';
  const style = isCard
    ? {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 'var(--s-4)',
      padding: 'var(--s-3) var(--s-4)',
    }
    : {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 'var(--s-3)',
      padding: '0 var(--s-2)',
      marginBottom: 'var(--s-2)',
    };

  return (
    <div className={isCard ? 'wp-card' : undefined} style={style}>
      <div>{left}</div>
      {right ? <div>{right}</div> : null}
    </div>
  );
}
