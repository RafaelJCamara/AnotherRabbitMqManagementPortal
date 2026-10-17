import { describe, expect, it } from 'vitest';

import {
  diffOf,
  expectFormatted,
  workspaceTree,
} from '../shared/test-utils.ts';
import { migrationGenerator } from './generator.ts';

const dir = 'libs/engine/persistence/src/migrations';

describe('migration', () => {
  it('creates the library on first use and migration 0001', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      migrationGenerator(tree, { name: 'core' }),
    );

    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('numbers the next migration after the highest existing one', async () => {
    const tree = workspaceTree();
    await migrationGenerator(tree, { name: 'core' });

    const { created, updated } = await diffOf(tree, () =>
      migrationGenerator(tree, { name: 'data-keys' }),
    );

    expect(Object.keys(created).sort()).toEqual([
      `${dir}/0002_data_keys.spec.ts`,
      `${dir}/0002_data_keys.ts`,
    ]);
    const registry = updated[`${dir}/index.ts`] ?? '';
    expect(registry).toMatch(
      /\[\s*migration0001Core,\s*migration0002DataKeys,?\s*\]/,
    );
  });

  it('accepts snake_case names', async () => {
    const tree = workspaceTree();

    await migrationGenerator(tree, { name: 'data_keys' });

    expect(tree.exists(`${dir}/0001_data_keys.ts`)).toBe(true);
  });

  it('refuses an invalid name', async () => {
    await expect(
      migrationGenerator(workspaceTree(), { name: 'Data Keys' }),
    ).rejects.toThrow('kebab-case');
  });
});
