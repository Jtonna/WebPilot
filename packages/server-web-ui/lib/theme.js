/**
 * Theme + palette utilities for the WebPilot web UI.
 *
 * Two independent axes:
 *
 *   Theme    : 'light' | 'dark' | 'system'
 *              Mirrored to localStorage.webpilotTheme and <html data-theme="…">.
 *              "System" means: no localStorage key, no data-theme attribute —
 *              prefers-color-scheme decides via the CSS media block.
 *
 *   Palette  : 'apple' | 'pastel' | 'mono'
 *              Mirrored to localStorage.webpilotPalette and
 *              <html data-palette="…">. Default is "apple".
 *              Unlike theme, there is no "system" — the user always picks one,
 *              with "apple" implied when storage is empty.
 *
 * An inline script in app/layout.js applies both before the body paints so we
 * never flash the wrong palette/theme on reload.
 *
 * All entry points are SSR-safe.
 */

const THEME_STORAGE_KEY = 'webpilotTheme';
const PALETTE_STORAGE_KEY = 'webpilotPalette';

const VALID_PALETTES = ['apple', 'pastel', 'mono'];
const DEFAULT_PALETTE = 'apple';

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

/* ----------------------------------------------------------------------- */
/* Palette                                                                 */
/* ----------------------------------------------------------------------- */

/**
 * Read the persisted palette choice.
 * @returns {'apple' | 'pastel' | 'mono'} — defaults to 'apple' when unset.
 */
export function getPalette() {
  if (!hasStorage()) return DEFAULT_PALETTE;
  try {
    const v = window.localStorage.getItem(PALETTE_STORAGE_KEY);
    if (VALID_PALETTES.indexOf(v) !== -1) return v;
    return DEFAULT_PALETTE;
  } catch (_e) {
    return DEFAULT_PALETTE;
  }
}

/**
 * Persist the palette choice and apply it to the document root.
 * @param {'apple' | 'pastel' | 'mono'} value
 */
export function setPalette(value) {
  if (!hasWindow()) return;
  if (VALID_PALETTES.indexOf(value) === -1) return;
  if (hasStorage()) {
    try {
      window.localStorage.setItem(PALETTE_STORAGE_KEY, value);
    } catch (_e) {
      /* ignore */
    }
  }
  const root = document.documentElement;
  if (root && root.dataset) root.dataset.palette = value;
}
