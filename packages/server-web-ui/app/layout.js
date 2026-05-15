import './globals.css';
import AppShell from '../components/AppShell';

export const metadata = {
  title: 'WebPilot',
  description: 'WebPilot server control panel',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/*
          Apple Quiet typography — one family, varied weights.
            • Geist      — variable sans for the whole UI (300/400/500/600)
            • Geist Mono — only for UUIDs, ports, API keys, JSON snippets
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
