# Luxury UI research for WebPilot

> Lens: **luxury / high-end / "made by people who care."** Companion briefs cover Apple
> and Simple/minimal. Where this one disagrees with them, the disagreement is on purpose —
> the team lead will reconcile.
>
> Reference frames: Patek Philippe product pages, Hermes.com negative space, Carta cap-table
> hierarchy, Anduril Lattice console restraint, Apple Pro apps (Final Cut, Logic), Linear at
> its most disciplined, Things by Cultured Code, Notion Calendar / Cron, Granola.

---

## What "luxury" looks like in digital UI

**1. Restraint reads as confidence.** Luxury UIs use fewer colors, fewer fonts, fewer
weights, fewer surfaces than they could. A Patek Philippe product page is mostly
photograph + one sentence + one button — the absence is the message. WebPilot should
feel like an instrument that doesn't need to advertise itself.

**2. The neutrals do the work.** Premium UIs are built on a precisely tuned neutral
spine — anthracite, paper, ivory, oxidized steel — and an accent that appears maybe
twice per screen. The neutral is the *material*; the accent is the *signal*. Most
mass-market SaaS gets the accent right and the neutral generic; luxury inverts that.

**3. Hierarchy is editorial, not modular.** A luxury screen has one hero, one supporting
zone, and a footer of dense reference data — the structure of a Financial Times article,
not a Bento grid. The eye knows where to land. Carta, Anduril Lattice, and Apple's
Final Cut inspector pane all share this: oversized titling typography sitting above
tightly packed tabular data, with breathing room between.

**4. Density is earned, not feared.** Luxury isn't "more whitespace everywhere" —
that's marketing-site luxury. A Rolex spec table is dense; a Hermes landing is sparse.
The trick is *contrast between* zones: a serene hero next to a compact spec block.
WebPilot's status data (PIDs, ports, profile dirs) deserves to be dense and beautiful,
not hidden.

**5. Material, not decoration.** Surfaces feel like materials: paper, anodized
aluminum, glass-against-felt. This is achieved with extremely subtle tonal steps
(1–3% luminance shifts), one well-placed hairline, and shadows that behave like
real light — not with gradients, glows, or ornament. Apple Pro Display XDR's UI
chrome is the reference.

---

## Where the current redesign falls short of luxury

**1. The accent is generic-tech blue.** `#2E6FE6` / `#5AA9FF` is a competent
Apple-systemBlue derivative. It reads "Stripe, Linear, GitHub, Vercel" — which is
*good*, but it's the same blue every developer tool has had since 2019. Luxury wants
an accent that feels *rare*: an oxidized brass, a deep oxblood, a single warm
champagne, or — best for this product — **a near-black ink with a single restrained
metallic ember**. The current accent is the most replaceable token in the system.

**2. The neutrals are clinical, not material.** `#F7F8FA` / `#0F1318` are correct
greys; they're also greys you've seen on every dashboard. Luxury neutrals have a
*direction*: Hermes uses warm paper-ivory; Anduril uses cold gunmetal; Patek uses
near-black with a faint green-brown undertone. The current palette is undirected —
"neutral cool grey" — which reads as competent but anonymous. The doc itself calls
the bias "named nowhere" and frames that as discipline; from a luxury lens, it's a
missed opportunity to give the brand a temperature.

**3. The sidebar is functional, not crafted.** The current sidebar spec (240px,
filled-pill active state, wordmark top, connection dot bottom) is correct Linear/Vercel
school. But luxury sidebars do more: they treat the rail as a **brand moment** —
a vertical column of identity — and they reward the user for looking at it
(secondary metadata, a quiet stat, a typeset wordmark with a hairline beneath).
Right now the sidebar is the least considered surface in the spec.

**4. The Dashboard is too humble for a hero.** The UX spec opens the Dashboard
with `Dashboard` h1 + subtitle and goes straight to action items. That's Apple
System Settings, which is correct for the "trust console" framing. But a luxury
Dashboard would invest *one* moment in stillness: a hero that frames the
instrument itself — "WebPilot · paired to 2 agents · since May 13" — before the
work begins. Editorial, not utilitarian.

