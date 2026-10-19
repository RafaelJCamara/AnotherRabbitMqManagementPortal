import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0007Credentials } from './0007_credentials';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0007Credentials.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

describe('0007_credentials', () => {
  it('has an id equal to its file name', () => {
    expect(migration0007Credentials.id).toBe('0007_credentials');
  });

  it('creates one credentials table keyed by profile and protocol, with no column for a plain secret', async () => {
    const statements = await statementsFor('sqlite');

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE TABLE credentials');
    expect(statements[0]).toContain('PRIMARY KEY (connection_id, protocol)');
    expect(statements[0]).toContain("CHECK (protocol IN ('http', 'amqp'))");
    expect(statements[0]).not.toMatch(/password|token|secret/i);
  });

  it('writes the same DDL apart from the column types for both dialects', async () => {
    const sqlite = await statementsFor('sqlite');
    const pg = await statementsFor('pg');

    expect(pg).toHaveLength(sqlite.length);
    expect(pg[0]).toContain('BYTEA');
    expect(sqlite[0]).toContain('BLOB');
  });
});
