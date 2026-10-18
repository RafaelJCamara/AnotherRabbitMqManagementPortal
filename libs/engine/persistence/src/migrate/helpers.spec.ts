import { describe, expect, it } from 'vitest';

import { columnTypes } from './helpers';

describe('columnTypes', () => {
  it('maps every helper on SQLite', () => {
    const t = columnTypes('sqlite');

    expect([t.id(), t.json(), t.epochMs(), t.bytes()]).toEqual([
      'TEXT',
      'TEXT',
      'BIGINT',
      'BLOB',
    ]);
  });

  it('differs from SQLite only in bytes on Postgres', () => {
    const t = columnTypes('pg');

    expect([t.id(), t.json(), t.epochMs(), t.bytes()]).toEqual([
      'TEXT',
      'TEXT',
      'BIGINT',
      'BYTEA',
    ]);
  });
});
