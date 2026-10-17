import { describe, expect, it } from 'vitest';

import {
  diffOf,
  expectFormatted,
  parseJson,
  workspaceTree,
} from '../shared/test-utils.ts';
import { conformanceCellGenerator } from './generator.ts';

describe('conformance-cell', () => {
  it('creates the conformance project and a stub with the two assertions', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      conformanceCellGenerator(tree, { id: 'CF-QQ-42-GUARD-01' }),
    );

    expect(created).toMatchSnapshot();
    expect(
      parseJson<{ tags: string[]; projectType: string }>(
        created['apps/conformance/project.json'],
      ),
    ).toMatchObject({
      tags: ['type:test', 'runtime:node'],
      projectType: 'application',
    });
    await expectFormatted(created);
  });

  it('never writes lab evidence', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      conformanceCellGenerator(tree, { id: 'CF-QQ-42-GUARD-01' }),
    );

    expect(
      Object.keys(created).filter((path) => path.startsWith('testing/')),
    ).toEqual([]);
  });

  it('adds a second cell next to the first', async () => {
    const tree = workspaceTree();
    await conformanceCellGenerator(tree, { id: 'CF-QQ-42-GUARD-01' });

    const { created } = await diffOf(tree, () =>
      conformanceCellGenerator(tree, { id: 'CF-QQ-42-GUARD-02' }),
    );

    expect(Object.keys(created)).toEqual([
      'apps/conformance/src/cells/cf-qq-42-guard-02.cell.spec.ts',
    ]);
  });

  it('refuses a duplicate and a malformed id', async () => {
    const tree = workspaceTree();
    await conformanceCellGenerator(tree, { id: 'CF-QQ-42-GUARD-01' });

    await expect(
      conformanceCellGenerator(tree, { id: 'CF-QQ-42-GUARD-01' }),
    ).rejects.toThrow('already exists');
    await expect(
      conformanceCellGenerator(tree, { id: 'guard-01' }),
    ).rejects.toThrow('conformance id');
  });
});
