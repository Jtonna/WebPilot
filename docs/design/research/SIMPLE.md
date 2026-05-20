# Simple / Minimal UI research for WebPilot

> Lens: disciplined-minimal — the Linear / iA Writer / Things / Geist tradition.
> Two sibling briefs cover luxury and Apple. I stay in my lane: clarity at the
> cost of nothing, decoration at the cost of everything.

---

## Disciplined-minimal design fundamentals

1. **Hierarchy by typography and space, not color.** Linear, Things, iA Writer,
   and Vercel Geist all build their visual order from a tight type scale (two
   or three weights) and a strict spacing system. Color is reserved almost
   entirely for the accent and for status semantics. When a designer reaches
   for a tint to differentiate a card, the minimalist reaches for a heavier
   weight on the title or for more whitespace around the block. The result
   reads as confident rather than busy.

2. **One accent, used sparingly and intentionally.** The disciplined-minimal
   accent is closer to a signature than a brand. Linear's purple appears on
   one or two pixels of the active nav and on the primary CTA — nothing else.
   iA Writer's blue is reserved for selection and links. The rule isn't "use
   accent less" — it's "let accent always mean *the same thing*." When accent
   tints appear in multiple roles (CTA + selected row + focus ring + active
   nav + link + status pill), each instance loses meaning.

3. **Negative space is structural, not decorative.** Notion, Cron, and Things
   use whitespace the way a print designer uses margins: to define regions
   without lines. A "section" in minimal UI is rarely a card with a border;
   it's a label and a generous gap above and below. The page is read like a
   document, not parsed like a dashboard.

4. **Restraint about what earns a slot.** Linear has fewer sidebar items than
   you'd expect for an app that complex. Things hides everything that isn't
   "today / upcoming / inbox / someday" behind a small affordance. The
   discipline is to say no to the second-most-useful version of every
   feature, so the most-useful version has room to breathe. Density when
   functionally needed (Linear's issue list); air everywhere else.

5. **Functional density, not aesthetic density.** Minimal does not mean
   sparse. A Linear issue list is dense — many rows per screen. But every
   pixel in that row serves the user's job. Decorative density (zebra
   stripes, vertical column dividers, double borders, bold headers,
   gradient highlights) is what minimal rejects. When density appears, it's
   earned by information value, never by visual richness.

---

## Where the current redesign drifts from disciplined-minimal

1. **Accent is doing too many jobs.** PALETTE.md lists `--wp-accent` as the
   color for: primary buttons, links inline in prose, the selected-nav text
   *and* left border, the focus ring on every focusable element, the
   active-tab underline, selected-list-row tint, and ghost-button hover. Plus
   `--wp-info` is "a desaturated sibling of accent" — which means *two*
   blues in proximity. Linear's accent appears in maybe two of these roles.
   The current spec preserves Apple's permissiveness around system blue; a
   disciplined-minimal lens would prune.

2. **The palette has six semantic colors (accent, success, warning, danger,
   info + neutrals).** Geist, Linear-lite, iA Writer get by with three: a
   single accent, a single danger (used rarely), and the rest carried in
   grayscale. Success-green and warning-amber on status pills add a third
   and fourth hue family that the minimal tradition tends to handle via
   monochrome pills + a single colored dot.

3. **The cool-blue undertone in neutrals is a stylistic flavor, not a
   neutral.** PALETTE.md is explicit: "both `--wp-bg` values are
   deliberately cool" and the foregrounds carry "a faint navy cast." This
   is the *luxury / aviation* angle, not the minimal angle. Disciplined
   minimal tends to be either truly neutral (Geist's near-perfect gray
   ramp) or imperceptibly warm (iA Writer, Things) — never cool. Cool
   neutrals read as "tech product palette" rather than as "calm reading
   surface." It's a great choice for the luxury lens; it's slightly off
   for the minimal lens.

