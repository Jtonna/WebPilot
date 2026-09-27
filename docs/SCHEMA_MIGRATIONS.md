# Schema Migrations

Idempotent startup migrations for the daemon's SQLite store. Each migration is a JS file describing one structural change to the database. The runner applies all pending migrations at every boot, in lexical order, before the main schema is applied.

## Location

Migration files live at:

```
packages/server-for-chrome-extension/src/db/schema-migrations/
  index.js                                         ← runner
  NNN-description.js                               ← migration file
```

Each migration file is a plain CommonJS module alongside the runner.

## Boot Ordering

`runAll(db, { dataDir })` is invoked from `src/db/connection.js:init()` **before** `_db.exec(schemaSql)`.

Migrations run first so they can manipulate tables created by an older `schema.sql` shape. For example, a migration may rename a table whose new name appears in the current `schema.sql`. Running the migration first means `schema.sql`'s `CREATE TABLE IF NOT EXISTS` finds the post-migration shape and is a no-op for objects that already exist.

The actual rule for a brand-new install is stricter than "self-detects no work to do": migrations run against a database that contains, at most, the `schema_migrations` ledger table — none of the application tables exist yet. Every migration step MUST explicitly check that its target table/column exists before touching it; do not assume any prior migration or `schema.sql` has already run. #96 is the cautionary example: a migration step read a table that only `schema.sql` creates, so it crashed on every fresh install until it was guarded.

## The Runner

`runAll(db, opts)` accepts an undocumented `opts._migrationsDir` override (test-only) that points the runner at a custom directory instead of `__dirname`; production code never sets this.

`index.js` performs these steps in order:

1. Scans `schema-migrations/` for files matching `/^\d{3}-.*\.js$/`, sorts them lexically, and `require`s each one.
2. Validates that every loaded module exports a non-empty string `id` and a callable `up` — throws loudly if either is missing.
3. Ensures the ledger table exists (`CREATE TABLE IF NOT EXISTS schema_migrations ...`).
4. For each migration whose `id` is not yet in the ledger: calls `up(db, opts)` and inserts the ledger row inside the same `db.transaction(...)`. A crash mid-`up()` rolls both the schema change and the ledger row back together.

