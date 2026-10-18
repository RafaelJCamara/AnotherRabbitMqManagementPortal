import { join } from 'node:path';

import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PersistenceHandle } from '../database';
import { tempDirectory } from '../testing/sqlite-fixtures';
import { openSqlite } from './node-sqlite';

describe('node:sqlite dialect', () => {
  let directory: Awaited<ReturnType<typeof tempDirectory>>;
  let handle: PersistenceHandle;

  beforeEach(async () => {
    directory = await tempDirectory();
    handle = await openSqlite({ path: join(directory.dir, 'data.db') });
    await sql`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, data BLOB)`.execute(
      handle.db,
    );
  });

  afterEach(async () => {
    await handle.close();
    await directory.dispose();
  });

  const pragma = async (name: string): Promise<unknown> => {
    const result = await sql<
      Record<string, unknown>
    >`${sql.raw(`PRAGMA ${name}`)}`.execute(handle.db);
    return Object.values(result.rows[0] ?? {})[0];
  };

  it('opens in WAL mode with a 5 s busy timeout and foreign keys on', async () => {
    expect(await pragma('journal_mode')).toBe('wal');
    expect(await pragma('busy_timeout')).toBe(5000);
    expect(await pragma('foreign_keys')).toBe(1);
  });

  it('reports the path of a file database', () => {
    expect(handle.path).toBe(join(directory.dir, 'data.db'));
    expect(handle.dialect).toBe('sqlite');
  });

  it('inserts, selects and counts affected rows', async () => {
    const result =
      await sql`INSERT INTO t (name) VALUES (${'a'}), (${'b'})`.execute(
        handle.db,
      );
    expect(result.numAffectedRows).toBe(2n);
    const rows = await sql<{
      name: string;
    }>`SELECT name FROM t ORDER BY id`.execute(handle.db);
    expect(rows.rows.map((row) => row.name)).toEqual(['a', 'b']);
    const updated = await sql`UPDATE t SET name = 'z'`.execute(handle.db);
    expect(updated.numAffectedRows).toBe(2n);
  });

  it('binds booleans as 0 and 1, null, numbers and bytes', async () => {
    const bytes = Uint8Array.from([0, 1, 254, 255]);
    await sql`INSERT INTO t (name, flag, data) VALUES (${null}, ${true}, ${bytes})`.execute(
      handle.db,
    );
    await sql`INSERT INTO t (name, flag, data) VALUES (${'x'}, ${false}, ${null})`.execute(
      handle.db,
    );

    const rows = await sql<{
      name: string | null;
      flag: number;
      data: Uint8Array | null;
    }>`
      SELECT name, flag, data FROM t ORDER BY id`.execute(handle.db);

    expect(rows.rows.map((row) => [row.name, row.flag])).toEqual([
      [null, 1],
      ['x', 0],
    ]);
    expect(new Uint8Array(rows.rows[0]?.data ?? [])).toEqual(bytes);
    expect(rows.rows[1]?.data).toBeNull();
  });

  it('refuses a value it cannot bind instead of storing garbage', async () => {
    await expect(
      sql`INSERT INTO t (name) VALUES (${undefined})`.execute(handle.db),
    ).rejects.toThrow(TypeError);
    await expect(
      sql`INSERT INTO t (name) VALUES (${{ a: 1 }})`.execute(handle.db),
    ).rejects.toThrow('Cannot bind a object value');
  });

  it('commits a transaction and rolls one back', async () => {
    await handle.db.transaction().execute(async (trx) => {
      await sql`INSERT INTO t (name) VALUES ('committed')`.execute(trx);
    });
    await expect(
      handle.db.transaction().execute(async (trx) => {
        await sql`INSERT INTO t (name) VALUES ('rolled back')`.execute(trx);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    const rows = await sql<{ name: string }>`SELECT name FROM t`.execute(
      handle.db,
    );
    expect(rows.rows.map((row) => row.name)).toEqual(['committed']);
  });

  it('serialises transactions on the single connection', async () => {
    const log: string[] = [];
    const run = (label: string) =>
      handle.db.transaction().execute(async (trx) => {
        log.push(`${label} begin`);
        await sql`INSERT INTO t (name) VALUES (${label})`.execute(trx);
        await new Promise((resolve) => setTimeout(resolve, 10));
        log.push(`${label} end`);
      });

    await Promise.all([run('a'), run('b'), run('c')]);

    expect(log).toEqual([
      'a begin',
      'a end',
      'b begin',
      'b end',
      'c begin',
      'c end',
    ]);
  });

  it('enforces foreign keys', async () => {
    await sql`CREATE TABLE child (id INTEGER PRIMARY KEY, t_id INTEGER NOT NULL REFERENCES t (id))`.execute(
      handle.db,
    );

    await expect(
      sql`INSERT INTO child (t_id) VALUES (999)`.execute(handle.db),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('does not stream: page with a keyset', async () => {
    const stream = handle.db
      .selectFrom('schema_migrations')
      .selectAll()
      .stream();

    await expect(stream.next()).rejects.toThrow('does not stream');
  });

  it('fails at open, not at first use, when the path cannot be opened', async () => {
    await expect(
      openSqlite({ path: join(directory.dir, 'missing', 'dir', 'data.db') }),
    ).rejects.toThrow();
  });
});
