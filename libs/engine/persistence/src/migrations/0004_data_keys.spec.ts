import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0004DataKeys } from './0004_data_keys';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0004DataKeys.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

describe('0004_data_keys', () => {
  it('has an id equal to its file name', () => {
    expect(migration0004DataKeys.id).toBe('0004_data_keys');
  });

  it('creates data_keys with its two indexes, the same on both dialects', async () => {
    for (const dialect of ['sqlite', 'pg'] as const) {
      const names = (await statementsFor(dialect))
        .map(
          (sql) => /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (\w+)/.exec(sql)?.[1],
        )
        .filter((name) => name !== undefined);
      expect(names).toEqual([
        'data_keys',
        'data_keys_one_active',
        'data_keys_purpose',
      ]);
    }
  });

  it('allows one active key per purpose and only the known wrap kinds and states', async () => {
    const sql = (await statementsFor('sqlite')).join('\n');

    expect(sql).toContain(
      `CREATE UNIQUE INDEX data_keys_one_active ON data_keys (purpose) WHERE state = 'active'`,
    );
    expect(sql).toContain(
      `CHECK (wrap_kind IN ('file-kek', 'passphrase', 'keyring', 'ctl-delivered'))`,
    );
    expect(sql).toContain(`CHECK (state IN ('active', 'retired'))`);
  });

  it('has no column that could hold a data key in the open', async () => {
    const sql = (await statementsFor('sqlite')).join('\n');

    // The only bytes column is the sealed one; there is no `dek`, `key` or `secret` column.
    expect(sql).toMatch(/\bwrapped \w+ NOT NULL/);
    expect(sql).not.toMatch(/\b(dek|secret|plaintext|kek)\b\s+\w+/i);
  });
});
