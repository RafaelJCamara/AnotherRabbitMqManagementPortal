// Integration tests (M0-21): the same migrations and repository contract on SQLite and on
// Postgres 16 and 18. Run with `pnpm nx run persistence:it --dialects=sqlite,pg`.
// Postgres needs a Docker daemon; with `pg` selected and none running the run fails, it does not skip.
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { openPg } from '../dialects/pg';
import { openSqlite } from '../dialects/node-sqlite';
import { SchemaTooNewError } from '../migrate/errors';
import { createMigrationRunner } from '../migrate/runner';
import { migrations } from '../migrations';
import { migration0001Core } from '../migrations/0001_core';
import {
  startPostgres,
  type PostgresContainer,
} from '../testing/postgres-container';
import { repositoryContract } from '../testing/repository-contract';
import { tempDirectory } from '../testing/sqlite-fixtures';
import { sql } from 'kysely';

const dialects = (process.env.PERSISTENCE_IT_DIALECTS ?? 'sqlite,pg').split(
  ',',
);
const pgVersions = (process.env.PERSISTENCE_IT_PG_VERSIONS ?? '16,18').split(
  ',',
);

interface Target {
  name: string;
  /** Starts what the target needs (a container); returns what to call at the end. */
  start(): Promise<() => Promise<void>>;
  /** A new, empty database, closed by the test that opens it. */
  fresh(): Promise<PersistenceHandle>;
}

function sqliteTarget(): Target {
  let directory: Awaited<ReturnType<typeof tempDirectory>>;
  let counter = 0;
  return {
    name: 'sqlite',
    async start() {
      directory = await tempDirectory();
      return () => directory.dispose();
    },
    fresh() {
      counter += 1;
      return openSqlite({
        path: join(directory.dir, `data-${String(counter)}.db`),
      });
    },
  };
}

function pgTarget(version: string): Target {
  let container: PostgresContainer;
  return {
    name: `postgres ${version}`,
    async start() {
      container = await startPostgres(version);
      return () => container.stop();
    },
    async fresh() {
      return openPg({ connectionString: await container.createDatabase() });
    },
  };
}

const targets: Target[] = [
  ...(dialects.includes('sqlite') ? [sqliteTarget()] : []),
  ...(dialects.includes('pg') ? pgVersions.map(pgTarget) : []),
];

interface Outcome {
  version: number;
  schema: string[];
}
const outcomes = new Map<string, Outcome>();

/** Table and column names with nullability: the shape both dialects must share. */
async function schemaOf(handle: PersistenceHandle): Promise<string[]> {
  const tables = await handle.db.introspection.getTables();
  return tables
    .flatMap((table) =>
      table.columns.map(
        (column) =>
          `${table.name}.${column.name}${column.isNullable ? '?' : ''}`,
      ),
    )
    .sort();
}

describe.each(targets)('$name', (target) => {
  let stop: () => Promise<void>;
  const opened: PersistenceHandle[] = [];

  const fresh = async () => {
    const handle = await target.fresh();
    opened.push(handle);
    return handle;
  };

  beforeAll(async () => {
    stop = await target.start();
  });

  afterAll(async () => {
    await Promise.all(opened.map((handle) => handle.close()));
    await stop();
  });

  it('AC-1 applies the migrations to an empty database and reaches the latest schema version', async () => {
    const handle = await fresh();
    const runner = createMigrationRunner({ handle });

    const result = await runner.migrate();

    expect(result).toMatchObject({
      from: 0,
      to: migrations.length,
      backup: undefined,
    });
    expect(await runner.currentVersion()).toBe(runner.latestVersion);
    outcomes.set(target.name, {
      version: await runner.currentVersion(),
      schema: await schemaOf(handle),
    });
  });

  repositoryContract({
    name: `AC-1 ${target.name}`,
    open: async () => {
      const handle = await fresh();
      await createMigrationRunner({ handle }).migrate();
      return handle;
    },
  });

  it('AC-2 refuses a database stamped with a newer schema, with a Problem', async () => {
    const handle = await fresh();
    const runner = createMigrationRunner({ handle });
    await runner.migrate();
    await sql`INSERT INTO schema_migrations (id, applied_at) VALUES ('9999_future', 1)`.execute(
      handle.db,
    );

    const refusal = await runner.migrate().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(SchemaTooNewError);
    expect((refusal as SchemaTooNewError).problem).toMatchObject({
      type: 'urn:problem:schema-too-new',
      code: 'INTERNAL',
    });
  });

  it.runIf(target.name === 'sqlite')(
    'AC-2 a desktop migration takes a VACUUM INTO backup first',
    async () => {
      const handle = await fresh();
      await createMigrationRunner({
        handle,
        migrations: [migration0001Core],
      }).migrate();
      const next = {
        id: '0002_extra',
        up: (db: { execute(sql: string): Promise<void> }) =>
          db.execute('CREATE TABLE extra (id TEXT PRIMARY KEY)'),
      };

      const result = await createMigrationRunner({
        handle,
        migrations: [migration0001Core, next],
      }).migrate();

      expect(result.backup).toBeDefined();
      const files = await readdir(dirname(handle.path ?? ''));
      expect(files.filter((name) => name.endsWith('.bak'))).toHaveLength(1);
    },
  );

  it.runIf(target.name.startsWith('postgres'))(
    'two runners applying at once do not collide',
    async () => {
      const handle = await fresh();

      // Two connections of one pool: the advisory lock makes the second wait, then see the first's work.
      const results = await Promise.all([
        createMigrationRunner({ handle }).apply(),
        createMigrationRunner({ handle }).apply(),
      ]);

      expect(results.map((result) => result.applied.length).sort()).toEqual([
        0,
        migrations.length,
      ]);
    },
  );
});

describe('AC-1 both dialects', () => {
  it('reach the same schema version and the same schema', ({ skip }) => {
    if (outcomes.size < 2) skip();
    const [first, ...rest] = [...outcomes.values()];

    for (const other of rest) {
      expect(other).toEqual(first);
    }
    expect(first?.version).toBe(migrations.length);
  });
});
