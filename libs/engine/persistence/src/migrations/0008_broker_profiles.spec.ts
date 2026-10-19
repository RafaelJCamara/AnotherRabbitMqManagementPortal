import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0008BrokerProfiles } from './0008_broker_profiles';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0008BrokerProfiles.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

describe('0008_broker_profiles', () => {
  it('has an id equal to its file name', () => {
    expect(migration0008BrokerProfiles.id).toBe('0008_broker_profiles');
  });

  it('creates one table keyed by connection, with the fingerprint and the document', async () => {
    const statements = await statementsFor('sqlite');

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('CREATE TABLE broker_profiles');
    expect(statements[0]).toContain('connection_id');
    expect(statements[0]).toContain('PRIMARY KEY');
    expect(statements[0]).toContain('fingerprint');
    expect(statements[0]).toContain('profile');
  });

  it('writes the same DDL for both dialects: it holds no bytes column', async () => {
    expect(await statementsFor('pg')).toEqual(await statementsFor('sqlite'));
  });
});
