import { describe, expect, it } from 'vitest';

import { confinedPackages } from '../shared/eslint-config.ts';
import { Writer } from '../shared/writer.ts';
import {
  diffOf,
  expectFormatted,
  parseJson,
  workspaceTree,
} from '../shared/test-utils.ts';
import { adapterGenerator } from './generator.ts';

const root = 'libs/engine/adapter-demo';

describe('adapter', () => {
  it('creates the adapter library with a port skeleton and the contract hook', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      adapterGenerator(tree, {
        name: 'demo',
        port: 'DemoPort',
        confine: 'left-pad',
      }),
    );

    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('tags the project type:adapter and runtime:node', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      adapterGenerator(tree, { name: 'adapter-demo', port: 'DemoPort' }),
    );

    expect(
      parseJson<{ tags: string[] }>(created[`${root}/project.json`]).tags,
    ).toEqual(['type:adapter', 'runtime:node']);
  });

  it('adds a confinement row for --confine and nothing else in the config', async () => {
    const tree = workspaceTree();
    const before = tree.read('eslint.config.mjs', 'utf-8') ?? '';

    const { updated } = await diffOf(tree, () =>
      adapterGenerator(tree, {
        name: 'demo',
        port: 'DemoPort',
        confine: 'left-pad',
      }),
    );

    const known = new Set(before.split('\n'));
    const added = (updated['eslint.config.mjs'] ?? '')
      .split('\n')
      .filter((line) => !known.has(line));
    expect(added).toEqual([
      "  { names: ['left-pad'], only: ['libs/engine/adapter-demo'] },",
    ]);
    expect(confinedPackages(new Writer(tree)).get('left-pad')).toEqual([root]);
  });

  it('confines several packages in one row', async () => {
    const tree = workspaceTree();

    await adapterGenerator(tree, {
      name: 'demo',
      port: 'DemoPort',
      confine: 'left-pad, @scope/thing',
    });

    const confined = confinedPackages(new Writer(tree));
    expect(confined.get('left-pad')).toEqual([root]);
    expect(confined.get('@scope/thing')).toEqual([root]);
  });

  it('leaves the lint config alone without --confine', async () => {
    const tree = workspaceTree();

    const { updated } = await diffOf(tree, () =>
      adapterGenerator(tree, { name: 'demo', port: 'DemoPort' }),
    );

    expect(Object.keys(updated)).toEqual(['tsconfig.base.json']);
  });

  it('refuses to widen a package that is already confined', async () => {
    await expect(
      adapterGenerator(workspaceTree(), {
        name: 'demo',
        port: 'DemoPort',
        confine: 'amqplib',
      }),
    ).rejects.toThrow('already confined to libs/engine/adapter-amqp091');
  });

  it('refuses something that is not a package name', async () => {
    await expect(
      adapterGenerator(workspaceTree(), {
        name: 'demo',
        port: 'DemoPort',
        confine: 'Left Pad',
      }),
    ).rejects.toThrow('not an npm package name');
  });

  it('imports the port from @app/ports once that alias exists', async () => {
    const tree = workspaceTree();
    const base = parseJson<{
      compilerOptions: { paths: Record<string, string[]> };
    }>(tree.read('tsconfig.base.json', 'utf-8') ?? '');
    base.compilerOptions.paths['@app/ports'] = [
      './libs/engine/ports/src/index.ts',
    ];
    tree.write('tsconfig.base.json', JSON.stringify(base));

    const { created } = await diffOf(tree, () =>
      adapterGenerator(tree, { name: 'demo', port: 'DemoPort' }),
    );

    expect(created[`${root}/src/adapter-demo.ts`]).toContain(
      "import type { DemoPort } from '@app/ports';",
    );
    expect(created).not.toHaveProperty([`${root}/src/port.ts`]);
  });

  it('requires a PascalCase port', async () => {
    await expect(
      adapterGenerator(workspaceTree(), { name: 'demo', port: 'demoPort' }),
    ).rejects.toThrow('PascalCase');
  });
});
