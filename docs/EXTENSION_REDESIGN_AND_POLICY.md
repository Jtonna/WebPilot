# Extension Redesign + SQLite + Site Policy

**Status:** Design — not yet implemented. Tracks P2 work scoped 2026-05-17.
**Branch target:** TBD. Likely cut a feature branch off `QOL-Features` once the open P1 swarm is merged.
**Supersedes:** the draft in `docs/SQLITE_MIGRATION_DESIGN.md` (worktree commit `6826e08`, not yet merged). When we cherry-pick the DOCS agent's worktree back, we'll drop that file in favor of this one — most of its schema work is folded in below with revised scope.

---

## Goals

Three intertwined things landing as one cohesive change:

1. **SQLite migration.** Move durable state from JSON files under `<dataDir>` into a single SQLite database. Keeps high-volume append-only logs (server log, ring-buffer formatter logs) on the filesystem.
2. **Chrome extension redesign.** Strip the extension UI to a minimal status-and-escape-hatch panel, theme-match the webapp, move all admin into the webapp.
3. **Site policy model.** Per-site Allow/Block with per-agent overrides, server-side enforcement at every tool call, auto-close for tabs that land on blocked sites, baseline blocked list (financial institutions etc.) auto-updated from GitHub.

These are entangled — the new policy model needs new DB tables; the new extension popup queries those tables; the redesigned webapp's Sites page is the admin surface for them — so they ship together.

## Non-goals

- Rewriting the extension's handler internals (click.js / keyboard.js / accessibility.js stay where they are). That was the dropped "V2 thin scaffolding" idea — out of scope.
- Cross-device sync. Single-machine for now.
- Multi-user role-based auth on the webapp. The webapp is single-user-localhost, same as today.
- A formal schema-migration framework (alembic-style). Hand-rolled per-version code is fine for now; revisit if we hit a third migration.

---

## SQLite migration

### What goes IN the database

Durable state that needs ACID, indexed lookup, audit trail, or atomic multi-write:

- `agents` — per-agent identity, paired-key hash, profile binding, created_at, last_seen_at.
- `pairings` — pending/approved/denied/expired state machine. Replaces `paired-keys.json` + `pending-pairings.json`. Hashes the API key at rest (free win during the migration; today they're stored plain).
- `agent_site_overrides` — `(agent_id, domain, decision)`. Per-agent exception to the global rule.
- `global_site_rules` — `(domain, decision, source)`. The user's global Allowed/Blocked list, plus rows imported from the baseline blocklist tagged with `source='baseline'`.
- `baseline_blocklist_meta` — `(version, last_fetched_at, source_url)`. Tracks the auto-updated baseline.
- `formatter_incidents` — every formatter or workflow error, durable across server restart. Per-incident `dismissed_at`. **Replaces** the in-memory ring buffer's role as the source of truth.
- `config` — small KV table (`network_enabled`, `managed_profile`, port preference, etc.).
- `extension_installs` — per-(profile, install_id) tracking.

### What stays on the filesystem

- `daemon.log` — server stdout/stderr, rotated. Append-only, big, never queried.
- An in-memory cache of the most recent ~10 `formatter_incidents` per formatter. See "Cache layer" below.

### What we explicitly do NOT migrate

- The `network.enabled` flag file isn't migrated as-is; it becomes a row in `config`. The flag file gets removed on first boot of the new version after import (see "Backward compat" below).

### Cache layer (per the user's clarification)

`formatter_incidents` is the durable record but reads should be fast. Pattern:

- Server module `formatter-logs.js` keeps an **in-memory cache** keyed by formatter name. Capacity: 10 most recent incidents per formatter.
- On server boot: cache hydrates from `SELECT … FROM formatter_incidents WHERE formatter=? ORDER BY occurred_at DESC LIMIT 10` for each known formatter.
- On every new error: write-through to DB + prepend to cache + evict oldest if over capacity.
- `webpilot_dev_get_formatter_logs` (MCP tool) and `/api/ui/formatters/:name/logs` (UI endpoint) read from the cache by default. If the caller wants more history (e.g. for the GitHub issue body in the Report button), they pass `from_db: true` and the server queries the DB directly.

This preserves today's fast in-process read path while gaining durability across restarts.

### Schema sketch

```sql
-- Agents and pairing
CREATE TABLE agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,       -- argon2id or scrypt; never store plain
  profile_id TEXT,                          -- 'Default' / 'Profile 2' / etc.
  created_at TEXT NOT NULL,                 -- ISO 8601
  last_seen_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','revoked'))
);
CREATE INDEX idx_agents_profile ON agents(profile_id);
CREATE INDEX idx_agents_api_key_hash ON agents(api_key_hash);

CREATE TABLE pairings (
  id INTEGER PRIMARY KEY,
  pairing_id TEXT NOT NULL UNIQUE,          -- the public ID we hand to the agent
  agent_name TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','expired')),
  approved_agent_id INTEGER REFERENCES agents(id),
  metadata_json TEXT                        -- agent_name notes, source IP, etc.
);
CREATE INDEX idx_pairings_state ON pairings(state, requested_at DESC);

-- Site policy
CREATE TABLE global_site_rules (
  domain TEXT PRIMARY KEY,                  -- normalized (lowercased, no scheme, no port)
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  source TEXT NOT NULL CHECK(source IN ('user','baseline')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_site_overrides (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,                     -- normalized
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, domain)
);
CREATE INDEX idx_agent_overrides ON agent_site_overrides(agent_id, domain);

CREATE TABLE baseline_blocklist_meta (
  id INTEGER PRIMARY KEY CHECK(id=1),       -- single row table
  version TEXT NOT NULL,
  last_fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  domain_count INTEGER NOT NULL
);

-- Formatter incidents (audit trail for action items)
CREATE TABLE formatter_incidents (
  id INTEGER PRIMARY KEY,
  formatter TEXT NOT NULL,                  -- 'discord', 'threads', etc.
  occurred_at TEXT NOT NULL,                -- ISO 8601
  phase TEXT NOT NULL CHECK(phase IN ('format','workflow')),
  workflow TEXT,                            -- null for phase='format'
  message TEXT NOT NULL,
  stack_truncated TEXT,                     -- ~1024 chars
  params_json TEXT,                         -- workflow params for repro
  tab_id INTEGER,
  dismissed_at TEXT,
  dismissed_by TEXT                         -- agent_name that dismissed; 'user' for UI dismiss
);
CREATE INDEX idx_incidents_formatter_time ON formatter_incidents(formatter, occurred_at DESC);
CREATE INDEX idx_incidents_undismissed ON formatter_incidents(dismissed_at) WHERE dismissed_at IS NULL;

-- KV settings
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE extension_installs (
  install_id TEXT PRIMARY KEY,
  profile_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
```

### Driver choice

`better-sqlite3` (synchronous, fast, single-process model fits our use case perfectly). Risk: pkg native-module compatibility — we ship via `@yao-pkg/pkg` and native binaries can be finicky. Mitigation: bundle the prebuilt `.node` binary explicitly in the pkg asset config, smoke-test the produced binary on a fresh Windows VM before shipping.

If pkg integration turns into a multi-day debug, the fallback is `node:sqlite` (built-in as of Node 22) — but that requires bumping our pkg target to Node 22, which has its own ecosystem risk. Try better-sqlite3 first.

### Backward compatibility (user upgrade path)

On first boot of the new version:

1. Server checks if `<dataDir>/webpilot.db` exists. If yes, skip the rest.
2. Else: create the DB with the schema above.
3. For each known JSON store under `<dataDir>` (paired-keys.json, pending-pairings.json, formatter-logs.json, server.json, extension-installs.json, network.enabled flag file):
   - If present, parse + import its contents into the corresponding table(s).
   - Rename the original file to `<name>.json.imported.<ISO timestamp>` (do NOT delete — let the user clean up if they want; gives us a recovery path if the import had a bug).
4. Log a one-line summary: `[migration] imported N pairings, M incidents, K rules from JSON stores → SQLite.`
5. On subsequent boots, the `.imported` files are ignored. We rely on the DB.

---

## Site policy model

### The rule

For any (agent, tab URL) decision:

1. Normalize the URL's hostname to a lowercase domain (no scheme, no port, drop `www.` for matching).
2. Look up `agent_site_overrides(agent_id=<agent>, domain=<domain>)`. If a row exists, its `decision` wins.
3. Else, look up `global_site_rules(domain=<domain>)`. If a row exists, its `decision` wins. Distinguish `source='user'` (user-set in the webapp or popup) vs `source='baseline'` (came from the baseline GitHub list).
4. Else, default to `allow`.

Subdomain matching: a rule on `chase.com` covers `www.chase.com`, `secure.chase.com`, etc. A rule on `secure.chase.com` only covers exactly that subdomain (or `www.secure.chase.com`). Standard public-suffix-aware suffix match.

### Baseline blocklist (the financial-institutions pack)

- Hosted in a GitHub repo (likely a sibling `WebPilot-blocklists` or a subdirectory of the main repo — TBD). Format follows the de-facto Windows hosts-file standard:
  ```
  # WebPilot baseline blocklist - financial-institutions
  # version: 2026-05-17
  0.0.0.0 chase.com
  0.0.0.0 bankofamerica.com
  0.0.0.0 wellsfargo.com
  …
  ```
  (The `0.0.0.0` prefix is the hosts-file convention; we just strip it on parse. Comments start with `#`. Compatible with off-the-shelf blocklist tooling.)
- Initial pack: the major US banks (top 30 by deposits), major brokerages (Schwab, Fidelity, Vanguard, Robinhood, etc.), credit unions (top 10), and a few international (HSBC, Barclays). Aim for ~100-200 domains in the first ship.
- Server's `blocklist-updater.js` (mirror of `formatter-updater.js`) fetches on boot + every 24 h. Successful fetch updates the `global_site_rules` table: removes rows where `source='baseline'` and inserts the new list. User's `source='user'` rules are never touched.
- The user can disable the baseline pack entirely via a toggle in the webapp settings (`config` table: `baseline_blocklist_enabled = false`). When disabled, the updater still runs but doesn't write to the DB.

### Server-side enforcement (per the user's clarification)

Enforcement runs on the server, NOT in the extension. The extension just relays commands.

Two enforcement checkpoints:

**A. `browser_create_tab(url)`**
Server normalizes `url`'s hostname and runs the policy check. If blocked, return an MCP error immediately:
```json
{ "ok": false, "error": "site blocked by policy", "domain": "chase.com", "policySource": "baseline" }
```
The tab is never opened.

**B. Every tool that operates on an existing `tab_id`** (`browser_click`, `browser_type`, `browser_scroll`, `browser_get_accessibility_tree`, `browser_inject_script`, `browser_execute_js`, `webpilot_run_workflow`):
Server fetches the current URL of the tab (via existing `browser_get_tabs` data, cached) and runs the policy check. If blocked, return:
```json
{
  "ok": false,
  "error": "site blocked by policy",
  "domain": "chase.com",
  "policySource": "baseline",
  "tabId": 1234,
  "tabWillCloseAt": "2026-05-17T14:30:05.000Z",
  "tabCloseInSeconds": 5
}
```
Server schedules `chrome.tabs.remove(tab_id)` via the extension after the countdown. The agent sees the error response, knows the tab is going away, and doesn't have to clean up itself.

`browser_get_tabs` (the listing call) is always allowed — agents can see what's open, including blocked tabs, but can't interact with them. Otherwise we'd hide existence of tabs the user navigated to manually, which is confusing.

`browser_close_tab(tab_id)` is also always allowed — agents should be able to close any tab they can see.

### Subtlety: navigation via click

If `mysite.com` has a link to `chase.com` and the agent calls `browser_click(linkRef)`:
- The click itself succeeds (we just dispatch mouse events; we can't predict where the click goes).
- The tab navigates to `chase.com`.
- The agent's NEXT tool call against that tab (e.g. `browser_get_accessibility_tree`) hits the policy check, gets the blocked error, and the tab is scheduled for auto-close.

This is the model the user described and is correct: enforcement at the call layer, with cleanup. We don't try to predict navigations.

---

## Chrome extension redesign

### Scope

The extension does **less**. All admin moves to the webapp. The popup is a minimal status-and-escape-hatch panel themed to match the webapp.

### What the popup shows

Four things, nothing else:

1. **Connection status** — green/yellow/red dot + one-word label (`Connected` / `Reconnecting` / `Disconnected`). Click reveals which profile and the server URL underneath.
2. **Current tab** — one line: domain name + state pill (`Allowed` / `Blocked (baseline)` / `Blocked (user)` / `Override: Allowed for this agent`). If the agent is currently paired, also shows which agent.
3. **Per-site toggle** — single primary button. If the current site's state is `Allowed`, button reads "Block on this site (all agents)". If `Blocked`, button reads "Allow on this site (all agents)". One click toggles the global rule. **Scope is global** per the locked decision — the popup is the "I don't want any AI touching this site" fast button. Per-agent fine-tuning happens in the webapp Sites page.
4. **Open dashboard** — button that opens `http://localhost:<port>/ui/` in a new tab.

The popup removes everything else that's currently there: agent rename, profile picker, pairing requests, notes, badges. All of that moves to the webapp.

### Theme

Match the webapp's dark theme (`#0a0a0a` background, `#e5e5e5` text, system font stack). Reuses the same CSS variables/classes where possible so the visual identity is one cohesive thing. Specific shared elements: the connection status dot uses the same `.wp-dot-*` classes the webapp's dashboard already has; the primary button uses `.wp-btn-primary`.

### What moves to the webapp

- Agent management (rename, revoke key, mode — though we dropped modes, so just rename/revoke) → new tab on the webapp's Agents page.
- Sites management (global rules, per-agent overrides, baseline pack on/off) → new "Sites" tab.
- Pairing approve/deny — already in webapp at `/pairings`.
- Profile picker — already in webapp at `/profiles`.

### Files affected

- `packages/chrome-extension-unpacked/popup/popup.html` — gutted, replaced with the 4-component layout.
- `packages/chrome-extension-unpacked/popup/popup.js` — slimmed; only needs to fetch status + current-tab policy + handle the one toggle button + the open-dashboard link.
- `packages/chrome-extension-unpacked/popup/popup.css` — rewritten to match webapp theme.
- `packages/chrome-extension-unpacked/manifest.json` — version bump.
- `packages/server-web-ui/app/sites/page.js` — NEW. Two sections: global rules table + per-agent overrides (selected via dropdown).
- `packages/server-web-ui/app/agents/page.js` — gets a "Site overrides" sub-section per agent.
- Existing extension files we're NOT touching: `background.js`, `handlers/*`, anything under `utils/`. The redesign is UI-only at the extension level.

---

## Action items UX

### Dismiss model (per the user's locked decision)

Per-incident. Each row in the dashboard's Action Items list is one `formatter_incidents` row with `dismissed_at IS NULL`. Clicking Dismiss sets `dismissed_at = now()` and the row goes away. New errors from the same formatter appear as new rows.

### Header + bulk action (per user's clarification)

The Action Items section header shows a count badge:
```
Action items (12)                                    [Dismiss all]
```
"Dismiss all" applies to the currently-rendered list (after any filters): bulk-update sets `dismissed_at = now()` for all undismissed incidents. Confirmation modal: "Dismiss 12 action items?" so it's not a one-misclick disaster.

Optional follow-up: per-formatter "Dismiss all from <formatter>" button at the top of each formatter's incident group, if we group incidents by formatter in the UI. The DB shape supports either rendering.

### Cache + reads

UI fetches via `GET /api/ui/action-items` which queries the cache (10 recent per formatter) + filters `dismissed_at IS NULL`. For full history, the per-formatter logs page (`/ui/formatters/logs/?name=X`) queries the DB directly with pagination.

---

## Phased migration plan

Each phase is one or two commits, independently testable.

**Phase 1 — DB layer, no behavior change.**
- Add `better-sqlite3` dep, bundle prebuilt for pkg.
- Create `packages/server-for-chrome-extension/src/db/` with `schema.sql`, `connection.js` (opens the file, runs PRAGMAs for WAL mode), and the migration-on-first-boot logic.
- Server boots, runs schema, doesn't touch JSON yet. Verify the DB file gets created and the import path runs cleanly on a copy of real `<dataDir>`.

**Phase 2 — Migrate `paired-keys` to DB.**
- Replace `paired-keys.json` + `pending-pairings.json` reads/writes with DB queries.
- First-boot import: parse existing JSON, populate `agents` + `pairings` tables, rename JSON to `.imported`. Hash API keys at rest during import.
- All existing pairing flows (request → approve → use → revoke) must keep working unchanged from the agent's POV.

**Phase 3 — Migrate formatter incidents.**
- New `formatter_incidents` table populated on every `recordError` call. In-memory cache hydrates from DB on boot. Pruning: daily `DELETE WHERE dismissed_at IS NOT NULL AND dismissed_at < now()-90 days`.
- Update `webpilot_dev_get_formatter_logs` and the UI logs page to read from cache first, DB on demand.
- Drop the JSON ring buffer; the in-memory cache replaces it.

**Phase 4 — Site policy plumbing.**
- New tables: `global_site_rules`, `agent_site_overrides`, `baseline_blocklist_meta`.
- New `blocklist-updater.js` module fetching from GitHub. Boot fetch + 24h interval.
- Initial GitHub repo + the curated financial-institutions list. Hosts.txt format.
- Server-side enforcement function `isAllowed(agentId, url) → {allowed, source, decision}`. Add it as a check at the top of every `browser_*` handler in `mcp-handler.js`.
- Auto-close scheduler: blocked tab → `setTimeout(() => extensionBridge.send(profile, 'close_tab', {tab_id}), 5000)`.

**Phase 5 — Webapp Sites page.**
- New `/ui/sites/` route. Two sections: Global rules (CRUD on `global_site_rules` rows with `source='user'`) and Per-agent overrides (agent dropdown → that agent's `agent_site_overrides`).
- Setting toggle for the baseline pack.

**Phase 6 — Extension redesign.**
- Gut `popup.html`/`.js`/`.css`. Implement the 4-component layout.
- Theme matches webapp. Bump extension version.
- One-time-per-profile reload required to install the new popup.

**Phase 7 — Cleanup.**
- Drop the old JSON-handling code paths from `paired-keys.js`, `formatter-logs.js`, `server.js`.
- Move any remaining `.json` files in `<dataDir>` into `config` rows or delete them.
- Update `docs/MCP_SERVER.md`, `docs/CHROME_EXTENSION.md`, `accessibility-tree-formatters/DEV_GUIDE.md` to reflect the new state.

---

## Risks + open questions

- **pkg + better-sqlite3 native binary.** Could cost a half-day to get right. Mitigation: dry-run on a fresh Windows machine before merging Phase 1.
- **First-boot import correctness.** If we mis-parse an existing JSON file, we could lose state. Mitigation: the rename-to-`.imported` strategy keeps the originals; we add a `--reimport` CLI flag for recovery.
- **Subdomain matching semantics for site policy.** Public-suffix-aware is the right answer but adds a dependency (the `psl` npm package). Acceptable.
- **WAL mode sidecar files.** SQLite WAL produces `webpilot.db-wal` + `webpilot.db-shm` alongside `webpilot.db`. Confirm none of our backup/zip flows assume single-file dataDir state.
- **Extension popup state freshness.** The popup queries the server for the current site's state every time it opens. If the server is down, the popup shows "Disconnected" and disables the toggle. Acceptable. No need for a local cache.
- **Open question: per-formatter "Dismiss all" in the UI?** The bulk action covers "Dismiss all visible." If the UI groups by formatter, we could also offer "Dismiss all from discord." Defer until we see how the list looks in practice.
- **Open question: revocation flow.** "Revoke" on an agent today is implicit (just delete the entry from `paired-keys.json`). With a DB, we have a real state machine — soft-delete (`state='revoked'`) gives us a revocation audit log. Worth implementing in Phase 2.

---

## Acceptance criteria

Per phase:
1. DB layer: server boots, `webpilot.db` exists, schema is up.
2. Pairings migrated: existing paired agents continue working after upgrade. New pairings flow through the DB. Old `paired-keys.json` is renamed.
3. Formatter incidents: trigger an error from a formatter, restart the server, the incident is still there. Dismiss it. Restart again. Still dismissed.
4. Site policy: with the baseline pack enabled, calling `browser_create_tab('https://chase.com')` returns a blocked error. Calling `browser_click` on a link that navigates to a blocked site succeeds, then the next tool call returns a blocked error with a countdown, and the tab actually closes ~5 s later.
5. Sites page: CRUD on global rules works. Per-agent overrides override the global rule for that agent only.
6. Extension popup: 4 components, theme-matched, the Block/Allow toggle on the current tab actually flips `global_site_rules` for that domain.
7. Cleanup: no stale `paired-keys.json` / `pending-pairings.json` / `formatter-logs.json` paths in the code after Phase 7.

End-to-end: a fresh install on a new machine should boot, pair an agent, demonstrate blocking on a baseline-blocked site (chase.com), allow on a user-added rule, override per-agent, and dismiss a formatter incident — all without touching any JSON file.
