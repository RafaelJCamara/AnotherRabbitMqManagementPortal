import { sql, type Kysely } from 'kysely';

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

/** audit_events (M0-30): the hash-chained audit; see 0003_audit_receipts for what each column holds. */
export interface AuditEventsTable {
  seq: number;
  at: number;
  phase: string;
  correlation_id: string;
  action_id: string;
  kind: string;
  actor_id: string;
  surface: string;
  on_behalf_of_id: string | null;
  /** JSON text. */
  actor: string;
  target: string;
  env: string;
  risk: string;
  plan_id: string | null;
  plan_digest: string | null;
  approved_by: string;
  attempt_seq: number | null;
  result: string | null;
  code: string | null;
  job_id: string | null;
  receipt_id: string | null;
  detail: string;
  prev_hash: string;
  hash: string;
}

/** receipts (M0-30): one row per message-touching or mutating execution. */
export interface ReceiptsTable {
  id: string;
  action_id: string;
  plan_id: string | null;
  plan_digest: string | null;
  principal_id: string;
  on_behalf_of_id: string | null;
  correlation_id: string;
  env: string;
  risk: string;
  started_at: number;
  finished_at: number;
  result: string;
  code: string | null;
  job_id: string | null;
  audit_seq: number | null;
  /** JSON text. */
  detail: string;
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
  audit_events: AuditEventsTable;
  receipts: ReceiptsTable;
}

/** Runs one raw SQL statement, for what Kysely cannot express (triggers) in tests and repair tools. */
export async function executeRawStatement(
  handle: PersistenceHandle,
  statement: string,
): Promise<void> {
  await sql.raw(statement).execute(handle.db);
}

/** An open database: a Kysely instance plus what the runner needs to know about it. */
export interface PersistenceHandle {
  readonly dialect: DialectName;
  readonly db: Kysely<Database>;
  /** The SQLite file, when there is one. Undefined for `:memory:` and for Postgres. */
  readonly path: string | undefined;
  close(): Promise<void>;
}