**5. Status pills carry too much color.** Six tinted pills (success/warning/danger/
info/accent + the neutral) is a 2018 dashboard convention. Luxury reads color as a
rare event. Patek doesn't have six status badges — it has typography and a single
dot. WebPilot has at most three real states (Active / Ready / Needs setup); they
should feel like a single typographic system with one accent dot, not a rainbow.

---

## Recommendations

### Palette refinements

**Single recommendation: anthracite-and-ember.** Shift the entire palette
warmer-and-darker in dark mode, warmer-and-quieter in light mode, and replace
the cool sky-blue accent with a restrained **warm metallic ember** that reads as
"machined brass under shop light" rather than "shiny gold."

**Light mode (paper-ivory + ink):**

| Token | Current | Proposed | Why |
|---|---|---|---|
| `--wp-bg` | `#F7F8FA` (cool off-white) | `#F5F2EC` (paper ivory) | Warm undertone gives the canvas a *material* identity. Reads as fine stationery, not screen-grey. |
| `--wp-bg-card` | `#FFFFFF` | `#FCFAF6` (ivory white) | Cards are still the lighter surface, but they belong to the same warm family. No more clinical pure-white. |
| `--wp-bg-elevated` | `#FFFFFF` | `#FFFEFB` | Popovers crisp up to near-white, still warm. |
| `--wp-fg` | `#0B1220` (navy ink) | `#1A1612` (sepia ink) | Near-black with a brown-warm cast — the color of fountain-pen ink on cream. AAA on ivory. |
| `--wp-fg-secondary` | `#3C4860` | `#5C544A` (warm graphite) | Same family as primary; the cool blue cast is replaced by a graphite warmth. |
| `--wp-fg-muted` | `#6B7588` | `#8A8276` (warm stone) | Stone instead of slate. |
| `--wp-separator` | `rgba(11,18,32,0.08)` | `rgba(26,22,18,0.06)` | Hairlines softer and warm. |
| `--wp-accent` | `#2E6FE6` (sky-blue) | `#8B6914` (oxidized brass / dark amber) | **The single biggest change.** Pulled from the patina of an aged brass watch case — reads as "machined metal," not "gold gradient." Used identically to today's accent: primary button, active nav, focus ring. |
| `--wp-accent-hover` | `#2560CC` | `#74570F` | Deeper brass. |
| `--wp-accent-tint` | sky-blue @ 10% | `rgba(139,105,20,0.08)` | Selected row reads as faint candle-glow on paper. |

**Dark mode (anthracite + ember):**

| Token | Current | Proposed | Why |
|---|---|---|---|
| `--wp-bg` | `#0F1318` (cool charcoal) | `#16130F` (warm anthracite) | The Anduril/Pro-Display reference: near-black with a warm undertone. Photographs of luxury watch dials live here. |
| `--wp-bg-card` | `#161B22` | `#1F1B16` | Card lift is the same magnitude (~3% luminance) but in the warm direction. |
| `--wp-bg-elevated` | `#1C222B` | `#28231D` | Popovers and modals warmer still. |
| `--wp-fg` | `#E8ECF2` (cool off-white) | `#EDE6D8` (warm parchment) | Off-white with the same parchment cast as the light-mode background — *the two modes echo each other* across the inversion. |
| `--wp-fg-secondary` | `#B4BCCA` | `#B8AE9A` | Warm taupe. |
| `--wp-fg-muted` | `#7E8696` | `#7E7567` | Warm stone, mirror of light mode. |
| `--wp-accent` | `#5AA9FF` (bright sky-blue) | `#D4A547` (warm amber / brass-lit) | The brass *catches the light* in dark mode — slightly lighter, more saturated than the light-mode brass, but still nothing close to chrome-gold. Think: lit candle through whisky. |
| `--wp-accent-tint` | sky-blue @ 14% | `rgba(212,165,71,0.10)` | Selected row reads as warmth from a desk lamp. |

**Semantic colors** (success / warning / danger / info): **desaturate further** and
keep them current cool/neutral. The accent already carries the warm signature; the
semantic colors should retreat. Current values are roughly correct in magnitude;
just nudge them all -10% saturation so the brass accent stays the rare warm event.
Specifically: Info should be *removed as a named color* and folded into
foreground-secondary — there is no luxury UI with a "neutral notice" color that
isn't the accent.

