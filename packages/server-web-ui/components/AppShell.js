'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  HomeIcon as HomeOutline,
  KeyIcon as KeyOutline,
  UserCircleIcon as UserCircleOutline,
  CpuChipIcon as CpuChipOutline,
  CommandLineIcon as CommandLineOutline,
  Cog6ToothIcon as Cog6ToothOutline,
  GlobeAltIcon as GlobeAltOutline,
  Bars3Icon,
} from '@heroicons/react/24/outline';
import {
  HomeIcon as HomeSolid,
  KeyIcon as KeySolid,
  UserCircleIcon as UserCircleSolid,
  CpuChipIcon as CpuChipSolid,
  CommandLineIcon as CommandLineSolid,
  Cog6ToothIcon as Cog6ToothSolid,
  GlobeAltIcon as GlobeAltSolid,
} from '@heroicons/react/24/solid';
import { getStatus } from '../lib/api';

/**
 * AppShell — structural redesign chrome.
 *
 * Sidebar is a two-section source list (Apple Mail / Reminders pattern):
 *
 *   WebPilot
 *   ─── (accent hairline)
 *
 *   WORKSPACE                       <- group header (mono nano caps)
 *     Dashboard
 *     Pairings           2          <- typeset count, no badge
 *     Profiles
 *     Agents
 *
 *   SYSTEM
 *     Settings
 *
 *   ● Connected                     <- footer (existing dot + label)
 *
 * Active state: neutral elevated fill + 2px accent left-edge hairline + solid
 * Heroicons variant + primary-fg text. No accent-tinted bg.
 */

const NAV_WORKSPACE = [
  {
    href: '/ui/',
    label: 'Dashboard',
    match: (p) => p === '/ui' || p === '/ui/',
    IconOutline: HomeOutline,
    IconSolid: HomeSolid,
  },
  {
    href: '/ui/profiles/',
    label: 'Profiles',
    match: (p) => p.startsWith('/ui/profiles'),
    IconOutline: UserCircleOutline,
    IconSolid: UserCircleSolid,
  },
  {
    href: '/ui/agents/',
    label: 'Agents',
    match: (p) => p.startsWith('/ui/agents'),
    IconOutline: CpuChipOutline,
    IconSolid: CpuChipSolid,
  },
  {
    href: '/ui/sites/',
    label: 'Sites',
    match: (p) => p.startsWith('/ui/sites'),
    IconOutline: GlobeAltOutline,
    IconSolid: GlobeAltSolid,
  },
  {
    href: '/ui/formatters/',
    label: 'Formatters',
    match: (p) => p.startsWith('/ui/formatters'),
    IconOutline: CommandLineOutline,
    IconSolid: CommandLineSolid,
  },
  {
    href: '/ui/pairings/',
    label: 'Pairings',
    match: (p) => p.startsWith('/ui/pairings'),
    IconOutline: KeyOutline,
    IconSolid: KeySolid,
    showCount: true,
  },
];

const NAV_SYSTEM = [
  {
    href: '/ui/settings/',
    label: 'Settings',
    match: (p) => p.startsWith('/ui/settings'),
    IconOutline: Cog6ToothOutline,
    IconSolid: Cog6ToothSolid,
  },
];

function normalizePath(p) {
  if (!p) return '/ui/';
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function useServerStatus() {
  const [serverOk, setServerOk] = useState(null);
  const [pendingPairings, setPendingPairings] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const data = await getStatus();
        if (cancelled) return;
        setServerOk(true);
        const n = (data && Array.isArray(data.pendingPairings))
          ? data.pendingPairings.length
          : 0;
        setPendingPairings(n);
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
  return { serverOk, pendingPairings };
}

function SidebarGroup({ title, items, pathname, query, onItemClick, counts }) {
  return (
    <div className="wp-sidebar-group">
      {title ? <div className="wp-sidebar-group-title">{title}</div> : null}
      <nav className="wp-nav" aria-label={title || 'Primary'}>
        {items.map((item) => {
          const active = item.match(pathname, query);
          const Icon = active ? item.IconSolid : item.IconOutline;
          const count =
            item.showCount && counts && counts[item.label]
              ? counts[item.label]
              : null;
          return (
            <a
              key={item.href}
              href={item.href}
              className={`wp-nav-item${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={onItemClick}
            >
              <span className="wp-nav-icon" aria-hidden="true">
                <Icon style={{ width: 20, height: 20 }} />
              </span>
              <span className="wp-nav-item-grow">{item.label}</span>
              {count ? (
                <span className="wp-nav-count" aria-label={`${count} pending`}>
                  {count}
                </span>
              ) : null}
            </a>
          );
        })}
      </nav>
    </div>
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

function SidebarContents({ pathname, query, serverOk, pendingPairings, onNavClick }) {
  const counts = { Pairings: pendingPairings || 0 };
  return (
    <>
      <div className="wp-sidebar-scroll">
        <div className="wp-sidebar-brand">
          <a href="/ui/" className="wp-brand" onClick={onNavClick}>
            WebPilot
          </a>
          <span className="wp-sidebar-brand-rule" aria-hidden="true" />
        </div>

        <SidebarGroup
          items={NAV_WORKSPACE}
          title="Workspace"
          pathname={pathname}
          query={query}
          counts={counts}
          onItemClick={onNavClick}
        />
        <SidebarGroup
          items={NAV_SYSTEM}
          title="System"
          pathname={pathname}
          query={query}
          counts={counts}
          onItemClick={onNavClick}
        />
      </div>
      <SidebarFooter serverOk={serverOk} />
    </>
  );
}

export default function AppShell({ children }) {
  const rawPath = usePathname() || '/ui/';
  const pathname = normalizePath(rawPath);
  const { serverOk, pendingPairings } = useServerStatus();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Read the ?filter=… query param client-side so Activity items can match.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    function readQuery() {
      try {
        const u = new URL(window.location.href);
        setQuery(u.searchParams.get('filter') || '');
      } catch (_e) {
        setQuery('');
      }
    }
    readQuery();
    window.addEventListener('popstate', readQuery);
    return () => window.removeEventListener('popstate', readQuery);
  }, [pathname]);

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
            <Bars3Icon style={{ width: 24, height: 24 }} />
          </button>
        </div>
      </header>

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
            query={query}
            serverOk={serverOk}
            pendingPairings={pendingPairings}
            onNavClick={onNavClick}
          />
        </div>
      </aside>

      <div className="wp-body">
        <aside className="wp-sidebar" aria-label="Primary">
          <SidebarContents
            pathname={pathname}
            query={query}
            serverOk={serverOk}
            pendingPairings={pendingPairings}
          />
        </aside>

        <main className="wp-main">{children}</main>
      </div>
    </div>
  );
}
