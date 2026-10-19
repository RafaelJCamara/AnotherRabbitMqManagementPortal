import type { Migration } from '../migrate/types';

// The workspace (M0-47, blueprint 6.2): saved views. A view belongs to one person (`owner_id`) and
// to no connection, so the same view opens on every one. Layouts, settings and keybindings are
// documents in the `settings` table under the scopes `workspace.<kind>:<owner>`: they need no
// table of their own. `definition` is JSON the UI owns. The index serves the window query: one
// owner's views in id (creation) order.
export const migration0006Workspace: Migration = {
  id: '0006_workspace',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE views (
  id ${t.id()} NOT NULL PRIMARY KEY,
  owner_id ${t.id()} NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  definition ${t.json()} NOT NULL,
  created_at ${t.epochMs()} NOT NULL,
  updated_at ${t.epochMs()} NOT NULL
)`);
    await db.execute('CREATE INDEX views_owner ON views (owner_id, id)');
  },
};