4. **Sidebar lacks structural grouping.** UX.md gives the sidebar five
   flat top-level items (Dashboard, Pairings, Profiles, Agents, Settings)
   with no sections, no dividers, no labels. The user has explicitly
   asked for "more defined" and "extra options" — the current spec
   resists by going flatter. The minimalist answer isn't "add more
   items"; it's "introduce sections so the existing items + a small
   number of new ones read as organized."

5. **Card-heavy page composition.** Settings is described as "multiple
   cards," Dashboard as cards, Profiles as a row card + a "promoted"
   creation card, Agents as cards. Every region is bounded. Notion,
   iA Writer, and Linear's settings pages mostly *don't* use cards —
   they use labeled sections separated by whitespace and the occasional
   hairline. Cards are a SaaS-dashboard idiom; the minimal idiom is the
   document.

---

## Recommendations

### Palette refinements

**Shift to a near-neutral grayscale with one warm-neutral undertone, and
demote `info` entirely.**

Specific moves:

- **Replace cool-blue-tinted neutrals with neutral-or-imperceptibly-warm
  neutrals.** Change `--wp-bg` from `#F7F8FA` (cool) to `#FAFAF9` (a true
  off-white with a barely-perceptible warm cast, the iA Writer / Things /
  Stripe-Docs register). Foreground primary from `#0B1220` (navy cast) to
  `#0A0A0A` or `#111111` — pure ink, no hue. Dark mode: `--wp-bg` from
  `#0F1318` to `#0B0B0C` (true near-black). This removes the "tech product
  cold" feel and brings the surface into the reading-document tradition.

- **Keep the accent, but desaturate slightly.** `#2E6FE6` is fine in
  isolation but reads as "system blue" — it carries strong Apple
  associations. The minimal tradition leans either toward a single
  cooler-but-quieter blue (Linear's `#5E6AD2` indigo, Geist's `#0070F3`)
  or toward an unusual signature hue. I recommend `#3D63DD` (a slightly
  indigo-shifted blue) in light mode, `#7C8FF0` in dark. It still feels
  like a "blue," but it doesn't compete with native macOS controls in
  the user's peripheral vision.

- **Delete `--wp-info`.** A semantic role that's "softer than accent" is
  doing nothing the secondary text color can't do. Notices that need a
  color cue use accent; notices that don't, use `--wp-fg-secondary`. One
  blue, period.

- **Reduce status-pill saturation.** Move success / warning / danger to
  monochrome-pill-plus-colored-dot pattern: pill background is
  `--wp-separator` (neutral gray wash), pill text is `--wp-fg`, and a 6px
  colored dot to the left carries the state. This is the Linear / Things
  pattern. Saves the saturated colors for the few moments they're truly
  needed (danger button, dot, focus).

- **Lower contrast on dividers.** PALETTE.md sets `--wp-separator` at 8%
  in light mode. Drop to 6%. Disciplined minimal trusts the eye to find
  the row break from spacing alone; the line is a whisper, not a rule.

Justification: this triplet of moves (warm-neutral undertone, indigo-leaning
accent, demoted secondary blues) is what makes a UI feel like a
reading-surface rather than a tooling-surface. WebPilot is configuration
that users want to forget about — the palette should reward forgetting.

### Sidebar redesign

The user wants "more defined" + "extra options." The minimalist take:
**introduce two labeled sections plus a status footer; do not add unlabeled
items; resist the temptation to put counts on rows.**

Proposed structure (desktop, 240px wide, no vertical divider rule between
sidebar and content — just background-lift):

```
WebPilot                                     (wordmark, 13px, weight 500, fg-secondary)

  Dashboard
  Pairings
  Agents
  Profiles

  WORKSPACE                                  (8px label, uppercase, letter-spaced, fg-muted)
  Activity
  Logs

  CONFIG                                     (8px label, same treatment)
  Network
  Notifications
  Appearance
  Server
  About

────────────────────────────────────── (hairline, --wp-separator at 6%)
  ● Connected · localhost:3456               (12px, fg-secondary, dot is the only color)
```

Key moves and rationale:

