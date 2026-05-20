# WebPilot UX Spec

> Scope: information architecture and per-page composition for the WebPilot
> server control panel served at `http://localhost:<port>/ui`. This is a
> spec — no source code in this branch is modified by this document.
>
> Locked constraints: same five pages (Dashboard, Pairings, Profiles, Agents,
> Settings); inline Action Items on the Dashboard; fully responsive; Apple-grade
> "quiet" feel.

---

## Concept

WebPilot is a *trust console*: a small, calm room where a developer authorizes
AI agents to drive their real Chrome and then largely forgets about it. The UI
should feel like System Settings on macOS — generous whitespace, a single
visual focal point per page, no dashboards-for-dashboard's-sake. The user
should feel **in control without being on guard**: a glance tells them
"nothing needs me right now," and when something does, exactly one thing
draws the eye.

We are not building a monitoring tool. We are building a permission slip,
a key ring, and a settings drawer — composed into the smallest surface that
still feels honest about what's happening on the user's machine.

---

## Information architecture

```
WebPilot UI
├── Dashboard                         (/ui)
│   ├── Action items                  (pending pairings, inline approve/deny)
│   ├── System status (single card)   (Chrome + Server + Extensions, one line each)
│   └── Quiet zone                    (gentle "what next" card when truly empty)
│
├── Pairings                          (/ui/pairings)
│   ├── Awaiting review               (same inline card as Dashboard)
│   └── History                       (persistent, server-backed, paginated)
│       └── Row → expand              (timestamp, decision, bound profile)
│
├── Profiles                          (/ui/profiles)
│   ├── Known profiles                (list, grouped by status)
│   ├── + New sandbox profile         (primary CTA, inline form, not a modal)
│   └── How to load the extension     (collapsed "Learn more", expands inline)
│
├── Agents                            (/ui/agents)
│   ├── Paired agents                 (rows: name, profile, last active, …)
│   ├── Pair a new agent              (primary CTA → modal walkthrough)
│   └── Manual setup snippets         (collapsed; for advanced users)
│
└── Settings                          (/ui/settings)
    ├── Appearance                    (theme: System / Light / Dark)
    ├── Network                       (LAN toggle, restarts server)
    ├── Notifications                 (system-toast on/off, sound on/off)
    ├── Server                        (port, data dir, log path — read-only)
    └── About                         (version, "Check for updates", links)
```

The five pages are kept; the *contents* of each are tightened. Dashboard
becomes lighter (was: 4 big sections; becomes: 2 — action items + a
single status card). Pairings History becomes persistent (server-backed,
not session-scoped). Agents grows a real onboarding flow. Settings
finally has more than one thing in it.

---

## Navigation

### Sidebar (desktop, ≥ 900px)

- Fixed 240px left rail, full height. Subtle inner border, no shadow.
- Order: **Dashboard**, **Pairings**, **Profiles**, **Agents**, **Settings**.
  This is the order the user *thinks* about them — what needs me now, what
  asked me recently, who I trust, what's the boring config.
- Active state: solid background pill on the row, no left bar, no arrow.
  Inactive items get a faint hover tint only — no underline.
- Brand: "WebPilot" wordmark at the top, links to Dashboard. Not a button.
- Sidebar footer: a tiny dot + label — `Connected` / `Disconnected` —
  polling every 15s. Already implemented; keep it. No port number, no
  PID, no IP — those live on the Settings → Server card.

