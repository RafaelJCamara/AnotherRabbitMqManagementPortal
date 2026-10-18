import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0001Core } from './0001_core';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0001Core.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

describe('0001_core', () => {
  it('has an id equal to its file name', () => {
    expect(migration0001Core.id).toBe('0001_core');
  });

  it('creates settings, connection_profiles and blobs', async () => {
    const statements = await statementsFor('sqlite');

    expect(
      statements
        .map((sql) => /^CREATE TABLE (\w+)/.exec(sql)?.[1])
        .filter((name) => name !== undefined),
    ).toEqual(['settings', 'connection_profiles', 'blobs']);
  });

  it('is one migration set: the dialects differ only in the bytes type', async () => {
    const sqlite = await statementsFor('sqlite');
    const pg = await statementsFor('pg');

    expect(sqlite.join('\n')).toContain('body BLOB NOT NULL');
    expect(pg.join('\n')).toContain('body BYTEA NOT NULL');
    expect(pg.map((sql) => sql.replace('BYTEA', 'BLOB'))).toEqual(sqlite);
  });
});
