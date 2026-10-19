// The one place that knows what a workspace project looks like: project.json with tags and the
// lint, typecheck and test targets, the solution-style tsconfigs, a hand-written
// vitest.config.mts (the Nx Vitest generators refuse Vitest 5, docs/architecture/s-11), a README
// and the `@app/*` path alias. Every other generator builds on scaffoldLibrary.
import { offsetFromRoot } from '@nx/devkit';

import {
  LAYERS,
  PROJECT_ROOTS,
  assertRuntime,
  defaultRuntime,
  type LayerType,
  type Runtime,
} from './layers.ts';
import { assertKebab } from './names.ts';
import { renderReadme, type ReadmeSpec } from './readme.ts';
import type { Writer } from './writer.ts';

export interface LibrarySpec {
  /** Nx project name, kebab-case; also the directory name. */
  name: string;
  type: LayerType;
  runtime: Runtime;
  /** Project root, relative to the workspace root. */
  root: string;
  trustCritical: boolean;
  /** Path alias; null for projects that nothing imports (apps). */
  importPath: string | null;
  projectType: 'library' | 'application';
  readme: Omit<ReadmeSpec, 'name' | 'tags'>;
  /** Files below the project root. Must contain `src/index.ts`. */
  files: Readonly<Record<string, string>>;
}

export function tagsOf(
  spec: Pick<LibrarySpec, 'type' | 'runtime' | 'trustCritical'>,
): string[] {
  return [
    `type:${spec.type}`,
    `runtime:${spec.runtime}`,
    ...(spec.trustCritical ? ['trust:critical'] : []),
  ];
}

/** Resolves the project root from the options every generator shares. */
export function resolveRoot(
  type: LayerType,
  name: string,
  directory: string | undefined,
): string {
  const parent = (directory ?? LAYERS[type].directory).replace(/\/+$/, '');
  const first = parent.split('/')[0] ?? '';
  if (!(PROJECT_ROOTS as readonly string[]).includes(first)) {
    throw new Error(
      `Projects live below ${PROJECT_ROOTS.join(', ')}; "${parent}" would be skipped by the lint zones in eslint.config.mjs.`,
    );
  }
  return `${parent}/${name}`;
}

export function resolveRuntime(
  type: LayerType,
  runtime: Runtime | undefined,
): Runtime {
  const resolved = runtime ?? defaultRuntime(type);
  assertRuntime(type, resolved);
  return resolved;
}

export function isProject(writer: Writer, root: string): boolean {
  return writer.exists(`${root}/project.json`);
}

/** Every Nx project name in the tree, found from project.json files below the scan roots. */
function projectNames(writer: Writer): Set<string> {
  const names = new Set<string>();
  const visit = (dir: string): void => {
    for (const entry of writer.tree.children(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'tmp') {
        continue;
      }
      const path = `${dir}/${entry}`;
      if (entry === 'project.json') {
        const config = writer.readJson<{ name?: string }>(path);
        if (config.name) names.add(config.name);
      } else if (!writer.tree.isFile(path)) {
        visit(path);
      }
    }
  };
  for (const root of PROJECT_ROOTS) {
    if (writer.exists(root)) visit(root);
  }
  return names;
}

export function assertNewProject(
  writer: Writer,
  name: string,
  root: string,
  importPath: string | null,
): void {
  assertKebab(name, 'project name');
  if (isProject(writer, root) || projectNames(writer).has(name)) {
    throw new Error(`A project named "${name}" already exists.`);
  }
  if (importPath && writer.exists('tsconfig.base.json')) {
    const paths = pathAliases(writer);
    if (importPath in paths) {
      throw new Error(`The path alias ${importPath} is already registered.`);
    }
  }
}

interface TsConfigBase {
  compilerOptions?: { paths?: Record<string, string[]> };
}

export function pathAliases(writer: Writer): Record<string, string[]> {
  const base = writer.readJson<TsConfigBase>('tsconfig.base.json');
  return base.compilerOptions?.paths ?? {};
}

/** Registers `importPath` in tsconfig.base.json, keeping the table sorted. */
export function registerPathAlias(
  writer: Writer,
  importPath: string,
  root: string,
): void {
  const base = writer.readJson<TsConfigBase>('tsconfig.base.json');
  const compilerOptions = (base.compilerOptions ??= {});
  const paths = {
    ...compilerOptions.paths,
    [importPath]: [`./${root}/src/index.ts`],
  };
  compilerOptions.paths = Object.fromEntries(
    Object.entries(paths).sort(([a], [b]) => a.localeCompare(b)),
  );
  writer.writeJson('tsconfig.base.json', base);
}

const spaces = (value: unknown): string => JSON.stringify(value, null, 2);