No badge counts on nav items. If there are 3 pending pairings, the user
sees them on the Dashboard or on the dot in the page title (`(3) WebPilot`
in `<title>` — a notification surface they don't have to look for).
Sidebar counts create permanent visual noise.

### Top bar (mobile, < 900px)

- Sidebar collapses into a sheet. Trigger: a 40×40 hamburger in the top-left
  of a 56px-tall top bar. The page title fills the bar; no breadcrumb.
- Top-right: the same connection dot. Tapping it opens the sidebar (so
  there's always a way out without hunting for the hamburger).
- The sheet slides in from the left, full height, with a backdrop scrim.
  Tapping the scrim or any nav item dismisses it.

### Active state pattern

- Sidebar item: filled pill background, text in primary foreground weight 500.
- Inside a page, no further breadcrumbs. Each page has exactly one `<h1>`.

### Sub-nav

None. If a page grows enough to need tabs, that's the signal to split it
into its own page — not to nest. (One exception: Settings uses **section
anchors**, not tabs — see Settings detail below.)

---

## Per-page detail

### 1. Dashboard

**Purpose.** A glance that tells you "you don't need me," or surfaces the
exactly-one thing that does.

**Primary user action.** Approve or deny a pending pairing.

**Layout (top to bottom).**
1. Page header — `Dashboard` h1 + one-line subtitle.
2. **Action items** section. If there's anything pending, this is the only
   thing the user sees above the fold.
   - Inline pairing cards (the new `PairingPromptCard` — keep, refine
     only the spacing). One per pending pairing. Approve / Deny buttons
     right in the card. Profile selector (existing dropdown including the
     `+ New sandbox profile` sentinel) lives in the card.
3. **System status** section. Single card with three rows:
   - `Chrome` → `Running · debug flag enabled` (green) /
     `Running · debug flag missing` (amber + a "Restart Chrome" link) /
     `Not detected` (grey + a "Launch Chrome" link).
   - `Extension` → `2 of 2 active profiles connected` (green) /
     `0 of 1 connected — waiting on profile "Default"` (amber).
   - `Server` → `Localhost · port 3456` (default) / `LAN · 0.0.0.0:3456`
     (with an info icon if LAN — "Reachable from other devices on your
     network").

   This replaces the current Dashboard's separate Chrome card, Active
   profiles section, and All profiles collapsible. Those details belong
   on the Profiles page; the Dashboard summarizes them.

That's it. No "Recent activity" feed — the activity is the agent driving
Chrome, and the user sees it happen in their browser. We won't fake an
events list.

**Empty state (truly empty: no Chrome, no agents, never paired).**
Replace System status with a **Welcome card**:
- Title: `Welcome to WebPilot.`
- Body: `Pair your first agent to get started.`
- CTA: `Pair an agent` → routes to Agents page, scrolls to the
  walkthrough modal trigger.
- Secondary link, smaller and grey: `What is WebPilot?` → opens
  `https://github.com/Jtonna/WebPilot#readme` in a new tab.

**Empty state (Chrome closed, no pending).**
System status shows `Chrome · Not detected` with a `Launch Chrome` link;
Action items shows `Nothing waiting.` That's enough.

**Loading state.** A single shimmer-style card 240px tall. No skeleton
explosion across the page — load the data, then paint. Sidebar paints
instantly because it's static.

**Error state.** If `/api/ui/status` fails, replace System status with
one card: `Couldn't reach the server. <inline retry button>`. Don't
hide other content; the cached pending list is still useful if we have
it.

**Microcopy callouts.**
- Section header: `Action items` (not "Pending pairings" — broader, less
  noun-y).
- Section aside: `All clear` when empty, `1 pending` / `3 pending` otherwise.
- Welcome card: `Welcome to WebPilot.` (with the period — Apple-confident.)
- Chrome state: `Running · debug flag enabled` (interpunct as the
  separator, not em-dash — em-dash is for asides, not facts).

**Modals originating here.** Only the **Revoke / Deny confirmation** when
the user clicks Deny — same `ConfirmModal` pattern as elsewhere.
"New sandbox profile" from the inline picker should *not* be a modal — it
opens an inline name-input row inside the pairing card.

---

### 2. Pairings

**Purpose.** A specialist view for the user who is doing several pairings
in a row, plus the *history* of who they've ever approved (and on what
profile).

**Primary user action.** Approve or deny — same as Dashboard.

**Layout.**
1. Header: `Pairings` h1 + subtitle.
2. **Awaiting review** section — identical card to Dashboard. (Same
   component, no behavior drift.)
3. **History** section — persistent, server-backed.
   - Server already has `listAllPairings()`. We surface it via
     `GET /api/ui/pairings/history` (paginated: `?cursor=&limit=50`).
   - Row layout: agent name (left), decision pill (right), timestamp
     (under name in `wp-row-sub`), bound profile name + status dot
     (also in sub). Default sort: newest first.
   - Clicking a row expands it to show: pairing ID (mono, copyable),
     decided at full timestamp, link to the agent on the Agents page if
     still active, `Revoke` button if still active.
   - Pagination: a `Load 50 more` button at the bottom. Not an infinite
     scroll — the user is here to find a thing, not to graze.

**Empty state (no history yet).** Single line: `No pairings yet. They'll
appear here after you approve or deny your first request.`

**Empty state (no pending).** Section card reads `Nothing pending right
now.` No retry, no auto-refresh button — the page subscribes to
`pairing_requested` events.

**Loading state.** Awaiting review section shows a 1-card-tall shimmer
while loading; History below is hidden until first fetch resolves (to
avoid the layout jumping when the first page of history arrives).

**Error state.** Per-section. If `/api/ui/status` fails, the Awaiting
review card shows the error; if `/api/ui/pairings/history` fails, only
the History card shows it and offers a retry.

**Microcopy callouts.**
- Section: `Awaiting review` (not "Pending" — friendlier, action-oriented).
- Section: `History`. Aside: `Last 30 days` / `All time` toggle is
  deferred to v1.5 — for v1, just show all.
- Deny confirm body: `Deny pairing for "<agent>"? They'll have to call
  request_pairing again to retry.`
- Approve success toast: `Paired. <agent> is bound to <profile>.`

**Modals.** Deny confirm; row-level Revoke confirm (reuses the existing
`ConfirmModal`).

---

### 3. Profiles

**Purpose.** Manage the Chrome profiles WebPilot is aware of — see which
ones are ready, which need extension setup, and create new sandboxes for
agents to live in.

**Primary user action.** Create a new sandbox profile, or check why a
profile says "Needs setup."

**Layout.**
1. Header.
2. **Known profiles** section.
   - One row per profile. Default sort: `active` first, then `ready`,
     then `needs_setup`. Within a status, sort by last-active descending.
   - Each row: display name + status pill (right), Google account email
     + monospace directory name (sub). For `needs_setup` rows, an
     inline hint expands beneath the row (already implemented as
     `NEEDS_SETUP_HINT` — keep it, but reword: see microcopy).
   - For `needs_setup`, the row gains a primary `Set up` button on the
     right. Clicking it opens the **Profile setup walkthrough** modal
     (see below).
3. **+ New sandbox profile** section.
   - Promoted from today's "stub-feeling" form into a real, prominent
     panel: a friendly intro sentence, an input, and a primary button.
     Same component, more visual weight.
   - On success, the new profile launches and gets a
     `needs_setup` status. The success message *links* to the setup
     walkthrough rather than just telling the user where to go.
4. Removed from current implementation: nothing. We're keeping all
   existing functionality, just refining hierarchy.

**Modal: Profile setup walkthrough.**
A 480px wide modal, four numbered steps with a small illustration per
step (or, if no illustrations in v1, a colored numeral). Each step has
copy-buttons where relevant:
1. `Open chrome://extensions in <profile name>` (button copies the URL).
2. `Turn on Developer mode (top-right toggle).`
3. `Click "Load unpacked" and pick this folder:` (mono path with a
   copy button — server already knows the extension path).
4. `Done — come back here and the status will update to Ready.`

Closes with `Done` (primary, no destructive secondary).

**Empty state.** `No profiles found.` plus a one-line explanation:
`WebPilot reads profiles from Chrome's Local State file. If you've
never opened Chrome on this machine, launch it once and refresh.`

**Loading state.** Profile rows shimmer in place. The "+ New sandbox
profile" card paints immediately — it's static.

**Error state.** Section-level. The "+ New sandbox profile" card still
works even if the status fetch failed.

**Microcopy.**
- Status pill labels: keep `Active`, `Ready`, `Needs setup`. Color
  semantics: green / blue / amber. The verbiage `Needs setup` is
  better than e.g. `Not ready` — it implies the user has an action.
- New profile placeholder: `e.g. WebPilot Sandbox` (drop the quotes —
  Apple doesn't use scare-quotes in placeholder text).
- Needs-setup hint, rewritten: `Open Chrome's extensions page in this
  profile and load the WebPilot extension. Walkthrough →` (link opens
  the modal).

**Modals originating here.** Profile setup walkthrough (above).
No delete-profile modal in v1 — we don't delete Chrome profiles for
the user. (If users ask for that, it's a fresh design conversation.)

---

### 4. Agents

**Purpose.** Manage the agents (API keys) that can drive your browser,
and pair new ones.

**Primary user action.** Pair a new agent (first-time users) or revoke
an existing one (returning users).

**Layout.**
1. Header.
2. **Pair a new agent** section — promoted to the top when the list is
   empty; demoted to a secondary panel when ≥1 agent is paired.
   - Primary CTA: `Pair a new agent` button → opens the walkthrough
     modal (see below). The current sprawling first-time-setup card on
     this page (the URL-only `.mcp.json` block + giant pasted prompt
     + ordered list) becomes the *content* of that modal.
3. **Paired agents** section.
   - Same row pattern as today. Each row: name (editable), bound
     profile name, last-active timestamp, `Copy config` button (the
     keyed snippet, already implemented), kebab menu with `Rename`
     and `Revoke`.
   - Last-active formatting: relative for ≤ 7d (`3 minutes ago`,
     `Yesterday`, `4 days ago`), absolute for older (`May 2`).
4. **Manual setup snippets** — collapsible (`RevealSection`), default
   collapsed. Contains the raw JSON example and the four-step
   manual-paste instructions, for users who don't trust modals or who
   are setting up via SSH.

**Modal: Pair a new agent walkthrough.**
640px wide (wider than profile setup — more text). Three steps; the
user can leave at any time, and pairings show up live in the modal:
1. **Tell your client about WebPilot.** Copyable block — the
   URL-only `.mcp.json` snippet. Sub-text: `Project-level config only.
   Never put API keys in user-level config.`
2. **Ask the agent to pair.** Copyable block — the agent prompt that
   today is jammed at the bottom of the page. Sub-text: `The agent
   will call request_pairing on its own.`
3. **Approve here.** Live region — when a `pairing_requested` event
   arrives, the same `PairingPromptCard` renders right inside the
   modal. The user can approve without leaving. After approval, the
   modal flips to a success state: `Paired — <agent> is now in your
   agent list. You can close this.`

**Empty state.** Replace the Paired agents section with a single
welcoming card: `No agents paired yet. <Pair a new agent button>`.

**Loading state.** Shimmer rows; modal trigger paints immediately.

**Error state.** Section-scoped.

**Microcopy.**
- Section: `Paired agents` (keep).
- Empty state: `No agents paired yet. They'll appear here once you
  approve a pairing request.`
- Revoke confirm: `Revoke <agent>? Their API key stops working
  immediately. They can re-pair to come back.` (Active, not passive.)
- Rename inline: empty input placeholder `Pick a memorable name`.

**Modals originating here.** Pair-new-agent walkthrough; revoke
confirm.

---

### 5. Settings

**Purpose.** Configuration that affects the whole server. Used rarely,
should feel boring and reliable.

**Primary user action.** Toggle a setting. Usually theme or LAN.

**Layout.** Single column, multiple cards (no tabs, no sub-pages):

1. **Appearance**
   - Theme: a segmented control `System / Light / Dark` (default
     `System`). Persisted in `localStorage`; respects `prefers-color-scheme`
     when set to System. *New for this redesign.*
2. **Network**
   - LAN toggle, as it exists today. Restarts the server on change
     (existing confirm modal stays).
3. **Notifications**
   - Toggle: `System notifications for pairing requests` (default on).
     Persisted server-side so the daemon respects it.
   - Toggle: `Play sound with notifications` (default on, child of
     the above — visually disabled when the parent is off).
4. **Server** (read-only info, presented as a key/value list)
   - Port, data directory (mono, with copy button), log file path
     (mono, with copy button + an `Open` link on platforms where we
     can shell it out — Windows: `start <path>`; macOS: `open`).
   - `Restart server` button at the bottom. Same confirm flow as the
     LAN toggle.
5. **About**
   - WebPilot version, build date.
   - Buttons: `Check for updates` (calls the existing formatter-update
     endpoint, which we now also wire to a generic version check), and
     a small link row: `GitHub`, `Report an issue`, `Docs`.

**Empty/loading/error states.** Each card loads independently. Per-card
shimmer. If a card fails to load, only that card shows an inline error
with a `Retry` link.

**Microcopy.**
- LAN toggle copy: `Lets other devices on your network reach this
  server. The server will restart.` (Don't say "binds to 0.0.0.0" in
  the body — that's developer trivia. Keep that detail in a `What's
  this?` link that opens a tooltip with the raw bind address.)
- Restart confirm: `Restart WebPilot? Active agents will reconnect
  automatically.`
- Notifications toggle: `Show a system notification when an agent
  requests pairing.`

**Modals originating here.** Restart confirm; LAN-toggle confirm
(both reuse `ConfirmModal`).

---

## Cross-cutting patterns

### Status pill semantics

Three states. Keep the names; tune the colors and verbiage:

| State | Color | Meaning | When |
|---|---|---|---|
| `Active` | green | Profile has a live extension WebSocket and recent Chrome activity. | Extension connected, profile in use. |
| `Ready` | blue | Profile is set up (we've seen it identify before) but isn't currently connected. | Chrome closed, or this profile window isn't open. |
| `Needs setup` | amber | We've heard of this profile but it has no extension installed (no installId mapping). | First-time profile, or extension was removed. |

`Active` outranks `Ready`, which outranks `Needs setup` in sort order.
Pills use a colored dot + label; the entire pill is the legend.

### Pairing approval flow microsteps

The user already has the inline approve/deny on the Dashboard from
the recent work. Refinements:

1. New pairing arrives → `pairing_requested` event → card slides in
   (the existing `arrivingIds` animation, ~1.5s, stays).
2. Card shows: agent name (h3), origin hint (`localhost` /
   `192.168.x.x`), profile dropdown, two buttons.
3. **Approve** click → if `__new__` selected, the dropdown row
   expands to reveal a name input; the button label changes to
   `Approve and create`. Otherwise, the button is just `Approve`.
4. While the request is in flight: the entire card disables and the
   approve button reads `Pairing…`. No spinner inside the button —
   the label change is enough.
5. On success → a one-line toast (`Paired. <agent> bound to <profile>.`)
   plus the card animates out (slide + fade, ~220ms). The Agents page,
   if open in another tab, picks up the change via WS.
6. **Deny** → confirm modal → on confirm, the card animates out, toast
   reads `Denied <agent>.` (no period of doubt — just the fact).

### Destructive confirmations

Always a modal. Reuses `ConfirmModal` (already themed in F7). Pattern:
- Title: short, declarative, ends with `?` → `Revoke API key?` /
  `Deny pairing?` / `Restart server?`
- Body: one sentence on effect, one sentence on recovery / what
  happens next.
- Confirm button: red `wp-btn-danger` for destructive actions, primary
  blue for non-destructive (e.g., restart). Default focus on the
  cancel button — `Esc` closes, `Enter` does not auto-confirm.

Inline destructive UI (no modal) is reserved for **deny** in a list
context where the user is moving fast through many — and even there
we keep the modal. The cost of an accidental click on Deny is higher
than the cost of an extra Enter key.

### Toasts / in-app notifications

A single toast region in the lower-right (lower-center on mobile),
stacking max 3 visible. Each toast: 4s auto-dismiss, manual close
button. Three flavors:

- `success` (green check) — pairing approved, profile created, key
  revoked.
- `info` (neutral) — server restart kicked off, settings saved.
- `error` (red) — API call failed; the toast persists until dismissed
  (no auto-dismiss for errors).

Toasts never carry an action button in v1 — they are confirmations,
not commands. If the user needs to act, the action belongs in the
underlying UI, not in a fleeting toast.

### Theme toggle UI placement

In **Settings → Appearance**. *Not* in the sidebar. (A floating
sun/moon icon in a corner is a B-tier app convention; we're going for
A-tier.) Honor `prefers-color-scheme` by default. The current dark
palette stays; we author a light palette to match.

### First-run onboarding

We do **not** ship a modal welcome tour. Power users hate them; novices
forget them. Instead:

1. The Dashboard's *truly empty* state is a single Welcome card with one
   CTA (`Pair an agent`).
2. That CTA routes to the Agents page and opens the **Pair a new agent
   walkthrough modal** directly. The walkthrough is the onboarding.
3. Profiles page is opinionated: when there are 0 known profiles, the
   `+ New sandbox profile` card moves to the top and gets a friendly
   intro sentence.
4. We never auto-pop a modal on page load. Onboarding is reached by a
   click the user makes.

Rationale: WebPilot's audience is developers. They want to be trusted
with the docs link, not chaperoned through it.

---

## Microcopy tone guide

WebPilot's voice: **Apple confident, quietly technical.** Short
declarative sentences. Periods. No exclamation marks except in the
Welcome card. No emoji. No "we" or "let's" — the UI is not the
user's friend, it is their tool. But also: no jargon for jargon's
sake. "Localhost only" beats "Bound to 127.0.0.1" in body copy
(keep the latter in a tooltip).

### Acceptable

- `All clear.`
- `Welcome to WebPilot.`
- `Paired. Cursor is bound to Default.`
- `Open Chrome's extensions page in this profile and load the WebPilot
  extension. Walkthrough →`
- `Their API key stops working immediately. They can re-pair to come
  back.`

### Unacceptable

- `Yay! You're all set 🎉` (cloying, emoji).
- `An error occurred while processing your request.` (vague, passive,
  capital A).
- `Please click the button below to continue.` (please, button-below).
- `Network mode successfully toggled.` (passive, "successfully").
- `🚀 Pair your first agent!` (rocket, exclamation, marketing).

### Punctuation rules

- End complete sentences with periods, including in subtitles.
- Use interpuncts (`·`) as inline metadata separators
  (`PID 12345 · port 3456`). Never `|`, never `-`.
- Em-dashes for asides, hyphens for compounds, never to bullet things.
- Mono font (Geist Mono) only for: ports, PIDs, paths, UUIDs, JSON.

---

## Mobile / responsive considerations

Breakpoints: `≥ 1200px` (desktop comfortable), `≥ 900px` (desktop
minimum, sidebar still shown), `≥ 600px` (tablet), `< 600px` (phone).

### What collapses

- Sidebar → hamburger sheet below 900px.
- Multi-column key/value layouts → stacked label-above-value below
  900px.
- Pairing card's profile dropdown + Approve/Deny → buttons reflow
  below the dropdown below 600px.
- Agents page table-like rows → stacked card layout below 600px
  (kebab menu becomes a full-width "Manage" button revealing a
  bottom sheet).

### What gets dropped on mobile

- Last-active timestamps drop to relative-only (`3m ago` instead of
  `3 minutes ago at 14:23`).
- Profile directory monospace name is hidden by default below 600px;
  tap the row to reveal it. The display name is enough at a glance.
- The Agents page's "Manual setup snippets" collapsible is shown but
  has its raw JSON wrapped in a horizontally scrollable region —
  not a reflow-mangled mess.

### Touch targets

Minimum 44×44 for any tappable target. Pills are decorative (not
tappable) so they stay their elegant size. Kebab buttons grow to 44
on mobile.

### Hamburger placement

Top-left of the mobile top bar, 16px from the edge. Standard. The
connection dot mirrors at top-right.

---

## What this UX is NOT

- **Not a dashboard with charts.** No request-per-minute graph, no
  latency histogram. WebPilot's value is enabling work, not measuring it.
- **Not a chat UI.** No conversation history, no agent transcript.
  Agents talk to MCP, not to us.
- **Not a welcome tour modal.** No `< Previous / Next >` carousel
  the first time you load the app. Onboarding is opt-in.
- **Not a settings tab forest.** Settings stays a single page with
  cards, not 6 sub-pages with three controls each.
- **Not bristling with badge counts.** No red dots on sidebar items;
  pending pairings show on the Dashboard and in the document title.
- **Not loud.** No animated gradients, no live activity feed, no
  motion above 220ms, no shadows above `0 1px 2px`. Apple Quiet.
- **Not over-engineered for v1.** We deliberately defer: a Welcome
  tour, a server-side activity log viewer, per-row keyboard
  shortcuts beyond Tab/Enter/Esc, a search box on the History page,
  multi-user permissions. They each cost more than they're worth
  this round. We can add any of them when we have a real user
  asking for them.
