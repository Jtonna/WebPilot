# Apple iOS / macOS research for WebPilot

> Lens: authentically Apple — specifically the design language of iOS 17+, macOS
> Sonoma/Sequoia System Settings, Finder, Mail, Reminders, Notes, Music, and the
> Pro apps. Not the apple.com marketing site. Not "Apple-inspired" in the
> generic SaaS sense.

---

## Apple's design fundamentals at a glance

1. **Semantic color, not raw color.** Apple never paints a UIView with `#FFFFFF`.
   It paints with `systemBackground`, which resolves at render time to a value
   that depends on appearance (light/dark), elevation (base vs. grouped), and
   accessibility (increased contrast). The whole system is **roles, not hexes**.
   The role hierarchy is rigid: `label` → `secondaryLabel` → `tertiaryLabel` →
   `quaternaryLabel`, and `systemBackground` → `secondarySystemBackground` →
   `tertiarySystemBackground`. WebPilot has tokens that *look* like this but
   are not anchored to the same hierarchy.

2. **Materials carry depth, not shadows.** On native Apple platforms, a sidebar
   sits on a `sidebar` material; a popover sits on `menu` material; a HUD on
   `hudWindow`. These are vibrancy effects — they sample the wallpaper or
   parent view and apply blur + saturation + tint. **On the web we cannot
   reproduce this faithfully**, so the honest substitute is **flat tonal
   layering** (which is exactly what System Settings does inside a window:
   a tinted canvas + opaque white cards with hairline separators). WebPilot
   should commit to flat layering and resist `backdrop-filter` cosplay.

3. **The "grouped" inset list is the canonical surface.** Settings, Reminders,
   Mail prefs, the new System Settings — they are all **rounded-corner cards
   containing rows separated by hairlines, sitting on a tinted canvas**. Not
   "cards on a white page." The canvas is tinted (subtly cool grey in light,
   subtly lifted near-black in dark) and the cards are *whiter* than the
   canvas. WebPilot currently has white cards on a cool off-white — the
   relationship is right, but the canvas needs **more tint** so the card lift
   is visible without a border.

4. **Hierarchy by typographic scale + monochrome ink.** Apple uses *one*
   accent on a screen — the rest is `label` and `secondaryLabel` ink in
   varying type sizes. The "Large Title" pattern (a 34pt bold title that
   collapses into the toolbar on scroll) is the iOS/macOS settings detail
   signature. Section headers within a grouped list are **uppercase, 13pt,
   tertiary color, letter-spaced** — not bold black h3s.

5. **Restraint as luxury.** Apple's polish is in what's *removed*: no
   gradient buttons, no second accent, no shadow on the active sidebar pill,
   no zebra striping, no decorative dividers between sections (whitespace
   does that work). The "quiet luxury" line in WebPilot's docs is right —
   but the current redesign still has the muscle-memory of a SaaS dashboard
   (cards floating with shadows, a saturated blue that's slightly off-key).

---

## Where the current redesign drifts from Apple authenticity

1. **The accent is wrong by a few degrees of hue and saturation.** Apple's
   light-mode `systemBlue` is `#007AFF`. WebPilot chose `#2E6FE6` — explicitly
   "pulled toward cobalt." Cobalt reads *enterprise SaaS* (Linear, Stripe,
   Notion), not Apple. The "sky at altitude" rationale is poetic but the
   resulting color is recognisably **not Apple's blue**. Same in dark:
   Apple's dark-mode `systemBlue` is `#0A84FF`; WebPilot chose `#5AA9FF`,
   which is lighter and pastier — that's a Material-3 move, not an Apple
   move. Apple's dark blue is *more saturated* than its light blue, not less.

2. **The canvas isn't tinted enough; cards rely on shadow to lift.** Light
   canvas `#F7F8FA` against pure-white `#FFFFFF` cards has only ~1.5%
   luminance delta. Apple's System Settings canvas is closer to ~4% cooler
   than the card. The elegance spec then adds `--elev-1` shadow to make
   the card readable — which is the **opposite** of Apple's approach.
   Apple settings cards have **no shadow at all**; they lift through
   canvas tint + rounded corners + the absence of any other surface
   between them and the window chrome. WebPilot is leaning on shadow to
   compensate for an undertinted canvas. Fix the canvas, drop the shadow.

3. **The sidebar is a flat nav list, not a source list.** WebPilot's sidebar
   is five items in a vertical stack with a connection dot in the footer.
   That's a *web app sidebar*. Apple sidebars (Finder, Mail, Music, Notes,
   Reminders, System Settings) are **source lists**: they have **section
   headers** (uppercase, secondary color, letter-spaced), **collapsible
   groups**, and a clear separation between "places" (top, app-defined)
   and "things" (below, user-defined or dynamic). WebPilot's "more
   defined, with extra options" instinct is correct — the right move is
   to grow it into a real source list, not to thicken the nav items.