- **One unlabeled section at the top** for the core navigation (Dashboard,
  Pairings, Agents, Profiles). These are the user's mental model — the work
  they do. Order matters: Dashboard first (entry), Pairings second (action
  required), Agents third (their trust list), Profiles fourth (the
  infrastructure beneath). No label above this group — the wordmark is the
  implicit header.

- **A "WORKSPACE" labeled section** for new entries that earn slots: Activity
  (a server-event log viewer — currently deferred but a real power-user ask)
  and Logs (the daemon log file rendered with tail-and-search). These are
  the "extra options" the user wants, but they're *deferred not-shipped*
  features in UX.md. Including them now sets the structural promise.

- **A "CONFIG" labeled section** that explodes the current single Settings
  page into its sub-sections. UX.md already organizes Settings as five
  cards (Appearance, Network, Notifications, Server, About). The minimalist
  move is: **stop hiding them inside a single page**, since the user wants
  more visible options. Each card becomes a sidebar item. This adds five
  visible entries without adding a single new feature — exactly the
  "more defined" feel the user is asking for, achieved by promotion rather
  than invention.

- **Sections use uppercase labels at `micro` token (12px), letter-spaced,
  `fg-muted`, with `s-3` (12px) of space above each section label and `s-1`
  (4px) below.** This is the Linear / Notion / Stripe-Docs pattern. No
  dividers between sections — the label and the whitespace do the
  separation work.

