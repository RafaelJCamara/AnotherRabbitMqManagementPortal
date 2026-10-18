import type { Kysely } from 'kysely';

import type { DialectName } from './migrate/helpers';

/** `schema_migrations`: one row per applied migration. The runner owns it, not a migration. */
export interface SchemaMigrationsTable {
  id: string;
  applied_at: number;
}

/** `settings`: scoped key/value documents (workspace settings, keybindings, layouts...). */
export interface SettingsTable {
  scope: string;
  key: string;
  /** JSON text. */
  value: string;
  updated_at: number;
}

/** `connection_profiles` (blueprint 6.2). The JSON `config` is owned by svc-connections. */
export interface ConnectionProfilesTable {
  id: string;
  name: string;
  env_class: string;
  color: string | null;
  /** JSON text: endpoints, dial route, TLS, credential refs, issuer pin, managed flags. */
  config: string;
  owner_id: string | null;
  visibility: string;
  created_at: number;
  updated_at: number;
}

/** `blobs`: content-addressed, reference-counted bodies (blueprint 6.2). */
export interface BlobsTable {
  sha256: string;
  body: Uint8Array;
  size: number;
  refcount: number;
  created_at: number;
}

/** The typed schema every repository and the runner query through. */
export interface Database {
  schema_migrations: SchemaMigrationsTable;
  settings: SettingsTable;
  connection_profiles: ConnectionProfilesTable;
  blobs: BlobsTable;
}

/** An open database: a Kysely instance plus what the runner needs to know about it. */
export interface PersistenceHandle {
  readonly dialect: DialectName;
  readonly db: Kysely<Database>;
  /** The SQLite file, when there is one. Undefined for `:memory:` and for Postgres. */
  readonly path: string | undefined;
  close(): Promise<void>;
}
