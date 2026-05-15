'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import RuntimeClock from './RuntimeClock';
import { getStatus } from '../lib/api';

/**
 * Application chrome: top runtime strip + left sidebar + main column.
 *
 * The runtime strip pulls a lightweight `/status` snapshot once on mount so it
 * can display the live port and an OK/DOWN indicator. We keep this fetch
 * separate from the page-level fetchers so the strip can render even if a page
 * is unmounted/swapping. See pages for the authoritative data flows.
 */

const NAV = [
  { num: '01', href: '/ui/', label: 'Dashboard', match: (p) => p === '/ui' || p === '/ui/' },
  { num: '02', href: '/ui/pairings/', label: 'Pairings', match: (p) => p.startsWith('/ui/pairings') },
  { num: '03', href: '/ui/profiles/', label: 'Profiles', match: (p) => p.startsWith('/ui/profiles') },
  { num: '04', href: '/ui/agents/', label: 'Agents', match: (p) => p.startsWith('/ui/agents') },
  { num: '05', href: '/ui/settings/', label: 'Settings', match: (p) => p.startsWith('/ui/settings') },
];

function normalizePath(p) {
  if (!p) return '/ui/';
  // Drop trailing slash for matching, but keep leading.
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export default function AppShell({ children }) {
  const rawPath = usePathname() || '/ui/';
  const pathname = normalizePath(rawPath);
  const [strip, setStrip] = useState({ port: null, host: '127.0.0.1', ok: null, networkMode: false });
  // When the OK/DOWN bit flips we briefly paint the indicator with a flash
  // class. The class is removed by setTimeout so the keyframe runs once.
  const [statusFlash, setStatusFlash] = useState(false);
  const prevOkRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const data = await getStatus();
        if (cancelled) return;
        setStrip({
          port: data.port || null,
          host: data.networkMode ? '0.0.0.0' : '127.0.0.1',
          ok: true,
          networkMode: !!data.networkMode,
        });
      } catch (_e) {
        if (cancelled) return;
        setStrip((s) => ({ ...s, ok: false }));
      }
    }
    tick();
    const id = setInterval(tick, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Watch the OK bit and trigger the flash on transitions (not first paint).
  useEffect(() => {
    if (strip.ok === null) return;
    if (prevOkRef.current !== null && prevOkRef.current !== strip.ok) {
      setStatusFlash(true);
      const t = setTimeout(() => setStatusFlash(false), 220);
      prevOkRef.current = strip.ok;
      return () => clearTimeout(t);
    }
    prevOkRef.current = strip.ok;
    return undefined;
  }, [strip.ok]);

  const portStr = strip.port ? `${strip.host}:${strip.port}` : `${strip.host}:----`;
  const statusLabel =
    strip.ok === null ? 'BOOTING' : strip.ok ? 'STATUS OK' : 'STATUS DOWN';
  const statusClass = [
    strip.ok ? 'wp-strip-status-ok' : '',
    statusFlash ? 'wp-strip-status-flash' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="wp-shell">
      <div className="wp-strip" role="banner">
        <div className="wp-strip-left">
          <span className="wp-strip-accent">WEBPILOT</span>
          <span className="wp-strip-sep">·</span>
          <span>MISSION CONTROL</span>
          <span className="wp-strip-sep">·</span>
          <span>{portStr}</span>
          <span className="wp-strip-sep">·</span>
          <span className={statusClass}>{statusLabel}</span>
          {strip.networkMode ? (
            <>
              <span className="wp-strip-sep">·</span>
              <span>LAN</span>
            </>
          ) : null}
        </div>
        <div className="wp-strip-right">
          <RuntimeClock />
        </div>
      </div>

      <div className="wp-body">
        <aside className="wp-sidebar" aria-label="Primary">
          <a href="/ui/" className="wp-brand">WebPilot</a>
          <span className="wp-brand-sub">v0.5 · console</span>
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
                  <span className="wp-nav-num">{item.num}</span>
                  <span className="wp-nav-arrow">{active ? '→' : '/'}</span>
                  <span>{item.label}</span>
                </a>
              );
            })}
          </nav>
          <div className="wp-sidebar-footer">
            <div>LOCAL ONLY</div>
            <div>NO TELEMETRY</div>
          </div>
        </aside>

        <main className="wp-main">{children}</main>
      </div>
    </div>
  );
}
