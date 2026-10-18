import type { Migration } from '../migrate/types';

// The first schema: workspace settings, connection profiles and content-addressed blobs. SQL both
// dialects accept; `db.t` covers the one difference (bytes). Released migrations are append-only
// (A-18: expand/contract), so a later change is a new migration, never an edit of this one.
export const migration0001Core: Migration = {
  id: '0001_core',
  up: async (db) => {
    const { t } = db;

    await db.execute(`CREATE TABLE settings (
  scope ${t.id()} NOT NULL,
  key ${t.id()} NOT NULL,
  value ${t.json()} NOT NULL,
  updated_at ${t.epochMs()} NOT NULL,
  PRIMARY KEY (scope, key)
)`);

    await db.execute(`CREATE TABLE connection_profiles (
  id ${t.id()} NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  env_class TEXT NOT NULL,
  color TEXT,
  config ${t.json()} NOT NULL,
  owner_id ${t.id()},
  visibility TEXT NOT NULL,
  created_at ${t.epochMs()} NOT NULL,
  updated_at ${t.epochMs()} NOT NULL
)`);
    await db.execute(
      'CREATE INDEX connection_profiles_owner ON connection_profiles (owner_id, id)',
    );

    await db.execute(`CREATE TABLE blobs (
  sha256 ${t.id()} NOT NULL PRIMARY KEY,
  body ${t.bytes()} NOT NULL,
  size INTEGER NOT NULL,
  refcount INTEGER NOT NULL,
  created_at ${t.epochMs()} NOT NULL
)`);
  },
};
