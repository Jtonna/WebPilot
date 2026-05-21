# WebPilot Elegance Spec (non-color visual craft)

> Scope: typography, spacing, sizing, borders, shadows, icons, motion, composition, responsive behavior. Color is defined separately.
> Audience: power-users / developers who care about craft.
> Goal: an Apple-grade, quiet, premium feel for the local web UI at `http://localhost:<port>/ui`.
>
> Related docs: [`PALETTE.md`](./PALETTE.md) (color tokens), [`UX.md`](./UX.md)
> (information architecture, per-page composition), and the design-research
> siblings [`research/APPLE.md`](./research/APPLE.md),
> [`research/LUXURY.md`](./research/LUXURY.md),
> [`research/SIMPLE.md`](./research/SIMPLE.md).
>
---

## Concept

WebPilot is a local-first developer tool. The UI should feel like a settings pane in macOS Ventura — confident, quiet, and well-spaced — not like a SaaS dashboard. We lean on generous whitespace, a single restrained type family, and **hairline-everything** card edges (a 1px `--wp-separator` border on every panel surface, no shadow). Motion is slow enough to feel deliberate and short enough to never be in the way. Every screen earns its content; nothing decorates.

---

## Typography

### Lead font: **Geist Sans** (Vercel, by Basement Studio — free, Google Fonts, OFL)

Geist is the most disciplined humanist sans on Google Fonts right now. Its lowercase has the calm proportions of SF Pro, its numerals are tabular by default (essential for ports, PIDs, agent IDs), and its lighter weights stay legible at small sizes — which lets us hold the page together with very few weights. We deliberately avoid Inter (overused, slightly noisy at display sizes) and the system stack (inconsistent across OS).

### Mono font: **Geist Mono**

Same family system as the sans, so vertical rhythm and x-height align when mono is inlined next to body text (e.g., a port number inside a sentence). Tabular by default, no ligatures enabled by default (we are not a code editor).

### Type scale

All values in `rem` (1rem = 16px) with px equivalents in comments. Use these and no other sizes.

| Token            | Size              | Weight | Line height | Letter spacing | Usage                                  |
| ---------------- | ----------------- | ------ | ----------- | -------------- | -------------------------------------- |
| `display`        | 2rem (32px)       | 500    | 1.2         | -0.015em       | Page hero / `h1`                       |
| `section` (`h2`) | 1.25rem (20px)    | 500    | 1.3         | -0.01em        | Section heading                        |
| `subsection`     | 1rem (16px)       | 600    | 1.4         | -0.005em       | Card title / `h3`                      |
| `body`           | 0.9375rem (15px)  | 400    | 1.55        | 0              | Default reading text                   |
| `body-strong`    | 0.9375rem (15px)  | 500    | 1.55        | 0              | Inline emphasis (never bold-700)       |
| `small`          | 0.8125rem (13px)  | 400    | 1.5         | 0.005em        | Captions, metadata, helper text        |
| `micro`          | 0.75rem (12px)    | 500    | 1.4         | 0.02em         | Status pills, table column headers     |
| `mono`           | 0.875rem (14px)   | 400    | 1.5         | 0              | Inline code, ports, IDs, paths         |
| `mono-small`     | 0.8125rem (13px)  | 400    | 1.4         | 0              | Mono in tables / dense lists           |

### Weights used (restraint)

- **Sans**: 400 (regular), 500 (medium), 600 (semibold for card titles only). Never 700+. Apple uses two weights on most screens — we use at most three.
- **Mono**: 400 only. If you ever need emphasis on a mono string, change its background or color, not its weight.

### Font features

- `font-feature-settings: 'ss01', 'cv11', 'tnum'` on the body. Tabular numerals everywhere; the alternate single-storey `a` in Geist's `ss01` reads closer to SF Pro.
- `-webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;`

---

## Spacing system

Base unit **4px**. The full scale, named:

