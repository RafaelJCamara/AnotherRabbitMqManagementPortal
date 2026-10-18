import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0003AuditReceipts } from './0003_audit_receipts';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0003AuditReceipts.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

describe('0003_audit_receipts', () => {
  it('has an id equal to its file name', () => {
    expect(migration0003AuditReceipts.id).toBe('0003_audit_receipts');
  });

  it('creates audit_events and receipts with their indexes', async () => {
    const statements = await statementsFor('sqlite');

    expect(
      statements
        .map(
          (sql) =>
            /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER) (\w+)/.exec(sql)?.[1],
        )
        .filter((name) => name !== undefined),
    ).toEqual([
      'audit_events',
      'audit_events_actor',
      'audit_events_action',
      'audit_events_correlation',
      'audit_events_at',
      'audit_events_no_update',
      'audit_events_no_delete',
      'receipts',
      'receipts_plan',
      'receipts_created',
    ]);
  });

  it('keeps the chain linear: seq is the key and prev_hash is unique', async () => {
    const sql = (await statementsFor('sqlite')).join('\n');

    expect(sql).toContain('seq BIGINT NOT NULL PRIMARY KEY');
    expect(sql).toContain('prev_hash TEXT NOT NULL UNIQUE');
  });

  it('rejects UPDATE and DELETE on SQLite', async () => {
    const sql = (await statementsFor('sqlite')).join('\n');

    expect(sql).toMatch(
      /BEFORE UPDATE ON audit_events\s+BEGIN\s+SELECT RAISE\(ABORT/,
    );
    expect(sql).toMatch(
      /BEFORE DELETE ON audit_events\s+BEGIN\s+SELECT RAISE\(ABORT/,
    );
  });

  it('rejects UPDATE, DELETE and TRUNCATE on Postgres', async () => {
    const sql = (await statementsFor('pg')).join('\n');

    expect(sql).toContain('BEFORE UPDATE OR DELETE ON audit_events');
    expect(sql).toContain('BEFORE TRUNCATE ON audit_events');
    expect(sql).toContain('RAISE EXCEPTION');
  });
});
