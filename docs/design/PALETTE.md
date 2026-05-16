# WebPilot Palette

## Concept

A near-neutral grey foundation in the spirit of macOS Sonoma and iCloud — soft, hierarchical, and quiet — with a single restrained accent pulled from a clear high-altitude sky (`#0A84FF` reframed as `#2E6FE6` in light mode, `#5AA9FF` in dark). Pastels never become surfaces; they appear only as ~10–14% accent washes on status pills and focus states, the way Apple uses secondary system fills. Greys carry meaning through layering and contrast steps, so the UI feels like a precision instrument rather than a painted dashboard.

## Light mode

| Role | Token | Value | Notes |
|---|---|---|---|
| Background, base | `--wp-bg` | `#F7F8FA` | Cool off-white with a 2-point blue bias. The "sky-at-altitude" hint lives here, not in saturation. |
| Background, card | `--wp-bg-card` | `#FFFFFF` | Pure white card surface on top of base. |
| Background, elevated | `--wp-bg-elevated` | `#FFFFFF` | Same as card; elevation conveyed via shadow + `--wp-separator-subtle`, not a tint. Keeps popovers crisp. |
| Foreground, primary | `--wp-fg` | `#0B1220` | Near-black with a faint navy cast. AAA on base and card. |
| Foreground, secondary | `--wp-fg-secondary` | `#3C4860` | Body-secondary, captions, metadata. AA Large / AA on white. |
| Foreground, muted | `--wp-fg-muted` | `#6B7588` | Placeholder, disabled label, helper text. AA on white. |
| Separator, subtle | `--wp-separator` | `rgba(11, 18, 32, 0.08)` | Hairline borders, table row dividers. |
| Separator, strong | `--wp-separator-strong` | `rgba(11, 18, 32, 0.16)` | Card outlines, input borders, header rules. |
| Accent, default | `--wp-accent` | `#2E6FE6` | The sky-blue. Used for primary buttons, links, selection, active nav. |
| Accent, hover | `--wp-accent-hover` | `#2560CC` | ~6% darker. |
| Accent, active | `--wp-accent-active` | `#1E51B0` | Pressed / depressed state. |
| Accent, focus ring | `--wp-accent-focus` | `rgba(46, 111, 230, 0.35)` | 3px outline ring, offset 2px. |
| Accent, bg-tint | `--wp-accent-tint` | `rgba(46, 111, 230, 0.10)` | Selected-row fill, ghost-button hover, badge bg. |
| Success, default | `--wp-success` | `#1F8F4E` | Connected / paired / ok states. AA on white. |
| Success, bg-tint | `--wp-success-tint` | `rgba(31, 143, 78, 0.12)` | Pill background; pair with `--wp-success` text. |
| Warning, default | `--wp-warning` | `#A06400` | Restart-required, flag-missing notices. Warm but desaturated. AA on white. |
| Warning, bg-tint | `--wp-warning-tint` | `rgba(160, 100, 0, 0.12)` | Pill background. |
| Danger, default | `--wp-danger` | `#C13030` | Revoke, denied, disconnected errors. AA on white. |
| Danger, bg-tint | `--wp-danger-tint` | `rgba(193, 48, 48, 0.10)` | Pill background. |
| Info, default | `--wp-info` | `#3B7CC4` | Neutral notices — slightly softer than accent so the two don't fight. AA on white. |
| Info, bg-tint | `--wp-info-tint` | `rgba(59, 124, 196, 0.10)` | Pill background. |

## Dark mode