| Token   | Value | Typical use                                                       |
| ------- | ----- | ----------------------------------------------------------------- |
| `s-1`   | 4px   | Icon-to-label gap, between inline tag and its number              |
| `s-2`   | 8px   | Inside-pill padding, tight stack of related labels                |
| `s-3`   | 12px  | Form field internal spacing, gap between sibling small controls   |
| `s-4`   | 16px  | Default text block gap, card content stack gap                    |
| `s-5`   | 24px  | Card padding (default), gap between cards in a grid               |
| `s-6`   | 32px  | Between card and surrounding section, sidebar inner padding       |
| `s-7`   | 48px  | Between major page sections (`<section>` separators)              |
| `s-8`   | 64px  | Top padding of a page hero, bottom margin of the page             |
| `s-9`   | 96px  | Large empty states, marketing-style page intros                   |

**Rules**

- Never use a non-token value. If you reach for 10px or 18px, you are wrong — round to the nearest token.
- The default vertical rhythm between dissimilar siblings is `s-5` (24px). Between similar siblings (rows in a list) it's `s-3` (12px).
- A page always opens with `s-8` (64px) of top padding on desktop, `s-6` (32px) on mobile.

---

## Sizing tokens

### Card padding

- `card-pad-sm` 16px — dense list rows, sidebar items
- `card-pad-md` 24px — default
- `card-pad-lg` 32px — hero card, empty states, settings group containers

### Buttons

- Height: **32px** (default), **28px** (compact, table rows), **40px** (primary CTAs only)
- Horizontal padding: **12px** (default), **10px** (compact), **16px** (CTA)
- Icon-only button: square at the button's height
- Minimum touch target on mobile: **44px** (we add padding around the visual, not size up the button itself)

### Inputs

- Height: **36px** (default), **44px** (mobile)
- Horizontal padding: **12px**
- Multiline / textarea inner padding: **12px**

### Icon sizes

Be opinionated — use only these:

- **16px** — inline within body text, inside small buttons, table cells
- **20px** — sidebar nav, default button icon, input affixes
- **24px** — page hero icon, mobile top-nav, empty-state illustrations
- **32px** — onboarding / empty-state hero icon only