function projectJson(spec: LibrarySpec, angular: boolean): unknown {
  const compiler = angular ? 'ngc' : 'tsc';
  return {
    name: spec.name,
    $schema: `${offsetFromRoot(spec.root)}node_modules/nx/schemas/project-schema.json`,
    sourceRoot: `${spec.root}/src`,
    projectType: spec.projectType,
    tags: tagsOf(spec),
    targets: {
      lint: {},
      typecheck: {
        executor: 'nx:run-commands',
        cache: true,
        inputs: ['default', '^production'],
        options: {
          commands: [
            `${compiler} -p ${spec.root}/tsconfig.lib.json --noEmit`,
            `${compiler} -p ${spec.root}/tsconfig.spec.json --noEmit`,
          ],
          parallel: false,
        },
      },
      test: {
        executor: 'nx:run-commands',
        cache: true,
        inputs: ['default', '^production'],
        options: {
          command: `vitest run --config ${spec.root}/vitest.config.mts`,
        },
      },
    },
  };
}

function tsconfigJson(spec: LibrarySpec, angular: boolean): unknown {
  const offset = offsetFromRoot(spec.root);
  const compilerOptions: Record<string, unknown> = {};
  // Engine code has no DOM: the library list says so, and so does the compiler.
  if (spec.runtime === 'node') compilerOptions.lib = ['es2022'];
  // The shared libraries (contracts, kernel, ...) import their own files as `./x.ts`, and a
  // project that imports them through the `@app/*` aliases compiles those sources too (OQ-327).
  if (!angular) compilerOptions.noEmit = true;
  compilerOptions.allowImportingTsExtensions = true;
  if (angular) {
    // Off, like ui-data: the shared libraries read index signatures with dots (OQ-264).
    compilerOptions.noPropertyAccessFromIndexSignature = false;
    compilerOptions.experimentalDecorators = true;
    compilerOptions.module = 'preserve';
  }
  return {
    extends: `${offset}tsconfig.base.json`,
    ...(Object.keys(compilerOptions).length > 0 ? { compilerOptions } : {}),
    ...(angular
      ? {
          angularCompilerOptions: {
            enableI18nLegacyMessageIdFormat: false,
            strictInjectionParameters: true,
            strictInputAccessModifiers: true,
            strictTemplates: true,
          },
        }
      : {}),
    files: [],
    include: [],
    references: [
      { path: './tsconfig.lib.json' },
      { path: './tsconfig.spec.json' },
    ],
  };
}

function vitestConfig(spec: LibrarySpec, angular: boolean): string {
  const environment = angular || spec.runtime === 'browser' ? 'jsdom' : 'node';
  return `import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  // Resolve the @app/* aliases of tsconfig.base.json.
  resolve: { tsconfigPaths: true },
  test: {
    name: '${spec.name}',
    environment: '${environment}',
    include: ['src/**/*.spec.ts'],
  },
});
`;
}

/**
 * Creates the library that a feature generator adds to when it does not exist yet (for
 * example libs/shared/lint-rules). Returns true when the library was created, in which case the
 * caller may add the files that only a new library needs.
 */
export function ensureLibrary(writer: Writer, spec: LibrarySpec): boolean {
  if (isProject(writer, spec.root)) return false;
  scaffoldLibrary(writer, spec);
  return true;
}

/** Writes a complete project and registers its path alias. */
export function scaffoldLibrary(writer: Writer, spec: LibrarySpec): void {
  if (!('src/index.ts' in spec.files)) {
    throw new Error('scaffoldLibrary needs a src/index.ts file.');
  }
  assertNewProject(writer, spec.name, spec.root, spec.importPath);

  const angular = LAYERS[spec.type].angular;
  const offset = offsetFromRoot(spec.root);
  const out = (path: string, content: string): void => {
    writer.write(`${spec.root}/${path}`, content);
  };

  out('project.json', `${spaces(projectJson(spec, angular))}\n`);
  out('tsconfig.json', `${spaces(tsconfigJson(spec, angular))}\n`);
  out(
    'tsconfig.lib.json',
    `${spaces({
      extends: './tsconfig.json',
      compilerOptions: {
        outDir: `${offset}dist/out-tsc`,
        types: spec.runtime === 'node' ? ['node'] : [],
      },
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
    })}\n`,
  );
  out(
    'tsconfig.spec.json',
    `${spaces({
      extends: './tsconfig.json',
      compilerOptions: {
        outDir: `${offset}dist/out-tsc`,
        types: ['vitest/globals', 'node'],
      },
      include: ['src/**/*.ts', 'vitest.config.mts'],
    })}\n`,
  );
  out('vitest.config.mts', vitestConfig(spec, angular));
  out(
    'README.md',
    renderReadme({ ...spec.readme, name: spec.name, tags: tagsOf(spec) }),
  );
  for (const [path, content] of Object.entries(spec.files)) out(path, content);

  if (spec.importPath) registerPathAlias(writer, spec.importPath, spec.root);
}
