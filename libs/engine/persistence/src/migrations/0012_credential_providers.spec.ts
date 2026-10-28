import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0012CredentialProviders } from './0012_credential_providers';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0012CredentialProviders.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

const columns = (create: string): string[] =>
  create
    .split('\n')
    .slice(1, -2)
    .map((line) => line.trim().split(' ')[0] ?? '');

describe('0012_credential_providers', () => {
  it('has an id equal to its file name', () => {
    expect(migration0012CredentialProviders.id).toBe(
      '0012_credential_providers',
    );
  });

  it.each(['sqlite', 'pg'] as const)(
    'M1-23 slice E creates the provider table keyed like the credentials, with no secret column (%s)',
    async (dialect) => {
      const statements = await statementsFor(dialect);

      expect(statements).toHaveLength(1);
      const create = statements[0] ?? '';
      expect(create).toMatch(/^CREATE TABLE credential_providers \(/);
      expect(columns(create)).toEqual([
        'connection_id',
        'protocol',
        'config',
        'updated_at',
      ]);
      expect(create).toContain('PRIMARY KEY (connection_id, protocol)');
      // The same two protocols as the credentials table (0007), and no other.
      expect(create).toContain("CHECK (protocol IN ('http', 'amqp'))");
      // The config is JSON text on both dialects; nothing here is bytes (the sealed secret is not here).
      expect(create).toContain('config TEXT NOT NULL');
      expect(create).not.toMatch(/BLOB|BYTEA/);
      expect(create).not.toMatch(/\b(secret|password|token|ciphertext)\w* /i);
      expect(create).not.toMatch(/REFERENCES/i);
    },
  );
});