4. **Section headers inside cards are too loud.** UX spec calls for h2
   `section` token at 20px / 500. Apple's section headers inside a
   grouped list are 13pt uppercase tertiary-color — they're labels, not
   headlines. Headlines are the page's Large Title alone; section
   "headers" are quiet captions above each card group. The current
   "Action items / System status" h2s feel like dashboard cards;
   they should feel like Settings.app group headers.

5. **The Settings page is structured as 5 unrelated cards, not as
   semantic groups.** Apple's Settings.app (and iOS Settings) groups
   *related* rows into one card with row-dividers, and uses **multiple
   small cards** when the rows are semantically distinct. WebPilot's
   plan has Appearance / Network / Notifications / Server / About as
   five top-level cards each containing 1–3 controls. Apple would
   collapse Appearance + Notifications into a single "General" card,
   keep Network as its own card, and put Server + About into an
   "Advanced" disclosure group.

---

## Recommendations

### Palette refinements

**Adopt Apple's literal semantic accent values.** This is the single
biggest authenticity win. Replace the cobalt-leaning blues with Apple's
exact `systemBlue`:

| Token | Current | Recommended | Source |
|---|---|---|---|
| `--wp-accent` (light) | `#2E6FE6` | **`#007AFF`** | iOS/macOS `systemBlue` light |
| `--wp-accent` (dark) | `#5AA9FF` | **`#0A84FF`** | iOS/macOS `systemBlue` dark |
| `--wp-accent-hover` (light) | `#2560CC` | **`#0066D6`** | ~10% darker `systemBlue` |
| `--wp-accent-hover` (dark) | `#7BBBFF` | **`#409CFF`** | Slightly lighter `systemBlue` |

Note the dark accent is **more saturated**, not less — Apple's dark blues
are punchier than their light blues, the opposite of what most web
designers reach for. The dark-mode-button-uses-near-black-text rule the
palette spec already notes is correct and stays.

**Tint the canvas more, drop the card shadow.** Light mode:

| Token | Current | Recommended |
|---|---|---|
| `--wp-bg` (canvas) | `#F7F8FA` | **`#F2F2F7`** (Apple `systemGroupedBackground` light) |
| `--wp-bg-card` | `#FFFFFF` | `#FFFFFF` (keep) |
| `--wp-bg-elevated` | `#FFFFFF` | `#FFFFFF` (keep) |

Dark mode:

| Token | Current | Recommended |
|---|---|---|
| `--wp-bg` (canvas) | `#0F1318` | **`#000000`** (Apple `systemGroupedBackground` dark, pure black on OLED) |
| `--wp-bg-card` | `#161B22` | **`#1C1C1E`** (Apple `secondarySystemGroupedBackground` dark) |
| `--wp-bg-elevated` | `#1C222B` | **`#2C2C2E`** (Apple `tertiarySystemGroupedBackground` dark) |

Yes, this means **pure black canvas in dark mode**. That's the
authentically-Apple choice on iOS 13+ and matches System Settings on
Macs with the dark appearance. The palette spec's "never `#000`" rule
is a holdover from pre-OLED design wisdom that Apple themselves no
longer follow. If pure black feels too aggressive on a web window
(no wallpaper showing through to soften it), the safe alternative is
`#1C1C1E` as canvas and `#2C2C2E` as card — that's Apple's
*non-grouped* `systemBackground` hierarchy and is also defensible.

**Then drop the card shadow entirely.** With `#F2F2F7` canvas against
`#FFFFFF` card, the lift is unmistakable without shadow. The
`--elev-1` shadow stays in the system for popovers and modals only,
not for resting cards. This change alone moves the UI 60% closer to
Settings.app.

