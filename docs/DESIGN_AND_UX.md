# WebPilot Design & UX

WebPilot's UI is **warm-monochrome, hairline-everything, content-first, dot-only color**. Ivory in light mode, anthracite in dark, with a single restrained deep-slate accent. It should feel like a settings pane in macOS Ventura — a local instrument, not a SaaS dashboard. Value (not hue) carries hierarchy; the accent only has to be findable. Live values mirror `packages/server-web-ui/app/globals.css` — that file is the source of truth; this doc explains what's there and how to use it.

---

## Tokens

### Colors — light mode

| Role | Token | Value |
|---|---|---|
| Background, base | `--wp-bg` | `#FBFAF7` |
| Background, card | `--wp-bg-card` | `#FFFFFF` |
| Background, elevated | `--wp-bg-elevated` | `#F4F2EE` |
| Foreground, primary | `--wp-fg` | `#1A1815` |
| Foreground, secondary | `--wp-fg-secondary` | `rgba(26, 24, 21, 0.62)` |
| Foreground, muted | `--wp-fg-muted` | `rgba(26, 24, 21, 0.36)` |
| Separator, subtle | `--wp-separator` | `rgba(26, 24, 21, 0.08)` |
| Separator, strong | `--wp-separator-strong` | `rgba(26, 24, 21, 0.14)` |
| Accent, default | `--wp-accent` | `#3F4147` |
| Accent, hover | `--wp-accent-hover` | `#2A2C30` |
| Accent, active | `--wp-accent-active` | `#1A1815` |
| Accent, focus ring | `--wp-accent-focus` | `rgba(63, 65, 71, 0.35)` |
| Accent, bg-tint | `--wp-accent-tint` | `rgba(63, 65, 71, 0.08)` |
| On-accent text | `--wp-on-accent` | `#FBFAF7` |
| Success | `--wp-success` / `--wp-success-tint` | `#5A7A4A` / `rgba(90, 122, 74, 0.12)` |
| Warning | `--wp-warning` / `--wp-warning-tint` | `#B47A33` / `rgba(180, 122, 51, 0.12)` |
| Danger | `--wp-danger` / `--wp-danger-tint` | `#9A3D3D` / `rgba(154, 61, 61, 0.10)` |
| Info | `--wp-info` / `--wp-info-tint` | aliased to accent (no second hue) |

### Colors — dark mode

| Role | Token | Value |
|---|---|---|
| Background, base | `--wp-bg` | `#161412` |
| Background, card | `--wp-bg-card` | `#1F1D1A` |
| Background, elevated | `--wp-bg-elevated` | `#2A2724` |
| Foreground, primary | `--wp-fg` | `#F0EDE8` |
| Foreground, secondary | `--wp-fg-secondary` | `rgba(240, 237, 232, 0.62)` |
| Foreground, muted | `--wp-fg-muted` | `rgba(240, 237, 232, 0.36)` |
| Separator, subtle | `--wp-separator` | `rgba(240, 237, 232, 0.10)` |
| Separator, strong | `--wp-separator-strong` | `rgba(240, 237, 232, 0.16)` |
| Accent, default | `--wp-accent` | `#BFB7A8` |
| Accent, hover | `--wp-accent-hover` | `#D5CDBE` |
| Accent, active | `--wp-accent-active` | `#A89E8F` |
| Accent, focus ring | `--wp-accent-focus` | `rgba(191, 183, 168, 0.4)` (focus width 2.5px in dark) |
| Accent, bg-tint | `--wp-accent-tint` | `rgba(191, 183, 168, 0.12)` |
| On-accent text | `--wp-on-accent` | `#161412` |
| Success | `--wp-success` / `--wp-success-tint` | `#8FAA7F` / `rgba(143, 170, 127, 0.14)` |
| Warning | `--wp-warning` / `--wp-warning-tint` | `#D4A663` / `rgba(212, 166, 99, 0.14)` |
| Danger | `--wp-danger` / `--wp-danger-tint` | `#C97373` / `rgba(201, 115, 115, 0.14)` |
| Info | `--wp-info` / `--wp-info-tint` | aliased to accent |

