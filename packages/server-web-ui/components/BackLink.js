'use client';

import { ArrowLeftIcon } from '@heroicons/react/20/solid';

/**
 * Contextual back link, rendered above the page's `wp-page-head` on pages
 * reached via a filter or deep-link (currently only `/agents?profile=<X>`).
 *
 * Top-level sibling pages get no back-link — the sidebar is the navigation
 * surface, and a back-button on every page would be visual noise.
 *
 * Style: secondary-fg, hover lifts to primary-fg, hairline gap below.
 *
 * @param {{ href: string, label: string }} props
 */
export default function BackLink({ href, label }) {
  return (
    <a href={href} className="wp-back-link">
      <ArrowLeftIcon
        style={{ width: 16, height: 16, marginRight: 4 }}
        aria-hidden="true"
      />
      {label}
    </a>
  );
}
