import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Add a per-group `thinking` column to container_configs so a group can pin an
 * extended-thinking mode (adaptive / enabled+budget / disabled), materialized
 * into container.json and passed to the Claude SDK. JSON-encoded
 * `{ type, budgetTokens? }`, nullable (no thinking override by default).
 *
 * Name `container-configs-thinking-2-1-19` (rather than the original
 * pre-2.1.19 local migration name `container-config-thinking`) so DBs that
 * already carry the column from that prior local migration don't get a
 * "duplicate column" error on upgrade — the runner keys pending by name, and
 * the column-existence guard below makes the up() a no-op when it's already
 * there. A fresh install runs this and gets the column.
 */
export const migration020: Migration = {
  version: 20,
  name: 'container-configs-thinking-2-1-19',
  up(db: Database.Database) {
    // Defensive: skip if the column already exists (covers installs that
    // pre-date 2.1.19 and had a local migration of the same logical effect).
    const cols = new Set(
      (db.prepare("PRAGMA table_info('container_configs')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (cols.has('thinking')) return;
    db.prepare('ALTER TABLE container_configs ADD COLUMN thinking TEXT').run();
  },
};