All foreground/background pairings meet WCAG AA at body size; the named-fg-on-named-bg pairings hit AAA. `--wp-fg-muted` is AA Large only — use for placeholder / helper text, never body. See `globals.css` for the live values; flatten alpha tokens against their surface before re-measuring.

### Type

**Fonts.** Geist Sans (lead), Geist Mono (mono). Both from Google Fonts (OFL). No system fallback as the lead; no third family. Body uses `font-feature-settings: 'ss01', 'cv11', 'tnum'` for tabular numerals and the single-storey `a`.

| Token | Size | Weight | Line height | Letter spacing | Use |
|---|---|---|---|---|---|
| `display` | 2rem (32px) | 500 | 1.2 | -0.015em | Page hero / `h1` |
| `section` | 1.25rem (20px) | 500 | 1.3 | -0.01em | `h2` |
| `subsection` | 1rem (16px) | 600 | 1.4 | -0.005em | Card title / `h3` |
| `body` | 0.9375rem (15px) | 400 | 1.55 | 0 | Reading text |
| `body-strong` | 0.9375rem (15px) | 500 | 1.55 | 0 | Inline emphasis (never 700) |
| `small` | 0.8125rem (13px) | 400 | 1.5 | 0.005em | Captions, helper |
| `micro` | 0.75rem (12px) | 500 | 1.4 | 0.02em | Status pills, column headers |
| `mono` | 0.875rem (14px) | 400 | 1.5 | 0 | Inline code, ports, IDs, paths |
| `mono-small` | 0.8125rem (13px) | 400 | 1.4 | 0 | Mono in dense lists |

Weights: sans 400 / 500 / 600 (card titles only). Mono 400 only. Never 700.

### Spacing

Base **4px**. Use these tokens; never a non-token value.

| Token | Value | Use |
|---|---|---|
| `s-1` | 4px | Icon-to-label gap |
| `s-2` | 8px | Pill padding, tight stacks |
| `s-3` | 12px | Form field internals, sibling small controls |
| `s-4` | 16px | Default text block / card stack gap |
| `s-5` | 24px | Card padding, grid gaps, default sibling gap |
| `s-6` | 32px | Card-to-section, sidebar inner padding |
| `s-7` | 48px | Between major page sections |
| `s-8` | 64px | Page hero top padding (desktop), page bottom |
| `s-9` | 96px | Large empty states |

Card padding: `card-pad-sm` 16px (dense rows), `card-pad-md` 24px (default), `card-pad-lg` 32px (hero / empty / settings groups). Buttons: 28/32/40px height (compact/default/CTA), 10/12/16px horizontal pad. Inputs: 36px desktop, 44px mobile, 12px pad. Icons: 16 / 20 / 24 / 32 only. Page max-width 1120px (centered, `s-6` gutter desktop / `s-4` mobile); prose max 640px; modal 480px default, 640px large, `min(92vw, 720px)` mobile.

### Motion

Easing:
- `ease-quart-out` `cubic-bezier(0.25, 1, 0.5, 1)` — default entrances and state changes.
- `ease-quart-in-out` `cubic-bezier(0.76, 0, 0.24, 1)` — state-to-state on persistent elements.
- `ease-spring-soft` `cubic-bezier(0.34, 1.3, 0.64, 1)` — first-appearance only, ≤1.05× overshoot.

| Duration | Value | Use |
|---|---|---|
| `dur-instant` | 80ms | Hover tone, focus ring |
| `dur-quick` | 180ms | Button press, toggle |
| `dur-normal` | 240ms | Popover, dropdown, mobile sidebar |
| `dur-slow` | 400ms | Modal mount, route fade |

