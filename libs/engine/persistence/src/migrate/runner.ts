// The migration runner (ADR-013, amendment A-18): one ordered migration set for both dialects.
//
//   refuseNewer()  a database stamped with a newer schema is refused with a Problem
//   backup()       desktop and local: VACUUM INTO a copy of the SQLite file before migrating
//   apply()        every pending migration in one transaction (Postgres: under an advisory lock)
//   migrate()      the engine start-up sequence: refuseNewer, backup when something is pending, apply
//
// The schema version is the number of the last applied migration, kept in `schema_migrations`.
// Team migrations run in a Helm hook Job under a DDL role; the app role never calls `apply`.
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { sql, type Kysely } from 'kysely';

import type { Database, PersistenceHandle } from '../database';
import { migrations as defaultMigrations } from '../migrations/index';
import { MigrationHistoryError, SchemaTooNewError } from './errors';
import { columnTypes } from './helpers';
import type { Migration, SqlExecutor } from './types';

/** Serialises concurrent `apply` calls on Postgres (an arbitrary constant). */
const ADVISORY_LOCK_KEY = 7_262_901;
const TABLE = 'schema_migrations';

export interface MigrationRunnerOptions {
  handle: PersistenceHandle;
  /** The ordered migration set. Defaults to the engine's own; tests inject others. */
  migrations?: readonly Migration[];
  /** Directory for backups. Defaults to the directory of the database file. */
  backupDir?: string;
  /** Wall-clock milliseconds, for backup names and `applied_at`. */
  now?: () => number;
  /** Correlation id of the Problem raised for a newer schema. */
  correlationId?: () => string;
}

export interface MigrateResult {
  /** The schema version before and after. */
  from: number;
  to: number;
  /** Ids applied by this call, in order. */
  applied: string[];
  /** The backup taken before migrating, when one was. */
  backup: string | undefined;
}

export interface MigrationRunner {
  /** The highest schema version this engine knows. */
  readonly latestVersion: number;
  /** The schema version stamped in the database; 0 when it has none. */
  currentVersion(): Promise<number>;
  /** Throws `SchemaTooNewError` (carrying a Problem) when the database is newer than this engine. */
  refuseNewer(): Promise<void>;
  /** SQLite file only: `VACUUM INTO` a copy and return its path. Undefined for Postgres and `:memory:`. */
  backup(): Promise<string | undefined>;
  /** Applies every pending migration in one transaction. */
  apply(): Promise<MigrateResult>;
  /** `refuseNewer`, then `backup` when a populated database has pending migrations, then `apply`. */
  migrate(): Promise<MigrateResult>;
}

/** `0007_name` is version 7. */
function versionOf(id: string): number {
  return Number.parseInt(id.slice(0, 4), 10);
}

/** The version of the last id of an ordered list; 0 for an empty list. */
function lastVersion(ids: readonly string[]): number {
  const last = ids.at(-1);
  return last === undefined ? 0 : versionOf(last);
}

async function readApplied(db: Kysely<Database>): Promise<string[]> {
  const tables = await db.introspection.getTables();
  if (!tables.some((table) => table.name === TABLE)) return [];
  const rows = await db.selectFrom(TABLE).select('id').orderBy('id').execute();
  return rows.map((row) => row.id);
}

export function createMigrationRunner(
  options: MigrationRunnerOptions,
): MigrationRunner {
  const { handle } = options;
  const set = options.migrations ?? defaultMigrations;
  const now = options.now ?? Date.now;
  const latestVersion = lastVersion(set.map((migration) => migration.id));

  /** Throws when the applied ids are newer than, or not a prefix of, this engine's set. */
  function checkHistory(applied: readonly string[]): void {
    const found = applied.reduce((max, id) => Math.max(max, versionOf(id)), 0);
    if (found > latestVersion) {
      throw new SchemaTooNewError(
        found,
        latestVersion,
        options.correlationId?.(),
      );
    }
    applied.forEach((id, index) => {
      if (set[index]?.id !== id)
        throw new MigrationHistoryError(id, set[index]?.id);
    });
  }

  const currentVersion = async (): Promise<number> => {
    const applied = await readApplied(handle.db);
    return lastVersion(applied);
  };

  const refuseNewer = async (): Promise<void> => {
    checkHistory(await readApplied(handle.db));
  };

  const backup = async (): Promise<string | undefined> => {
    if (handle.dialect !== 'sqlite' || handle.path === undefined) {
      return undefined;
    }
    const from = String(await currentVersion()).padStart(4, '0');
    const dir = options.backupDir ?? dirname(handle.path);
    const target = join(
      dir,
      `${basename(handle.path)}.v${from}.${String(now())}.bak`,
    );
    await mkdir(dir, { recursive: true });
    await sql`VACUUM INTO ${target}`.execute(handle.db);
    return target;
  };

  const apply = (): Promise<MigrateResult> =>
    handle.db.transaction().execute(async (trx) => {
      const t = columnTypes(handle.dialect);
      if (handle.dialect === 'pg') {
        await sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`.execute(
          trx,
        );
      }
      await sql
        .raw(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (id ${t.id()} NOT NULL PRIMARY KEY, applied_at ${t.epochMs()} NOT NULL)`,
        )
        .execute(trx);

      const applied = await readApplied(trx);
      checkHistory(applied);
      const from = lastVersion(applied);

      const executor: SqlExecutor = {
        dialect: handle.dialect,
        t,
        execute: async (statement) => {
          await sql.raw(statement).execute(trx);
        },
      };
      const done: string[] = [];
      for (const migration of set.slice(applied.length)) {
        await migration.up(executor);
        await trx
          .insertInto(TABLE)
          .values({ id: migration.id, applied_at: now() })
          .execute();
        done.push(migration.id);
      }
      return {
        from,
        to: done.length === 0 ? from : lastVersion(done),
        applied: done,
        backup: undefined,
      };
    });

  const migrate = async (): Promise<MigrateResult> => {
    const applied = await readApplied(handle.db);
    checkHistory(applied);
    // Back up only a database that has data to lose: not a fresh one, not one already current.
    const taken =
      applied.length > 0 && applied.length < set.length
        ? await backup()
        : undefined;
    const result = await apply();
    return { ...result, backup: taken };
  };

  return {
    latestVersion,
    currentVersion,
    refuseNewer,
    backup,
    apply,
    migrate,
  };
}
