import React, { useEffect } from 'react';
import '../app/globals.css';

/**
 * Storybook preview — wires the real WebPilot palette into the canvas.
 *
 * - Imports app/globals.css so every story renders against the live tokens.
 * - Adds a `theme` toolbar global ('light' | 'dark' | 'system'). The
 *   decorator mirrors the selection onto <html data-theme="…"> exactly like
 *   lib/theme.js does at runtime, so light/dark variants of every component
 *   can be reviewed without leaving Storybook.
 * - parameters.backgrounds matches the --wp-bg tokens from globals.css so
 *   the canvas tone matches the theme.
 *
 * Storybook is dev-only — none of this leaks into the daemon's static export
 * (Next.js never imports .storybook/ during `next build`).
 */

const LIGHT_BG = '#FBFAF7'; // --wp-bg in globals.css :root
const DARK_BG = '#161412';  // --wp-bg under [data-theme="dark"]

/** @type { import('@storybook/nextjs-vite').Preview } */
const preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: LIGHT_BG },
        { name: 'dark', value: DARK_BG },
      ],
    },
    layout: 'padded',
  },
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'WebPilot palette (mirrors data-theme on <html>)',
      defaultValue: 'light',
      toolbar: {
        icon: 'circlehollow',
        items: [
          { value: 'light', icon: 'sun', title: 'Light' },
          { value: 'dark', icon: 'moon', title: 'Dark' },
          { value: 'system', icon: 'browser', title: 'System' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme || 'light';

      // Mirror onto <html> so :root[data-theme="dark"] selectors in
      // globals.css take effect. 'system' clears the attribute so the
      // prefers-color-scheme media query takes over.
      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const root = document.documentElement;
        const prev = root.dataset.theme;
        if (theme === 'system') {
          delete root.dataset.theme;
        } else {
          root.dataset.theme = theme;
        }
        return () => {
          if (prev === undefined) {
            delete root.dataset.theme;
          } else {
            root.dataset.theme = prev;
          }
        };
      }, [theme]);

      // Switch the canvas background to match the active theme. 'system'
      // falls back to the OS preference via matchMedia.
      let bgName = 'light';
      if (theme === 'dark') bgName = 'dark';
      else if (theme === 'system' && typeof window !== 'undefined') {
        bgName = window.matchMedia &&
          window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark' : 'light';
      }

      // Wrap stories in a div so a) hover/focus styles have a real surface
      // and b) we can attach data-theme locally even when Storybook reuses
      // the same iframe across switches.
      return (
        <div
          data-sb-theme={theme}
          style={{
            background: bgName === 'dark' ? DARK_BG : LIGHT_BG,
            color: 'var(--wp-fg)',
            padding: '24px',
            minHeight: '100vh',
            fontFamily: 'var(--wp-font-sans)',
          }}
        >
          <Story />
        </div>
      );
    },
  ],
};

export default preview;