**Why brass and not navy, oxblood, or hunter-green:** All three were considered.
Navy is too close to the existing sky-blue and to every fintech brand. Oxblood
reads as "wine bar" and skews feminine-luxury, wrong register for a developer
tool. Hunter green codes "old money / private bank," which is closer but too
nostalgic. Brass on anthracite is the *workshop-luxury* register — Leica, Patek
movement plates, Anduril console accents — which is exactly the register WebPilot
should occupy: a precision instrument, not a salon.

**Contrast preservation:** The proposed brass values were chosen to clear AA on
their surfaces. `#8B6914` on `#FCFAF6` ≈ 5.4:1 (AA text). `#D4A547` on `#16130F`
≈ 8.9:1 (AAA). Dark-mode primary button uses `#16130F` text on the `#D4A547`
brass fill — same near-black-on-light pattern Apple uses for systemBlue in dark.

---

### Sidebar redesign

The current sidebar is **a list of five links**. The luxury version is
**a vertical column of brand + crafted state**, divided into three editorial zones
with hairline separators between them. Width stays 240px (280px at `wide`).

**Proposed structure (top to bottom):**

```
+--------------------------+
|                          |  s-6 top breathing
|  W E B P I L O T         |  Wordmark, letter-spaced, sepia-ink
|  ─────                   |  4px brass hairline beneath, 24px wide (signature mark)
|  Local control panel     |  Tagline in micro token, fg-muted
|                          |
+-- s-5 spacer ------------+
|                          |
|  Dashboard               |  Nav. Phosphor Regular icon, body-strong label.
|  Pairings           (2)  |  ONE numeral allowed: pending-pairings count in
|  Profiles                |  fg-muted at the right edge. No badge bubble.
|  Agents                  |
|  Settings                |
|                          |
+-- hairline -- s-5 -------+
|                          |
|  Quick actions           |  Section title in micro, uppercase, letter-spaced
|                          |
|  Pair a new agent  →     |  Single-line buttons, ghost style, body weight
|  Launch Chrome     →     |  Available only when contextually meaningful
|  Open log file     →     |  (e.g., Launch hidden if Chrome already running
|                          |   with flag)
+-- hairline -- s-5 -------+
|                          |
|  Session                 |  Section title in micro, uppercase
|                          |
|  Chrome   ● running      |  Three rows of dense reference data,
|  Server   ● localhost    |  small token, mono for the value where appropriate.
|  Uptime   2h 14m         |  This is the "watch movement under the dial" —
|                          |  the user is rewarded for looking.
+-- pushed to bottom ------+
|                          |
|  ● Connected             |  Existing status dot, fg-secondary
|  v0.5.4 · localhost:3456 |  micro, fg-muted, mono for the port
|                          |  s-5 bottom breathing
+--------------------------+
```

**The extra options, justified:**

- **Brand moment at the top (wordmark + hairline + tagline).** A 4px-wide brass
  hairline beneath the wordmark is the *one* place the accent appears unprompted
  by user state. It signs the rail. Equivalent to the bezel-engraving on a luxury
  watch — present, restrained, immediately readable as identity. The tagline
  ("Local control panel") gives the user a one-line answer to "what is this?"
  that the current spec answers nowhere.

- **Single pending-pairings numeral on the Pairings nav row.** The UX spec
  forbids badge bubbles ("create permanent visual noise") — correct rejection
  of the wrong thing. But a *typeset* numeral aligned to the right edge in
  `fg-muted`, e.g. `Pairings        (2)`, is the luxury equivalent: it's the
  same information without the playground-red dot. Disappears when zero.

- **Quick actions block.** Three context-aware action links. They appear only
  when they would do something — "Launch Chrome" is hidden when Chrome is
  already running with the flag. This rewards the user for being in the app:
  the rail *knows the state of the machine* and offers exactly the one or two
  things worth doing right now. Anduril Lattice does this with its left-rail
  "Available actions" pane; Linear does a quieter version in its command bar.
  For a developer tool, having these one click away is real value, not
  ornament.

