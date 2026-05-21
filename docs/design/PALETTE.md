# WebPilot Palette

## Concept

A warm-monochrome foundation — ivory in light mode, anthracite in dark — with a single restrained deep-slate accent (bone in dark mode). Pastels never become surfaces; they appear only as ~8–14% washes on status pills and focus states. Value (not hue) carries hierarchy, so the UI feels like a precision instrument rather than a painted dashboard.

The tokens below mirror the live values in `packages/server-web-ui/app/globals.css`. Both palettes are mounted on `:root` (light) and `:root[data-theme="dark"]` (dark), with a `prefers-color-scheme: dark` fallback for unset themes.

## Light mode

| Role | Token | Value | Notes |
|---|---|---|---|
| Background, base | `--wp-bg` | `#FBFAF7` | Warm ivory page canvas. |
| Background, card | `--wp-bg-card` | `#FFFFFF` | Pure white card surface on top of base. |
| Background, elevated | `--wp-bg-elevated` | `#F4F2EE` | Hover / selected row fill, drawer / drawer-like surfaces. |
| Foreground, primary | `--wp-fg` | `#1A1815` | Near-black anthracite. |
| Foreground, secondary | `--wp-fg-secondary` | `rgba(26, 24, 21, 0.62)` | Body-secondary, captions, metadata. Alpha-on-`--wp-fg`. |
| Foreground, muted | `--wp-fg-muted` | `rgba(26, 24, 21, 0.36)` | Placeholder, disabled label, helper text. |
| Separator, subtle | `--wp-separator` | `rgba(26, 24, 21, 0.08)` | Hairline borders, table row dividers. |
| Separator, strong | `--wp-separator-strong` | `rgba(26, 24, 21, 0.14)` | Card outlines, input borders, header rules. |
| Accent, default | `--wp-accent` | `#3F4147` | Deep-slate. Primary buttons, links, selection, active nav. |
| Accent, hover | `--wp-accent-hover` | `#2A2C30` | Darker on hover. |
| Accent, active | `--wp-accent-active` | `#1A1815` | Pressed / depressed state. |
| Accent, focus ring | `--wp-accent-focus` | `rgba(63, 65, 71, 0.35)` | 2px outline ring, offset 2px (`--wp-focus-width`/`--wp-focus-offset`). |
| Accent, bg-tint | `--wp-accent-tint` | `rgba(63, 65, 71, 0.08)` | Selected-row fill, ghost-button hover, badge bg, step-number bg. |
| On-accent text | `--wp-on-accent` | `#FBFAF7` | Text/icon colour on filled accent surfaces (primary button labels). |
| Success, default | `--wp-success` | `#5A7A4A` | Connected / paired / ok states. Muted moss-green. |
| Success, bg-tint | `--wp-success-tint` | `rgba(90, 122, 74, 0.12)` | Pill background; pair with `--wp-success` text. |
| Warning, default | `--wp-warning` | `#B47A33` | Restart-required, flag-missing notices. Warm desaturated amber. |
| Warning, bg-tint | `--wp-warning-tint` | `rgba(180, 122, 51, 0.12)` | Pill background. |
| Danger, default | `--wp-danger` | `#9A3D3D` | Revoke, denied, disconnected errors. Muted brick. |
| Danger, bg-tint | `--wp-danger-tint` | `rgba(154, 61, 61, 0.10)` | Pill background. |
| Info, default | `--wp-info` | `#3F4147` | Aliased to accent in the warm-monochrome palette — info reads as neutral, not a second hue. |
| Info, bg-tint | `--wp-info-tint` | `rgba(63, 65, 71, 0.08)` | Pill background. |

## Dark mode

| Role | Token | Value | Notes |
|---|---|---|---|
| Background, base | `--wp-bg` | `#161412` | Warm near-black. Not pure black, never `#000`. |
| Background, card | `--wp-bg-card` | `#1F1D1A` | First elevation. Subtle warm lift from base. |
| Background, elevated | `--wp-bg-elevated` | `#2A2724` | Hover / selected row fill, popovers. |
| Foreground, primary | `--wp-fg` | `#F0EDE8` | Warm off-white — pure white on dark is fatiguing. |
| Foreground, secondary | `--wp-fg-secondary` | `rgba(240, 237, 232, 0.62)` | Alpha-on-`--wp-fg`. |
| Foreground, muted | `--wp-fg-muted` | `rgba(240, 237, 232, 0.36)` | Placeholders, disabled. |
| Separator, subtle | `--wp-separator` | `rgba(240, 237, 232, 0.10)` | Hairlines. |
| Separator, strong | `--wp-separator-strong` | `rgba(240, 237, 232, 0.16)` | Borders. |
| Accent, default | `--wp-accent` | `#BFB7A8` | Bone — warm light neutral; reads as accent on dark anthracite. |
| Accent, hover | `--wp-accent-hover` | `#D5CDBE` | Lighter on hover (inverse of light mode — feels right on dark). |
| Accent, active | `--wp-accent-active` | `#A89E8F` | Pressed. |
| Accent, focus ring | `--wp-accent-focus` | `rgba(191, 183, 168, 0.4)` | Slightly more opaque to read on dark. `--wp-focus-width` raised to 2.5px in dark. |
| Accent, bg-tint | `--wp-accent-tint` | `rgba(191, 183, 168, 0.12)` | Selected row, ghost-button hover. |
| On-accent text | `--wp-on-accent` | `#161412` | Near-black text on bone-fill buttons (inverted from light mode). |
| Success, default | `--wp-success` | `#8FAA7F` | Lighter, desaturated moss so it reads on `#161412`. |
| Success, bg-tint | `--wp-success-tint` | `rgba(143, 170, 127, 0.14)` | |
| Warning, default | `--wp-warning` | `#D4A663` | |
| Warning, bg-tint | `--wp-warning-tint` | `rgba(212, 166, 99, 0.14)` | |
| Danger, default | `--wp-danger` | `#C97373` | |
| Danger, bg-tint | `--wp-danger-tint` | `rgba(201, 115, 115, 0.14)` | |
| Info, default | `--wp-info` | `#BFB7A8` | Aliased to accent in warm-monochrome dark — info is neutral, not a second hue. |
| Info, bg-tint | `--wp-info-tint` | `rgba(191, 183, 168, 0.14)` | |