- **What does not earn a slot**: badge counts (the page title `(3)` channel
  is sufficient — keep that from UX.md). A search box (Linear has one;
  WebPilot doesn't have enough navigation to need it). A collapse/expand
  control for sections (always-open is honest; collapse is for things you
  want to hide, which means they shouldn't be in the sidebar). User avatar
  / account switcher (this is a single-user local tool).

- **Footer**: a single line, no card, no border above. Just the dot and the
  connection text in `fg-secondary`. Hover reveals the port as `fg-muted`
  below it. The footer is the only place a colored element appears in the
  resting sidebar.

- **Active state**: solid pill background (`--wp-separator`, the neutral
  wash) on the row. **No accent color on the active item.** This is the
  biggest divergence from Apple-flavored design — disciplined minimal does
  not paint the active nav with the brand color, because then "where I am"
  and "what to click" use the same signal. The active item is *quieter*
  than the rest, not louder. (Linear does it the other way; Things, iA
  Writer, Notion side panel all do it the way I'm recommending.)

### Page composition refinements

The unifying principle: **fewer cards, more labeled sections; let the
page read like a document.**

**Dashboard**

- Drop the System Status card border. The three rows (Chrome / Extension /
  Server) become a label-and-value list separated from the Action Items
  region by `s-7` (48px) of whitespace alone. The h2 `System status` is
  the only structural signal needed.
- Action Items section: keep the inline pairing cards (they have real
  interactive content — that's exactly when a bounded surface is earned).
  But drop the surrounding section card.
- Remove the "Welcome card" gradient/illustration impulse. The truly-empty
  state is just an h1, a one-sentence subtitle, and one inline link to
  `Pair an agent`. No bordered card around it. iA Writer's empty state is
  *the absence of content*, not a styled placeholder.

**Pairings**

- "Awaiting review" and "History" become two labeled sections, h2 each,
  with `s-7` between them.
- History rows are bordered top-and-bottom only by 1px hairlines (no full
  card around each row, no card around the section). Like Linear's issue
  list or a Stripe Docs API reference table. Row height stays at 44px;
  hover sets `background: --wp-separator` (the gray wash) — no accent tint.
- The expand-on-click row reveals its detail *inline within the same row
  block*, indented `s-5` (24px), with `s-3` (12px) of vertical padding —
  no nested card.

**Profiles**

- Same treatment as Pairings: known-profiles list is a hairline-separated
  set of rows, not a card. The `+ New sandbox profile` panel is the **only
  bordered region on the page** — a small bordered block ~360px wide,
  left-aligned, not full-width. The minimalist creation form is a focused
  region within a wider quiet field, not another card in a stack of cards.
- Status pills follow the new monochrome-with-dot pattern.

**Agents**

- The first-time-setup wall-of-content moves into the walkthrough modal
  as planned (UX.md is already right here). The page becomes very quiet
  when populated: an h1, an h2 `Paired agents`, a hairline-separated row
  list, and a small `Pair a new agent →` link in the section header (not
  a primary button) once the user already has at least one.
- "Manual setup snippets" collapsible drops the surrounding card. It's
  a labeled disclosure, not a panel.

**Settings**

- *Removed* — its contents have been promoted into the sidebar (see
  sidebar redesign). Each former card becomes its own page. Each of
  those pages is a single-column document: h1, subtitle, then the
  controls in a label-above-value layout (Linear settings pattern).
  No cards, no panels, no segmented controls within decorative
  containers — just labels, controls, and helper text.
- The About section becomes a small `About` page that's mostly text
  and links — the version, a "Check for updates" button (text link
  styled, not a filled button), and three plain links. Looks like
  iA Writer's About box.

**Cross-page rule**: maximum one bordered region per page. If a region
needs a border, it's because the user is *interacting with structured
data inside it* (the pairing card, the new-profile form). Everywhere
else, replace borders with `s-7` (48px) of vertical whitespace and a
labeled h2.

---

## Reference snapshot

- **Linear** — the closest reference for the sidebar discipline (labeled
  sections, restraint on accent, monochrome-with-dot status). Their
  settings pages are also the model for promoting CONFIG items out of a
  single page.
- **iA Writer** — the closest reference for the *feel* (warm-neutral
  ground, typographic confidence, zero card-flavored regions). The
  reading-document register WebPilot's settings should aspire to.
- **Vercel Geist** — the closest reference for the *system* (token
  rigor, near-neutral grayscale, single restrained accent, hairline
  borders only when functional). The closest match for a developer-tool
  audience that wants polish without flash.
- **Things 3** — the closest reference for sidebar restraint with
  status footer (the connection dot pattern is essentially Things'
  area-status pattern at the bottom of its sidebar).
- **Stripe Docs** — the closest reference for *page composition*
  (rows, hairlines, generous whitespace between labeled sections,
  no cards in long-form content). The model for the per-page rewrites
  above.

---

## What I'm deliberately NOT recommending

- **A monochrome-no-accent palette.** Considered and rejected. Removing the
  accent entirely is "lazy minimal" — it forces the user to find the CTA by
  reading every label. The single restrained accent is the disciplined
  choice, not the no-accent choice.
- **Pure-white card surfaces on a pure-gray canvas.** Considered. Rejected
  because the existing `elev-1` two-layer shadow system in ELEGANCE.md
  already handles card lift gracefully when cards are used — the move I'm
  recommending is "fewer cards," not "different cards."
- **Removing dark mode tone-step layering.** ELEGANCE.md's three-tone dark
  mode (canvas / panel / card) is a strong choice and I'd keep it; my
  recommendations affect *light* mode warmth more than they affect the
  dark mode architecture.
- **Aggressive functional trimming.** Hiding the Profiles page behind
  Settings, collapsing Agents into Pairings, or removing the manual-setup
  snippets are all "minimal by deletion" — they hurt the power-user the
  app exists for. Every page UX.md specifies should still exist; only
  Settings gets fragmented into its component pages because the user
  asked for more visible options.
- **A custom typeface beyond Geist Sans + Geist Mono.** Considered iA Writer's
  Quattro (gorgeous, but a different register from Geist) and a serif
  accent for headings (Stripe Docs uses one). Rejected: ELEGANCE.md's
  one-sans-one-mono discipline is correct for this product. The minimal
  move within that constraint is to use *fewer weights*, not different
  families.
- **A "compact mode" toggle.** Considered as a developer-friendly density
  option. Rejected: providing two densities means designing each screen
  twice, and disciplined-minimal apps tend to pick one density and trust
  it. Linear's only-one-density choice is the right precedent here.
