# SQLite Migration Design

**Status:** Design only — not yet greenlit for implementation.
**Audience:** Project owner, evaluating whether to schedule the work
described here.
**Branch context:** Drafted on `QOL-Features`, post-v1 work.

This document scopes a migration of WebPilot's per-module JSON file
stores under `<dataDir>` into a single SQLite database. Nothing in
this doc is binding — it's an honest sizing + risk pass before any
code is written. See the open questions in §9 before approving.

---

## 1. Inventory of current JSON stores

Audited by grepping `getDataDir()` and `fs.writeFileSync` calls under
`packages/server-for-chrome-extension/src/`. Six runtime-mutable
stores (plus a few transient files we do **not** propose to move).

### 1a. `<dataDir>/config/paired-keys.json`

- **Written by:** `paired-keys.js` (`saveKeys()`)
- **Read by:** `paired-keys.js` (`loadKeys()` — cached with mtime
  invalidation), called from `mcp-handler.js` (auth gate +
  `resolveTargetProfile`), `server.js` UI middleware, web UI agents
  endpoints.
- **Shape:** Array of entries:
  ```json
  [
    {
      "key": "<uuid>",
      "agentName": "string",
      "createdAt": "ISO-8601",
      "lastAccessed": "ISO-8601 | null",
      "profileId": "string | null",
      "source": "web-ui-direct | undefined"
    }
  ]
  ```
- **Expected size after months of use:** small. One row per paired
  AI agent. Even heavy users plausibly have <50 entries.
- **Write frequency:** burst on `approvePairing`, then sporadic —
  every `touchKey()` (one disk write per authenticated MCP tool
  call). This is the highest-volume write in WebPilot today, since
  every tool call from a paired agent calls `touchKey()`.

### 1b. `<dataDir>/config/pending-pairings.json`

- **Written by:** `paired-keys.js` (`savePendingPairings()`)
- **Read by:** same module via `loadPendingPairings()`. Drives the
  web UI's `/pairings` page + Dashboard "Action items".
- **Shape:** Array of `{ pairingId, agentName, status, expiresAt,
  createdAt, decidedAt?, apiKey? }`. `status ∈ {pending, approved,
  denied, expired}`.
- **Expected size after months:** grows unboundedly. 24 h TTL exists
  for the `pending` → `expired` transition, but denied/approved/
  expired entries are never pruned. OPEN_ITEMS.md P1 calls this out
  as `cleanupOldPairings(maxAgeDays)` — not yet implemented.
- **Write frequency:** on every `requestPairing`,
  `approvePairing`, `denyPairing` + idempotency-check writes when a
  pending entry ages past its TTL.

### 1c. `<dataDir>/formatter-logs.json`

- **Written by:** `formatter-logs.js` (`flush()` on a 60 s interval +
  exit handler for SIGINT/SIGTERM/exit).
- **Read by:** `formatter-logs.js` (`hydrate()` on first call after
  start) and the `/api/ui/formatters` + `/api/ui/formatters/:name/
  logs` routes. Also surfaced via the
  `webpilot_dev_get_formatter_logs` MCP tool.
- **Shape:** `{ writtenAt, formatters: { <name>: { successCount,
  errorCount, lastSuccessAt, lastErrorAt, recentOutcomes,
  logs: [{ timestamp, phase, workflow?, message, stack,
  params?, tabId? }] } } }`. Ring-buffer cap 50 per formatter; 7-day
  TTL on hydrate; stacks truncated to 1024 chars.
- **Expected size after months:** bounded by ring cap × formatter
  count × ~2 KB per entry. For 10 formatters: ~1 MB ceiling. Real
  size will be much smaller because most entries are successes
  (counters only, not log rows).
- **Write frequency:** every 60 s while the server runs.

### 1d. `<dataDir>/config/extension-installs.json`

- **Written by:** `extension-installs.js` (`saveInstalls()`)
- **Read by:** `extension-installs.js` (`loadInstalls()`), called
  during the hello-handshake fallback chain in `extension-bridge.js`.
- **Shape:** Object keyed by installId UUID:
  ```json
  {
    "<uuid>": {
      "profileId": "string",
      "firstSeen": "ISO-8601",
      "lastResolved": "ISO-8601"
    }
  }
  ```
- **Expected size after months:** one row per Chrome extension
  install across all profiles. 90-day TTL via
  `cleanupStaleInstalls()`. Plausibly <20 rows.
- **Write frequency:** burst on extension install/reinstall, plus
  `lastResolved` touch on every hello handshake.

