import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0009Captures } from './0009_captures';

async function statementsFor(
  dialect: DialectName,
  failing: (sql: string) => boolean = () => false,
): Promise<string[]> {
  const statements: string[] = [];
  await migration0009Captures.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      if (failing(sql)) return Promise.reject(new Error('no such module'));
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

const objects = (statements: string[]): (string | undefined)[] =>
  statements.map(
    (sql) => /^CREATE (?:VIRTUAL )?(?:TABLE|INDEX) (\w+)/.exec(sql)?.[1],
  );

describe('0009_captures', () => {
  it('has an id equal to its file name', () => {
    expect(migration0009Captures.id).toBe('0009_captures');
  });

  it('M1-09 AC-15 creates the capture tables and their indexes, and the FTS5 table on SQLite', async () => {
    const statements = await statementsFor('sqlite');

    expect(objects(statements)).toEqual([
      'captures',
      'captures_owner',
      'captures_expiry',
      'capture_blobs',
      'capture_blob_chunks',
      'captured_messages',
      'captured_messages_capture',
      'captured_messages_blob',
      'captured_fts',
    ]);
    expect(statements.at(-1)).toContain('contentless_delete=1');
  });

  it('M1-09 AC-15 adds a tsvector column with a GIN index on Postgres instead of the FTS5 table', async () => {
    const statements = await statementsFor('pg');

    expect(statements.join('\n')).not.toContain('fts5');
    expect(statements.slice(-2)).toEqual([
      'ALTER TABLE captured_messages ADD COLUMN search tsvector',
      'CREATE INDEX captured_messages_search ON captured_messages USING GIN (search)',
    ]);
    expect(statements.filter((s) => s.includes('BYTEA'))).toHaveLength(2);
  });

  it('M1-09 AC-11 skips the FTS5 table when the runtime refuses it, and keeps the rest', async () => {
    const statements = await statementsFor('sqlite', (sql) =>
      sql.includes('fts5'),
    );

    expect(objects(statements)).toHaveLength(8);
    expect(statements.join('\n')).not.toContain('captured_fts');
  });

  it('keeps the sealed columns as bytes and holds no column for a key or a plaintext body', async () => {
    const ddl = (await statementsFor('sqlite')).join('\n');

    expect(ddl).toMatch(/body_sealed BLOB/);
    expect(ddl).toMatch(/meta_sealed BLOB NOT NULL/);
    expect(ddl).not.toMatch(/\bbody (TEXT|BLOB)/);
    expect(ddl).not.toMatch(/\b(dek|secret|password)\w* /i);
  });
});
