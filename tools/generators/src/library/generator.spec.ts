import { describe, expect, it } from 'vitest';

import { LAYER_TYPES, LAYERS } from '../shared/layers.ts';
import {
  diffOf,
  expectFormatted,
  parseJson,
  workspaceTree,
} from '../shared/test-utils.ts';
import { libraryGenerator } from './generator.ts';

interface Project {
  tags: string[];
  targets: Record<string, { options?: Record<string, unknown> }>;
}

describe('library', () => {
  it('creates a type:pure library', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      libraryGenerator(tree, { name: 'demo-pure', type: 'pure' }),
    );

    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it.each(LAYER_TYPES)(
    'tags a type:%s library with a legal runtime',
    async (type) => {
      const tree = workspaceTree();

      const { created } = await diffOf(tree, () =>
        libraryGenerator(tree, { name: 'demo', type }),
      );
      const root = `${LAYERS[type].directory}/demo`;
      const project = parseJson<Project>(created[`${root}/project.json`]);

      expect(project.tags).toEqual([
        `type:${type}`,
        `runtime:${LAYERS[type].runtimes[0] ?? ''}`,
      ]);
    },
  );

  it('adds trust:critical on request', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      libraryGenerator(tree, {
        name: 'demo',
        type: 'kernel',
        trustCritical: true,
      }),
    );

    expect(
      parseJson<Project>(created['libs/engine/demo/project.json']).tags,
    ).toEqual(['type:kernel', 'runtime:node', 'trust:critical']);
  });

  it('typechecks Angular libraries with ngc and tests them in jsdom', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      libraryGenerator(tree, { name: 'demo', type: 'ui-lib' }),
    );
    const project = parseJson<Project>(created['libs/ui/demo/project.json']);

    expect(project.targets.typecheck?.options?.commands).toEqual([
      'ngc -p libs/ui/demo/tsconfig.lib.json --noEmit',
      'ngc -p libs/ui/demo/tsconfig.spec.json --noEmit',
    ]);
    expect(created['libs/ui/demo/vitest.config.mts']).toContain(
      "environment: 'jsdom'",
    );
  });

  it('registers the path alias, keeping the table sorted', async () => {
    const tree = workspaceTree();

    await libraryGenerator(tree, { name: 'zeta', type: 'pure' });
    await libraryGenerator(tree, { name: 'alpha', type: 'pure' });

    const base = parseJson<{
      compilerOptions: { paths: Record<string, string[]> };
    }>(tree.read('tsconfig.base.json', 'utf-8') ?? '');
    const keys = Object.keys(base.compilerOptions.paths);
    expect(base.compilerOptions.paths['@app/alpha']).toEqual([
      './libs/shared/alpha/src/index.ts',
    ]);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it('honours --directory and --import-path', async () => {
    const tree = workspaceTree();

    await libraryGenerator(tree, {
      name: 'demo',
      type: 'pure',
      directory: 'libs/shared/nested',
      importPath: '@app/other-name',
    });

    expect(tree.exists('libs/shared/nested/demo/project.json')).toBe(true);
    expect(tree.read('tsconfig.base.json', 'utf-8')).toContain(
      '@app/other-name',
    );
  });

  it('refuses a runtime the layer cannot have', async () => {
    await expect(
      libraryGenerator(workspaceTree(), {
        name: 'demo',
        type: 'pure',
        runtime: 'node',
      }),
    ).rejects.toThrow('type:pure projects may only be runtime:isomorphic');
  });

  it('refuses a directory the lint zones do not scan', async () => {
    await expect(
      libraryGenerator(workspaceTree(), {
        name: 'demo',
        type: 'pure',
        directory: 'packages',
      }),
    ).rejects.toThrow('skipped by the lint zones');
  });

  it('refuses a layer that does not exist', async () => {
    await expect(
      libraryGenerator(workspaceTree(), {
        name: 'demo',
        type: 'bogus' as 'pure',
      }),
    ).rejects.toThrow('--type must be one of');
  });

  it('refuses a duplicate project name and a duplicate alias', async () => {
    const tree = workspaceTree();
    await libraryGenerator(tree, { name: 'demo', type: 'pure' });

    await expect(
      libraryGenerator(tree, { name: 'demo', type: 'kernel' }),
    ).rejects.toThrow('already exists');
    await expect(
      libraryGenerator(tree, {
        name: 'other',
        type: 'pure',
        importPath: '@app/demo',
      }),
    ).rejects.toThrow('already registered');
  });
});
