-- WebPilot SQLite schema.
-- All CREATEs use IF NOT EXISTS so connection.js can run this idempotently
-- on every boot. Hand-rolled per-version migration code lives in
-- src/db/schema-migrations/; this file is the ground-truth.

-- ─── Agents and pairing ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,       -- argon2id or scrypt; never store plain
  profile_id TEXT,                          -- 'Default' / 'Profile 2' / etc.
  created_at TEXT NOT NULL,                 -- ISO 8601
  last_seen_at TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','revoked'))
);
CREATE INDEX IF NOT EXISTS idx_agents_profile ON agents(profile_id);
CREATE INDEX IF NOT EXISTS idx_agents_api_key_hash ON agents(api_key_hash);

CREATE TABLE IF NOT EXISTS pairings (
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
CREATE INDEX IF NOT EXISTS idx_pairings_state ON pairings(state, requested_at DESC);

-- ─── Site policy ──────────────────────────────────────────────────────────

-- Site policy is tiered; each tier owns its own table so a row in one tier
-- can never mask or overwrite a row in another:
--   * agent_site_rules            per-agent rules tier. `domain` may be the
--                                 literal '*' (agent-wide default decision).
--   * global_user_site_rules      global tier, rules the user set by hand.
--                                 Exact domains only (no '*').
--   * global_site_blocklist_rules global tier, domains from the signed global
--                                 site blocklist bundle. Block-only; rewritten
--                                 wholesale by global-site-blocklist-updater.
-- The config key `global_tier_enabled` switches the whole global tier (both
-- global_* rule tables) on or off.
-- All `domain` columns are normalized (lowercased, no scheme, no port).

CREATE TABLE IF NOT EXISTS global_user_site_rules (
  domain TEXT PRIMARY KEY CHECK(instr(domain, '*') = 0),
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_site_blocklist_rules (
  domain TEXT PRIMARY KEY CHECK(instr(domain, '*') = 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_site_rules (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,                     -- normalized, or the literal '*' (agent-wide default)
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  created_at TEXT NOT NULL,
  UNIQUE(agent_id, domain)
);

CREATE TABLE IF NOT EXISTS global_site_blocklist_meta (
  id INTEGER PRIMARY KEY CHECK(id=1),       -- single row table
  version TEXT NOT NULL,
  last_fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  domain_count INTEGER NOT NULL
);

-- ─── Site policy event log ─────────────────────────────────────────────────
-- One row per (agent, domain) the agent's browser_* calls were checked
-- against. Deduplicated: repeat checks bump hit_count/last_seen_at and flip
-- decision/source/matched_domain in place. No history rows. Default allows
-- are logged too. Pruned by site-policy-events.cleanup() (age + row cap).
CREATE TABLE IF NOT EXISTS site_policy_events (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,                       -- verdict.domain: normalized host, or raw IP/single-label host
  decision TEXT NOT NULL CHECK(decision IN ('allow','block')),
  source TEXT NOT NULL CHECK(source IN ('agent_rule','global_user','global_site_blocklist','default')),
  matched_domain TEXT,                        -- stored domain of matching rule; '*' for agent wildcard; NULL for default
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  decision_changed_at TEXT NOT NULL,          -- = first_seen_at until the decision first flips
  hit_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(agent_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_site_policy_events_last_seen ON site_policy_events(last_seen_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_site_policy_events_agent_last_seen ON site_policy_events(agent_id, last_seen_at DESC);

-- ─── Formatter incidents (audit trail for action items) ───────────────────

CREATE TABLE IF NOT EXISTS formatter_incidents (
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
CREATE INDEX IF NOT EXISTS idx_incidents_formatter_time ON formatter_incidents(formatter, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_undismissed ON formatter_incidents(dismissed_at) WHERE dismissed_at IS NULL;

-- ─── KV settings ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS extension_installs (
  install_id TEXT PRIMARY KEY,
  profile_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
