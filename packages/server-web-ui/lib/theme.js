/**
 * Theme utilities for the WebPilot web UI.
 *
 * Three-state model: 'light' | 'dark' | 'system' (mirrors macOS Appearance).
 * The "explicit" choice is mirrored into `localStorage.webpilotTheme` and into
 * `<html data-theme="…">`. "System" means: no localStorage key, no `data-theme`
 * attribute — `prefers-color-scheme` resolves it via the CSS rule.
 *
 * An inline script in `app/layout.js` applies the persisted choice before the
 * body paints to prevent flash-of-wrong-theme on reload.
 *
 * All entry points are SSR-safe: `window`/`localStorage` access is guarded.
 */

const STORAGE_KEY = 'webpilotTheme';

function hasWindow() {
  return typeof window !== 'undefined';
}

function hasStorage() {
  if (!hasWindow()) return false;
  try {
    return typeof window.localStorage !== 'undefined' && window.localStorage !== null;
  } catch (_e) {
    return false;
  }
}

/**
 * Read the persisted explicit choice.
 * @returns {'light' | 'dark' | null} — `null` means "system" (no explicit choice).
 */
export function getTheme() {
  if (!hasStorage()) return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Persist the explicit choice and apply it to the document root.
 * @param {'light' | 'dark' | 'system'} value
 */
export function setTheme(value) {
  if (!hasWindow()) return;
  const root = document.documentElement;
  if (value === 'system') {
    if (hasStorage()) {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch (_e) {
        /* ignore */
      }
    }
    if (root && root.dataset) delete root.dataset.theme;
    return;
  }
  if (value !== 'light' && value !== 'dark') return;
  if (hasStorage()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (_e) {
      /* ignore */
    }
  }
  if (root && root.dataset) root.dataset.theme = value;
}

/**
 * Resolve the currently effective theme, taking `prefers-color-scheme` into
 * account when no explicit choice exists.
 * @returns {'light' | 'dark'}
 */
export function getEffectiveTheme() {
  const explicit = getTheme();
  if (explicit) return explicit;
  if (!hasWindow() || typeof window.matchMedia !== 'function') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch (_e) {
    return 'light';
  }
}