## The Ledger Table

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
```

One row per applied migration. `applied_at` is an ISO-8601 timestamp written by the runner at apply time.

Inspect the ledger at any time:

```sql
SELECT id, applied_at FROM schema_migrations ORDER BY applied_at;
```

## Dual-Layer Idempotency

Migrations are protected against double-application at two layers:

**Ledger (primary).** The runner checks `schema_migrations` before calling `up()`. If the `id` is already present, the migration is skipped entirely. This is the normal path for every boot after the first.

**In-body guards (defensive).** Each `up()` is also written to detect "already applied" by inspecting the current DB shape directly (`sqlite_master`, `PRAGMA table_info`, row presence, filesystem `existsSync`, etc.). These guards exist for the restore-from-backup scenario: a vintage backup that pre-dates the ledger has no ledger row, so the runner would otherwise re-execute `up()` against a shape that is already post-migration. The in-body guards make that re-execution a safe no-op.

## Naming Convention

Migration filenames follow the pattern `NNN-kebab-case-description.js`, where `NNN` is a 3-digit zero-padded sequence number:

```
001-first-change.js
002-your-next-change.js
```

The runner sorts files lexically. Lexical order matches numerical order through `999`. Past `999`, lexical sort breaks (`1000` sorts before `999` because `'1' < '9'` as characters), so new migrations appear in the wrong position in the list. Stay within the 001–999 range; if that limit ever approaches, switch to 4-digit padding (`0001`-style) consistently across all files.

## Migration File Shape

Each file exports a plain object:

```js
module.exports = {
  id:          '003-your-migration',  // ledger PK; matches the filename without `.js`
  description: 'Human-readable one-liner shown in runner log lines',
  up(db, opts) {
    // db  — open better-sqlite3 handle
    // opts — { dataDir: string }
    // The runner wraps this call in a transaction. Do not open your own
    // outer transaction. A nested savepoint inside up() is fine for
    // advanced ops like SQLite's 12-step CHECK rewrite.
  },
};
```

`id` is the string used as the ledger primary key. By convention it matches the filename without `.js`. `description` appears in the runner's log lines.

## Failure Semantics

If `up()` throws, the `db.transaction(...)` wrapper rolls back: no schema change is persisted and no ledger row is inserted. The error then propagates through the full boot chain:

1. `connection.js:init()` closes the SQLite handle, leaves its singleton unset (so a later `init()` call can retry cleanly), and rethrows.
2. `index.js`'s pre-boot network-mode lookup calls `init()` first; if it fails there, that lookup catches the error, logs `[boot] network-mode DB lookup failed, using CLI/env default:`, and falls back to the CLI/env default — it does **not** stop the boot.
3. `src/server.js`'s `createServer()` calls `init()` again (this is the call that actually matters). It logs `[server] SQLite init failed:` and rethrows.
4. That rethrow escapes `createServer()`, which `index.js` calls synchronously at the top level, so it becomes an uncaught exception. `index.js`'s `uncaughtException` handler logs a `FATAL uncaughtException:` line and calls `process.exit(1)`.

Net effect: on a broken database the daemon does not run degraded — it exits 1, and the error is logged twice (once from the network-mode lookup, once from `createServer()`). That double log is intended, not a bug.

This matters for how the daemon gets restarted, since none of these supervisors distinguish "crashed on a broken DB" from any other crash:

- **launchd** (macOS): `KeepAlive` + `ThrottleInterval 10` restarts the daemon every ~10s.
- **systemd** (Linux): `Restart=on-failure` + `RestartSec=10` restarts every ~10s.
- **Electron**: polls `/health` for up to 30s after spawning the daemon; if it never comes up, Electron shows its "server didn't start" page.
- **Windows Run key** (autostart): does not retry — if the daemon exits, it stays down until the user logs in again or launches it manually.

Also note: the daemon's log file is truncated at the start of every run (`SizeManagedWriter` in `src/service/logger.js` calls `fs.writeFileSync(logPath, '', 'utf8')` on construction). Combined with a restart loop, only the latest crash's log survives — earlier crash details are gone by the time you go look. To recover, fix the migration or restore the database, then restart.

## Adding a Migration

1. Read the latest file in `schema-migrations/` and pick the next 3-digit prefix.
2. Create `NNN-your-description.js` exporting `{ id, description, up(db, opts) }`.
3. Write `up()` to be idempotent in spirit (see [Dual-Layer Idempotency](#dual-layer-idempotency)): guard each step against the already-applied state. Just as important: guard each step against the table/column it touches **not existing yet**, since on a fresh install the migration runs against a DB containing only the `schema_migrations` ledger — none of the application tables exist until `schema.sql` runs afterward. Do not assume `schema.sql` or any earlier migration has already created what you need.
4. Test via `packages/server-for-chrome-extension/test/db-migration.test.js`: create an in-memory SQLite fixture seeded with the pre-migration shape, call `runAll`, and assert the post-migration shape. Also keep the fresh-DB tests in `test/db-migration.test.js` and `test/db-connection.test.js` green — `db-connection.test.js` runs every real migration against a brand-new database via `init()`, so it is what catches future regressions like #96 (a migration step that only works when a table already exists).

### Testing a new migration

Before landing a migration, run both of these and confirm they pass:

- `packages/server-for-chrome-extension/test/db-migration.test.js` — targeted unit coverage for the migration's own pre/post shape.
- `packages/server-for-chrome-extension/test/db-connection.test.js` — exercises `connection.js:init()` end-to-end, including running every real migration (yours included) against a genuinely fresh database. This is the test that would have caught #96.

## Inspection Tips

Check which migrations have been applied to a live database:

```sql
SELECT id, applied_at FROM schema_migrations ORDER BY applied_at;
```

Confirm the ledger table structure:

```sql
SELECT sql FROM sqlite_master WHERE type='table' AND name='schema_migrations';
```
