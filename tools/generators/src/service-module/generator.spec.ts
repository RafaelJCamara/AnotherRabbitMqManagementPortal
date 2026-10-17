import { describe, expect, it } from 'vitest';

import {
  diffOf,
  expectFormatted,
  parseJson,
  workspaceTree,
} from '../shared/test-utils.ts';
import { serviceModuleGenerator } from './generator.ts';

const root = 'libs/engine/svc-demo';

describe('service-module', () => {
  it('creates the uniform service shape for svc-demo', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      serviceModuleGenerator(tree, { name: 'svc-demo' }),
    );

    expect(Object.keys(created).sort()).toMatchSnapshot('files');
    expect(created[`${root}/README.md`]).toMatchSnapshot('README');
    expect(created[`${root}/src/module.ts`]).toMatchSnapshot('module');
    expect(created[`${root}/src/module.spec.ts`]).toMatchSnapshot('spec');
    expect(created[`${root}/project.json`]).toMatchSnapshot('project.json');
    await expectFormatted(created);
  });

  it('tags the project type:service and runtime:node', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      serviceModuleGenerator(tree, { name: 'svc-demo' }),
    );

    expect(
      parseJson<{ tags: string[] }>(created[`${root}/project.json`]).tags,
    ).toEqual(['type:service', 'runtime:node']);
  });

  it('adds trust:critical on request', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      serviceModuleGenerator(tree, { name: 'svc-demo', trustCritical: true }),
    );

    expect(
      parseJson<{ tags: string[] }>(created[`${root}/project.json`]).tags,
    ).toEqual(['type:service', 'runtime:node', 'trust:critical']);
  });

  it('gives explicit lint, typecheck and test targets', async () => {
    const tree = workspaceTree();

    const { created } = await diffOf(tree, () =>
      serviceModuleGenerator(tree, { name: 'svc-demo' }),
    );
    const project = parseJson<{
      targets: Record<string, { options?: Record<string, unknown> }>;
    }>(created[`${root}/project.json`]);

    expect(Object.keys(project.targets)).toEqual(['lint', 'typecheck', 'test']);
    expect(project.targets.typecheck?.options?.commands).toEqual([
      `tsc -p ${root}/tsconfig.lib.json --noEmit`,
      `tsc -p ${root}/tsconfig.spec.json --noEmit`,
    ]);
    expect(project.targets.test?.options?.command).toBe(
      `vitest run --config ${root}/vitest.config.mts`,
    );
  });

  it('registers the @app/svc-demo path alias', async () => {
    const tree = workspaceTree();

    await serviceModuleGenerator(tree, { name: 'svc-demo' });

    const base = parseJson<{
      compilerOptions: { paths: Record<string, string[]> };
    }>(tree.read('tsconfig.base.json', 'utf-8') ?? '');
    expect(base.compilerOptions.paths['@app/svc-demo']).toEqual([
      `./${root}/src/index.ts`,
    ]);
    expect(Object.keys(base.compilerOptions.paths)).toEqual(
      Object.keys(base.compilerOptions.paths).sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  it('adds the svc- prefix when it is missing', async () => {
    const tree = workspaceTree();

    await serviceModuleGenerator(tree, { name: 'demo' });

    expect(tree.exists(`${root}/project.json`)).toBe(true);
  });

  it('refuses a name that is already a project', async () => {
    const tree = workspaceTree();
    await serviceModuleGenerator(tree, { name: 'svc-demo' });

    await expect(
      serviceModuleGenerator(tree, { name: 'svc-demo' }),
    ).rejects.toThrow('already exists');
  });

  it('refuses a name that is not kebab-case', async () => {
    await expect(
      serviceModuleGenerator(workspaceTree(), { name: 'Svc_Demo' }),
    ).rejects.toThrow('kebab-case');
  });
});
