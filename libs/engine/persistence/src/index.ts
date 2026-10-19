// @app/persistence: Kysely over an in-repo node:sqlite dialect and over pg, one migration set,
// backup before migrating and refusal of a newer schema (M0-21, ADR-013).
export type {
  AuditEventsTable,
  BlobsTable,
  ConnectionProfilesTable,
  CredentialsTable,
  DataKeysTable,
  Database,
  IdempotencyKeysTable,
  JobEventsTable,
  JobsTable,
  PersistenceHandle,
  PlansTable,
  ReceiptsTable,
  SchemaMigrationsTable,
  SettingsTable,
  ViewsTable,
} from './database';
export { executeRawStatement } from './database';
export { openSqlite, type NodeSqliteOptions } from './dialects/node-sqlite';
export { openPg, type PgOptions } from './dialects/pg';
export {
  MigrationHistoryError,
  SCHEMA_TOO_NEW_TYPE,
  SchemaTooNewError,
} from './migrate/errors';
export {
  columnTypes,
  type ColumnTypes,
  type DialectName,
} from './migrate/helpers';
export {
  createMigrationRunner,
  type MigrateResult,
  type MigrationRunner,
  type MigrationRunnerOptions,
} from './migrate/runner';
export type { Migration, SqlExecutor } from './migrate/types';
export { migrations } from './migrations';
export { createRepositories, type RepositoryOptions } from './repos';
export type {
  BlobRepository,
  ConnectionProfileInput,
  ConnectionProfileRecord,
  ConnectionProfileRepository,
  ConnectionVisibility,
  JsonValue,
  Repositories,
  SettingEntry,
  SettingsRepository,
} from './repos/ports';
