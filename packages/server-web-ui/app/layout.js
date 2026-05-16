import './globals.css';
import AppShell from '../components/AppShell';

export const metadata = {
  title: 'WebPilot',
  description: 'WebPilot server control panel',
};

/**
 * Inline theme application — runs synchronously before <body> paints so we
 * never see a flash of the wrong theme on reload. Reads localStorage
 * `webpilotTheme` (set by lib/theme.js setTheme) and writes it to
 * `documentElement.dataset.theme`. Absence means "system" — we leave the
 * attribute unset and let the CSS prefers-color-scheme media query decide.
 *
 * Wrapped in try/catch because some browsers (private mode, storage disabled)
 * throw on localStorage access and we'd rather render light-mode than crash.
 */
const themeBootScript = `(function(){try{var t=localStorage.getItem('webpilotTheme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * Geist Sans (300/400/500/600) — body, headings, buttons.
         * Geist Mono (400 only) — facts: ports, IDs, paths, pairing codes.
         */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@300..600&family=Geist+Mono:wght@400&display=swap"
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
