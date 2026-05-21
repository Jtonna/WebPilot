# WebPilot Palette

<!-- TODO(founder): The Concept / Accent rationale / Pastel usage / Contrast audit /
"What this palette is NOT" sections below were written for the previous
sky-blue palette and DO NOT MATCH the current warm-monochrome implementation
in packages/server-web-ui/app/globals.css. The token tables have been updated
to the actual values shipped; the prose sections still need a full rewrite to
reflect the warm-monochrome / deep-slate-accent direction. See docs/design/research/SIMPLE.md
("warm-monochrome restraint, dot-only color, hairline-everything"). -->

## Concept

A warm-monochrome foundation — ivory in light mode, anthracite in dark — with a single restrained deep-slate accent (bone in dark mode). Pastels never become surfaces; they appear only as ~8–14% washes on status pills and focus states. Value (not hue) carries hierarchy, so the UI feels like a precision instrument rather than a painted dashboard. <!-- TODO(founder): confirm this rewritten concept statement matches your current intent. -->

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

<!-- TODO(founder): FLAG — entire section below describes the retired sky-blue palette
(`#2E6FE6` / `#5AA9FF` / cool charcoal neutrals). The shipped palette is warm-monochrome
(deep slate `#3F4147` in light, bone `#BFB7A8` in dark, warm ivory / anthracite neutrals).
The "quiet horizon / cool-bias neutral" narrative no longer applies. Rewrite this section
to explain the value-over-hue rationale (see docs/design/research/SIMPLE.md). Leaving
original prose below for reference until rewritten. -->

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

<!-- TODO(founder): FLAG — every ratio in both tables below was computed against the
retired sky-blue palette (`#0B1220` fg, `#2E6FE6` accent, `#E8ECF2` fg on `#0F1318`,
etc.). None of these pairings exist in the current warm-monochrome implementation.
Recompute all ratios using the live values: light fg `#1A1815` on bg `#FBFAF7` / card
`#FFFFFF` / elevated `#F4F2EE`; dark fg `#F0EDE8` on bg `#161412` / card `#1F1D1A` /
elevated `#2A2724`; accent `#3F4147` (light) / `#BFB7A8` (dark) with `--wp-on-accent`
text. Tables retained below for structural reference only — values are STALE. -->

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

<!-- TODO(founder): FLAG — first bullet still references aviation/sky-fade imagery,
which is no longer the design language. Update to reflect warm-monochrome direction. -->

- **Not gradient-driven.** No accent gradients on buttons, no sky-fade backdrops, no aurora effects. Aviation is referenced through hue choice and naming intent, not through literal sky imagery. The moment we add a gradient we cross from "Apple-restrained" into "marketing site."
- **Not glassmorphism.** No `backdrop-filter: blur()` surfaces, no translucent navigation bars. These look great in screenshots and degrade poorly across browsers, GPUs, and accessibility modes (forced-colors, reduced-transparency).
- **Not glow / neon.** No `box-shadow` with coloured spread on focus or hover. Focus is a solid ring at `--wp-accent-focus`, full stop.
- **Not multi-accent.** One accent. Info is deliberately a *desaturated* sibling of accent, not a second brand colour. We do not have a "secondary brand colour."
- **Not high-saturation pastels.** Tints are derived as low-opacity overlays of the semantic colour against the surface — not hand-picked pastel hexes. This guarantees they harmonise with each surface layer instead of fighting it.
- **Not dark = inverted-light.** The dark palette was tuned independently (background-card lift, accent re-hued for dark legibility, button text inverted on accent fills). It is a peer of the light palette, not a derivation.