| Role | Token | Value | Notes |
|---|---|---|---|
| Background, base | `--wp-bg` | `#0F1318` | Cool near-black, the "night sky before takeoff" reference. Not pure black, never `#000`. |
| Background, card | `--wp-bg-card` | `#161B22` | First elevation. Subtle lift from base. |
| Background, elevated | `--wp-bg-elevated` | `#1C222B` | Popovers, modals, dropdowns. Each step is ~+3% luminance. |
| Foreground, primary | `--wp-fg` | `#E8ECF2` | Soft off-white — pure white on dark is fatiguing. AAA on base. |
| Foreground, secondary | `--wp-fg-secondary` | `#B4BCCA` | AA on base. |
| Foreground, muted | `--wp-fg-muted` | `#7E8696` | Placeholders, disabled. AA Large on base. |
| Separator, subtle | `--wp-separator` | `rgba(232, 236, 242, 0.08)` | Hairlines. |
| Separator, strong | `--wp-separator-strong` | `rgba(232, 236, 242, 0.14)` | Borders. |
| Accent, default | `--wp-accent` | `#5AA9FF` | Brighter, lighter sky — readable on dark surfaces without glow. |
| Accent, hover | `--wp-accent-hover` | `#7BBBFF` | Lighter on hover (inverse of light mode — feels right on dark). |
| Accent, active | `--wp-accent-active` | `#4F95E0` | Pressed. |
| Accent, focus ring | `--wp-accent-focus` | `rgba(90, 169, 255, 0.45)` | Slightly more opaque to read on dark. |
| Accent, bg-tint | `--wp-accent-tint` | `rgba(90, 169, 255, 0.14)` | Selected row, ghost-button hover. |
| Success, default | `--wp-success` | `#4CC38A` | Lighter so it reads on `#0F1318`. |
| Success, bg-tint | `--wp-success-tint` | `rgba(76, 195, 138, 0.14)` | |
| Warning, default | `--wp-warning` | `#E0A24A` | |
| Warning, bg-tint | `--wp-warning-tint` | `rgba(224, 162, 74, 0.14)` | |
| Danger, default | `--wp-danger` | `#F26B6B` | |
| Danger, bg-tint | `--wp-danger-tint` | `rgba(242, 107, 107, 0.14)` | |
| Info, default | `--wp-info` | `#7DB3E5` | Softer than accent to avoid duelling blues. |
| Info, bg-tint | `--wp-info-tint` | `rgba(125, 179, 229, 0.14)` | |

## Accent rationale

The sky reference is concentrated entirely in one place — the accent — and only there. In light mode it is `#2E6FE6`: a clear-day blue, more saturated than Apple's `#007AFF` system blue but pulled slightly toward cobalt so it reads as "sky at 30,000 feet" rather than generic UI blue. In dark mode it lifts to `#5AA9FF` — the same hue family, but tuned for legibility on a dark surface (lighter, slightly less saturated). The two were chosen as a pair so a user who toggles modes mid-session feels continuity, not whiplash.

That accent is the *only* place a saturated colour is permitted on a primary surface. It appears on: the primary CTA ("Approve pairing"), the selected nav item's text + left border, links inline in prose, the focus ring on every focusable element, and the active-tab underline. It is forbidden as a background fill anywhere except its own `--wp-accent-tint` washes (selected-row highlight, ghost-button hover). Buttons get the accent as a flat fill — no gradients, no inner glows.

The second, subtler nod to sky lives in the *neutrals*. Both `--wp-bg` values are deliberately cool — `#F7F8FA` reads as off-white but compared against a true `#F7F7F7` it has a faint sky-bias; `#0F1318` is a cool charcoal rather than a warm one. The foreground primaries (`#0B1220` / `#E8ECF2`) carry the same bias, so the whole interface sits in a coherent cool-neutral family. This is the "quiet horizon" — present everywhere, named nowhere.

## Pastel usage

Pastels exist only as **opacity washes of the named colours**, never as standalone hex values, and only in these specific places:

