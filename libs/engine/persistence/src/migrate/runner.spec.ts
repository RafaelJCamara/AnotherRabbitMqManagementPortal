import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ProblemSchema } from '@app/contracts';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { openSqlite } from '../dialects/node-sqlite';
import { migrations as engineMigrations } from '../migrations';
import { tempDirectory } from '../testing/sqlite-fixtures';
import { MigrationHistoryError, SchemaTooNewError } from './errors';
import { createMigrationRunner } from './runner';
import type { Migration } from './types';

const create = (id: string, table: string): Migration => ({
  id,
  up: async (db) => {
    await db.execute(
      `CREATE TABLE ${table} (id ${db.t.id()} PRIMARY KEY, body ${db.t.bytes()})`,
    );
  },
});
const m1 = create('0001_first', 'first');
const m2 = create('0002_second', 'second');

const tableNames = async (handle: PersistenceHandle): Promise<string[]> =>
  (await handle.db.introspection.getTables()).map((table) => table.name).sort();

describe('MigrationRunner', () => {
  let directory: Awaited<ReturnType<typeof tempDirectory>>;
  let handle: PersistenceHandle;
  let file: string;

  beforeEach(async () => {
    directory = await tempDirectory();
    file = join(directory.dir, 'data.db');
    handle = await openSqlite({ path: file });
  });

  afterEach(async () => {
    await handle.close();
    await directory.dispose();
  });

  it('applies every migration to an empty database and stamps the version', async () => {
    const runner = createMigrationRunner({
      handle,
      migrations: [m1, m2],
      now: () => 42,
    });

    const result = await runner.migrate();

    expect(result).toEqual({
      from: 0,
      to: 2,
      applied: ['0001_first', '0002_second'],
      backup: undefined,
    });
    expect(await runner.currentVersion()).toBe(2);
    expect(await tableNames(handle)).toEqual([
      'first',
      'schema_migrations',
      'second',
    ]);
    const rows = await handle.db
      .selectFrom('schema_migrations')
      .selectAll()
      .orderBy('id')
      .execute();
    expect(rows).toEqual([
      { id: '0001_first', applied_at: 42 },
      { id: '0002_second', applied_at: 42 },
    ]);
  });

  it('reports version 0 before any migration and applies nothing twice', async () => {
    const runner = createMigrationRunner({ handle, migrations: [m1] });
    expect(await runner.currentVersion()).toBe(0);

    await runner.migrate();
    const again = await runner.migrate();

    expect(again).toMatchObject({
      from: 1,
      to: 1,
      applied: [],
      backup: undefined,
    });
  });

  it('applies only the pending migrations', async () => {
    await createMigrationRunner({ handle, migrations: [m1] }).migrate();

    const result = await createMigrationRunner({
      handle,
      migrations: [m1, m2],
    }).apply();

    expect(result).toMatchObject({ from: 1, to: 2, applied: ['0002_second'] });
  });

  it('rolls back the whole run when a migration fails', async () => {
    const broken: Migration = {
      id: '0002_broken',
      up: async (db) => {
        await db.execute('CREATE TABLE half (id TEXT)');
        await db.execute('CREATE TABLE half (id TEXT)');
      },
    };
    const runner = createMigrationRunner({ handle, migrations: [m1, broken] });

    await expect(runner.migrate()).rejects.toThrow();

    expect(await tableNames(handle)).toEqual([]);
    expect(await runner.currentVersion()).toBe(0);
  });

  it('AC-2 refuses a database stamped with a newer schema, with a Problem', async () => {
    const runner = createMigrationRunner({
      handle,
      migrations: [m1],
      correlationId: () => 'cor-1',
    });
    await runner.migrate();
    await sql`INSERT INTO schema_migrations (id, applied_at) VALUES ('0099_future', 1)`.execute(
      handle.db,
    );

    const refusal = await runner.refuseNewer().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(SchemaTooNewError);
    const error = refusal as SchemaTooNewError;
    expect(ProblemSchema.parse(error.problem)).toMatchObject({
      type: 'urn:problem:schema-too-new',
      code: 'INTERNAL',
      correlationId: 'cor-1',
      retryable: false,
    });
    expect(error.problem.detail).toContain('schema version 99');
    expect(error.problem.detail).toContain('up to 1');
    // migrate() refuses too, and leaves the database and its files untouched.
    await expect(runner.migrate()).rejects.toBeInstanceOf(SchemaTooNewError);
    await expect(runner.apply()).rejects.toBeInstanceOf(SchemaTooNewError);
    expect(await tableNames(handle)).toEqual(['first', 'schema_migrations']);
    expect(
      (await readdir(directory.dir)).filter((name) => name.endsWith('.bak')),
    ).toEqual([]);
  });

  it('refuses a history that is not a prefix of the engine migrations', async () => {
    await createMigrationRunner({ handle, migrations: [m1] }).migrate();
    const other = create('0001_other', 'other');

    await expect(
      createMigrationRunner({ handle, migrations: [other, m2] }).migrate(),
    ).rejects.toBeInstanceOf(MigrationHistoryError);
  });

  it('AC-2 takes a VACUUM INTO backup before migrating a populated database', async () => {
    await createMigrationRunner({ handle, migrations: [m1] }).migrate();
    await sql`INSERT INTO first (id) VALUES ('kept')`.execute(handle.db);
    let existedBeforeDdl = false;
    const watcher: Migration = {
      id: '0002_second',
      up: async (db) => {
        const files = await readdir(directory.dir);
        existedBeforeDdl = files.some((name) => name.endsWith('.bak'));
        await m2.up(db);
      },
    };
    const runner = createMigrationRunner({
      handle,
      migrations: [m1, watcher],
      now: () => 1_700_000_000_000,
    });

    const result = await runner.migrate();

    expect(existedBeforeDdl).toBe(true);
    expect(result.backup).toBe(
      join(directory.dir, 'data.db.v0001.1700000000000.bak'),
    );
    expect(existsSync(result.backup ?? '')).toBe(true);
    // The copy is the database as it was: version 1, its row, and no table of migration 2.
    const copy = new DatabaseSync(result.backup ?? '', { readOnly: true });
    try {
      expect(copy.prepare('SELECT id FROM first').all()).toEqual([
        { id: 'kept' },
      ]);
      expect(copy.prepare('SELECT id FROM schema_migrations').all()).toEqual([
        { id: '0001_first' },
      ]);
      expect(
        copy
          .prepare("SELECT name FROM sqlite_master WHERE name = 'second'")
          .all(),
      ).toEqual([]);
    } finally {
      copy.close();
    }
    expect(await tableNames(handle)).toContain('second');
  });

  it('keeps the backup when the migration then fails', async () => {
    await createMigrationRunner({ handle, migrations: [m1] }).migrate();
    const broken: Migration = {
      id: '0002_broken',
      up: () => Promise.reject(new Error('boom')),
    };
    const runner = createMigrationRunner({ handle, migrations: [m1, broken] });

    await expect(runner.migrate()).rejects.toThrow('boom');

    expect(
      (await readdir(directory.dir)).filter((name) => name.endsWith('.bak')),
    ).toHaveLength(1);
    expect(await runner.currentVersion()).toBe(1);
  });

  it('takes no backup of a fresh database or of one that is already current', async () => {
    const runner = createMigrationRunner({ handle, migrations: [m1] });

    const fresh = await runner.migrate();
    const current = await runner.migrate();

    expect(fresh.backup).toBeUndefined();
    expect(current.backup).toBeUndefined();
    expect(
      (await readdir(directory.dir)).filter((name) => name.endsWith('.bak')),
    ).toEqual([]);
  });

  it('writes the backup to backupDir when given', async () => {
    await createMigrationRunner({ handle, migrations: [m1] }).migrate();
    const backupDir = join(directory.dir, 'nested', 'backups');

    const result = await createMigrationRunner({
      handle,
      migrations: [m1, m2],
      backupDir,
      now: () => 7,
    }).migrate();

    expect(result.backup).toBe(join(backupDir, 'data.db.v0001.7.bak'));
    expect(existsSync(join(backupDir, 'data.db.v0001.7.bak'))).toBe(true);
  });

  it('has no file to back up for an in-memory database', async () => {
    const memory = await openSqlite({ path: ':memory:' });
    try {
      const runner = createMigrationRunner({
        handle: memory,
        migrations: [m1, m2],
      });
      await createMigrationRunner({
        handle: memory,
        migrations: [m1],
      }).migrate();

      const result = await runner.migrate();

      expect(await runner.backup()).toBeUndefined();
      expect(result).toMatchObject({ from: 1, to: 2, backup: undefined });
    } finally {
      await memory.close();
    }
  });

  it('knows the latest version of the engine migrations', () => {
    expect(createMigrationRunner({ handle }).latestVersion).toBe(
      engineMigrations.length,
    );
    expect(
      createMigrationRunner({ handle, migrations: [] }).latestVersion,
    ).toBe(0);
  });
});