### 1e. `<dataDir>/config/notifications.json`

- **Written by:** `notifications-settings.js` (`saveSettings()`)
- **Read by:** same module, called from the pairing-notify fire site
  and the `/api/ui/settings/notifications` route.
- **Shape:** `{ systemNotifications: boolean, sound: boolean }`.
- **Expected size:** tiny, fixed.
- **Write frequency:** rare — only when the user toggles a checkbox
  in settings.

### 1f. `<dataDir>/config/server.json`

- **Written by:** the install-time scaffold (Electron deploy script);
  occasionally re-written by `server.js` when settings change.
- **Read by:** `service/paths.js` (`loadConfig()`) — called on every
  invocation of `getPort()` and `getApiKey()`, including from the
  hot path of MCP tool routing (see OPEN_ITEMS.md P2 I9:
  `resolveTargetProfile` reads `server.json` on every tool call).
- **Shape:** `{ port?, apiKey?, ...future settings }`.
- **Expected size:** tiny, fixed.
- **Write frequency:** rare.

### 1g. `<dataDir>/network.enabled` *(flag file, not JSON)*

- **Written by:** `server.js` line 1424 when the network-mode toggle
  is flipped.
- **Read by:** `server.js` line 419 on startup.
- **Shape:** ASCII `'0'` or `'1'`.
- **Comment:** This is a plain flag file. Could fold into the
  `config` KV table; or leave as-is since it predates the migration
  and isn't read on the hot path. Cheapest decision: leave it alone.

### Not proposed for migration

- `<dataDir>/server.pid`, `<dataDir>/server.port` — process-lifecycle
  files, cleaned up on uninstall. Keep on filesystem.
- `<dataDir>/logs/*.log` — line-oriented log files. Wrong shape for
  SQLite.
- `<dataDir>/daemon.log` — same.
- `<dataDir>/formatters/`, `<dataDir>/custom-formatters/` — formatter
  JS source files. Keep on filesystem.

## 2. Why SQLite

Concrete benefits given WebPilot's actual usage:

1. **Atomic multi-write transactions.** Today, `approvePairing`
   modifies *both* `paired-keys.json` (adds entry) *and*
   `pending-pairings.json` (updates status to `approved`). A crash
   between the two writes leaves the system in a half-consistent
   state — the key was minted but the pending entry still says
   `pending`, or vice versa. With SQLite, both rows write in a
   single `BEGIN; ... COMMIT;` block.
2. **Indexed lookup.** `paired-keys.js` `validateKey()` is called
   twice per authenticated MCP tool call (auth gate +
   `resolveTargetProfile`). Today it's a linear scan over the keys
   array — fine while there are <50 entries, but an `apiKey UNIQUE`
   index gives O(log n) lookup for free, with no caching dance.
   `formatter-logs.js` currently scans the entire ring buffer per
   call to filter by phase + workflow — an indexed `formatter +
   timestamp` lookup is strictly faster.
3. **Easier pruning / aggregation.** OPEN_ITEMS.md P1
   `cleanupOldPairings(maxAgeDays)` becomes a single `DELETE FROM
   pairings WHERE decided_at < ? AND state IN ('denied', 'expired',
   'approved')`. Today it would be a read-filter-write cycle on the
   whole file.
4. **Single-file backup.** `cp webpilot.db webpilot.db.bak` covers
   all state. Currently a user wanting to back up their pairings has
   to know about three separate JSON files.
5. **SQL ad-hoc queries for debugging.** During incident
   investigation, being able to run `sqlite3 webpilot.db 'SELECT
   formatter, COUNT(*) FROM formatter_log_entries WHERE phase =
   "error" AND timestamp > "2026-05-01" GROUP BY formatter;'` is a
   much better experience than grepping JSON.

**Non-reasons** (to keep this honest):

- Performance is **not** a current bottleneck. All the JSON stores
  are small and most reads are cached. We are not migrating for
  speed.
- Concurrency is **not** a current need — WebPilot runs as a single
  server process. SQLite's locking model gives us future-proofing
  if we ever fork tooling, but it's not solving a present problem.

## 3. Schema sketch

