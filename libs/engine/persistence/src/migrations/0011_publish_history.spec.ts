import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0011PublishHistory } from './0011_publish_history';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0011PublishHistory.up({
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
    .slice(1, -1)
    .map((line) => line.trim().split(' ')[0] ?? '');

describe('0011_publish_history', () => {
  it('has an id equal to its file name', () => {
    expect(migration0011PublishHistory.id).toBe('0011_publish_history');
  });

  it.each(['sqlite', 'pg'] as const)(
    'M1-19 AC-17 creates the publish history table and its indexes (%s)',
    async (dialect) => {
      const statements = await statementsFor(dialect);

      expect(statements).toHaveLength(3);
      expect(statements[0]).toMatch(/^CREATE TABLE publish_history \(/);
      expect(statements[1]).toBe(
        'CREATE INDEX publish_history_window ON publish_history (owner_id, connection_id, published_at, id)',
      );
      expect(statements[2]).toBe(
        'CREATE INDEX publish_history_expiry ON publish_history (expires_at, id)',
      );
      expect(columns(statements[0] ?? '')).toEqual([
        'id',
        'owner_id',
        'connection_id',
        'vhost',
        'published_at',
        'expires_at',
        'exchange',
        'routing_key',
        'copies',
        'summary',
        'body_bytes',
        'body_sha256',
        'data_sealed',
      ]);
      // The sealed document is bytes, and no other column can hold a body, a header or a property.
      expect(statements[0]).toContain(
        `data_sealed ${dialect === 'pg' ? 'BYTEA' : 'BLOB'} NOT NULL`,
      );
      expect(statements[0]).not.toMatch(/\b(body|headers|props)\b/);
      expect(statements[0]).not.toMatch(/\b(secret|password|dek)\w* /i);
    },
  );
});