Two principles: (1) **fade + ≤8px translate. Never scale, never rotate.** Modal in from `translateY(8px)`, popover from `translateY(-4px)`, mobile sidebar from `translateX(-12px)`. Exits fade only. (2) **Per-element, not per-page.** Route changes cross-fade content over `dur-slow`; chrome doesn't move.

Reduced motion: every transition/animation respects `@media (prefers-reduced-motion: reduce)` — collapse durations to 0ms, drop translates, keep opacity transitions capped at 80ms.

---

## Surfaces & borders

**Hairline-everything.** Every card-shaped surface is `background: var(--wp-bg-card); border: 1px solid var(--wp-separator);` and nothing else — the canonical `.wp-card`. The hairline defines the edge; the warm-monochrome value-step between `--wp-bg`, `--wp-bg-card`, and `--wp-bg-elevated` does the rest. Don't stack tonal-lift *and* shadow on the same surface. Borders go on cards, inputs, table row dividers (horizontal, never vertical), and popover/menu frames. Borders are 1px solid. Hover lifts opacity ~50%, never changes color. Focus is a 2px ring (2.5px in dark) offset by 2px in `--wp-accent-focus` — replaces the border, never stacks.

**Three-tone triad.** Both modes ship canvas → card → elevated (light `#FBFAF7` / `#FFFFFF` / `#F4F2EE`; dark `#161412` / `#1F1D1A` / `#2A2724`). The elevated step is hover/selected fill.

**Shadows reserved for floating.** `elev-0` everywhere on canvas (including cards). `elev-1` hover only. `elev-2` popovers / dropdowns / toasts. `elev-3` modals / drag-previews. Never combine `elev-2`/`elev-3` on adjacent nested surfaces.

**Radii.** `radius-xs` 4px (pills/inline code), `radius-sm` 6px (buttons/inputs), `radius-md` 10px (cards), `radius-lg` 14px (modals/popovers), `radius-xl` 20px (onboarding), `radius-pill` 999px. Nested radius rule: outer = inner + 4px max.

**Icons.** `@heroicons/react` 24x24, outline by default. Single active sidebar item swaps to solid as a state mark. Icons inherit `currentColor` — never tinted independently.

**Pastels** appear only as `--wp-{semantic}-tint` washes (status pills, selected row, ghost-button hover, inline code bg). Never as a surface, page bg, or gradient stop.

---

## Information architecture

Two sidebar groups. Order matches `components/AppShell.js`.

**Workspace** — Dashboard, Profiles, Agents, Sites, Formatters, Pairings.
**System** — Settings.

```
/ui                        Dashboard
/ui/profiles               Profiles
/ui/agents                 Agents
/ui/sites                  Sites               (P2 phase 5)
/ui/formatters             Formatters          (P2 phase 6)
/ui/formatters/logs/?name= Per-formatter logs
/ui/pairings               Pairings
/ui/settings               Settings
```

Sidebar (desktop ≥900px): fixed 240px, no shadow. Active state = elevated fill + 3px `--wp-fg` left-edge bar + solid Heroicon variant + 600-weight label — **no accent tint**. Brand wordmark at top links to Dashboard. Footer is a small connection dot + label (`Connected` / `Disconnected` / `Connecting…`); polls every 15s after first success, 500ms before. The Pairings row shows a mono pending-count on its right edge — the single allowed nav-item count.

Mobile (<900px): top bar 56px with hamburger (top-left) and connection dot (top-right, also opens the sheet). Sidebar slides in as a left sheet from `translateX(-12px)` over `dur-normal`. Backdrop scrim dismisses.

No sub-nav / tabs (Settings uses section anchors). One `<h1>` per page; no breadcrumbs.

### Per-page composition

