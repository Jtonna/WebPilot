# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Site policy event log: one row per agent + domain that an agent's browser tools were checked against (domain only, no path). Repeat checks bump a hit count and last-seen time; when the verdict changes the row flips in place, with no history rows. Default allows are logged too. Rows are pruned after 30 days or beyond 5,000 rows, at boot and hourly. Stored in the new `site_policy_events` table. (#103)
- `GET /api/ui/sites/events`: paginated read API for the log (filter by agent and decision), including whether the domain can be targeted by a per-agent rule and the agent's current rule for it. (#103)
- `POST /api/ui/agents/:agentId/site-events/allow` and `.../revoke`: create a per-agent allow or block rule for a logged domain. Revoke always creates a block for that agent only and never deletes an allow rule (a same-domain per-agent allow is overwritten in place). (#103)
- New WebSocket event `site_policy_events_changed`, emitted when a row is created, its decision flips, or retention removes rows (not on every hit). (#103)

### Changed
- Site rules are now stored per tier (per-agent, global user, signed global blocklist). User rules no longer overwrite or mask signed blocklist entries; removing a user rule immediately restores signed-list behavior. (#102)
- The global toggle now disables the whole global tier (signed blocklist AND global user rules). Users who had the toggle off will find their global user rules inactive until they turn it back on. Per-agent rules are unaffected. (#102)
- Config key renamed `global_site_blocklist_enabled` → `global_tier_enabled`; web UI route renamed `POST /api/ui/sites/global-site-blocklist/toggle` → `POST /api/ui/sites/global-tier/toggle`; WebSocket reason `global_site_blocklist_toggle` → `global_tier_toggle`. (#102)
- Per-agent `*` wildcard rule: named domains beat `*`. A `*` rule also applies to IP addresses and single-label hosts such as localhost, which cannot currently be exempted with a named per-agent rule. (#102)
- The signed blocklist is re-fetched once after upgrading (migration 002 marks the stored version as `pre-002:<version>` until the next successful fetch; that string is visible in the status API until then). (#102)
- The extension popup's site toggle still writes global user rules; while the global tier is off, a popup block has no effect. The popup API now reports `globalTierEnabled`. Popup rework is tracked in #105. (#102)
- Sites page redesigned: a two-column layout with an "Enable Global Block List" card (toggle plus a "View / manage list" modal grouping your allows, your blocks, and the signed list, with search and paging) beside a "Per-agent rules" card (agent picker, rule list, and an add form that accepts `*` as the agent-wide default). Below both, a "Site access log" table lists every domain each agent has been checked against, with "Allow for this agent" and "Revoke for this agent" actions. Allow requires typing `i understand`; Revoke creates a block for that agent only. (#104)
- Per-agent tier renamed from "overrides" to "rules" in lockstep: table `agent_site_overrides` → `agent_site_rules` (migration 003 runs automatically, keeps all rules, and drops the redundant `idx_agent_overrides` index); web UI routes `/api/ui/agents/:agentId/site-overrides[/:domain]` → `/api/ui/agents/:agentId/site-rules[/:domain]`; WebSocket `sites_changed` reasons `agent_override_upsert|delete` → `agent_rule_upsert|delete`. (#104)
- MCP clients: the `policySource` value in a blocked-site response changes from `agent_override` to `agent_rule`. The `site_policy_events` table is rebuilt with the new `source` value. (#104)
- Confirmation dialogs no longer confirm on Enter; Enter only activates the focused button. Escape still cancels. (#104)
- The web UI event stream client now emits `reconnected` after a dropped connection so pages can refetch state missed during the gap. (#104)
- The extension popup's site toggle now goes through the same server code as the Sites page (`upsertGlobalUserRule`), including rejecting `*` with the same explanation. No popup-only policy logic remains. `POST /api/popup/site-toggle` also accepts `decision` alongside `action`; its error bodies now carry `{ error, reason }`. (#105)
- Popup: the pill now says whether the verdict comes from your own rule ("Allowed (your rule)" / "Blocked (your rule)" / "Blocked (global block list)"), shows a "Rule on <domain>" line when a parent-domain rule matched, and disables the toggle with an explanation while global rules are off. `GET /api/popup/state` adds `currentTab.matchedDomain`. (#105)

### Removed
- The unreachable "Override · Allowed / Blocked" popup pills and the unused "Agent:" line. The popup shows the global policy for the Chrome profile only; per-agent rules live on the Sites page. (#105)

### Fixed
- fix(extension): remove orphaned client-side whitelist gate — site-policy enforcement is now server-side only (`mcp-handler.js` + `site-policy.js:isAllowed`). Fixes regression introduced 2026-05-17 (commit `4009982`) where new installs and cleared chrome.storage triggered block-all with no in-extension UI to recover. (#80)
- fix(server): guard schema migration 001 against the missing `config` table on a brand-new database. In v2.2.0, fresh installs failed SQLite init and could not pair agents; upgraded installs were not affected. No user action is needed once updated. The daemon now exits with code 1 when SQLite init fails instead of running without a database while `/health` still responded. (#96)

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
