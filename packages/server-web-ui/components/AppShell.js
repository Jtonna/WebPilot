'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  House,
  Handshake,
  UserCircle,
  Robot,
  GearSix,
  List as ListIcon,
} from '@phosphor-icons/react';
import { getStatus } from '../lib/api';

/**
 * AppShell — Phase 1 chrome.
 *
 * Desktop (≥ 900px, CSS-driven): persistent sidebar + content column.
 *   Layout / sidebar positioning all lives in globals.css; this component
 *   simply renders both the topbar and the sidebar — the media query in CSS
 *   hides whichever one shouldn't show. That keeps SSR stable (no
 *   matchMedia at render time) and avoids hydration mismatch.
 *
 * Mobile (< 900px):
 *   - 56px top bar with the WebPilot wordmark left, hamburger right.
 *   - Tapping the hamburger opens a left drawer (80vw) with the sidebar.
 *   - Tapping the backdrop or any nav item closes the drawer.
 *   - A tiny connection dot also lives in the top-right.
 *
 * The connection footer in the sidebar polls /status every 15s.
 *
 * Theme toggle is NOT in the chrome — it lives in Settings → Appearance
 * (Phase 2). The persisted choice is applied by an inline script in
 * app/layout.js before paint.
 */

const NAV = [
  {
    href: '/ui/',
    label: 'Dashboard',
    match: (p) => p === '/ui' || p === '/ui/',
    Icon: House,
  },
  {
    href: '/ui/pairings/',
    label: 'Pairings',
    match: (p) => p.startsWith('/ui/pairings'),
    Icon: Handshake,
  },
  {
    href: '/ui/profiles/',
    label: 'Profiles',
    match: (p) => p.startsWith('/ui/profiles'),
    Icon: UserCircle,
  },
  {
    href: '/ui/agents/',
    label: 'Agents',
    match: (p) => p.startsWith('/ui/agents'),
    Icon: Robot,
  },
  {
    href: '/ui/settings/',
    label: 'Settings',
    match: (p) => p.startsWith('/ui/settings'),
    Icon: GearSix,
  },
];

function normalizePath(p) {
  if (!p) return '/ui/';
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function useServerStatus() {
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
  return serverOk;
}

function SidebarNav({ pathname, onItemClick }) {
  return (
    <nav className="wp-nav" aria-label="Primary">
      {NAV.map((item) => {
        const active = item.match(pathname);
        const Icon = item.Icon;
        return (
          <a
            key={item.href}
            href={item.href}
            className={`wp-nav-item${active ? ' is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={onItemClick}
          >
            <span className="wp-nav-icon" aria-hidden="true">
              <Icon size={20} weight={active ? 'duotone' : 'regular'} />
            </span>
            <span>{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

function SidebarFooter({ serverOk }) {
  const statusState = serverOk === null ? '' : serverOk ? 'ok' : 'down';
  const statusLabel =
    serverOk === null ? 'Connecting…' : serverOk ? 'Connected' : 'Disconnected';
  return (
    <div className="wp-sidebar-footer" aria-live="polite">
      <span
        className="wp-sidebar-status-dot"
        data-state={statusState}
        aria-hidden="true"
      />
      <span>{statusLabel}</span>
    </div>
  );
}

function SidebarContents({ pathname, serverOk, onNavClick }) {
  return (
    <>
      <div className="wp-sidebar-scroll">
        <a href="/ui/" className="wp-brand" onClick={onNavClick}>
          WebPilot
        </a>
        <SidebarNav pathname={pathname} onItemClick={onNavClick} />
      </div>
      <SidebarFooter serverOk={serverOk} />
    </>
  );
}

export default function AppShell({ children }) {
  const rawPath = usePathname() || '/ui/';
  const pathname = normalizePath(rawPath);
  const serverOk = useServerStatus();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Lock body scroll while drawer is open
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    if (drawerOpen) {
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  // Close drawer on Escape
  useEffect(() => {
    if (!drawerOpen) return;
    function onKey(e) {
      if (e.key === 'Escape') setDrawerOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const statusState = serverOk === null ? '' : serverOk ? 'ok' : 'down';
  const onNavClick = () => setDrawerOpen(false);

  return (
    <div className="wp-shell">
      {/* Mobile top bar (hidden on desktop via CSS) */}
      <header className="wp-topbar" role="banner">
        <a href="/ui/" className="wp-topbar-brand">WebPilot</a>
        <div className="wp-topbar-right">
          <span
            className="wp-topbar-dot"
            data-state={statusState}
            aria-label={
              serverOk === null
                ? 'Connecting'
                : serverOk
                  ? 'Connected'
                  : 'Disconnected'
            }
          />
          <button
            type="button"
            className="wp-icon-btn"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            <ListIcon size={24} weight="regular" />
          </button>
        </div>
      </header>

      {/* Mobile drawer (sheet). Hidden on desktop via CSS. */}
      <div
        className={`wp-drawer-backdrop${drawerOpen ? ' is-open' : ''}`}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={`wp-drawer${drawerOpen ? ' is-open' : ''}`}
        aria-label="Primary navigation"
        aria-hidden={!drawerOpen}
      >
        <div className="wp-sidebar" style={{ width: '100%', height: '100%' }}>
          <SidebarContents
            pathname={pathname}
            serverOk={serverOk}
            onNavClick={onNavClick}
          />
        </div>
      </aside>

      <div className="wp-body">
        {/* Desktop sidebar (hidden on mobile via CSS) */}
        <aside className="wp-sidebar" aria-label="Primary">
          <SidebarContents pathname={pathname} serverOk={serverOk} />
        </aside>

        <main className="wp-main">{children}</main>
      </div>
    </div>
  );
}
