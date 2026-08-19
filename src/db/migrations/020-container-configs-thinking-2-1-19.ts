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
  async up(db) {
    // Idempotent sans interroger le schéma : la politique de portabilité
    // (portability.test.ts) interdit l'introspection propre à SQLite, et elle
    // scanne le SOURCE de la fonction — commentaires compris. On tente donc
    // l'ajout et on absorbe le seul échec attendu : la colonne existe déjà,
    // sur les installs antérieures à 2.1.19 qui portaient une migration locale
    // de même effet. Toute autre erreur remonte.
    try {
      await db.exec(`ALTER TABLE container_configs ADD COLUMN thinking TEXT`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/duplicate column name/i.test(message)) throw err;
    }
  },
};
