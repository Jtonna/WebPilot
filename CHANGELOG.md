# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Site policy event log: one row per agent + domain (domain only, no path). Repeat checks update a hit count and last-seen time. Verdict changes update in place (no history rows). Default allows are logged. Rows purge after 30 days or beyond 5,000 rows (at boot and hourly). Stored in `site_policy_events` table. (#103)
- `GET /api/ui/site-policy/events`: paginated read API for the log (filter by agent, decision). Returns whether the domain can be targeted by a per-agent rule and the agent's current rule for it. (#103)
- `POST /api/ui/agents/:agentId/site-events/allow` and `.../revoke`: create a per-agent allow or block rule for a logged domain. Revoke always creates a block for that agent only and never deletes an allow rule (a same-domain per-agent allow is overwritten in place). (#103)
- WebSocket event `site_policy_events_changed`: emitted when a row is created, its decision flips, the deciding rule/source changes, or retention removes rows (not on every hit). (#103)

### Changed
- Site rules stored per tier: per-agent, global user, signed global blocklist. User rules no longer mask signed blocklist entries; removing a user rule restores signed-list behavior. (#102)
- Global toggle disables the whole global tier (signed blocklist + global user rules). Users with toggle off find global user rules inactive until re-enabled. Per-agent rules unaffected. (#102)
- Renamed: config key `global_site_blocklist_enabled` → `global_tier_enabled`; route `POST /api/ui/sites/global-site-blocklist/toggle` → `POST /api/ui/site-policy/global-tier/toggle`; WebSocket reason `global_site_blocklist_toggle` → `global_tier_toggle`. (#102)
- Per-agent `*` wildcard rule: named domains take precedence. `*` matches IP addresses and single-label hosts (localhost) but cannot be exempted by named rules. (#102)
- Migration 002 marks the blocklist version `pre-002:<version>` for users with global user rules. Next successful fetch re-applies the signed list (restoring any masked domains). Prefixed string stays visible in status API until then. (#102)
- Extension popup's site toggle writes global user rules. API now reports `globalTierEnabled`. (#102)
- Site Policy page redesigned: global block list and per-agent rules cards, site access log with Allow/Revoke actions, reusable rules modal. (#104, #119)
- Per-agent tier renamed "overrides" → "rules". Renamed: table `agent_site_overrides` → `agent_site_rules` (migration 003 auto-runs, keeps all rules, drops redundant `idx_agent_overrides` index); routes `/api/ui/agents/:agentId/site-overrides[/:domain]` → `/api/ui/agents/:agentId/site-rules[/:domain]`; WebSocket reasons `agent_override_upsert|delete` → `agent_rule_upsert|delete`. (#104)
- MCP clients: `policySource` value changes `agent_override` → `agent_rule` in blocked-site responses. `site_policy_events` table rebuilt with new `source` value. (#104)
- Confirmation dialogs: Enter activates only the focused button; Escape cancels. No Enter-to-confirm. (#104)
- Web UI event stream emits `reconnected` after connection drops, letting pages refetch missed state. (#104)
- Extension popup's site toggle uses the same server code as Site Policy page (`upsertGlobalUserRule`), rejecting `*` identically. No popup-only policy logic. `POST /api/popup/site-toggle` accepts `decision` alongside `action`; errors return `{ error, reason }`. (#105)
- Popup pill shows verdict source: "Allowed (your rule)" / "Blocked (your rule)" / "Blocked (global block list)". Shows "Rule on <domain>" for parent-domain matches. Disables toggle when global rules off. `GET /api/popup/state` adds `currentTab.matchedDomain`. (#105)
- "Sites" renamed "Site Policy" (breaking change). Web UI page `/ui/sites/` → `/ui/site-policy/` (nav label). Routes: `GET/POST /api/ui/sites` → `GET/POST /api/ui/site-policy/global-rules`; `DELETE /api/ui/sites/:domain` → `DELETE /api/ui/site-policy/global-rules/:domain`. WebSocket `sites_changed` → `site_policy_changed` (reason codes unchanged). Server log `[ui-api:sites]` → `[ui-api:site-policy]`. Per-agent routes `/api/ui/agents/:agentId/site-rules` and `.../site-events/allow|revoke`, and `POST /api/ui/site-policy/global-tier/toggle` (already renamed under #102), are unchanged. Breaks anything calling UI API or listening for `sites_changed`. (#119)
- Site Policy page redesigned: two-column → compact strip of two small cards (Global block list, Per-agent rules) each with `Manage` button above Site access log. Manage buttons open one reusable `RulesModal` (global or agent scope) whose list, add and delete-confirm views replace each other in a fixed-height shell, so only the list scrolls. Log columns: Domain (sub-line: source · matched-domain · hit-count; `default` = "No rule (allowed by default)"), Agent (links to `/ui/agents/?agent=<key>`), Status (green = approved, red = blocked), Last seen, Action. Agents page supports `?agent=<key>` query filter. (#119)
- `Allow for this agent` requires a 4-character confirmation code (case-insensitive). Code regenerates on each open. (#119)

### Removed
- Unreachable "Override · Allowed / Blocked" popup pills and unused "Agent:" line. Popup shows global policy (Chrome profile only); per-agent rules moved to Site Policy page. (#105)

### Fixed
- Tab switching: no reload, no "Connecting…" splash. Links navigate in-app. Splash shows only until first connection. Side menu highlights current page. (#121)
- fix(extension): remove orphaned client-side whitelist gate — site-policy enforcement is now server-side only (`mcp-handler.js` + `site-policy.js:isAllowed`). Fixes regression introduced 2026-05-17 (commit `4009982`) where new installs and cleared chrome.storage triggered block-all with no in-extension UI to recover. (#80)
- fix(server): guard schema migration 001 against the missing `config` table on a brand-new database. In v2.2.0, fresh installs failed SQLite init and could not pair agents; upgraded installs were not affected. No user action is needed once updated. The daemon now exits with code 1 when SQLite init fails instead of running without a database while `/health` still responded. (#96)
- Site-policy gate fails closed when check cannot complete (exception, disconnected extension, unreadable URL). Returns `{ "ok": false, "error": "site policy check failed", "reason": "...", "message": "..." }` with codes: `policy_error`, `extension_disconnected`, `tab_url_unavailable`, `invalid_tab_id`, `invalid_url`. Not recorded in site policy event log. (#100)
- Tab-scoped tools with disconnected extension: reason `extension_disconnected` (not JSON-RPC `-32000`); message text unchanged. (#100)
- `tab_id` must be an integer (not missing or numeric-string like `"7"`). Non-integer rejected with `invalid_tab_id`. (#100)
- `browser_create_tab` rejects non-string `url` with `invalid_url`. Missing or empty `url` still fails in extension. (#100)
- `browser_request_chain`: failed policy check returns the error envelope as step result; later steps run. (#100)
- Failed global blocklist update (network, bad signature, missing file) no longer empties the blocklist. Existing rows kept; next daily check retries. Fresh installs show "updated never" (not version `0` "updated just now"). Broken installs recover on successful fetch. (#101)
- Status API's `globalSiteBlocklist` adds `lastCheckedAt` and `lastCheckError` (in-memory since daemon start) to show failed or cache-served checks. (#101)
- Modals center on viewport with full-page backdrop via portal into `document.body` (not triggering card). (#119)

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