- **Status pills.** `bg: --wp-{semantic}-tint` + `color: --wp-{semantic}`. Used for "Pending", "Approved", "Disconnected", "Restart required" on the Pairings / Paired Agents pages.
- **Selected list row.** `bg: --wp-accent-tint` (no border change). Used for the currently selected pairing in the master/detail layout.
- **Ghost / tertiary button hover.** Transparent default, `bg: --wp-accent-tint` on hover.
- **Inline code / kbd backgrounds.** `bg: --wp-separator` (an opacity-grey wash, not a pastel — included here so it's clear it is *not* an accent-tint).

Pastels never appear as: a card surface, a page background, a sidebar fill, a header bar fill, or a gradient stop. The moment a pastel covers more than ~15% of the viewport it stops being a pastel and starts being a theme — that is explicitly out of scope for this palette.

## Contrast audit

All ratios calculated against the relevant surface. AA threshold is 4.5:1 (normal text) / 3.0:1 (large text or non-text UI). AAA is 7.0:1 (normal) / 4.5:1 (large).

### Light mode

| Foreground | Background | Ratio | Result |
|---|---|---|---|
| `#0B1220` fg | `#F7F8FA` base | 16.9:1 | AAA |
| `#0B1220` fg | `#FFFFFF` card | 18.5:1 | AAA |
| `#3C4860` fg-secondary | `#F7F8FA` base | 8.9:1 | AAA |
| `#3C4860` fg-secondary | `#FFFFFF` card | 9.7:1 | AAA |
| `#6B7588` fg-muted | `#FFFFFF` card | 4.6:1 | AA |
| `#6B7588` fg-muted | `#F7F8FA` base | 4.3:1 | AA Large only — use on card surfaces. |
| `#2E6FE6` accent | `#FFFFFF` card | 4.8:1 | AA (text); AAA Large |
| `#2E6FE6` accent | `#F7F8FA` base | 4.5:1 | AA (boundary — pad button to large) |
| `#FFFFFF` on `#2E6FE6` accent fill | — | 4.8:1 | AA — primary button text |
| `#1F8F4E` success | `#FFFFFF` | 4.6:1 | AA |
| `#A06400` warning | `#FFFFFF` | 5.4:1 | AA |
| `#C13030` danger | `#FFFFFF` | 5.6:1 | AA |
| `#3B7CC4` info | `#FFFFFF` | 4.5:1 | AA boundary |

### Dark mode

| Foreground | Background | Ratio | Result |
|---|---|---|---|
| `#E8ECF2` fg | `#0F1318` base | 15.2:1 | AAA |
| `#E8ECF2` fg | `#161B22` card | 13.0:1 | AAA |
| `#E8ECF2` fg | `#1C222B` elevated | 11.5:1 | AAA |
| `#B4BCCA` fg-secondary | `#0F1318` base | 9.4:1 | AAA |
| `#B4BCCA` fg-secondary | `#161B22` card | 8.0:1 | AAA |
| `#7E8696` fg-muted | `#161B22` card | 4.5:1 | AA |
| `#7E8696` fg-muted | `#0F1318` base | 4.6:1 | AA |
| `#5AA9FF` accent | `#0F1318` base | 7.8:1 | AAA |
| `#5AA9FF` accent | `#161B22` card | 6.7:1 | AA (text); AAA Large |
| `#FFFFFF` on `#5AA9FF` accent fill | — | 2.4:1 | Fail — primary button uses `#0B1220` text instead → 8.6:1, AAA. |
| `#4CC38A` success | `#0F1318` | 8.6:1 | AAA |
| `#E0A24A` warning | `#0F1318` | 8.5:1 | AAA |
| `#F26B6B` danger | `#0F1318` | 6.0:1 | AA |
| `#7DB3E5` info | `#0F1318` | 8.1:1 | AAA |

**Notable derived rule:** the dark-mode primary button uses near-black text (`#0B1220`) on the light-blue accent, not white. This is the same choice Apple makes for `systemBlue` button fills in dark mode and it's the only way to keep AA on a light-on-light pairing.

## Implementation note

Default to system preference, allow manual override, persist the override. Concretely:

1. Define both palettes as CSS custom properties under `:root` (light) and `:root[data-theme="dark"]` (dark).
2. Add a `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { /* dark values */ } }` block so users with no explicit choice get OS-driven theming with zero JS.
3. The manual toggle writes `data-theme="light"` or `data-theme="dark"` onto `<html>` and mirrors the value into `localStorage.webpilotTheme`.
4. An early inline script in `<head>` (before first paint) reads `localStorage.webpilotTheme` and sets `data-theme` synchronously — this prevents the flash-of-wrong-theme on reload.
5. A "Match system" option clears `data-theme` and removes the localStorage key, restoring `prefers-color-scheme` behavior.

The three-state model (light / dark / system) mirrors macOS System Settings → Appearance and is the established pattern (Vercel, Linear, GitHub all do this). Don't invent a fourth state.

## What this palette is NOT

- **Not gradient-driven.** No accent gradients on buttons, no sky-fade backdrops, no aurora effects. Aviation is referenced through hue choice and naming intent, not through literal sky imagery. The moment we add a gradient we cross from "Apple-restrained" into "marketing site."
- **Not glassmorphism.** No `backdrop-filter: blur()` surfaces, no translucent navigation bars. These look great in screenshots and degrade poorly across browsers, GPUs, and accessibility modes (forced-colors, reduced-transparency).
- **Not glow / neon.** No `box-shadow` with coloured spread on focus or hover. Focus is a solid ring at `--wp-accent-focus`, full stop.
- **Not multi-accent.** One accent. Info is deliberately a *desaturated* sibling of accent, not a second brand colour. We do not have a "secondary brand colour."
- **Not high-saturation pastels.** Tints are derived as low-opacity overlays of the semantic colour against the surface — not hand-picked pastel hexes. This guarantees they harmonise with each surface layer instead of fighting it.
- **Not dark = inverted-light.** The dark palette was tuned independently (background-card lift, accent re-hued for dark legibility, button text inverted on accent fills). It is a peer of the light palette, not a derivation.