**Dashboard** — Page header, then **Action items** (inline `PairingPromptCard`s — approve / deny in-card, profile selector with `+ New sandbox profile` sentinel), then **Chrome profiles** (rows link to `/agents?profile=<dir>`), then **System status** (one card: Chrome / Extension / Server). Truly empty: replace System status with a Welcome card + single `Pair an agent` CTA. No activity feed.

**Pairings** — `Awaiting review` (same card as Dashboard) and persistent server-backed **History** (`GET /api/ui/pairings/history` paginated by cursor; row expands to show pairing ID, decided-at timestamp, link to agent, Revoke if active). `Load 50 more` button — no infinite scroll.

**Profiles** — `Known profiles` (sort: active → ready → needs_setup, then last-active desc; `needs_setup` rows show a `Set up` button opening the four-step Profile setup walkthrough modal) and a prominent **+ New sandbox profile** panel (inline form, not a modal).

**Agents** — **Pair a new agent** CTA opens the walkthrough modal (three steps: copy `.mcp.json`, copy agent prompt, approve inline via embedded `PairingPromptCard`). **Paired agents** list with rename / revoke kebab. **Manual setup snippets** collapsible at bottom. Last-active: relative ≤7d, absolute older.

**Sites** — Global Blocklist card (toggle + version + last fetch + count, with a `What's in the pack?` disclosure listing the bundled domains read-only). **Custom rules** (domain / decision, inline add). **Per-agent overrides** with agent picker.

**Formatters** — `Loaded from remote` + `Custom` sections; row = name + `HealthPill` + last error time; row links to `/ui/formatters/logs/?name=…`. REST poll every 30s.

**Settings** — Single column of cards: **Appearance** (segmented `System / Light / Dark`), **Network** (LAN toggle, restarts server), **Notifications** (system toast + sound, child disables with parent), **Server** (port / data dir / log path key-value, copy + open buttons, `Restart server`), **About** (version, `Check for updates`, GitHub / Issues / Docs links). Each card loads independently.

---

## Microcopy & patterns

**Tone:** Apple-confident, quietly technical. Short declarative sentences. Periods. No `!` except the Welcome card. No emoji. No "we" / "let's". Plain over precise — `Localhost only` in body, `127.0.0.1` in a tooltip.

**Eyebrow rule:** none. Section headers are H2 `section` token; no kicker, no breadcrumb above the H1.

**Empty states:** one line + one icon (32px) + at most one action. Examples — `No pairings yet. They'll appear here after you approve or deny your first request.` / `No agents paired yet.` / `Nothing pending right now.`

**Status pills:** `Active` (green, live extension + recent activity) → `Ready` (blue, set up but not connected) → `Needs setup` (amber, no extension installId yet). Dot + label. Active outranks Ready outranks Needs setup. Decision pills: `Allow` / `Block`. Health pills: `Healthy` / `Degraded` / `Unhealthy`.

**Confirmation modals** (`ConfirmModal`): title is a short declarative question (`Revoke API key?` / `Restart server?`). Body: one sentence effect, one sentence recovery. Default focus on Cancel; Esc closes; Enter does not auto-confirm. Use `wp-btn-danger` for destructive, primary for non-destructive (restart). Every destructive action gets a modal — even in fast-moving lists.

**Toasts:** lower-right region (lower-center mobile), max 3 stacked. 4s auto-dismiss, manual close. `success` / `info` / `error` flavors; errors persist until dismissed. No action buttons in toasts.

**Error cards:** section-scoped. `Couldn't reach the server. <Retry>`. Don't hide adjacent content if cached data is still useful.

**Punctuation:** periods end sentences (including subtitles). Interpunct `·` separates inline metadata (`PID 12345 · port 3456`) — never `|`, never `-`. Em-dash for asides, hyphen for compounds. Mono only for facts (ports, PIDs, paths, UUIDs, JSON); sans for prose. Never both at once.