## Accent rationale

The accent is deliberately a desaturated warm grey — `#3F4147` in light mode, `#BFB7A8` in dark — and the choice is the design statement. We considered the obvious moves (a confident blue, a brass, a soft green) and rejected all of them: every saturated accent would have told the user *"this is a brand"*, and WebPilot is the opposite of a brand. It is a local-first instrument the operator runs at the edge of their own machine. The palette should read as *paper and ink*, not as a product surface.

So the accent does what an accent has to do — mark the primary CTA, hold the focus ring, underline the active nav — but it does it in the same temperature family as the type. Compare `#3F4147` to `#1A1815`: they're both warm anthracite, separated by value, not hue. The result is that the eye finds the CTA because of contrast against ivory, not because a saturated patch is shouting from the page. In dark mode the relationship inverts cleanly — bone `#BFB7A8` against near-black `#161412` reads as "highlighted neutral", not as a coloured glow. `--wp-on-accent` flips with the theme (ivory on slate in light, near-black on bone in dark) so the primary button stays legible without anyone hand-tuning.

The discipline behind that choice is **value-over-hue hierarchy** (see `docs/design/research/SIMPLE.md`). When every surface, every type token, and the accent itself sit within a single warm-neutral family, the interface is forced to differentiate by spacing, weight, and value — not by colour. That is what makes the UI feel like a settings pane in macOS Ventura or a Things sidebar, rather than a SaaS dashboard. The accent does not carry "delight"; the typography and whitespace do. The accent only has to be findable.

There is one practical consequence worth naming: the accent is **not allowed to leak**. It appears on the primary CTA, the active nav item's left edge / solid-icon flip, link text in prose, the focus ring, and the active-tab underline — and nowhere else. No gradients, no inner glows, no decorative slate fills on cards. The moment the slate covers more than the few pixels it needs, the palette stops being warm-monochrome and starts being warm-slate-with-grey-accent, which is a different (worse) palette.

## Pastel usage

Pastels exist only as **opacity washes of the named colours**, never as standalone hex values, and only in these specific places:

- **Status pills.** `bg: --wp-{semantic}-tint` + `color: --wp-{semantic}`. Used for "Pending", "Approved", "Disconnected", "Restart required" on the Pairings / Paired Agents pages.
- **Selected list row.** `bg: --wp-accent-tint` (no border change). Used for the currently selected pairing in the master/detail layout.
- **Ghost / tertiary button hover.** Transparent default, `bg: --wp-accent-tint` on hover.
- **Inline code / kbd backgrounds.** `bg: --wp-separator` (an opacity-grey wash, not a pastel — included here so it's clear it is *not* an accent-tint).

Pastels never appear as: a card surface, a page background, a sidebar fill, a header bar fill, or a gradient stop. The moment a pastel covers more than ~15% of the viewport it stops being a pastel and starts being a theme — that is explicitly out of scope for this palette.

## Contrast audit

All ratios calculated against the relevant surface using the live values in `packages/server-web-ui/app/globals.css`. AA threshold is 4.5:1 (normal text) / 3.0:1 (large text or non-text UI). AAA is 7.0:1 (normal) / 4.5:1 (large). Alpha-channel foreground tokens are flattened against the named surface before measurement.

### Light mode

| Foreground | Background | Ratio | Result |
|---|---|---|---|
| `#1A1815` fg | `#FBFAF7` base | 16.9:1 | AAA |
| `#1A1815` fg | `#FFFFFF` card | 17.6:1 | AAA |
| `#1A1815` fg | `#F4F2EE` elevated | 16.0:1 | AAA |
| `fg-secondary` (0.62) | `#FFFFFF` card | 5.4:1 | AA |
| `fg-secondary` (0.62) | `#FBFAF7` base | 5.2:1 | AA |
| `fg-muted` (0.36) | `#FFFFFF` card | 2.6:1 | AA Large only — use for placeholder / helper only, never body text |
| `#3F4147` accent | `#FBFAF7` base | 9.1:1 | AAA |
| `#3F4147` accent | `#FFFFFF` card | 9.6:1 | AAA |
| `#FBFAF7` on-accent on `#3F4147` accent fill | — | 9.6:1 | AAA — primary button text |
| `#5A7A4A` success | `#FBFAF7` base | 4.4:1 | AA Large — body-size pill text passes against the lighter `--wp-success-tint` fill behind it |
| `#B47A33` warning | `#FBFAF7` base | 3.6:1 | AA Large only — pad warning pills, never use as body text |
| `#9A3D3D` danger | `#FBFAF7` base | 5.8:1 | AA |

### Dark mode

| Foreground | Background | Ratio | Result |
|---|---|---|---|
| `#F0EDE8` fg | `#161412` base | 15.3:1 | AAA |
| `#F0EDE8` fg | `#1F1D1A` card | 13.6:1 | AAA |
| `#F0EDE8` fg | `#2A2724` elevated | 11.4:1 | AAA |
| `fg-secondary` (0.62) | `#1F1D1A` card | 6.6:1 | AA (text); AAA Large |
| `fg-muted` (0.36) | `#1F1D1A` card | 3.0:1 | AA Large only |
| `#BFB7A8` accent | `#161412` base | 10.0:1 | AAA |
| `#BFB7A8` accent | `#1F1D1A` card | 9.0:1 | AAA |
| `#161412` on-accent on `#BFB7A8` accent fill | — | 10.0:1 | AAA — primary button text |
| `#8FAA7F` success | `#161412` base | 6.6:1 | AA (text); AAA Large |
| `#D4A663` warning | `#161412` base | 8.6:1 | AAA |
| `#C97373` danger | `#161412` base | 6.4:1 | AA (text); AAA Large |

**Notable derived rule:** the dark-mode primary button uses near-black text on the bone accent, not white. The implementation exposes this via the `--wp-on-accent` token (`#FBFAF7` in light mode, `#161412` in dark mode) — buttons reference `var(--wp-on-accent)` rather than hard-coding a colour, so the inversion happens automatically with the theme switch.

## Implementation note

Default to system preference, allow manual override, persist the override. Concretely:

1. Define both palettes as CSS custom properties under `:root` (light) and `:root[data-theme="dark"]` (dark).
2. Add a `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { /* dark values */ } }` block so users with no explicit choice get OS-driven theming with zero JS.
3. The manual toggle writes `data-theme="light"` or `data-theme="dark"` onto `<html>` and mirrors the value into `localStorage.webpilotTheme`.
4. An early inline script in `<head>` (before first paint) reads `localStorage.webpilotTheme` and sets `data-theme` synchronously — this prevents the flash-of-wrong-theme on reload.
5. A "Match system" option clears `data-theme` and removes the localStorage key, restoring `prefers-color-scheme` behavior.

The three-state model (light / dark / system) mirrors macOS System Settings → Appearance and is the established pattern (Vercel, Linear, GitHub all do this). Don't invent a fourth state.

## What this palette is NOT

- **Not cool-slate.** The neutrals are deliberately *warm* (ivory `#FBFAF7`, anthracite `#1A1815`, bone `#BFB7A8`). A cool-slate equivalent — `#F7F8FA` on `#0F1318` with a blue-grey accent — reads as Linear / Vercel / generic-developer-tool. We want paper-and-ink, not LCD-and-pixel.
- **Not blueprint-blue.** No saturated blue accent, no engineering-drawing palette, no "cyan as productivity" trope. The accent is a desaturated neutral so the page reads as a document, not as a CAD viewport.
- **Not corporate-SaaS-blue.** The retired sky-blue accent (Stripe-adjacent) was rejected because it pulls the design language toward "trustworthy SaaS dashboard" — exactly the register WebPilot is trying to escape. The current palette is closer to Things 3 / iA Writer than to any cloud-console product.
- **Not gradient-driven.** No accent gradients on buttons, no warm-fade backdrops, no aurora effects. The moment we add a gradient we cross from "instrument" into "marketing site."
- **Not glassmorphism.** No `backdrop-filter: blur()` surfaces, no translucent navigation bars. These look great in screenshots and degrade poorly across browsers, GPUs, and accessibility modes (forced-colors, reduced-transparency).
- **Not glow / neon.** No `box-shadow` with coloured spread on focus or hover. Focus is a solid ring at `--wp-accent-focus`, full stop.
- **Not multi-accent.** One accent. Info is deliberately aliased *to* the accent token, not given a second hue. We do not have a "secondary brand colour."
- **Not high-saturation pastels.** Tints are derived as low-opacity overlays of the semantic colour against the surface — not hand-picked pastel hexes. This guarantees they harmonise with each surface layer instead of fighting it.
- **Not dark = inverted-light.** The dark palette was tuned independently (background-card lift, accent re-hued for dark legibility, button text inverted on accent fills). It is a peer of the light palette, not a derivation.
