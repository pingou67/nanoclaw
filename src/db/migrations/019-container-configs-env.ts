import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Add a per-group `env` column to container_configs so providers can opt into
 * features that need per-group env vars (e.g. NANOCLAW_OPENCODE_PLUGINS for
 * opencode-claude-memory) without touching the host's `.env`. JSON-encoded
 * Record<string,string>, empty for groups with no overrides. Defaults to '{}'
 * (NOT NULL) so existing rows continue to work without a separate backfill.
 */
export const migration019: Migration = {
  version: 19,
  name: 'container-configs-env',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'").run();
  },
};