```sql
-- Per-agent API keys minted via the pairing handshake or the
-- web-ui-direct path. Replaces paired-keys.json.
CREATE TABLE paired_keys (
  api_key         TEXT PRIMARY KEY,        -- UUID, stored plain (today's behavior)
  agent_name      TEXT NOT NULL,
  profile_id      TEXT,                    -- nullable: legacy entries pre-v1.5
  source          TEXT,                    -- 'web-ui-direct' | NULL (classic handshake)
  created_at      TEXT NOT NULL,           -- ISO-8601
  last_accessed   TEXT                     -- ISO-8601, NULL until first tool call
);
CREATE INDEX idx_paired_keys_profile_id ON paired_keys(profile_id);
CREATE INDEX idx_paired_keys_last_accessed ON paired_keys(last_accessed);

-- Pairing handshake state machine. Replaces pending-pairings.json.
-- Approved entries carry an api_key FK pointing into paired_keys.
CREATE TABLE pairings (
  pairing_id      TEXT PRIMARY KEY,        -- UUID
  agent_name      TEXT NOT NULL,
  state           TEXT NOT NULL CHECK(state IN ('pending','approved','denied','expired')),
  expires_at      INTEGER NOT NULL,        -- epoch ms (matches today's representation)
  created_at      TEXT NOT NULL,           -- ISO-8601
  decided_at      TEXT,                    -- ISO-8601, NULL while pending
  api_key         TEXT,                    -- FK -> paired_keys.api_key, populated on approve
  FOREIGN KEY (api_key) REFERENCES paired_keys(api_key) ON DELETE SET NULL
);
CREATE INDEX idx_pairings_agent_name ON pairings(agent_name);
CREATE INDEX idx_pairings_state ON pairings(state);
CREATE INDEX idx_pairings_expires_at ON pairings(expires_at);

-- Aggregate health stats per formatter. One row per registered
-- formatter. Replaces the per-formatter outer object in
-- formatter-logs.json.
CREATE TABLE formatter_status (
  formatter         TEXT PRIMARY KEY,
  success_count     INTEGER NOT NULL DEFAULT 0,
  error_count       INTEGER NOT NULL DEFAULT 0,
  last_success_at   TEXT,                  -- ISO-8601
  last_error_at     TEXT,                  -- ISO-8601
  recent_outcomes   TEXT NOT NULL DEFAULT '[]',  -- JSON array, capacity 10 (kept inline for cheap reads)
  dismissed_at      TEXT                   -- for "I acknowledge this error" UX, future
);

-- Per-error log entries. One row per recorded error or workflow
-- exception. Successes are not row-logged (only counter-bumped on
-- formatter_status). Replaces formatter-logs.json `logs` arrays.
CREATE TABLE formatter_log_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  formatter     TEXT NOT NULL,
  timestamp     TEXT NOT NULL,             -- ISO-8601
  phase         TEXT NOT NULL,             -- 'format' | 'workflow' | future
  workflow      TEXT,                      -- workflow name, when phase='workflow'
  message       TEXT NOT NULL,
  stack         TEXT,                      -- truncated to STACK_MAX (1024) by writer
  params_json   TEXT,                      -- arbitrary JSON blob, stringified
  tab_id        INTEGER,                   -- chrome tab id when known
  FOREIGN KEY (formatter) REFERENCES formatter_status(formatter) ON DELETE CASCADE
);
CREATE INDEX idx_formatter_log_entries_formatter_ts
  ON formatter_log_entries(formatter, timestamp DESC);
CREATE INDEX idx_formatter_log_entries_phase ON formatter_log_entries(phase);

-- Chrome extension install -> profile mapping. Replaces
-- extension-installs.json.
CREATE TABLE extension_installs (
  install_id    TEXT PRIMARY KEY,          -- UUID minted by extension
  profile_id    TEXT NOT NULL,
  first_seen    TEXT NOT NULL,             -- ISO-8601
  last_resolved TEXT NOT NULL              -- ISO-8601
);
CREATE INDEX idx_extension_installs_profile_id ON extension_installs(profile_id);
CREATE INDEX idx_extension_installs_last_resolved ON extension_installs(last_resolved);

-- Generic key/value config. Replaces notifications.json + server.json
-- + network.enabled (if we choose to fold the flag in). Values are
-- stored as TEXT; callers parse JSON if the value is structured.
CREATE TABLE config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,               -- JSON-encoded for structured values
  updated_at  TEXT NOT NULL                -- ISO-8601
);

-- Bookkeeping table for the migration tool itself.
CREATE TABLE schema_meta (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL
);
INSERT INTO schema_meta (key, value) VALUES ('version', '1');
```

Notes on the schema:

- We deliberately do not hash API keys at rest (`paired_keys.api_key`
  is stored plain). This matches today's `paired-keys.json` behavior;
  changing it is a separate security improvement that should not
  ride along with the storage migration.
- `formatter_log_entries.params_json` keeps the arbitrary blob shape
  the current code stores. A future schema rev can promote
  frequently-queried fields out into typed columns.
- `pairings.expires_at` is `INTEGER epoch ms` to match the current
  code's representation, not ISO-8601. The decision: don't change
  data shape and storage shape in the same migration.
- WAL mode (`PRAGMA journal_mode = WAL`) should be set at DB-open
  time. WAL gives us much better concurrency between writers and
  ad-hoc `sqlite3 webpilot.db` readers during debugging, at the cost
  of two sidecar files (`-wal`, `-shm`) that need to be included in
  backups.

## 4. Choice of SQLite driver

### `better-sqlite3` *(recommended)*

- **Pros:** Synchronous API (matches the existing codebase, which is
  mostly synchronous `fs.readFileSync`/`writeFileSync`). Fast (no
  thread-pool round-trip per query). Well-maintained. Excellent
  prepared-statement caching.
- **Cons:** Native module. Requires platform-specific binaries
  (prebuilds exist for win-x64, linux-x64, darwin-x64, darwin-arm64).
- **pkg compatibility:** **This is the highest-risk item in the
  whole migration.** pkg has historically been finicky about native
  modules — it needs to either include the `.node` binding as an
  asset and resolve it at runtime, or use the
  `pkg.bin`/`pkg.deployFiles` config to copy the binding next to the
  exe. Both patterns work in practice but require validation per
  platform. Concrete risks:
  - The pkg binary may not find the `.node` file at runtime if the
    `Module._extensions['.node']` resolution is broken under the
    snapshot layer.
  - Different prebuilds for win-x64 vs. darwin-arm64 means the
    release pipeline needs a per-platform build step rather than
    "build once on Windows, ship to all".
  - Worst case: we end up shipping a `node_modules/better-sqlite3/
    build/Release/better_sqlite3.node` *alongside* the pkg exe and
    use `pkg.assets` to bundle it. Doable; requires testing.

### `sqlite3`

- **Pros:** Older, also widely used. Callback API + promise wrappers
  available (`sqlite3.Database`).
- **Cons:** Async-only, which means every read in `paired-keys.js`
  becomes a `Promise` and the auth gate (currently sync) must be
  rewritten async-aware. That's a much larger blast radius than the
  storage layer itself.
- **pkg compatibility:** Same risks as `better-sqlite3` but the
  prebuilds are less reliably maintained.
- **Verdict:** **Not recommended.** The async surface change isn't
  worth it.

### `node:sqlite` (built-in since Node 22)

- **Pros:** No native module to bundle. No pkg risk.
- **Cons:** API is marked **stability: 1 - Experimental** as of
  May 2026 and the surface may change. Requires Node 22+ at runtime.
  WebPilot currently targets Node 18 for the pkg binary (per
  `pkg . --target node18-win-x64` in the build memory notes).
- **Verdict:** Tempting but premature. Reassess in 6-12 months when
  it stabilizes and we can bump the pkg target.

**Recommendation:** `better-sqlite3`. Accept the pkg-bundling work
as a phase-1 cost and budget time for it explicitly.

## 5. Phased migration plan

### Phase 1 — Dual-write (DB alongside JSON)

- Introduce `lib/db.js` that opens/initializes the SQLite database
  on server startup. Run schema-create idempotently.
- For each module (paired-keys, pending-pairings, formatter-logs,
  extension-installs, notifications-settings, server-config): keep
  existing JSON read/write paths intact. Add a *second* write that
  mirrors the JSON change into the corresponding SQLite table.
- Reads continue to come from JSON, so user-visible behavior is
  unchanged.
- Add a `webpilot_dev_db_check` MCP tool (auth-required) that
  diff's the in-memory JSON state against the SQLite snapshot and
  reports any divergence. Run this in CI smoke tests.
- **Done when:** Every code path that writes one of the six JSON
  stores also writes the SQLite mirror, and the diff tool reports
  zero divergence across a full integration test suite.

### Phase 2 — Per-domain reader cutover

Pick one module at a time, in this order (simplest first):

1. **`notifications-settings.js`** — single-row KV, no concurrent
   writers, easy to roll back.
2. **`extension-installs.js`** — small, well-bounded.
3. **`pending-pairings.json` → `pairings` table.**
4. **`paired-keys.json` → `paired_keys` table.** (Hot-path reader;
   needs careful benchmarking against the current cache.)
