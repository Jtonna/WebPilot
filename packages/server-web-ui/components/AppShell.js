'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getStatus } from '../lib/api';

/**
 * Application chrome: left sidebar + main column. No top runtime strip — the
 * server connection state is surfaced as a tiny dot + label in the sidebar
 * footer instead.
 *
 * We poll `/status` every 15s so the footer indicator reflects reality, but
 * deliberately keep it small and quiet — no port numbers, no clocks, no
 * mono telemetry. Apple Quiet.
 */

const NAV = [
  { href: '/ui/', label: 'Dashboard', match: (p) => p === '/ui' || p === '/ui/' },
  { href: '/ui/pairings/', label: 'Pairings', match: (p) => p.startsWith('/ui/pairings') },
  { href: '/ui/profiles/', label: 'Profiles', match: (p) => p.startsWith('/ui/profiles') },
  { href: '/ui/agents/', label: 'Agents', match: (p) => p.startsWith('/ui/agents') },
  { href: '/ui/settings/', label: 'Settings', match: (p) => p.startsWith('/ui/settings') },
];

function normalizePath(p) {
  if (!p) return '/ui/';
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export default function AppShell({ children }) {
  const rawPath = usePathname() || '/ui/';
  const pathname = normalizePath(rawPath);
  const [serverOk, setServerOk] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        await getStatus();
        if (cancelled) return;
        setServerOk(true);
      } catch (_e) {
        if (cancelled) return;
        setServerOk(false);
      }
    }
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const statusState = serverOk === null ? '' : serverOk ? 'ok' : 'down';
  const statusLabel = serverOk === null ? 'Connecting…' : serverOk ? 'Connected' : 'Disconnected';

  return (
    <div className="wp-shell">
      <div className="wp-body">
        <aside className="wp-sidebar" aria-label="Primary">
          <a href="/ui/" className="wp-brand">WebPilot</a>
          <nav className="wp-nav">
            {NAV.map((item) => {
              const active = item.match(pathname);
              return (
                <a
                  key={item.href}
                  href={item.href}
                  className={`wp-nav-item${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>
          <div className="wp-sidebar-footer" aria-live="polite">
            <span
              className="wp-sidebar-status-dot"
              data-state={statusState}
              aria-hidden="true"
            />
            <span>{statusLabel}</span>
          </div>
        </aside>

        <main className="wp-main">{children}</main>
      </div>
    </div>
  );
}
