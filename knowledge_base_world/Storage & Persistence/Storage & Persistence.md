# Storage & Persistence

Manages Nous's data storage using XDG Base Directory conventions. The main data directory is `$XDG_DATA_HOME/nous/` which contains SQLite databases (`nous-dev.db*`) for sessions and history, `account.json` for authentication, `repos/` for cloned repositories, `snapshot/`, `tool-output/`, and state files. Log files are in `log/` and session diffs in `storage/session_diff/`.

## Key Files
- `clear-nous.sh` — utility script that removes only `log/` and `storage/session_diff/`, preserving auth (`account.json`), DB, cache, repos, snapshots, tool-output, and config. Optionally clears `.noussh` dirs in a project root.
- `packages/core/src/global.ts` — Defines all XDG path constants (`data`, `cache`, `config`, `state`, `tmp`) used throughout the app; account creation and config resolution depend on these paths
- `packages/core/src/account.ts` — Manages reading, migrating (auth.json → account.json), and writing the auth/account JSON file with secure permissions
- `packages/opencode/src/storage/db.ts` — Database init, Drizzle migration runner (reads `OPENCODE_MIGRATIONS` build-time constant), and connection management for Bun SQLite
- `packages/opencode/migration/20260510033149_session_usage/migration.sql` — Adds `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write` columns to `session` table via raw `ALTER TABLE ADD` (no `IF NOT EXISTS`)
- `packages/opencode/src/data-migration.ts` — Post-DDL row-level data migrations framework; runs after Drizzle migrations to backfill or transform existing records
- `packages/opencode/src/session/session.sql.ts` — Drizzle table definitions for `SessionTable` and `MessageTable`, including all usage tracking fields defined in the migration above
- `packages/opencode/drizzle.config.ts` — Drizzle Kit configuration; defines schema glob and migration output directory
- `packages/opencode/src/data-migration.sql.ts` — Defines the `data_migration` table (name + time_completed) that tracks which data migrations have run
- `packages/opencode/src/storage/json-migration.ts` — One-time import from legacy `.json` files into SQLite, invoked during initial migration flow
- `packages/effect-drizzle-sqlite/src/effect-sqlite/migrator.ts` — Wraps Drizzle's `readMigrationFiles` and `migrate` for the Effect SQLite driver
- `packages/effect-drizzle-sqlite/src/up-migrations/sqlite.ts` — Utility that checks column existence via `PRAGMA table_info` before running `ALTER TABLE ADD COLUMN`
- `packages/core/src/util/log.ts` — log rotation and file writing under the data directory
- `packages/opencode/src/storage/storage.ts` — storage abstraction, migration runner, and `NotFoundError`
- `packages/opencode/src/session/session.ts` — session CRUD and queries backed by the SQLite DB
- `packages/opencode/src/cli/cmd/run/trace.ts` — dev-only JSONL event tracing to `data/log/direct/`
- `packages/opencode/src/cli/cmd/uninstall.ts` — uninstall command that cleans up all XDG directories plus legacy `~/.nous`

## Notes
- Auth lives in `account.json` (never removed by cleanup).
- The SQLite DB is authoritative for session data; session diffs (`ses_*.json`) are derived exports, safe to delete.
- The script guards against destructive paths when a project root argument is given.