import './globals.css';
import AppShell from '../components/AppShell';

export const metadata = {
  title: 'WebPilot — Mission Control',
  description: 'WebPilot server control panel',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/*
          Mission Control typography stack — pulled from Google Fonts.
            • Fraunces      — variable serif, used italic 700 for page titles
            • JetBrains Mono — telemetry, code, ALL CAPS labels
            • IBM Plex Sans  — body copy & button labels
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