- **Session block.** Three rows of facts (Chrome, Server, Uptime). This is the
  "watch movement" — dense, typographically considered, monospace where
  appropriate, totally honest about the underlying system. The user can glance
  here and know everything important without going to Settings → Server.
  Crucially, this is **read-only**; no controls. It is the dial face, not a
  button.

- **Footer kept minimal.** The existing connection dot + label stays. Version
  and bind address sit beneath it in micro, mono for the port. The UX spec
  forbids port/PID in the footer; the luxury lens disagrees specifically for
  the *port* and *version*, because for a localhost server tool the port *is*
  the address you give to clients — it's not trivia, it's the most-copied
  string in the app. Putting it in the sidebar makes it always-reachable
  without taking a click.

**Active state:** Drop the filled-pill background. Use instead a **2px brass
hairline on the LEFT edge of the row** (the row stretches into the rail's left
inner padding to meet it), with the icon swapping to Phosphor Duotone and the
label going to weight 500. This is the watch-dial hour-marker treatment:
precise, metal, single-color. The filled-pill is correct Linear; the hairline
is correct luxury.

**Hover:** Background lifts by one tonal step (warm anthracite → next step warm
brown). No accent on hover — accent is reserved for *selected*. Hairline does
not appear on hover; it is the signature of "you are here."

**Hairlines between zones:** 1px, `--wp-separator` opacity, **20px wide rather
than full-width** (left-aligned to the nav column's text indent). Inset
hairlines read as editorial section breaks rather than fence-rails. This is the
Patek/FT move.

---

### Page composition refinements

The current UX spec opens every page with `<h1>` + 1-line subtitle + `s-7` of
breathing room. That is correct Apple. The luxury upgrade is to **invest one
editorial moment per page**, then return to Apple discipline. Per-page:

**Dashboard — the instrument frame.**
Replace the current `<h1>Dashboard</h1>` + subtitle with a two-line **editorial
header**:

- Line 1 (`display` token, sepia ink, letter-spaced -0.02em):
  `WebPilot.` (just the wordmark as title, with the period — a Patek/Hermes
  signature move; the period says "we know what we are").
- Line 2 (`body`, `fg-secondary`):
  `Paired with 2 agents · since May 13 · localhost:3456`.

This is the only place in the app where the wordmark appears as a title; on
every other page the page name is the `<h1>`. Then `s-8` (64px) of breathing
room and the existing Action items / System status cards follow exactly as
the UX spec defines them. The cards themselves don't need to change — they
just need this *moment* above them to feel like the front of an instrument
manual rather than a settings page.

**Pairings — the ledger.**
Treat the History section like a fine-print ledger: row dividers as 1px
warm-stone hairlines, oversized timestamps in mono on the right, decision pill
replaced by a **single brass dot for approved, hollow circle for denied** and
the word `approved` / `denied` typeset in micro caps next to it. No green/red
fills. The page header stays editorial-simple (`Pairings` h1 + subtitle). The
luxury move here is the dignity of the table — Carta cap-table school.

**Profiles — the cabinet.**
Each profile row is a wider, more generous card-row with three columns:
display name (sans, body-strong), Google email + warm-stone monospace directory
(stacked sub), status dot + label. Drop the colored status pill backgrounds
entirely — use only the brass-dot / hollow-circle / amber-dot single-pixel
indicator. The `+ New sandbox profile` section gets promoted into a **full-bleed
panel with a one-sentence intro in `display` weight 500**: `New sandbox
profile.` (with the period), then the input and button beneath. This is the
Hermes-product-page move applied to a CRUD form — a moment of stillness on a
utility action.

**Agents — the key ring.**
Lead with a one-sentence editorial header in `subsection` size beneath the
`<h1>`: `Two agents currently hold keys to this machine.` (dynamic count.)
Then the list. Each agent row gets *more* vertical breathing room than the UX
spec calls for — 64px row height rather than 44px — because each row represents
a trust grant, and trust deserves space. Last-active timestamps in mono, brass
dot if active within the last hour. The "Manual setup snippets" collapsible
title gets a hairline above it (20px inset, left-aligned) — the editorial
section break.

**Settings — the spec sheet.**
This is the page where luxury restraint matters most and the existing UX spec
is already very close. Two refinements:

1. Each Settings card gets an oversized section label in `section` token (20px)
   to the *left* of the card on desktop (wide breakpoint and up), with the
   card content to its right — the two-column "label-then-spec" layout of a
   Patek movement spec sheet. On smaller breakpoints it stacks. This gives
   Settings the dignity of a reference document.
2. The About card at the bottom gets one editorial line at the very bottom of
   the page, centered, micro, fg-muted: `WebPilot · made for local-first
   work · v0.5.4` — the colophon of a printed manual.

**Across all pages:** Establish a **single editorial footer line** that appears
beneath the page's deepest content (above the page's bottom padding), in
`micro`, `fg-muted`, centered. Per-page the text differs (Dashboard: the
welcome / "All clear" line; Pairings: `Last updated · just now`; etc.). This
mirrors the colophon at the foot of a printed page and is one of the
quietest-but-most-immediately-luxury moves available.