No 12px (illegible at Phosphor's regular weight), no 28px (off-rhythm), no 40px+.

### Container widths

- Page content max-width: **1120px**, centered, with `s-6` (32px) horizontal gutter on desktop and `s-4` (16px) on mobile.
- Reading-prose max-width (settings descriptions, docs-style copy): **640px**.
- Modal: **480px** default, **640px** large, **min(92vw, 720px)** on mobile.

---

## Borders & radii

### Radius tokens

| Token         | Value  | Applied to                                                |
| ------------- | ------ | --------------------------------------------------------- |
| `radius-xs`   | 4px    | Tags, status pills (when not full pill), inline code      |
| `radius-sm`   | 6px    | Buttons (default), inputs, small interactive chips        |
| `radius-md`   | 10px   | Cards, sidebar nav items (active state), table containers |
| `radius-lg`   | 14px   | Modals, popovers, settings group cards                    |
| `radius-xl`   | 20px   | Onboarding panels, very large feature cards               |
| `radius-pill` | 999px  | Status indicators, toggles, avatar wrappers               |

Rule of thumb: a container's radius should be larger than the radius of its children, but never by more than 4px. Nested radii that don't follow the "outer + 4" rule look amateur.

### Borders — the hairline-everything philosophy

The shipped direction (adopted from `research/SIMPLE.md`) is **hairline-everything**: every card-shaped surface gets a 1px `--wp-separator` border, no shadow. `.wp-card` in `app/globals.css` is the canonical example — `background: var(--wp-bg-card); border: 1px solid var(--wp-separator);` and nothing else. The hairline defines the edge; the warm-monochrome value-step between `--wp-bg` and `--wp-bg-card` (ivory → pure white in light, near-black → first-elevation in dark) provides the secondary cue. We do not stack tonal-lift *and* shadow on the same surface — that's the SaaS-card move we're explicitly rejecting.

**When to use a border**

- Every card on the canvas — panel surface plus 1px `--wp-separator`. No `elev-1` shadow.
- Inputs and selectable controls — borders here are a usability signal ("this is interactive") as well as an edge.
- Table row dividers — horizontal hairlines, never vertical column dividers.
- Popovers and menus — outermost 1px frame plus `elev-2` (the one place shadow stacks on hairline, because the surface is floating off the canvas).

**When to skip the border**

- Sections within a card (use spacing).
- Buttons and tabs at rest (hairline appears only on hover for ghost variants).
- Page-level chrome inside a card (the card edge already terminates the region).

### Border weight

- All borders are **1px solid** at the device level (no half-pixels, no double-borders).
- Default border opacity is roughly **8%** of the foreground in light mode, **12%** in dark mode (defined in the color spec). Hover lifts opacity by ~50% of itself — never by a new color.
- Focus rings are **2px** offset by 2px, using the accent color (color spec) — they replace the border, never stack on top of it.

---

## Shadows

Apple's signature feel comes from **stacking two shadows**: a tight, near-black inner shadow at small offset for crispness, and a wider, soft, low-opacity shadow for depth. We adopt that.

### Light mode tokens

```css
--elev-0: none;
--elev-1:
  0 1px 1px rgba(15, 17, 21, 0.04),
  0 2px 6px rgba(15, 17, 21, 0.05);
--elev-2:
  0 1px 2px rgba(15, 17, 21, 0.06),
  0 8px 24px rgba(15, 17, 21, 0.08);
--elev-3:
  0 2px 4px rgba(15, 17, 21, 0.08),
  0 16px 40px rgba(15, 17, 21, 0.12);
```

### Dark mode tokens

In dark mode, shadows do less work (less perceived contrast against a dark canvas); we keep them present but reduce blur and rely more on the background-lift token from the color spec.

```css
--elev-0: none;
--elev-1:
  0 1px 1px rgba(0, 0, 0, 0.4),
  0 2px 4px rgba(0, 0, 0, 0.25);
--elev-2:
  0 2px 4px rgba(0, 0, 0, 0.5),
  0 8px 20px rgba(0, 0, 0, 0.35);
--elev-3:
  0 4px 8px rgba(0, 0, 0, 0.55),
  0 16px 32px rgba(0, 0, 0, 0.45);
```

### Where each applies

- `elev-0` — buttons, inputs, table rows, sidebar items at rest, **and cards on the canvas** (cards lift via hairline + warm-neutral value-step, not shadow).
- `elev-1` — hovered buttons. Reserved for transient interactive feedback; not used as a resting card state under the hairline-everything direction.
- `elev-2` — popovers, dropdown menus, toast notifications.
- `elev-3` — modal dialogs, drag-preview chips.

**Rule**: never combine `elev-2` and `elev-3` on adjacent nested surfaces. A modal at `elev-3` should not contain a shadowed child — inside the modal, child surfaces drop back to `elev-0` and rely on hairlines + spacing.

---

## Icons (Heroicons)

**Library:** [`@heroicons/react`](https://heroicons.com) — the 24×24 set. We import the **outline** variant by default and swap to the **solid** variant on the single active sidebar item to mark state (one quiet "lit candle" per screen, no color rule needed). We never mix in mini (20px) or micro (16px) Heroicons sets — visual weight stays uniform across the chrome.

**Color:** icons inherit `currentColor`. They live in the type system — never tinted independently of their surrounding text.

**Standard sizes:** 16 / 20 / 24 / 32. See sizing tokens above for which-where. Heroicons are authored at 24×24 but scale cleanly at all four sizes when rendered as inline SVG.

**Icon catalog** (the working set — add to this list with intent, not by reflex). Names below are the Heroicons React component names; both outline and solid variants are imported:

| Surface                    | Heroicons React component (`@heroicons/react/24/{outline,solid}`) |
| -------------------------- | ----------------------------------------------------------------- |
| Dashboard / Home           | `HomeIcon`                                                        |
| Pairings (pending)         | `KeyIcon`                                                         |
| Profiles                   | `UserCircleIcon`                                                  |
| Paired agents              | `CpuChipIcon`                                                     |
| Sites                      | `GlobeAltIcon`                                                    |
| Formatters                 | `CommandLineIcon`                                                 |
| Settings                   | `Cog6ToothIcon`                                                   |
| Mobile nav toggle          | `Bars3Icon`                                                       |

---

## Motion

### Easing curves

- `ease-quart-out`: `cubic-bezier(0.25, 1, 0.5, 1)` — default for entrances and most state changes. Snappy at start, settles softly.
- `ease-quart-in-out`: `cubic-bezier(0.76, 0, 0.24, 1)` — for state-to-state transitions on persistent elements (a panel sliding open).
- `ease-spring-soft`: `cubic-bezier(0.34, 1.3, 0.64, 1)` — sparingly, only for things appearing for the first time (modal mount, toast slide-in). Slight overshoot under 1.05× — never more.

### Duration tokens

| Token         | Value  | Used for                                                       |
| ------------- | ------ | -------------------------------------------------------------- |
| `dur-instant` | 80ms   | Hover background tone shifts, focus ring fade-in               |
| `dur-quick`   | 180ms  | Button press feedback, checkbox/toggle state change            |
| `dur-normal`  | 240ms  | Popover open, dropdown open, sidebar reveal on mobile          |
| `dur-slow`    | 400ms  | Modal mount, route transition fade, large layout reflow        |

Anything wanting longer than 400ms is wrong — make it shorter or remove it.

### The two motion principles we commit to

1. **Fade + small translate. Never scale, never rotate.** Entering content fades from 0 → 1 over `dur-normal` and translates 6px → 0 along the appropriate axis. Modals come from `translateY(8px)`; popovers from `translateY(-4px)`; sidebar (mobile) from `translateX(-12px)`. Outgoing content fades only — no translate on exit (prevents jarring "throw").
2. **Motion is per-element, not per-page.** We do not slide whole pages. Route changes cross-fade content over `dur-slow`; chrome (sidebar, header) does not move.

### Reduced motion

Wrap every transition/animation in a `@media (prefers-reduced-motion: reduce)` override that collapses durations to 0ms and disables translate (opacity-only transitions stay, capped at 80ms — they're informative, not decorative).

---

## Composition rules

1. **One accent per screen.** A page may use the accent color in exactly one place — the primary CTA, or the active nav item, but not both at the same focal weight. The shipped active-nav treatment (`.wp-nav-item.is-active` in `app/globals.css`) is the **solid Heroicons variant + `--wp-bg-elevated` fill + 3px `--wp-fg` left-edge bar** — no accent tint, no hue change. The primary CTA gets the deep-slate (light) / bone (dark) accent fill with `--wp-on-accent` text. Everywhere else is neutral.
2. **No nested cards more than one level deep.** A card may contain a list, a form, or a table — never another card. If you feel the need to nest, you need a divider and spacing instead.
3. **Every page opens with a quiet `h1` (`display` token) followed by a 1-sentence lede in the secondary text color.** Then `s-7` (48px) of breathing room before the first card. No banners, no breadcrumbs above the `h1` on top-level pages.
4. **Mono is for facts, sans is for prose.** A port number, agent ID, file path, or pairing code is mono. A description of what that code means is sans. Never the reverse, never both at once.
5. **Empty states have one line, one icon at 32px, and at most one action.** No illustration art, no marketing copy. Example: *"No pending pairings."* + small "Learn how pairing works" link below.
6. **Tables breathe.** Row height = 44px minimum. Column headers in `micro` token, uppercase, letter-spaced. No zebra striping (it fights our background-lift system); use 1px row dividers at low opacity instead.

---

## Responsive breakpoints

| Name      | Min width | Notes                                                         |
| --------- | --------- | ------------------------------------------------------------- |
| mobile    | 0         | Default. Single column. Sidebar collapses to top nav.         |
| tablet    | 720px     | Two-column card grids appear. Sidebar still collapsed.        |
| desktop   | 1024px    | Persistent left sidebar (240px). Content area gets `s-6` pad. |
| wide      | 1440px    | Sidebar grows to 280px; content max-width caps at 1120px.     |

### What changes at each step

- **mobile → tablet**: card grids go from 1 → 2 columns. Page horizontal padding goes from `s-4` (16px) to `s-5` (24px). Modal width changes from `min(92vw, 720px)` to the 480/640 tokens.
- **tablet → desktop**: top nav is replaced by a left sidebar (`Drawer` shape, 240px wide, `card-pad-md` internal padding). Card grids go to 3 columns where appropriate. Page horizontal padding to `s-6` (32px).
- **desktop → wide**: sidebar widens to 280px; content stays capped at 1120px (extra space becomes outer margin). No new columns appear — we resist density.

The mobile top-nav is a single horizontal bar at 56px height with the WebPilot wordmark on the left, a `List` icon on the right that opens a full-height drawer at 80vw width. The drawer animates from `translateX(-12px)` over `dur-normal`.

---

## Light vs. dark adaptation

Beyond raw color swaps, the two modes differ in feel:

- **Hairlines do the work in both modes; shadows are reserved for floating surfaces.** Cards on the canvas use `1px var(--wp-separator)` and nothing else, in both light and dark. Shadows (`elev-2` / `elev-3`) appear only on popovers, menus, and modals — surfaces that are genuinely floating above the page.
- **Hairline opacity is tuned per mode.** Light mode `--wp-separator` is `rgba(26, 24, 21, 0.08)`; dark mode is `rgba(240, 237, 232, 0.10)`. Strong variants (`--wp-separator-strong`, used for input borders and header rules) sit at 0.14 / 0.16. Both modes keep the edge readable without making it a "ruled line"; the warm-neutral surfaces underneath are doing the heavier hierarchy work.
- **Three tone steps in dark, three in light.** Both modes ship a canvas / card / elevated triad (light: `#FBFAF7` / `#FFFFFF` / `#F4F2EE`; dark: `#161412` / `#1F1D1A` / `#2A2724`). The dark triad is read as "background → card → hover", the light triad as "background → card → hover/selected". `research/SIMPLE.md` (around line 328) recommended keeping the dark layering; the shipped CSS does that, with the light side getting an equivalent three-step structure rather than the originally proposed single-canvas approach.
- **Icons stay at Regular weight in both modes.** No "bolder in dark, lighter in light" tricks — we trust the color spec to handle perceived weight.
- **Focus rings get slightly thicker in dark mode (2.5px vs 2px) because the accent-against-dark contrast feels visually thinner.** Same offset.

---

## What this language is NOT

- **Not neumorphism.** No soft inset-shadow controls, no extruded buttons. Our buttons are flat surfaces that lift on hover via background and `elev-1`.
- **Not glassmorphism.** No backdrop-blur on cards or sidebars. We considered it; it dates instantly and tanks performance on lower-end machines this app must run well on.
- **Not drop-shadow-everywhere.** Most elements are `elev-0`. Lift is reserved for things that are genuinely floating (popovers, menus, modals).
- **Not box-every-region.** Hairline-everything applies to **card-shaped surfaces** — the regions that are conceptually a panel. We still do not box the page chrome, the sidebar, sections inside a card, or button groups at rest. The point is one consistent hairline language for panels, not a 1px grid of ruled rectangles everywhere.
- **Not display-italic fonts, not serif accents, not mixed font families.** One sans, one mono, both Geist. The discipline is the point.
- **Not monospace as a lead font.** Tempting for a developer tool, fights legibility for long-form copy in settings descriptions.
- **Not bold-700 anywhere.** Medium (500) is our heaviest weight. Heavier than that reads as shouting against this much whitespace.
- **Not gradients.** No background gradients, no gradient borders, no gradient text. A single accent color, used sparingly, does the work.
- **Not motion-as-decoration.** Nothing scales, nothing rotates, nothing wiggles, nothing has a stagger longer than 40ms between siblings. Motion is functional and short.
