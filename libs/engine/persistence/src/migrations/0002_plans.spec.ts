import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0002Plans } from './0002_plans';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0002Plans.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

describe('0002_plans', () => {
  it('has an id equal to its file name', () => {
    expect(migration0002Plans.id).toBe('0002_plans');
  });

  it('creates plans and idempotency_keys with the indexes the executor queries', async () => {
    const statements = await statementsFor('sqlite');

    expect(
      statements
        .map(
          (sql) => /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (\w+)/.exec(sql)?.[1],
        )
        .filter((name) => name !== undefined),
    ).toEqual([
      'plans',
      'plans_principal_state',
      'plans_expiry',
      'plans_retention',
      'idempotency_keys',
      'idempotency_keys_created',
    ]);
  });

  it('keeps the payload nullable (purged after use) and scopes a key to its principal', async () => {
    const sql = (await statementsFor('sqlite')).join('\n');

    expect(sql).toMatch(/payload BLOB,/);
    expect(sql).toContain('PRIMARY KEY (principal_id, key)');
  });

  it('is one migration set: the dialects differ only in the bytes type', async () => {
    const sqlite = await statementsFor('sqlite');
    const pg = await statementsFor('pg');

    expect(pg.join('\n')).toContain('payload BYTEA,');
    expect(pg.map((sql) => sql.replace('BYTEA', 'BLOB'))).toEqual(sqlite);
  });
});