---

## Reference snapshot

- **Apple Final Cut Pro inspector pane.** Dense reference data on a warm-anthracite
  surface, oversized hero-typography labels above each block, single accent only
  on the actively edited parameter. The dial-face-with-movement-beneath feel.

- **Carta (cap-table app).** Fintech-luxury done right: large editorial titles
  above extremely dense tables; one restrained accent for the primary action;
  hairlines doing the work that borders usually do; serene whitespace between
  the title block and the data block.

- **Anduril Lattice console screenshots.** Cold warm-anthracite surface, sparse
  warm accent, military-precision typography, three-zone left rail with mission
  identity at the top, action items in the middle, system telemetry at the
  bottom — almost the exact sidebar structure proposed above.

- **Patek Philippe product pages.** The reference for single-image,
  single-button, one-sentence hero composition. The product is the page; the
  page is the product. Periods at the end of sentences. Hairlines instead of
  borders.

- **Things by Cultured Code.** The closest existing *productivity tool* that
  feels expensive without ornament. Warm paper background, sepia-ink type, a
  single warm accent (its blue is actually lifted from old maps — warm
  navy), zero gradients, motion under 200ms. The Apple Design Award winner
  whose visual choices WebPilot can borrow most directly.

---

## What I'm deliberately NOT recommending

- **Gold gradients, embossed buttons, leather textures, glassmorphism, neumorphism.**
  These are pastiche-luxury. The current ELEGANCE.md already correctly forbids
  them. Keep that rejection list verbatim.

- **A serif font for headings.** Tempting (Times Now / GT Sectra in display
  sizes is the canonical 2026 luxury move). Rejected because WebPilot's
  density of mono-formatted facts (PIDs, ports, paths) makes a serif fight the
  rest of the type system. Stay on Geist Sans with tighter letter-spacing and
  the period-after-titles signature; that's enough.

- **Multiple accents (a brass + a navy, for example).** Considered as a way to
  give "active" and "pending" different temperatures. Rejected: violates the
  "one accent" principle. The single brass with a hollow-circle for
  inactive/denied is sufficient.

- **A floating sun/moon theme toggle.** Already correctly placed in Settings →
  Appearance by the UX spec. Don't relocate.

- **An onboarding tour, illustrations of cute robots, animated empty states,
  hero gradients, sparkle effects on success toasts.** All marketing-site
  moves. WebPilot is an instrument; instruments do not celebrate themselves.

- **Renaming "Pairings" to something more crafted ("Authorizations,"
  "Grants").** Considered because "pairings" has Bluetooth-headphones
  connotations. Rejected: the existing terminology is established in the
  product, the MCP tool surface, and the docs; renaming for taste creates a
  rename-cascade that costs more than it earns. Luxury is also knowing not to
  re-letter the dial.

- **Per-row keyboard shortcuts shown as kbd hints in the UI.** Linear-school
  move. Considered. Rejected for v1: the right luxury equivalent is a *single*
  Cmd-K command palette that everything funnels through, not visible
  shortcut-hints peppered across rows. Defer the command palette to a future
  brief.

- **Animated brass-shine accents, gold-leaf hover states, any motion above
  240ms.** Hard no. Brass is *matte-finished machined metal*, not jewelry.
