// Blueprint 2.4, "Uniform service shape":
//   src/module.ts        createXModule(deps): EngineModule
//   src/deps.ts          the ports the module needs; src/testing.ts holds their fakes
//   src/actions/*.ts     one implementAction per file, each a factory over its ports
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
export type { ${pascal}ModuleDeps } from './deps';
export type { EngineModule } from './module';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export { create${pascal}FakeDeps } from './testing';
`,
    'src/deps.ts': `/**
 * The ports this module needs, injected by the composition root. Name them here as the first action
 * needs them (for example \`readonly mgmt: MgmtReadPort\`), and give them fakes in testing.ts.
 */
export type ${pascal}ModuleDeps = Readonly<Record<string, never>>;
`,
    'src/module.ts': `// The composition root calls create${pascal}Module with the ports this service needs and
// registers what the module returns. A service never imports another service or an adapter:
// cross-service needs are ports wired in the composition root.
import { createActions } from './actions';
import type { ${pascal}ModuleDeps } from './deps';
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

export function create${pascal}Module(deps: ${pascal}ModuleDeps): EngineModule {
  return { id: '${project}', actions: createActions(deps), topics, jobs };
}
`,
    'src/actions/index.ts': `// One implementAction per file in this directory. The action generator lists each factory here;
// the module calls every one with its ports.
import type { ActionImpl } from '@app/kernel';

import type { ${pascal}ModuleDeps } from '../deps';

export const actionFactories: readonly ((
  deps: ${pascal}ModuleDeps,
) => ActionImpl)[] = [];

export function createActions(deps: ${pascal}ModuleDeps): readonly ActionImpl[] {
  return actionFactories.map((create) => create(deps));
}
`,
    'src/topics.ts': `// Live topics (defineTopic) owned by this service.
export const topics: readonly unknown[] = [];
`,
    'src/jobs/index.ts': `// Job definitions (defineJob), one per file in this directory; list them here.
export const jobs: readonly unknown[] = [];
`,
    'src/internal/.gitkeep': '',
    'src/testing.ts': `// Fakes for the ports of this module, shared by its specs, by the architecture manifest
// (tools/arch-tests) and by the HTTP specs (libs/testkit). Give each port in deps.ts a fake here.
import type { ${pascal}ModuleDeps } from './deps';

export function create${pascal}FakeDeps(): ${pascal}ModuleDeps {
  return {};
}
`,
    'src/module.spec.ts': `import { describe, expect, it } from 'vitest';

import { create${pascal}Module } from './module';
import { create${pascal}FakeDeps } from './testing';

describe('create${pascal}Module', () => {
  it('registers the module under the project name', () => {
    expect(create${pascal}Module(create${pascal}FakeDeps()).id).toBe('${project}');
  });

  // The action, topic and job generators register into these lists, so the module's own spec does
  // not pin their contents: each registered item has its own spec.
  it('lists its actions, topics and jobs', () => {
    const module = create${pascal}Module(create${pascal}FakeDeps());

    expect(Array.isArray(module.actions)).toBe(true);
    expect(Array.isArray(module.topics)).toBe(true);
    expect(Array.isArray(module.jobs)).toBe(true);
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
        `\`${pascal}ModuleDeps\` (\`src/deps.ts\`): the ports the module needs.`,
        `\`create${pascal}FakeDeps()\` (\`src/testing.ts\`): fakes for those ports, for specs, the architecture manifest and the HTTP specs.`,
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
