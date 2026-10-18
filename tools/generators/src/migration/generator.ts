// A numbered persistence migration (ADR-013: one migration set for SQLite and Postgres) in
// libs/engine/persistence, with a spec and the registration. The library is created on first use.
// The number is the next free one, so migrations stay contiguous and ordered.
import type { Tree } from '@nx/devkit';

import { ensureLibrary, type LibrarySpec } from '../shared/library.ts';
import { assertKebab, nameVariants, quote } from '../shared/names.ts';
import { appendImport, appendToArray } from '../shared/source-edit.ts';
import { Writer } from '../shared/writer.ts';
import type { MigrationOptions } from './schema.ts';

const ROOT = 'libs/engine/persistence';
const DIR = `${ROOT}/src/migrations`;
const REGISTRY = `${DIR}/index.ts`;
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.ts$/;

function hostLibrary(): LibrarySpec {
  return {
    name: 'persistence',
    type: 'adapter',
    runtime: 'node',
    root: ROOT,
    trustCritical: false,
    importPath: '@app/persistence',
    projectType: 'library',
    readme: {
      purpose:
        'Persistence over SQLite and Postgres (ADR-013): the repositories and the one ordered migration set both dialects apply.',
      publicApi: [
        '`migrations`: every migration, in order.',
        '`Migration`, `SqlExecutor`: the migration shape.',
      ],
      invariants: [
        'Migrations are numbered `NNNN_name`, contiguous and append-only: a released migration is never edited.',
        'One migration set serves both dialects; dialect differences live in the migrate helpers.',
        'The engine refuses a database stamped with a newer schema than the highest migration here.',
      ],
      proof: ['pnpm nx test persistence'],
    },
    files: {
      'src/index.ts': `export type { Migration, SqlExecutor } from './migrate/types';
export { migrations } from './migrations';
`,
      'src/migrate/helpers.ts': `/** The storage dialects: desktop and local (sqlite), team server (pg). */
export type DialectName = 'sqlite' | 'pg';

/** Column types for DDL, one method per helper (\`db.t.id()\`, \`db.t.bytes()\`, ...). */
export interface ColumnTypes {
  id(): string;
  json(): string;
  epochMs(): string;
  bytes(): string;
}

export function columnTypes(dialect: DialectName): ColumnTypes {
  return {
    id: () => 'TEXT',
    json: () => 'TEXT',
    epochMs: () => 'BIGINT',
    bytes: () => (dialect === 'pg' ? 'BYTEA' : 'BLOB'),
  };
}
`,
      'src/migrate/types.ts': `import type { ColumnTypes, DialectName } from './helpers';

/** The statement runner a migration receives; the migration runner implements it. */
export interface SqlExecutor {
  readonly dialect: DialectName;
  readonly t: ColumnTypes;
  execute(sql: string): Promise<void>;
}

export interface Migration {
  /** \`NNNN_name\`, equal to the file name without the extension. */
  readonly id: string;
  up(db: SqlExecutor): Promise<void>;
}
`,
      'src/migrations/index.ts': `import type { Migration } from '../migrate/types';

export const migrations: readonly Migration[] = [];
`,
      'src/migrations/index.spec.ts': `import { describe, expect, it } from 'vitest';

import { migrations } from './index';

describe('migrations', () => {
  it('are numbered 0001, 0002, ... without gaps, in order', () => {
    const numbers = migrations.map((migration) => migration.id.slice(0, 4));

    expect(numbers).toEqual(
      migrations.map((_, index) => String(index + 1).padStart(4, '0')),
    );
  });

  it('have ids of the form NNNN_name', () => {
    for (const migration of migrations) {
      expect(migration.id).toMatch(/^\\d{4}_[a-z0-9_]+$/);
    }
  });
});
`,
      'src/index.spec.ts': `import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('persistence public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual(['migrations']);
  });
});
`,
    },
  };
}

/** The number after the highest existing migration; 1 when there is none. */
export function nextNumber(writer: Writer): number {
  const numbers = writer.tree
    .children(DIR)
    .flatMap((file) => MIGRATION_FILE.exec(file)?.[1] ?? [])
    .map(Number);
  return Math.max(0, ...numbers) + 1;
}

export function migrationFiles(
  id: string,
  constant: string,
): Record<string, string> {
  return {
    [`${id}.ts`]: `import type { Migration } from '../migrate/types';

export const ${constant}: Migration = {
  id: ${quote(id)},
  // Replace with the DDL, one db.execute call per statement. Write SQL both SQLite and Postgres
  // accept, and use db.t.id(), db.t.json(), db.t.epochMs() and db.t.bytes() where they differ.
  up: () => Promise.resolve(),
};
`,
    [`${id}.spec.ts`]: `import { describe, expect, it } from 'vitest';

import { columnTypes } from '../migrate/helpers';
import { ${constant} } from './${id}';

describe(${quote(id)}, () => {
  it('has an id equal to its file name', () => {
    expect(${constant}.id).toBe(${quote(id)});
  });

  it('runs the statements it declares', async () => {
    const statements: string[] = [];

    await ${constant}.up({
      dialect: 'sqlite',
      t: columnTypes('sqlite'),
      execute: (sql) => {
        statements.push(sql);
        return Promise.resolve();
      },
    });

    // Assert the DDL here once the migration has some.
    expect(statements).toEqual([]);
  });
});
`,
  };
}

export async function migrationGenerator(
  tree: Tree,
  options: MigrationOptions,
): Promise<void> {
  const writer = new Writer(tree);
  const kebab = options.name.replace(/_/g, '-');
  assertKebab(kebab, 'migration name');

  ensureLibrary(writer, hostLibrary());
  const registry = writer.require(
    REGISTRY,
    `${ROOT} exists but has no migration registry; restore src/migrations/index.ts.`,
  );

  const number = String(nextNumber(writer)).padStart(4, '0');
  const id = `${number}_${kebab.replace(/-/g, '_')}`;
  const constant = `migration${number}${nameVariants(kebab).pascal}`;

  for (const [file, content] of Object.entries(migrationFiles(id, constant))) {
    writer.write(`${DIR}/${file}`, content);
  }
  const withImport = appendImport(
    registry,
    REGISTRY,
    `import { ${constant} } from './${id}';`,
  );
  writer.write(
    REGISTRY,
    appendToArray(withImport, REGISTRY, 'migrations', constant),
  );

  await writer.flush();
}

export default migrationGenerator;
