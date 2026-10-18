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

/** plans (M0-29): the ActionExecutor's plans; see 0002_plans for what each column holds. */
export interface PlansTable {
  id: string;
  action_id: string;
  input_hash: string;
  digest: string;
  principal_id: string;
  on_behalf_of_id: string | null;
  profile_fingerprint: string | null;
  env: string;
  risk: string;
  state: string;
  approvals_required: number;
  /** JSON text. */
  approvals: string;
  gates: string;
  warnings: string;
  consents_required: string;
  confirmation_phrase: string | null;
  preview: string;
  /** Ciphertext; null once purged. */
  payload: Uint8Array | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
  version: number;
}

/** idempotency_keys (M0-29): one row per key a principal has used. */
export interface IdempotencyKeysTable {
  principal_id: string;
  key: string;
  action_id: string;
  plan_id: string | null;
  created_at: number;
}

/** The typed schema every repository and the runner query through. */
export interface Database {
  schema_migrations: SchemaMigrationsTable;
  settings: SettingsTable;
  connection_profiles: ConnectionProfilesTable;
  blobs: BlobsTable;
  plans: PlansTable;
  idempotency_keys: IdempotencyKeysTable;
}

/** An open database: a Kysely instance plus what the runner needs to know about it. */
export interface PersistenceHandle {
  readonly dialect: DialectName;
  readonly db: Kysely<Database>;
  /** The SQLite file, when there is one. Undefined for `:memory:` and for Postgres. */
  readonly path: string | undefined;
  close(): Promise<void>;
}
