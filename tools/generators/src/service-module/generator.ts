// Blueprint 2.4, "Uniform service shape":
//   src/module.ts        createXModule(deps): EngineModule
//   src/actions/*.ts     one implementAction per file
//   src/topics.ts, src/jobs/*.ts, src/internal/**, *.spec.ts
//   README.md            purpose, public API, invariants, proof commands
import type { Tree } from '@nx/devkit';

import {
  resolveRoot,
  resolveRuntime,
  scaffoldLibrary,
} from '../shared/library.ts';
import { assertKebab, nameVariants, stem } from '../shared/names.ts';
import { Writer } from '../shared/writer.ts';
import type { ServiceModuleOptions } from './schema.ts';

export function serviceModuleFiles(
  project: string,
  pascal: string,
): Record<string, string> {
  return {
    'src/index.ts': `export { create${pascal}Module } from './module';
export type { ${pascal}ModuleDeps, EngineModule } from './module';
`,
    'src/module.ts': `// The composition root calls create${pascal}Module with the ports this service needs and
// registers what the module returns. A service never imports another service or an adapter:
// cross-service needs are ports wired in the composition root.
import { actions } from './actions';
import { jobs } from './jobs';
import { topics } from './topics';

/**
 * What the composition root registers. This is a local stand-in: replace it with the type
 * exported by the kernel once libs/engine/kernel provides EngineModule.
 */
export interface EngineModule {
  readonly id: string;
  readonly actions: readonly unknown[];
  readonly topics: readonly unknown[];
  readonly jobs: readonly unknown[];
}

/** The ports this module needs, injected by the composition root. */
export type ${pascal}ModuleDeps = Readonly<Record<string, never>>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the first port is wired in with the first action.
export function create${pascal}Module(deps: ${pascal}ModuleDeps): EngineModule {
  return { id: '${project}', actions, topics, jobs };
}
`,
    'src/actions/index.ts': `// One implementAction per file in this directory; list them here.
export const actions: readonly unknown[] = [];
`,
    'src/topics.ts': `// Live topics (defineTopic) owned by this service.
export const topics: readonly unknown[] = [];
`,
    'src/jobs/index.ts': `// Job definitions (defineJob), one per file in this directory; list them here.
export const jobs: readonly unknown[] = [];
`,
    'src/internal/.gitkeep': '',
    'src/module.spec.ts': `import { describe, expect, it } from 'vitest';

import { create${pascal}Module } from './module';

describe('create${pascal}Module', () => {
  it('registers the module under the project name', () => {
    expect(create${pascal}Module({}).id).toBe('${project}');
  });

  it('starts without actions, topics or jobs', () => {
    const module = create${pascal}Module({});

    expect(module.actions).toEqual([]);
    expect(module.topics).toEqual([]);
    expect(module.jobs).toEqual([]);
  });
});
`,
  };
}

export async function serviceModuleGenerator(
  tree: Tree,
  options: ServiceModuleOptions,
): Promise<void> {
  const writer = new Writer(tree);
  assertKebab(options.name, 'service name');
  const project = `svc-${stem(options.name, 'svc')}`;
  const pascal = nameVariants(project.slice('svc-'.length)).pascal;

  scaffoldLibrary(writer, {
    name: project,
    type: 'service',
    runtime: resolveRuntime('service', undefined),
    root: resolveRoot('service', project, options.directory),
    trustCritical: options.trustCritical ?? false,
    importPath: `@app/${project}`,
    projectType: 'library',
    readme: {
      purpose:
        options.description ??
        `The ${project.slice(4)} engine service: say in one or two sentences what it owns.`,
      publicApi: [
        `\`create${pascal}Module(deps)\`: returns the \`EngineModule\` the composition root registers.`,
        `\`${pascal}ModuleDeps\`: the ports the module needs.`,
      ],
      invariants: [
        'Never imports another service or an adapter; cross-service needs are ports wired in the composition root (blueprint 2.2).',
        'Every mutation is an `implementAction` file in `src/actions/`; nothing writes through a WritePort outside one (mutation funnel).',
        'Engine buffers are `BoundedRing` or `BoundedQueue` (`@app/bounded-buffers-only`).',
      ],
    },
    files: serviceModuleFiles(project, pascal),
  });

  await writer.flush();
}

export default serviceModuleGenerator;
