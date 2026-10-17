import type { Tree } from '@nx/devkit';

import {
  LAYER_TYPES,
  LAYERS,
  isLayerType,
  type Runtime,
} from '../shared/layers.ts';
import {
  resolveRoot,
  resolveRuntime,
  scaffoldLibrary,
} from '../shared/library.ts';
import { assertKebab, nameVariants } from '../shared/names.ts';
import { Writer } from '../shared/writer.ts';
import type { LibraryOptions } from './schema.ts';

/** The contents of an empty library: an index and a test that pins the public API. */
export function libraryFiles(name: string): Record<string, string> {
  return {
    'src/index.ts': `// Public API of this library. Export only what other projects need.
export {};
`,
    'src/index.spec.ts': `import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('${name} public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([]);
  });
});
`,
  };
}

export async function libraryGenerator(
  tree: Tree,
  options: LibraryOptions,
): Promise<void> {
  const writer = new Writer(tree);
  if (!isLayerType(options.type)) {
    throw new Error(
      `--type must be one of ${LAYER_TYPES.join(', ')}; got "${String(options.type)}".`,
    );
  }
  const type = options.type;
  assertKebab(options.name, 'library name');
  const runtime: Runtime = resolveRuntime(type, options.runtime);

  scaffoldLibrary(writer, {
    name: options.name,
    type,
    runtime,
    root: resolveRoot(type, options.name, options.directory),
    trustCritical: options.trustCritical ?? false,
    importPath: options.importPath ?? `@app/${options.name}`,
    projectType: 'library',
    readme: {
      purpose:
        options.description ??
        `${nameVariants(options.name).pascal}: say in one or two sentences what this library is for.`,
      publicApi: ['Nothing yet. List every export of `src/index.ts` here.'],
      invariants: [
        `Dependencies follow the type:${type} row of blueprint 2.2; \`pnpm nx lint ${options.name}\` enforces them.`,
        ...(LAYERS[type].angular
          ? [
              'Copy lives in i18n files, never in templates (`@app/ui-no-raw-template-text`).',
            ]
          : []),
      ],
    },
    files: libraryFiles(options.name),
  });

  await writer.flush();
}

export default libraryGenerator;
