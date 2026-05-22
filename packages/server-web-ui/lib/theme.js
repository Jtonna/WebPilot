/**
 * Theme utilities for the WebPilot web UI.
 *
 *   Theme : 'light' | 'dark' | 'system'
 *           Mirrored to localStorage.webpilotTheme and <html data-theme="…">.
 *           "System" means: no localStorage key, no data-theme attribute —
 *           prefers-color-scheme decides via the CSS media block.
 *
 * The single warm-monochrome palette is applied unconditionally on :root, so
 * no palette toggle is exposed.
 *
 * An inline script in app/layout.js applies the theme before the body paints
 * so we never flash the wrong theme on reload.
 *
 * All entry points are SSR-safe.
 */

const THEME_STORAGE_KEY = 'webpilotTheme';

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

/* ----------------------------------------------------------------------- */
/* Theme                                                                   */
/* ----------------------------------------------------------------------- */

/**
 * Read the persisted explicit theme choice.
 * @returns {'light' | 'dark' | null} — `null` means "system".
 */
export function getTheme() {
  if (!hasStorage()) return null;
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark') return v;
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Persist the explicit theme choice and apply it to the document root.
 * @param {'light' | 'dark' | 'system'} value
 */
export function setTheme(value) {
  if (!hasWindow()) return;
  const root = document.documentElement;
  if (value === 'system') {
    if (hasStorage()) {
      try {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
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
      window.localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch (_e) {
      /* ignore */
    }
  }
  if (root && root.dataset) root.dataset.theme = value;
}

/**
 * Resolve the currently effective theme, taking prefers-color-scheme into
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