**Label colors — adopt Apple's `label` hierarchy verbatim:**

| Role | Current (light) | Recommended (light) | Recommended (dark) |
|---|---|---|---|
| `label` (primary) | `#0B1220` | **`#000000` at 100%** (Apple `label`) | **`#FFFFFF` at 100%** |
| `secondaryLabel` | `#3C4860` | **`rgba(60, 60, 67, 0.60)`** | **`rgba(235, 235, 245, 0.60)`** |
| `tertiaryLabel` | `#6B7588` | **`rgba(60, 60, 67, 0.30)`** | **`rgba(235, 235, 245, 0.30)`** |
| `quaternaryLabel` (new) | — | **`rgba(60, 60, 67, 0.18)`** | **`rgba(235, 235, 245, 0.16)`** |

Apple expresses these as **alpha on a base ink color** specifically so
they harmonise across every background layer. The current hex-only
approach makes secondary text look slightly wrong on the card vs. on
the canvas. Switch to alpha-on-base and the tones unify automatically.

**Status colors — match Apple's system semantics.** Apple uses
`systemGreen #34C759` / `systemOrange #FF9500` / `systemRed #FF3B30`
in light; lifted variants `#30D158` / `#FF9F0A` / `#FF453A` in dark.
WebPilot's success/warning/danger are slightly desaturated relative
to these. **Recommend adopting Apple's exact values** for the same
reason as accent: instant recognition.

### Sidebar redesign

Restructure as a **macOS source list** (Finder / Mail / Music
sidebar), not a five-item nav stack. Three sections, uppercase
13pt secondary-label headers, items at 14pt regular:

```
WebPilot ▼                                        (app menu — version, restart, quit)
─────────────────────────────────────────────
[search field — 28px high, rounded, grey fill]   (NSSearchField equivalent)

WEBPILOT
   Dashboard
   Pairings                              (3)     (subtle count, tertiary color, no red dot)
   Profiles
   Agents

ACTIVITY
   Active now                            (2)     (live count of connected extensions)
   Recently paired

SYSTEM
   Settings
   Activity log                                  (new — read-only daemon log viewer)
   Diagnostics                                   (new — Chrome state, ports, paths)

─────────────────────────────────────────────
[footer: connection dot + "Localhost · 3456"]    (existing dot, plus port inline)
```

Specifics:

- **Section header style**: 11pt uppercase, `secondaryLabel` color
  (alpha 0.60), letter-spacing `+0.06em`. Padding: 24px top, 6px
  bottom. No divider line under it — whitespace separates.
- **Item style**: 32px row height (macOS sidebar standard is
  24–28pt; 32px reads cleaner on web). 14pt regular for inactive,
  14pt medium for active. Icon at 16px on the left, 8px gap to
  label.
- **Active state**: filled rounded rectangle background using
  `systemFill` (`rgba(120, 120, 128, 0.16)` light /
  `rgba(120, 120, 128, 0.24)` dark) — **not** accent-tint. Apple's
  sidebar selection uses the *neutral* fill, not the blue accent.
  Selection only goes blue when the window loses key focus (becomes
  inactive-state grey) — but on web we don't have that concept, so
  neutral fill is the right call. The label and icon turn `label`
  primary color (full opacity) when selected; inactive items show
  at `secondaryLabel`.
- **Search field**: 28px tall rounded-6px, `tertiarySystemFill`
  background, magnifying-glass leading icon, placeholder "Search"
  in tertiary color. Cmd+F focuses it. v1: scope is "this page";
  v1.5: global.
- **Counts**: live numeric badges aligned right, in `secondaryLabel`
  color, mono font, 12pt. **Not red dots, not pills**. Apple Mail's
  unread counts are exactly this — a number, not a pill. The UX
  spec's "no badge counts" rule should be relaxed for source-list
  sidebars; Apple uses them throughout (Mail unread, Music play
  count, Reminders task count).
- **"Activity" and "System" sections are the "extra options" the
  user asked for** — they unlock new surfaces (live activity view,
  history, log viewer, diagnostics) that were folded into the
  Dashboard / Pairings / Settings pages. Splitting them out turns
  the sidebar from a 5-item nav into a 9-item information space.
- **Collapsible groups**: section headers should be clickable to
  collapse the group (chevron appears on hover, like Finder). State
  persists in localStorage. v1.5 polish.