5. **`formatter-logs.json` → `formatter_status` + `formatter_log_
   entries`.** (Largest table; biggest cleanup win.)
6. **`server.json` + `network.enabled` → `config` table.** (Optional
   — see open question in §9.)

For each module: switch readers to SQLite, leave the JSON write in
place as a safety net for one release cycle, then drop it.

### Phase 3 — Cleanup

- Drop the JSON-write code paths.
- Ship a one-shot migration tool that on first boot of the new
  version:
  - Detects any `<dataDir>/config/*.json` files that exist alongside
    the SQLite DB.
  - Imports their contents into the corresponding tables, *only* for
    rows whose primary key isn't already present in the DB.
  - Renames the imported files to `<name>.json.imported` (not
    deleted — see §6).
  - Writes a one-line summary to the server log.
- Delete `formatter-logs.js` flush timer; replace with synchronous
  per-event INSERTs (or batched INSERTs on a short timer if perf is
  a concern).
- Update docs (`MCP_SERVER.md`, `OPEN_ITEMS.md` P1 cleanup bullet).

## 6. Backward compatibility & user upgrade path

WebPilot users upgrading from a JSON-era version to a SQLite-era
version will find `<dataDir>/config/*.json` files already present.
The new version must not lose their data.

**First-boot behavior of the new version:**

1. Open `<dataDir>/webpilot.db`. If absent, create it and run
   schema-init.
2. For each known JSON store, check if the file exists.
3. If yes, parse it and INSERT each row into the corresponding
   table using `INSERT OR IGNORE` semantics keyed on the primary key
   (api_key, pairing_id, install_id, etc.). Already-imported rows
   are skipped; this makes the import idempotent and safe to retry.
4. After successful import, rename the file from `<name>.json` to
   `<name>.json.imported`. Do **not** delete it. The user can clean
   up manually once they're satisfied the migration worked. Keeping
   the file also gives us a forensic trail if anything goes wrong.
5. Log a one-line summary per file:
   `[migration] imported 12 rows from paired-keys.json -> paired_keys`.

**Downgrade safety:** A user who pins back to a pre-migration
WebPilot version will find the renamed `*.json.imported` files and
will need to manually rename them back. Document this in the release
notes. Two-way upgrade/downgrade compatibility is **not** a goal.

## 7. Risks & open questions

### pkg native-module compatibility

The dominant risk. `better-sqlite3` ships a native binding per
platform. Concrete unknowns:

- Does pkg's snapshot fs correctly resolve
  `require('better-sqlite3/build/Release/better_sqlite3.node')`?
  Empirically: pkg needs the `.node` file declared via `pkg.assets`
  or copied to a sibling path of the exe with explicit
  `--public-packages better-sqlite3`. Both approaches have community
  reports of working — but neither is reliable across pkg versions.
- Need a per-platform release pipeline. Today WebPilot builds
  win-x64 only via `pkg . --target node18-win-x64`. Adding
  macOS+Linux pkg targets is a separate orthogonal piece of work
  that may be needed regardless.
- **Mitigation:** Phase-1 prototype gates the rest of the work. If
  pkg can't bundle better-sqlite3 cleanly, fall back to `node:sqlite`
  on Node 22 (and bump the pkg target).

### DB file corruption recovery

SQLite is robust under normal conditions, but:

- Power loss mid-write in WAL mode is recoverable on next open
  (WAL replay).
- Disk full → write fails → application sees a SQLITE_FULL error.
  Today's JSON code logs and silently swallows the error in several
  places. Document the error-handling contract: every write site
  must surface an error (not swallow), and the periodic
  formatter-logs flush should retry with exponential backoff.
- Manual `.db` corruption (user opens it with `sqlite3` and runs
  destructive SQL) is out of scope; we will fail loudly on
  malformed DB and recommend restoring from backup.

### Concurrent access from CLI tools

SQLite's default locking model (rollback journal) is exclusive for
writes but allows concurrent readers. WAL mode makes this strictly
better: many readers + one writer concurrently.

- A user opening `sqlite3 webpilot.db` while the server is running
  → fine (read-only by default).
- A user running `sqlite3 webpilot.db 'INSERT ...'` while the
  server is running → may briefly block server writes (SQLITE_BUSY).
  Document that ad-hoc writes should be done with the server
  stopped.

### Schema migration story for future changes

We need a versioned migrations layer. Two options:

1. **Hand-rolled per-version code.** A `migrations/v1.js`,
   `v2.js`, ... each exporting `up(db)`. The DB carries
   `schema_meta('version', N)` and on open we run any
   `v(N+1)..vCurrent` in order. Lightweight, no extra deps.
2. **A migrations library** (e.g. `node-postgres-migrations`-style).
   Heavier; not justified for our size.

**Recommendation:** Hand-rolled. Keep migrations in
`packages/server-for-chrome-extension/src/db/migrations/`.

## 8. Estimated effort

Rough sub-agent-day sizing. Assume one Opus-class sub-agent per
sub-task, working in serial.

- **Phase 1 — Dual-write:** ~4 days.
  - Day 1: `lib/db.js` + schema-init + better-sqlite3 pkg bundling
    proof of concept. **This day alone gates the rest of the work.**
  - Day 2: dual-write for `paired-keys.js` + `paired-keys` test
    coverage (currently untested per OPEN_ITEMS.md P3).
  - Day 3: dual-write for `pending-pairings.js` +
    `extension-installs.js` + `notifications-settings.js` +
    `server.json` KV.
  - Day 4: dual-write for `formatter-logs.js` +
    `webpilot_dev_db_check` MCP tool + CI integration.

- **Phase 2 — Reader cutover:** ~3 days.
  - Day 1: notifications-settings + extension-installs + server
    config.
  - Day 2: pairings (pending + paired) — careful, hot path.
  - Day 3: formatter-logs (largest table; needs care with the ring
    buffer → table-with-DELETE-old pattern).

- **Phase 3 — Cleanup + migration tool:** ~2 days.
  - Day 1: drop JSON writes, build import tool, write release
    notes.
  - Day 2: verification on a fresh upgrade-from-JSON-era install on
    each platform.

**Total: ~9 sub-agent-days.** Add 2 days of buffer for the pkg-
bundling risk in Phase 1, and 1 day for human review/integration
testing at each phase boundary → ~12-14 days end-to-end.

## 9. Open questions to surface to the user before kicking off

These need answers before implementation:

1. **Same DB file for dev mode and prod mode?** Dev mode currently
   writes to `~/.config/WebPilot` / `~/Library/Application Support/
   WebPilot` / `%LOCALAPPDATA%\WebPilot`; pkg/prod mode writes next
   to the binary under `Programs/WebPilot/data/`. The migration
   should respect that split (one DB per data dir), but worth
   confirming you don't want them unified.

2. **Should we ship a SQL CLI tool alongside the binary, or is
   `sqlite3 webpilot.db` good enough?** Bundling a `sqlite3` CLI
   inside the pkg distribution adds ~1 MB but means users on locked-
   down machines can introspect their data without installing
   anything. Cheapest answer: don't bundle; document that users can
   download `sqlite3` from sqlite.org if they want it.

3. **Hash API keys at rest, or keep them plain (current behavior)?**
   This migration is a natural seam to start storing only
   `crypto.createHash('sha256')` digests of API keys, validating
   tool-call API keys via constant-time compare against the digest.
   But this expands scope significantly — every paired agent would
   need to be re-paired, or we'd need a one-time migration step
   that hashes existing keys (only possible at the moment the user
   provides the plain key, which doesn't happen during silent
   upgrade). My recommendation: **out of scope for this
   migration.** Track it as a separate security improvement.

4. **WAL mode default?** Yes for the reasons in §3; but it adds
   `-wal` and `-shm` sidecar files next to the DB. Confirm that's
   acceptable in the data dir layout.

5. **What happens to the `network.enabled` flag file?** Cleanest:
   migrate to the `config` KV table along with `server.json`.
   Cheapest: leave it as a one-line text file forever. The flag
   was added recently and lives in `server.js` directly — folding
   it in would require a tiny refactor. Acceptable either way.
   Confirm preference.

---

## Cross-references

- Source of truth for current store shapes:
  `packages/server-for-chrome-extension/src/paired-keys.js`,
  `extension-installs.js`, `formatter-logs.js`,
  `notifications-settings.js`, `service/paths.js`.
- Related OPEN_ITEMS.md entries: P1 `pending-pairings.json` history
  pruning (cleanupOldPairings), P2 I9 (`resolveTargetProfile` reads
  `server.json` on every tool call), P3 testing gaps.
- Build pipeline that needs to learn `better-sqlite3`: `release.sh`,
  `release.ps1`, `packages/server-for-chrome-extension/package.json`
  pkg config.
