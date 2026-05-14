import './globals.css';

export const metadata = {
  title: 'WebPilot',
  description: 'WebPilot server control panel',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <div className="wp-shell">
          <header className="wp-header">
            <a href="/ui/" className="wp-brand">WebPilot</a>
            <nav className="wp-nav">
              <a href="/ui/">Home</a>
              <a href="/ui/pairings/">Pairings</a>
              <a href="/ui/profiles/">Profiles</a>
              <a href="/ui/agents/">Agents</a>
              <a href="/ui/settings/">Settings</a>
            </nav>
          </header>
          <main className="wp-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
