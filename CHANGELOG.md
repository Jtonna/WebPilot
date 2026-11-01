# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Discord formatter: `--- Servers ---` sidebar section (with folders) and `--- Navigation ---` section, plus workflows `check_sidebar`, `open_server` and `check_dm_list`. (#148)
- Site policy event log: one row per agent + domain (domain only, no path). (#103)
  - Repeat checks update a hit count and last-seen time.
  - Verdict changes update in place (no history rows).
  - Default allows are logged.
  - Rows purge after 30 days or beyond 5,000 rows (at boot and hourly).
  - Stored in `site_policy_events` table.
- `GET /api/ui/site-policy/events`: paginated read API for the log (filter by agent, decision). Returns whether the domain can be targeted by a per-agent rule and the agent's current rule for it. (#103)
- `POST /api/ui/agents/:agentId/site-events/allow` and `.../revoke`: create a per-agent allow or block rule for a logged domain. Revoke always creates a block for that agent only and never deletes an allow rule (a same-domain per-agent allow is overwritten in place). (#103)
- WebSocket event `site_policy_events_changed`: emitted when a row is created, its decision flips, the deciding rule/source changes, or retention removes rows (not on every hit). (#103)
- Popup profile picker for when the server can't match the Chrome profile. Suggested profiles come first, in-use profiles are disabled, and picking an already-registered profile asks for confirmation. (#138)
- `reidentify` message from popup to background. (#138)
- Dashboard and Profiles hint for an extension waiting to be matched, including the "Match the waiting extension" setup modal variant. (#138)

### Changed
- Discord formatter: `--- Server Notifications ---` replaced by `--- Servers ---`. (#148)
- Site rules stored per tier: per-agent, global user, signed global blocklist. User rules no longer mask signed blocklist entries; removing a user rule restores signed-list behavior. (#102)
- Global toggle disables the whole global tier (signed blocklist + global user rules). Users with toggle off find global user rules inactive until re-enabled. Per-agent rules unaffected. (#102)
- Renamed: (#102)
  - config key `global_site_blocklist_enabled` → `global_tier_enabled`
  - route `POST /api/ui/sites/global-site-blocklist/toggle` → `POST /api/ui/site-policy/global-tier/toggle`
  - WebSocket reason `global_site_blocklist_toggle` → `global_tier_toggle`
- Per-agent `*` wildcard rule: named domains take precedence. `*` matches IP addresses and single-label hosts (localhost) but cannot be exempted by named rules. (#102)
- Migration 002 marks the blocklist version `pre-002:<version>` for users with global user rules. Next successful fetch re-applies the signed list (restoring any masked domains). Prefixed string stays visible in status API until then. (#102)
- Extension popup's site toggle writes global user rules. API now reports `globalTierEnabled`. (#102)
- Site Policy page redesigned: global block list and per-agent rules cards, site access log with Allow/Revoke actions, reusable rules modal. (#104, #119)
- Per-agent tier renamed "overrides" → "rules". (#104)
  - table `agent_site_overrides` → `agent_site_rules` (migration 003 auto-runs, keeps all rules, drops redundant `idx_agent_overrides` index)
  - routes `/api/ui/agents/:agentId/site-overrides[/:domain]` → `/api/ui/agents/:agentId/site-rules[/:domain]`
  - WebSocket reasons `agent_override_upsert|delete` → `agent_rule_upsert|delete`
- MCP clients: `policySource` value changes `agent_override` → `agent_rule` in blocked-site responses. `site_policy_events` table rebuilt with new `source` value. (#104)
- Confirmation dialogs: Enter activates only the focused button; Escape cancels. No Enter-to-confirm. (#104)
- Web UI event stream emits `reconnected` after connection drops, letting pages refetch missed state. (#104)
- Extension popup's site toggle uses the same server code as Site Policy page (`upsertGlobalUserRule`), rejecting `*` identically. No popup-only policy logic. (#105)
  - `POST /api/popup/site-toggle` accepts `decision` alongside `action`.
  - errors return `{ error, reason }`.
- Popup pill shows verdict source: "Allowed (your rule)" / "Blocked (your rule)" / "Blocked (global block list)". (#105)
  - Shows "Rule on <domain>" for parent-domain matches.
  - Disables toggle when global rules off.
  - `GET /api/popup/state` adds `currentTab.matchedDomain`.
- "Sites" renamed "Site Policy" (breaking change). (#119)
  - Web UI page `/ui/sites/` → `/ui/site-policy/` (nav label)
  - Routes: `GET/POST /api/ui/sites` → `GET/POST /api/ui/site-policy/global-rules`; `DELETE /api/ui/sites/:domain` → `DELETE /api/ui/site-policy/global-rules/:domain`
  - WebSocket `sites_changed` → `site_policy_changed` (reason codes unchanged)
  - Server log `[ui-api:sites]` → `[ui-api:site-policy]`
  - Per-agent routes `/api/ui/agents/:agentId/site-rules` and `.../site-events/allow|revoke`, and `POST /api/ui/site-policy/global-tier/toggle` (already renamed under #102), are unchanged
  - Breaks anything calling UI API or listening for `sites_changed`
- Site Policy page redesigned: two-column → compact strip of two small cards (Global block list, Per-agent rules) each with `Manage` button above Site access log. (#119)
  - Manage buttons open one reusable `RulesModal` (global or agent scope) whose list, add and delete-confirm views replace each other in a fixed-height shell, so only the list scrolls.
  - Log columns: Domain (sub-line: source · matched-domain · hit-count; `default` = "No rule (allowed by default)"), Agent (links to `/ui/agents/?agent=<key>`), Status (green = approved, red = blocked), Last seen, Action.
  - Agents page supports `?agent=<key>` query filter.
- `Allow for this agent` requires a 4-character confirmation code (case-insensitive). Code regenerates on each open. (#119)
- Chrome detection failures report an `unknown` state. The server aborts rather than spawning or closing Chrome on a guess. (#132)
  - The manager re-verifies a cached "no flag" result (rate-limited to 5s) and prefers the flagged Chrome parent.
  - The status API and dashboard show `unknown`, aborted and partial Chrome outcomes.
- Restart-to-add-flag relaunches with `--restore-last-session` for active and required profiles. (#132)
- `browser_get_tabs` includes `pendingUrl`. `browser_create_tab` returns `opened_by_chrome_launch` and passes through the extension's `warning`. (#132)
- Extension manifest adds the `alarms` permission. (#132)
- Daemon log file lines are prefixed with ISO-8601 timestamps. Terminal output is unchanged. (#132)
- A second extension connection from a different install no longer displaces a live connection for the same profile; the server refuses it with close code `4409` (`connection_in_use`) and the extension retries after 30s. (#131)
- A workflow primitive blocked by site policy now returns the standard blocked envelope (or `ok: true` plus `policyBlocked` when the workflow handled the block) instead of a generic error, and is no longer recorded as a formatter error. (#131)
- The server identifies a new extension install by scanning that Chrome profile's extension storage for the install ID (read-only, size-capped) before falling back to inference by exclusion. (#138)
- `hello` carries `extensionId`. (#138)
- `identify_required` profiles carry `connected` and `registered`. (#138)
- `/api/ui/status` adds `pendingIdentification.count`. The UI broadcasts `identification_pending_changed`. (#138)

### Removed
- Unreachable "Override · Allowed / Blocked" popup pills and unused "Agent:" line. Popup shows global policy (Chrome profile only); per-agent rules moved to Site Policy page. (#105)

### Fixed
- Discord DM list counted Friends, Shop, Quests and Nitro links as DMs. (#148)
- Extension ref clicks missed or hit the wrong element when the target sat at the edge of a scrolled container or the layout shifted mid-click. Clicks now scroll the node into view, aim at the centre of its visible part, and refuse to click if another element covers the point. (#148)
- Tab switching: no reload, no "Connecting…" splash. Links navigate in-app. Splash shows only until first connection. Side menu highlights current page. (#121)
- fix(extension): remove orphaned client-side whitelist gate — site-policy enforcement is now server-side only (`mcp-handler.js` + `site-policy.js:isAllowed`). Fixes regression introduced 2026-05-17 (commit `4009982`) where new installs and cleared chrome.storage triggered block-all with no in-extension UI to recover. (#80)
- fix(server): guard schema migration 001 against the missing `config` table on a brand-new database. (#96)
  - In v2.2.0, fresh installs failed SQLite init and could not pair agents; upgraded installs were not affected.
  - No user action is needed once updated.
  - The daemon now exits with code 1 when SQLite init fails instead of running without a database while `/health` still responded.
- Site-policy gate fails closed when check cannot complete (exception, disconnected extension, unreadable URL). Returns `{ "ok": false, "error": "site policy check failed", "reason": "...", "message": "..." }` with codes: `policy_error`, `extension_disconnected`, `tab_url_unavailable`, `invalid_tab_id`, `invalid_url`. Not recorded in site policy event log. (#100)
- Tab-scoped tools with disconnected extension: reason `extension_disconnected` (not JSON-RPC `-32000`); message text unchanged. (#100)
- `tab_id` must be an integer (not missing or numeric-string like `"7"`). Non-integer rejected with `invalid_tab_id`. (#100)
- `browser_create_tab` rejects non-string `url` with `invalid_url`. Missing or empty `url` still fails in extension. (#100)
- `browser_request_chain`: failed policy check returns the error envelope as step result; later steps run. (#100)
- Failed global blocklist update (network, bad signature, missing file) no longer empties the blocklist. (#101)
  - Existing rows kept; next daily check retries.
  - Fresh installs show "updated never" (not version `0` "updated just now").
  - Broken installs recover on successful fetch.
- Status API's `globalSiteBlocklist` adds `lastCheckedAt` and `lastCheckError` (in-memory since daemon start) to show failed or cache-served checks. (#101)
- Modals center on viewport with full-page backdrop via portal into `document.body` (not triggering card). (#119)
- `browser_create_tab` no longer opens a blank window when Chrome is running and the extension is slow or disconnected. (#132)
  - One connect wait: 10s when Chrome is running, 15s after a launch or restart, with a 3s grace before spawning.
  - Chrome launches with the target URL and the launched tab is found via `get_tabs`.
  - Returns accurate errors for partial, timeout, unknown and abort outcomes instead of a misleading one.
- Extension reconnects after the MV3 service worker sleeps, via a 30s `chrome.alarms` heartbeat. Identify retries at 3s/10s/30s replace sitting idle on `identify_required`. (#132)
- Extension `create_tab` validates URLs up front, retries without stale window bounds, and no longer leaves an empty window behind. Non-fatal post-create failures return a `warning`. (#132)
- A new Chrome profile with no Google account no longer gets stuck on "Install ID not recognized by server" when another signed-out profile is closed. (#138)
- A workflow error raised after a swallowed site-policy block is no longer masked by the policy envelope. The real error is returned with `policyBlocked` attached and recorded as a formatter error. (#133)
- Commands in flight on a replaced extension socket are rejected immediately with "Extension connection replaced" instead of waiting out the 30s timeout. (#134)
- `/connect` `sseUrl` and `/api/popup/state` `serverUrl` are always loopback, and the extension rewrites a stale non-loopback stored `serverUrl` to `ws://localhost:<port>`. (#136)
- Extension reconnect race: a late close of a replaced socket after `identify_timeout` no longer leaves `identifyReconnectPending` set (which made the next socket's close skip its retry), and auto-connect keeps exactly one retry interval. (#141)

## [1.1.8]

### Added
- Electron shell — tray + splash window, single platform-appropriate `userData` path, multi-resolution RGBA icons.
- UI — connecting splash held until the daemon responds; readable dark dropdowns.
- Server — ships the `better-sqlite3` native binding alongside the app; legacy `userData` migration on first launch.
- CI — manual release workflows replace the previous label-gated flow.
- Open-source repository scaffolding: `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and this `CHANGELOG.md`.

### Fixed
- Installer — kill running processes on install/uninstall to make upgrades safe; `installer.nsh` now tracked in the repo.

### Removed
- Internal task tracking and design docs that lived in the repo during pre-1.0 development (`OPEN_ITEMS.md`, the P2 redesign design doc, the auth audit doc). The decisions they captured are now reflected in the live architecture docs and the code.

## [1.1.1]

Internal pre-1.0 development. Notable architectural milestones from this period:

- Auth model overhaul — retired the shared transport key in favour of per-profile installId identity + per-agent paired API keys.
- SQLite migration — moved per-profile state, paired agents, pending pairings, site policy, and formatter incident logs out of JSON files into a single SQLite database with WAL mode.
- Minimal popup redesign — Block/Allow toggle and pairing prompts surfaced in the extension popup.
- Dashboard pivot — replaced the four-up KPI grid with an Action Items section that surfaces pending pairings + formatter errors inline.
- Baseline blocklist — bundled financial-institution blocklist with hourly auto-update from GitHub, local-cache fallback chain for offline resilience.

[Unreleased]: https://github.com/Jtonna/WebPilot/compare/v1.1.8...HEAD
[1.1.8]: https://github.com/Jtonna/WebPilot/compare/v1.1.1...v1.1.8
[1.1.1]: https://github.com/Jtonna/WebPilot/releases/tag/v1.1.1
