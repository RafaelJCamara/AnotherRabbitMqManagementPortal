import type { Tree } from '@nx/devkit';
import { describe, expect, it } from 'vitest';

import { serviceModuleGenerator } from '../service-module/generator.ts';
import {
  diffOf,
  expectFormatted,
  filesOf,
  workspaceTree,
} from '../shared/test-utils.ts';
import { jobGenerator } from './generator.ts';
import type { JobOptions } from './schema.ts';

const PURGE_MANY: JobOptions = {
  name: 'queues.purge-many',
  module: 'svc-admin',
};

async function jobTree(): Promise<Tree> {
  const tree = workspaceTree();
  await serviceModuleGenerator(tree, { name: 'svc-admin' });
  return tree;
}

const generate = async (options: JobOptions, tree?: Tree) => {
  const target = tree ?? (await jobTree());
  const diff = await diffOf(target, () =>
    jobGenerator(target, options).then(() => undefined),
  );
  return { tree: target, ...diff };
};

describe('job generator: what it creates', () => {
  it('creates the definition, a fixture and a spec', async () => {
    const { created } = await generate(PURGE_MANY);

    expect(Object.keys(created).sort()).toEqual([
      'libs/engine/svc-admin/src/jobs/queues-purge-many.fixture.ts',
      'libs/engine/svc-admin/src/jobs/queues-purge-many.spec.ts',
      'libs/engine/svc-admin/src/jobs/queues-purge-many.ts',
    ]);
    expect(created).toMatchSnapshot();
    await expectFormatted(created);
  });

  it('registers the job and exports it', async () => {
    const { updated } = await generate(PURGE_MANY);

    const jobs = updated['libs/engine/svc-admin/src/jobs/index.ts'] ?? '';
    expect(jobs).toContain(
      "import { queuesPurgeManyJob } from './queues-purge-many';",
    );
    expect(jobs).toMatch(
      /jobs: readonly unknown\[\] = \[\s*queuesPurgeManyJob,?\s*\]/,
    );
    expect(updated['libs/engine/svc-admin/src/index.ts']).toContain(
      "export { queuesPurgeManyJob } from './jobs/queues-purge-many';",
    );
  });

  it('adds a second job beside the first, and needs no file of its own for the job types', async () => {
    const first = await generate(PURGE_MANY);
    const second = await generate(
      { ...PURGE_MANY, name: 'queues.copy-all' },
      first.tree,
    );

    expect(Object.keys(second.created)).toHaveLength(3);
    const jobs =
      filesOf(second.tree)['libs/engine/svc-admin/src/jobs/index.ts'] ?? '';
    expect(jobs).toContain('queuesPurgeManyJob');
    expect(jobs).toContain('queuesCopyAllJob');
  });

  it('defines the job with defineJob of the jobs library, not a copy of its types', async () => {
    const { created } = await generate(PURGE_MANY);
    const job =
      created['libs/engine/svc-admin/src/jobs/queues-purge-many.ts'] ?? '';

    expect(job).toContain(
      "import { defineJob, type JobEvent } from '@app/jobs';",
    );
    expect(
      Object.keys(created).some((path) => path.endsWith('job-def.ts')),
    ).toBe(false);
  });

  it('declares a job as resumable unless told otherwise', async () => {
    const resumable =
      (await generate(PURGE_MANY)).created[
        'libs/engine/svc-admin/src/jobs/queues-purge-many.ts'
      ] ?? '';
    const oneShot =
      (await generate({ ...PURGE_MANY, resumable: false })).created[
        'libs/engine/svc-admin/src/jobs/queues-purge-many.ts'
      ] ?? '';

    expect(resumable).toContain('resumable: true');
    expect(oneShot).toContain('resumable: false');
  });

  it('gives the stub no way to reach a port', async () => {
    const { created } = await generate(PURGE_MANY);
    const code =
      created['libs/engine/svc-admin/src/jobs/queues-purge-many.ts'] ?? '';

    expect(code).not.toMatch(
      /WritePort|ExecutorWrite|ConnectionManager|ctx\.writes|executorWrite/,
    );
  });

  it('fails until run() and onDrain() are written', async () => {
    const { created } = await generate(PURGE_MANY);
    const job =
      created['libs/engine/svc-admin/src/jobs/queues-purge-many.ts'] ?? '';

    expect(job).toContain("new AppError('INTERNAL'");
    expect(job).toContain('throw notImplemented()');
    expect(job).toContain('onDrain: () => Promise.reject(notImplemented())');
  });
});

describe('job generator: refusals', () => {
  type Change = { [K in keyof JobOptions]?: JobOptions[K] | undefined };

  it.each<[string, Change, RegExp]>([
    [
      'an id without a dot',
      { name: 'purge' },
      /must look like namespace\.name/,
    ],
    [
      'an id in capitals',
      { name: 'Queues.Purge' },
      /must look like namespace\.name/,
    ],
    [
      'a type longer than defineJob accepts',
      { name: `queues.${'a'.repeat(100)}` },
      /longer than 100 characters/,
    ],
    ['a module that does not exist', { module: 'svc-nope' }, /does not exist/],
    ['a module that is not kebab-case', { module: '../kernel' }, /kebab-case/],
  ])('refuses %s', async (_name, change, message) => {
    const tree = await jobTree();
    const before = filesOf(tree);

    await expect(
      jobGenerator(tree, { ...PURGE_MANY, ...change } as JobOptions),
    ).rejects.toThrow(message);

    expect(filesOf(tree)).toEqual(before);
  });

  it('refuses a job that is already there, and a file it would overwrite', async () => {
    const { tree } = await generate(PURGE_MANY);

    await expect(jobGenerator(tree, PURGE_MANY)).rejects.toThrow(
      /Refusing to overwrite/,
    );
  });

  it('refuses a project that is not a service module', async () => {
    const tree = await jobTree();
    tree.write(
      'libs/engine/svc-fake/project.json',
      JSON.stringify({ name: 'svc-fake', tags: ['type:adapter'] }),
    );

    await expect(
      jobGenerator(tree, { ...PURGE_MANY, module: 'svc-fake' }),
    ).rejects.toThrow(/not the type:service project/);
  });
});

describe('job generator: the generated spec', () => {
  it('states the invariants of a job: samples, progress and output, abort, drain deadline', async () => {
    const { created } = await generate(PURGE_MANY);
    const spec =
      created['libs/engine/svc-admin/src/jobs/queues-purge-many.spec.ts'] ?? '';

    expect(spec).toContain('job.input.safeParse(sampleInput)');
    expect(spec).toContain("toContain('progress')");
    expect(spec).toContain('abort.abort()');
    for (const reason of ['cancel', 'shutdown', 'suspend', 'emergency']) {
      expect(spec).toContain(`'${reason}'`);
    }
    expect(spec).toContain('toBeLessThan(200)');
  });
});
