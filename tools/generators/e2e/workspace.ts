// A throwaway copy of the workspace for the end-to-end proof: the policy files the generators read
// and edit, the plugin itself and the lint self-test, with node_modules linked to the real one.
// Generators then run through the real `nx g` CLI, and lint, typecheck and test run on what they
// made, without touching the checkout.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withoutAdoptedAliases } from '../src/shared/first-use.ts';

export const repoRoot = join(import.meta.dirname, '..', '..', '..');

const COPIED = [
  'nx.json',
  'package.json',
  'pnpm-workspace.yaml',
  // The module-boundaries rule needs the external nodes Nx builds from the lockfile.
  'pnpm-lock.yaml',
  'tsconfig.base.json',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierignore',
  'tools/eslint-rules',
  'tools/generators',
  'tools/lint-selftest',
  'tools/supply-chain/deps-allowlist.json',
];
// The libraries a generated service compiles against (its stubs import the kernel and the contracts).
const KERNEL_COPIED = [
  'libs/shared/contracts',
  'libs/engine/kernel',
  'libs/engine/ports',
];
// The golden-path proof also runs the router, the testkit, the architecture tests and the API
// document emitter, so it takes the whole product as it stands.
const FULL_COPIED = [
  'libs/engine',
  'libs/shared',
  'libs/testkit',
  'testing/broker-lab',
  'tools/arch-tests',
  'tools/api-docs',
  'docs/api',
];
const SKIPPED = new Set(['node_modules', 'dist', 'tmp', '.nx', 'coverage']);

/**
 * The environment for the nested Nx. When this suite runs under `nx test generators`, the outer
 * Nx has exported NX_* variables (workspace root, task hash, ...) that would point the inner one
 * at the real workspace, so every NX_* variable is dropped.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('NX_')),
  );
  return {
    ...inherited,
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
    CI: 'true',
    FORCE_COLOR: '0',
  };
}

export interface RunResult {
  status: number;
  output: string;
}

export class TempWorkspace {
  readonly root: string;

  /**
   * `full` copies the product as it stands and keeps every alias: the golden-path proof needs the
   * router, the testkit and the architecture tests. Otherwise the copy holds the policy files, the
   * plugin and the libraries a service compiles against, and starts without the aliases of the
   * adopted first-use libraries so the generators can create them (see `restoreAlias`).
   */
  constructor(options: { full?: boolean } = {}) {
    // The real path, not the 8.3 short name (RUNNER~1) that Windows temp directories can have:
    // Vitest's jsdom environment cannot find spec files below a short path.
    this.root = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'generators-e2e-')),
    );
    const copied = [
      ...COPIED,
      ...(options.full === true ? FULL_COPIED : KERNEL_COPIED),
    ];
    for (const path of copied) {
      cpSync(join(repoRoot, path), join(this.root, path), {
        recursive: true,
        filter: (source) => !SKIPPED.has(source.split(/[\\/]/).at(-1) ?? ''),
      });
    }
    if (options.full !== true) {
      const tsconfigBase = join(this.root, 'tsconfig.base.json');
      writeFileSync(
        tsconfigBase,
        withoutAdoptedAliases(readFileSync(tsconfigBase, 'utf8')),
      );
    }
    symlinkSync(
      join(repoRoot, 'node_modules'),
      join(this.root, 'node_modules'),
      'junction',
    );
  }

  /**
   * Puts one alias back once the generators have run, for a library that was copied: the kernel
   * imports `@app/ports`, but the adapter generator must not see that alias while it runs.
   */
  restoreAlias(alias: string): void {
    const read = (
      path: string,
    ): { compilerOptions: { paths: Record<string, string[]> } } =>
      JSON.parse(readFileSync(path, 'utf8')) as never;
    const target = join(this.root, 'tsconfig.base.json');
    const real = read(join(repoRoot, 'tsconfig.base.json'));
    const copy = read(target);
    const paths = real.compilerOptions.paths[alias];
    if (paths === undefined)
      throw new Error(`${alias} is not in tsconfig.base.json`);
    copy.compilerOptions.paths[alias] = paths;
    writeFileSync(target, `${JSON.stringify(copy, null, 2)}\n`);
    // The generators write it with Prettier's layout; so does the copy, or the format check fails.
    this.prettier('--write', 'tsconfig.base.json');
  }

  run(command: string, args: string[]): RunResult {
    const result = spawnSync(
      process.execPath,
      [join(this.root, command), ...args],
      {
        cwd: this.root,
        encoding: 'utf8',
        env: childEnvironment(),
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return {
      status: result.status ?? 1,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  /** `nx <args>` through the real CLI. */
  nx(...args: string[]): RunResult {
    return this.run('node_modules/nx/dist/bin/nx.js', args);
  }

  eslint(...args: string[]): RunResult {
    return this.run('node_modules/eslint/bin/eslint.js', args);
  }

  prettier(...args: string[]): RunResult {
    return this.run('node_modules/prettier/bin/prettier.cjs', args);
  }

  /** Removes the copy. The link goes first so nothing can follow it into the real node_modules. */
  dispose(): void {
    if (process.env.GENERATORS_E2E_KEEP) {
      console.info(`Kept the e2e workspace at ${this.root}`);
      return;
    }
    const link = join(this.root, 'node_modules');
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link);
    rmSync(this.root, { recursive: true, force: true });
  }
}