**Pairing flow:** event arrives → card slide-in (`arrivingIds` ~1.5s) → approve (with `__new__` expanding to an inline name input; label becomes `Approve and create`) → button reads `Pairing…` while in-flight → success toast `Paired. <agent> bound to <profile>.` + card animates out → deny opens confirm modal → on confirm toast `Denied <agent>.`

**First-run:** no welcome tour. Empty Dashboard's Welcome card → `Pair an agent` → Agents page opens the walkthrough modal directly. Profiles auto-promotes `+ New sandbox profile` when 0 profiles known.

---

## Boot & connection states

**Connecting splash** (`components/AppShell.js` `ConnectingSplash`). Until the first successful `/api/ui/status`, AppShell renders a full-window splash — not the page with a "Disconnected" banner. Centered `WebPilot` wordmark (28px / weight 500) on `var(--wp-bg)`, single-line `Starting server…` / `Connecting…`, three pulsing dots. Mirrors `electron/splash.html` (do not redesign one without the other). Polled at 500ms during boot, 15s heartbeat after first success. Once cleared, splash never returns — transient drops surface only via the sidebar dot.

**Dark-mode native-dropdown contract.** Native `<option>` popup chrome does not inherit theme colors. `globals.css` anchors `background-color` and `color` on `option` directly (under `.wp-select option, .wp-input option`) to `--wp-bg-card` / `--wp-fg`. Every dropdown surface — profile picker, agent picker, pairing-card profile select — **must** use `.wp-select` or `.wp-input`. Don't introduce a bespoke `<select>` without re-applying the option color anchors.

**Theme model.** Three-state: System / Light / Dark, lives in Settings → Appearance. Light is `:root`, dark is `:root[data-theme="dark"]`. Unset theme falls back to `@media (prefers-color-scheme: dark)`. Manual choice writes `data-theme` on `<html>` and mirrors to `localStorage.webpilotTheme`. An early inline script in `<head>` reads localStorage and sets `data-theme` synchronously to prevent flash-of-wrong-theme. "Match system" clears both. No floating sun/moon icon.

---

## Hard constraints

1. **No pure-white body text.** Use `--wp-fg` (`#1A1815` light, `#F0EDE8` dark). Pure `#FFF` on dark is fatiguing; pure `#000` on light is harsh.
2. **No pure `#000` backgrounds.** Dark base is `#161412`.
3. **No hex literals in components.** Every color goes through a token. If a token doesn't exist, the color is wrong.
4. **One accent per screen.** Primary CTA *or* active nav focal — not both at the same focal weight. Everywhere else neutral.
5. **One accent token, period.** Info is aliased to accent. No secondary brand color. No gradients.
6. **No nested cards >1 deep.** Use dividers and spacing instead.
7. **Hairline-everything for card surfaces.** No shadow on resting cards. Shadows only on floating surfaces (popovers, menus, modals).
8. **No retired effects:** neumorphism, glassmorphism (no `backdrop-filter`), drop-shadow-everywhere, gradients (any kind), neon glows, motion-as-decoration, badge counts (except the Pairings typeset count), red dots on sidebar items, welcome-tour modals, activity feeds, charts.
9. **No motion >400ms.** Nothing scales, rotates, wiggles. Stagger ≤40ms between siblings.
10. **Honor `prefers-reduced-motion`.** Collapse durations, drop translates, keep opacity ≤80ms.
11. **Bold-700 banned.** Medium (500) is the heaviest weight; card titles get 600.
12. **One sans, one mono, both Geist.** No display italics, no serif accents, no system stack fallback as lead.
13. **No accent leak.** Slate/bone appears only on primary CTA, active-nav left-edge + solid icon, prose link, focus ring, active-tab underline. Not on card fills, not as gradient stops, not anywhere it would cover more than a few pixels.
14. **Status pills are decorative, not tappable.** Kebab and other interactive icons grow to 44×44 on mobile; pills keep their size.
15. **Confirm destructive actions with a modal — every time.** Even in lists. Cost of accidental Deny > cost of an extra Enter.
