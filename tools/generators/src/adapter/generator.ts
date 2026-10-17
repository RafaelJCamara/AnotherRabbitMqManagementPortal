// A type:adapter library: the port implementation skeleton, the hook the shared port contract
// suite calls, and (with --confine) the third-party confinement row of blueprint 2.4.
import type { Tree } from '@nx/devkit';

import { addConfinement, assertPackageName } from '../shared/eslint-config.ts';
import {
  pathAliases,
  resolveRoot,
  resolveRuntime,
  scaffoldLibrary,
} from '../shared/library.ts';
import {
  assertIdentifier,
  assertKebab,
  nameVariants,
  splitList,
  stem,
} from '../shared/names.ts';
import { Writer } from '../shared/writer.ts';
import type { AdapterOptions } from './schema.ts';

const PORTS_ALIAS = '@app/ports';

export function adapterFiles(
  project: string,
  port: string,
  pascal: string,
  portFromWorkspace: boolean,
  confined: readonly string[],
): Record<string, string> {
  const portImport = portFromWorkspace
    ? `import type { ${port} } from '${PORTS_ALIAS}';`
    : `import type { ${port} } from './port';`;
  const confinement =
    confined.length > 0
      ? `// The only project that may import ${confined.join(', ')} (blueprint 2.4, eslint.config.mjs).\n`
      : '';
  const files: Record<string, string> = {
    'src/index.ts': `export { ${pascal}Adapter, create${pascal}Adapter } from './${project}';
`,
    [`src/${project}.ts`]: `${confinement}${portImport}

/** Implements ${port}. Add the port's members here; the compiler lists the missing ones. */
export class ${pascal}Adapter implements ${port} {
  readonly id = '${project}';
}

/** The hook the shared port contract suite uses to build the adapter under test. */
export function create${pascal}Adapter(): ${port} {
  return new ${pascal}Adapter();
}
`,
    [`src/${project}.spec.ts`]: `import { describe, expect, it } from 'vitest';

import { ${pascal}Adapter, create${pascal}Adapter } from './${project}';

describe('${pascal}Adapter', () => {
  it('identifies itself by the project name', () => {
    expect(new ${pascal}Adapter().id).toBe('${project}');
  });

  it('is built by the contract-suite hook', () => {
    expect(create${pascal}Adapter()).toBeInstanceOf(${pascal}Adapter);
  });

  it.todo('passes the ${port} contract suite against a real broker');
});
`,
  };
  if (!portFromWorkspace) {
    files['src/port.ts'] = `/**
 * Placeholder. Replace this file with an import of ${port} from '${PORTS_ALIAS}' once
 * libs/engine/ports defines it; the generator does that automatically when the alias exists.
 */
export interface ${port} {
  /** Stable adapter id used in logs, receipts and the conformance report. */
  readonly id: string;
}
`;
  }
  return files;
}

export async function adapterGenerator(
  tree: Tree,
  options: AdapterOptions,
): Promise<void> {
  const writer = new Writer(tree);
  assertKebab(options.name, 'adapter name');
  assertIdentifier(options.port, '--port');
  if (!/^[A-Z]/.test(options.port)) {
    throw new Error(`--port "${options.port}" must be a PascalCase type name.`);
  }
  const confined = splitList(options.confine);
  for (const name of confined) assertPackageName(name);

  const project = `adapter-${stem(options.name, 'adapter')}`;
  const pascal = nameVariants(project.slice('adapter-'.length)).pascal;
  const root = resolveRoot('adapter', project, options.directory);
  const portFromWorkspace = PORTS_ALIAS in pathAliases(writer);

  scaffoldLibrary(writer, {
    name: project,
    type: 'adapter',
    runtime: resolveRuntime('adapter', undefined),
    root,
    trustCritical: options.trustCritical ?? false,
    importPath: `@app/${project}`,
    projectType: 'library',
    readme: {
      purpose:
        options.description ??
        `Implements ${options.port} for ${project.slice('adapter-'.length)}: say in one or two sentences what it talks to.`,
      publicApi: [
        `\`${pascal}Adapter\`: the ${options.port} implementation.`,
        `\`create${pascal}Adapter()\`: the hook the shared port contract suite uses.`,
      ],
      invariants: [
        'Imports only contracts, pure, port and `net-*` projects (blueprint 2.2); never a service.',
        ...(confined.length > 0
          ? [
              `Only this project imports ${confined.join(', ')} (third-party confinement, blueprint 2.4); the row is in \`eslint.config.mjs\`.`,
            ]
          : []),
        `Passes the ${options.port} contract suite.`,
      ],
    },
    files: adapterFiles(
      project,
      options.port,
      pascal,
      portFromWorkspace,
      confined,
    ),
  });

  addConfinement(writer, confined, root);

  await writer.flush();
}

export default adapterGenerator;
