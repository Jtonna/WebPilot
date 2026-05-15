# QOL Features — Outstanding Follow-ups

Status as of: 2026-05-14
Branch: `QOL-Features` (local, not pushed)
Spec source-of-truth: `docs/TEMP_QOL_FEATURES_PLAN.md`

This is the *living* list of items in the QOL-Features scope that are **not done** or were intentionally deferred. Items get checked off (or deleted) as they land. Severity ordering — top items block before push, bottom items are nice-to-have.

---

## P0 — Required before pushing / opening PR

- [ ] **Live extension end-to-end smoke test on Windows** — load the unpacked extension into Default + Profile 2, exercise the full pairing flow + `browser_create_tab` flow + restart-on-flag-missing flow. Spec Section 8 checklist items that can only be validated live.
- [ ] **Decide on misattributed commit `87dd359`** — currently has A3's commit message ("scaffold web UI package") but contains A2's pairing code. Cosmetic only; content is correct. Options: leave + note in PR description / rewrite via filter-branch.
- [ ] **Decide on bd-init working-tree leftovers** — `.beads/`, `AGENTS.md`, `M .gitattributes` from agents running `bd init` to bypass the broken pre-commit hook. User's domain to decide whether to commit, gitignore, or fix the hook.

## P1 — Outstanding correctness / UX issues

- [x] **Profile auto-detect for non-signed-in profiles** — landed in commits `f439589` (inference by exclusion), `fccde12` + `13a0002` (server-side installId mapping store + extension UUID-on-install). Combined effect: anonymous profiles auto-resolve via exclusion on sequential connects; installId provides stable per-install identity that survives storage clears.
- [ ] **macOS detector / launcher / closer / notifications** — scaffolded honestly per spec, never tested on real macOS hardware. Will surface real issues on first non-Windows user.
- [ ] **Linux detector / launcher / closer / notifications** — same as above for Linux.
- [ ] **`pending-pairings.json` history pruning** — currently has a 24h expiry for pending, but denied/approved/expired entries accumulate forever. Add a longer max-age (e.g., 30 days) + cleanup.
- [ ] **Web UI `/pairings` history is session-scoped** — built from event-stream messages, lost on refresh. The server has `listAllPairings()` available; surface a `GET /api/ui/pairings/history` endpoint and have the UI read it.

## P2 — Minor improvements identified by reviews

- [ ] **`validateKey()` is called twice per tool call** (auth + routing). Memoize the entry from the auth gate and thread it to the routing function. Tiny I/O regression, not correctness.
- [ ] **Settings page race guard** — was assessed by the H2 agent as not needing it (no WS-event refresh trigger); revisit if a WS-event for settings is ever added.
- [ ] **Per-row keyboard a11y on agent list** — review I-finding; not addressed.
- [ ] **`formatDate` defensive fallback for null/undefined** — review S-finding.
- [ ] **Magic-number constants** — various places (timeouts, intervals) should be named constants.

## P3 — Larger deferred work (would not block v1 push, but flagged)

- [ ] **Web UI auth model for LAN deployments** — currently localhost-only. If users want LAN-accessible management, design a proper session/cookie auth flow.
- [ ] **Click-to-open from macOS / Linux notifications** — Windows toast got `activationType="protocol" launch=<url>`; macOS osascript and Linux notify-send don't have native click-handlers. Custom helper apps needed for parity.
- [ ] **Bundle the server into the Electron app** — currently distributed as a separate pkg binary that the Electron app spawns. Future iteration consolidates.
- [ ] **Auto-installing the extension into new profiles** — impossible (Chrome forbids it for unsigned extensions). Improve the manual-load instructions in the "Create sandbox profile" flow.
- [ ] **Cross user-data-dir Chrome management** — current model assumes Chrome's default user-data-dir. Power users with custom dirs are unsupported.

---

## Items recently completed (kept temporarily for context, prune as PR is opened)

- [x] Wave 1 — Chrome management, notifications scaffolds, async pairing API, web UI scaffold
- [x] Wave 2 — multi-extension WS, ChromeManager into `browser_create_tab`, web UI wired to server REST/WS, pairing tab removed, network mode moved, pkg build pipeline
- [x] Wave 4 fixes — F1 web UI localhost-only, F2 hello handshake ordering, F3 zombie pairingRequiredCache, F4 `clearConnection(ws)` bug, F5 dead `browser_create_tab` switch case, F6 pending-pairings 24h TTL, F7 themed confirm modal, F8 pkg-safe static serving
- [x] Wave 5 fixes — G1 profile name validation, G2 `profileId` wired through approve, G3 legacy `set_network_mode` WS handler removed, G4 approve/deny terminal-state semantics (409/404)
- [x] Wave 6 polish — H1 change-profile UI in extension, H2 REST/WS race guard, H3 stale `getLocalIP` removed, H5 web UI auto-open on `--foreground`, H6 per-agent `.mcp.json` copy snippet (H4 port change skipped — kept 3456)
- [x] Wave 7 — J1 Profiles page race guard, J2 per-agent tool routing
- [x] Notification fixes — AppUserModelID self-registration, click-to-open `launch` attribute on toast XML
- [x] Profile auto-detect — inference-by-exclusion + installId-based persistent mapping
