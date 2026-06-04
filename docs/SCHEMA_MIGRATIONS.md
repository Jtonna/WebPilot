# Schema Migrations

Idempotent startup migrations for the daemon's SQLite store. Each migration is a JS file describing one structural change to the database. The runner applies all pending migrations at every boot, in lexical order, before the main schema is applied.

## Location

Migration files live at:

```
packages/server-for-chrome-extension/src/db/schema-migrations/
  index.js                                         ← runner
  001-rename-baseline-to-global-site-blocklist.js  ← migration file
  README.md                                        ← contributor summary
```

Each migration file is a plain CommonJS module alongside the runner. See [`schema-migrations/README.md`](../packages/server-for-chrome-extension/src/db/schema-migrations/README.md) for the short contributor-facing summary.

## Boot Ordering

`runAll(db, { dataDir })` is invoked from `src/db/connection.js:init()` **before** `_db.exec(schemaSql)`.

Migrations run first so they can manipulate tables created by an older `schema.sql` shape. For example, a migration may rename a table whose new name appears in the current `schema.sql`. Running the migration first means `schema.sql`'s `CREATE TABLE IF NOT EXISTS` finds the post-migration shape and is a no-op for objects that already exist. On a brand-new install, every migration self-detects "no work to do" and `schema.sql` creates the modern shape directly.

## The Runner

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
001-rename-baseline-to-global-site-blocklist.js
002-your-next-change.js
```

The runner sorts files lexically. Lexical order matches numerical order through `999`. Past `999`, lexical sort breaks (`1000` sorts before `999` because `'1' < '9'` as characters), so new migrations appear in the wrong position in the list. Stay within the 001–999 range; if that limit ever approaches, switch to 4-digit padding (`0001`-style) consistently across all files.

## Migration File Shape

Each file exports a plain object:

```js
module.exports = {
  id:          '001-rename-baseline-to-global-site-blocklist',  // ledger PK
  description: 'Human-readable one-liner shown in runner log lines',
  up(db, opts) {
    // db  — open better-sqlite3 handle
    // opts — { dataDir: string }
    // The runner wraps this call in a transaction. Do not open your own
    // outer transaction. A nested savepoint inside up() is fine for
    // advanced ops like SQLite's 12-step CHECK rewrite (see migration 001).
  },
};
```

`id` is the string used as the ledger primary key. By convention it matches the filename without `.js`. `description` appears in the runner's log lines.

## Failure Semantics

If `up()` throws, the `db.transaction(...)` wrapper rolls back: no schema change is persisted and no ledger row is inserted. The daemon does not continue booting with an unmigrated database — the error propagates out of `connection.js:init()` and the process exits loudly. To recover, fix the migration or restore the database and restart.

## Adding a Migration

1. Read the latest file in `schema-migrations/` and pick the next 3-digit prefix.
2. Create `NNN-your-description.js` exporting `{ id, description, up(db, opts) }`.
3. Write `up()` to be idempotent in spirit (see [Dual-Layer Idempotency](#dual-layer-idempotency)): guard each step against the already-applied state.
4. Test via `packages/server-for-chrome-extension/test/db-migration.test.js`: create an in-memory SQLite fixture seeded with the pre-migration shape, call `runAll`, and assert the post-migration shape.
5. See [`schema-migrations/README.md`](../packages/server-for-chrome-extension/src/db/schema-migrations/README.md) for the short summary of conventions.

## Inspection Tips

Check which migrations have been applied to a live database:

```sql
SELECT id, applied_at FROM schema_migrations ORDER BY applied_at;
```

Confirm the ledger table structure:

```sql
SELECT sql FROM sqlite_master WHERE type='table' AND name='schema_migrations';
```
