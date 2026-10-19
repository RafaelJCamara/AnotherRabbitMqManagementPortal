import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0005Jobs } from './0005_jobs';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0005Jobs.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

describe('0005_jobs', () => {
  it('has an id equal to its file name', () => {
    expect(migration0005Jobs.id).toBe('0005_jobs');
  });

  it('creates jobs, job_events and their indexes', async () => {
    const statements = await statementsFor('sqlite');

    expect(
      statements.map(
        (sql) => /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (\w+)/.exec(sql)?.[1],
      ),
    ).toEqual([
      'jobs',
      'jobs_claim',
      'jobs_lease',
      'jobs_retention',
      'jobs_concurrency_running',
      'job_events',
    ]);
  });

  it('makes an idempotency key unique per principal and a concurrency key unique while running', async () => {
    const sql = (await statementsFor('sqlite')).join('\n');

    expect(sql).toContain('UNIQUE (principal_id, idempotency_key)');
    expect(sql).toMatch(
      /UNIQUE INDEX jobs_concurrency_running ON jobs \(concurrency_key\)\s+WHERE state = 'running' AND concurrency_key IS NOT NULL/,
    );
  });

  it('allows only the eight states of a job', async () => {
    const sql = (await statementsFor('pg')).join('\n');

    expect(sql).toContain(
      "CHECK (state IN ('queued', 'running', 'paused', 'paused-interrupted', 'awaiting-credentials', 'succeeded', 'failed', 'cancelled'))",
    );
  });

  it('stores the sealed members as bytes on each dialect', async () => {
    const sqlite = (await statementsFor('sqlite')).join('\n');
    const pg = (await statementsFor('pg')).join('\n');

    expect(sqlite).toContain('input BLOB NOT NULL');
    expect(pg).toContain('input BYTEA NOT NULL');
    expect(pg).toContain('checkpoint BYTEA,');
    expect(pg).toContain('result BYTEA,');
  });
});
