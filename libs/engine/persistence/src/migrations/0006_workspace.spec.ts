import { describe, expect, it } from 'vitest';

import { columnTypes, type DialectName } from '../migrate/helpers';
import { migration0006Workspace } from './0006_workspace';

async function statementsFor(dialect: DialectName): Promise<string[]> {
  const statements: string[] = [];
  await migration0006Workspace.up({
    dialect,
    t: columnTypes(dialect),
    execute: (sql) => {
      statements.push(sql);
      return Promise.resolve();
    },
  });
  return statements;
}

describe('0006_workspace', () => {
  it('has an id equal to its file name', () => {
    expect(migration0006Workspace.id).toBe('0006_workspace');
  });

  it('creates views and the index of the window query, and nothing bound to a connection', async () => {
    const statements = await statementsFor('sqlite');

    expect(
      statements.map((sql) => /^CREATE (?:TABLE|INDEX) (\w+)/.exec(sql)?.[1]),
    ).toEqual(['views', 'views_owner']);
    expect(statements.join('\n')).not.toMatch(/connection/i);
    expect(statements[1]).toBe(
      'CREATE INDEX views_owner ON views (owner_id, id)',
    );
  });

  it('writes the same DDL for both dialects', async () => {
    expect(await statementsFor('pg')).toEqual(await statementsFor('sqlite'));
  });
});