- **No left border bar, no shadow**. The sidebar's surface is one
  step *darker* than the canvas in light mode (`#E5E5EA` —
  Apple `systemGroupedBackground` secondary) and one step *lighter*
  in dark mode (`#1C1C1E`). It's defined by the tone step, not a
  rule. Width 240px stays.

### Page composition refinements

**Universal page chrome — adopt the Large Title pattern.**
Every page opens with a 28–32px **Large Title** (Apple's "Large
Title Display" — bold 600 weight, `-0.025em` tracking) followed
by the subtitle in `secondaryLabel`. No card around it. The title
sits on the canvas, not in a header bar. On scroll, no
collapse-into-toolbar behaviour on web (it's a native-feeling
flourish that's hard to get right) — just leave it; scroll past it.

Above the title, a **toolbar row** (40px tall) holds: page-specific
actions on the right (e.g. "Pair a new agent" on Agents page),
search in the middle if relevant, breadcrumb-free on the left.
This mirrors the macOS `NSToolbar` placement above the title.

**Replace h2 section headers with Apple-style group labels.**
Inside the canvas, content is **grouped cards** (Apple grouped
inset list pattern):

```
        [12pt uppercase secondary label: "ACTION ITEMS"]
        ┌─────────────────────────────────────────┐
        │ PairingPromptCard row                   │
        │ ─────────────────────────────────────── │  ← 0.5px hairline at quaternaryLabel
        │ PairingPromptCard row                   │
        └─────────────────────────────────────────┘
        [optional 11pt tertiary footnote: "Approve to grant API access"]

        [12pt uppercase secondary label: "SYSTEM STATUS"]
        ┌─────────────────────────────────────────┐
        │ Chrome · Running · debug flag enabled   │  ← 44px row, icon left
        │ ─────────────────────────────────────── │
        │ Extension · 2 of 2 connected            │
        │ ─────────────────────────────────────── │
        │ Server · Localhost · port 3456          │
        └─────────────────────────────────────────┘
```

- Card radius: **10px** (Apple's grouped inset standard). Currently
  the elegance spec says `radius-md 10px` for cards — keep it; align
  the rest of the spec to this.
- Card padding: **0 horizontal, 0 vertical on the container**; each
  row is 44px tall with 16px horizontal inset for content.
- Row hairline: **0.5px** (`device-pixel-ratio` hairline if available),
  `quaternaryLabel` color, inset 16px from the left so it doesn't
  reach under the leading icon — Apple's exact pattern.
- Section label above card: 12pt uppercase, `secondaryLabel`, 8px
  bottom margin. **No h2 with full-bleed bold text.**
- Footnote below card (optional): 11pt regular `tertiaryLabel`,
  reading-prose max-width 600px. This is Apple's "explainer
  paragraph" pattern — the small grey text under a settings group
  that explains the consequence of toggling something.

**Per-page application:**

- **Dashboard**: Two grouped cards — `ACTION ITEMS` (pending
  pairing rows), `SYSTEM STATUS` (3 rows: Chrome / Extension /
  Server). Drop the h2s. No "All clear" headline-as-content; if
  empty, the ACTION ITEMS card simply isn't rendered and a small
  centered "Nothing waiting." line sits where it would be, in
  `tertiaryLabel` 13pt. The Welcome (truly-empty) state stays a
  card with a CTA, but the card is **the only card on the page**
  centered vertically.

- **Pairings**: `AWAITING REVIEW` group + `HISTORY` group. History
  rows use the same 44px row pattern with disclosure chevrons on
  the right (Apple settings-row chevron, 13pt `tertiaryLabel`)
  that expand inline rather than navigating away.

- **Profiles**: `KNOWN PROFILES` group (each profile is a row;
  status pill sits inline on the right). `NEW SANDBOX PROFILE`
  group with a single row containing the input + "Create" button.
  The "How to load the extension" disclosure becomes a footnote
  link under the second group, not a collapsed section.

- **Agents**: `PAIRED AGENTS` group. `PAIR A NEW AGENT` group with
  one row containing the CTA. `MANUAL SETUP` as a disclosure
  group (Apple System Settings has these — a group with a
  chevron header that expands). Drop the wide pair-walkthrough
  modal in favour of a **NavigationSplitView-style detail pane**
  on desktop: the walkthrough opens as a right-side sheet
  (Apple's "Settings detail pane" pattern), not a centered
  modal. On mobile, it becomes a full-screen sheet from the
  bottom (iOS modal pattern).

- **Settings** — restructured to Apple's grouping logic:

  ```
  GENERAL
    Appearance       [segmented: System / Light / Dark]
    ─────────────────────────────────
    Notifications    [toggle]
    Notification sound  [toggle, indented child]

  NETWORK
    Network access   [toggle: Localhost only / LAN]
    ─────────────────────────────────
    Port             3456              (mono, secondary, copy on hover)

  ADVANCED                              [chevron — collapsed by default]
    Data directory   <path>             (mono with copy button)
    Log file         <path>             (mono with copy + open)
    Restart server   [button — danger style]

  ABOUT
    Version          0.5.4
    ─────────────────────────────────
    Check for updates   [button]
    ─────────────────────────────────
    GitHub · Docs · Report an issue     (link row, 13pt secondary)
  ```

  Four groups instead of five. Server details collapse under
  Advanced — power-user surface, not first-tier. "About" is the
  last group, as in every Apple settings pane.

**Toolbar treatments.** A 44px toolbar row above the Large Title,
flush with the canvas (no separator below). Right-aligned action
button uses Apple's "borderless tinted button" style: accent-color
text, no background, 13pt medium. Only **destructive** or
**primary commit** actions get a filled background.

---

## Reference snapshot

- **macOS System Settings (Sonoma+)** — the canonical reference for
  WebPilot's whole UI: tinted canvas, grouped inset cards, sidebar
  with sections, no shadows on resting surfaces. This is the
  closest single product analogy and should be the comparison
  screenshot for every page review.
- **macOS Mail sidebar** — the source-list pattern WebPilot's
  sidebar should imitate: section headers, counts on the right,
  neutral selection fill, collapsible mailboxes.
- **macOS Reminders** — three-pane composition where the sidebar
  has both static and dynamic groups (Lists below Smart Lists);
  exactly the structure WebPilot wants (static nav above,
  Activity below).
- **iOS Settings app** — the grouped-list-with-footnote pattern
  applied at maximum density; the footnote-explainer-under-the-card
  is the iOS Settings signature WebPilot should adopt for any
  setting that has consequences.
- **Final Cut Pro inspector panel** — when WebPilot eventually
  needs a denser inspector view (e.g. a future "Agent detail"
  pane with many properties), this is the reference: tight rows,
  uppercase mini-section labels, disclosure groups, value-on-right.

---

## What I'm deliberately NOT recommending

- **No `backdrop-filter: blur()` to fake vibrancy.** Web vibrancy is
  always a lie — it samples the page behind, not the wallpaper, and
  it dies on reduced-transparency. The elegance spec already bans
  this; keep the ban. Flat tonal layering is the honest substitute.
- **No skeuomorphism, no neumorphism.** No raised buttons, no
  inset toggles. Apple abandoned both in 2013 and 2020 respectively;
  any return is dated cosplay.
- **No animated gradient hero on the Dashboard.** That's apple.com
  marketing, not iOS/macOS product. WebPilot is a settings pane,
  not a launch page.
- **No "translucent sidebar" effect on web** — we can't get the
  wallpaper sample, so blurring the page canvas produces a muddy
  grey that's worse than a flat tone. Just use a flat tone.
- **No multi-accent system, no "info" as a second blue.** Apple's
  `systemBlue` does everything blue-ish; the palette spec's
  separate "info" color (`#3B7CC4`) competes with accent and
  should be merged. Use `systemBlue` for all info contexts; use
  `systemGray` for neutral notices that aren't urgent.
- **No SF Pro substitution attempt beyond Geist.** Geist is the
  honest free choice and the elegance spec made the right call.
  Don't try to fingerprint-match SF Pro with custom OpenType
  features beyond `tnum` and `ss01` — chasing it makes it worse.
- **No large-title scroll-collapse behaviour.** Beautiful on iOS,
  fragile on web, easy to over-engineer. Just print the Large
  Title and let it scroll off.
- **No badge dots on top-level nav.** Counts inside the source
  list are fine (Mail does this); a red unread dot on a top-level
  app icon is an iOS Home Screen pattern, not a sidebar pattern.

