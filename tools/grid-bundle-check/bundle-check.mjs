// Proves what the public entry of ui-grid bundles (M0-53, AC-3, DC-50, DC-52).
//
//   node tools/grid-bundle-check/bundle-check.mjs [--no-gates]
//
// It bundles `libs/ui/grid/src/index.ts` with its dependencies using the esbuild that
// @angular/build ships (no new bundler; the S-04 harness does the same), writes the metafile, and
// fails when
//   - an input comes from `ag-grid-enterprise`, an `@ag-grid-enterprise/*` package or another
//     AG Grid package that is not Community;
//   - the scan cannot see AG Grid Community at all (a control, so an empty scan proves nothing);
//   - the modules the adapter registers (`GRID_MODULE_NAMES`) are not all exported by
//     `ag-grid-community` itself, or are not an explicit list;
//   - the shipped-artefact checks of tools/supply-chain (licence, allow-list, pins) fail on it.
// It lives under `tools/` because it needs Node, and `libs/ui/grid` is browser code (blueprint 2.1).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..', '..');
export const OUT_DIR = join(root, 'dist', 'ui-grid-bundle-check');

// esbuild is a dependency of @angular/build; resolve it from there, not from the workspace root.
const angularBuild = createRequire(import.meta.url).resolve('@angular/build');
const esbuild = createRequire(angularBuild)('esbuild');

/** Input paths of AG Grid's commercial tier and of its Enterprise charts. */
const ENTERPRISE =
  /(^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(ag-grid-enterprise|@ag-grid-enterprise\/|ag-charts-enterprise|ag-grid-charts-enterprise|ag-grid-react-enterprise)/;

/** The `node_modules` package (name only) of one input path, or undefined for our own files. */
export function packageOf(inputPath) {
  const path = inputPath.replace(/\\/g, '/');
  const at = path.lastIndexOf('node_modules/');
  if (at === -1) return undefined;
  const rest = path.slice(at + 'node_modules/'.length).split('/');
  return rest[0]?.startsWith('@') ? rest.slice(0, 2).join('/') : rest[0];
}

/** Metafile inputs that belong to an AG Grid package other than Community. */
export function enterpriseInputs(metafile) {
  return Object.keys(metafile.inputs).filter((input) =>
    ENTERPRISE.test(input.replace(/\\/g, '/')),
  );
}

/** The distinct third-party packages in a metafile. */
export function bundledPackages(metafile) {
  return [
    ...new Set(Object.keys(metafile.inputs).map(packageOf).filter(Boolean)),
  ].sort();
}

const common = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
  absWorkingDir: root,
  tsconfig: join(root, 'libs', 'ui', 'grid', 'tsconfig.json'),
};

/** Bundles the public entry of ui-grid; returns the metafile and the size of the output. */
export async function buildBundle(outDir = OUT_DIR) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, 'ui-grid.js');
  const result = await esbuild.build({
    ...common,
    entryPoints: [join(root, 'libs', 'ui', 'grid', 'src', 'index.ts')],
    outfile,
    minify: true,
    metafile: true,
  });
  const metaPath = join(outDir, 'meta.json');
  writeFileSync(metaPath, JSON.stringify(result.metafile));
  const bytes = readFileSync(outfile);
  return {
    metafile: result.metafile,
    metaPath,
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes).length,
  };
}

/**
 * Gzip size of the adapter with AG Grid but without Angular, RxJS and tslib (the app already ships
 * those): the number to hold against the feature-chunk budget of 200 kB gzip (blueprint 10).
 */
export async function adapterGzipBytes(outDir = OUT_DIR) {
  const outfile = join(outDir, 'ui-grid.without-angular.js');
  await esbuild.build({
    ...common,
    entryPoints: [join(root, 'libs', 'ui', 'grid', 'src', 'index.ts')],
    outfile,
    minify: true,
    external: ['@angular/*', 'rxjs', 'rxjs/*', 'tslib'],
  });
  return gzipSync(readFileSync(outfile)).length;
}

/** The names the adapter registers, read from a bundle of `grid-config.ts` alone (no Angular). */
export async function registeredModuleNames(outDir = OUT_DIR) {
  const outfile = join(outDir, 'grid-config.mjs');
  await esbuild.build({
    ...common,
    entryPoints: [join(root, 'libs', 'ui', 'grid', 'src', 'grid-config.ts')],
    outfile,
    minify: false,
  });
  const { GRID_MODULE_NAMES } = await import(pathToFileURL(outfile).href);
  return [...GRID_MODULE_NAMES];
}

/** Names of the modules `ag-grid-community` itself exports (Community by definition). */
export async function communityModuleNames() {
  const entry = createRequire(join(root, 'package.json')).resolve(
    'ag-grid-community',
  );
  const loaded = await import(pathToFileURL(entry).href);
  // The CommonJS entry exposes its exports as default.
  const exported = { ...loaded, ...(loaded.default ?? {}) };
  return new Set(
    Object.values(exported)
      .filter(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          typeof value.moduleName === 'string' &&
          value.enterprise !== true,
      )
      .map((module) => module.moduleName),
  );
}

/** The problems of a built bundle; an empty list means AC-3 holds. */
export async function check({ metafile }, outDir = OUT_DIR) {
  const problems = [];
  for (const input of enterpriseInputs(metafile)) {
    problems.push(`an AG Grid Enterprise input is bundled: ${input}`);
  }
  const packages = bundledPackages(metafile);
  if (!packages.includes('ag-grid-community')) {
    problems.push(
      'the scan does not see ag-grid-community in the bundle, so it proves nothing',
    );
  }
  const stray = packages.filter(
    (name) =>
      /^(ag-grid|@ag-grid|ag-charts)/.test(name) &&
      !['ag-grid-community'].includes(name),
  );
  for (const name of stray) {
    problems.push(`an unexpected AG Grid package is bundled: ${name}`);
  }
  const registered = await registeredModuleNames(outDir);
  const community = await communityModuleNames();
  if (registered.length === 0) problems.push('no AG Grid module is registered');
  if (registered.includes('AllCommunityModule') || registered.length > 30) {
    problems.push('the module list is not an explicit short list');
  }
  for (const name of registered) {
    if (!community.has(name)) {
      problems.push(`registered module ${name} is not a Community module`);
    }
  }
  return problems;
}

function runGates(metaPath) {
  const result = spawnSync(
    process.execPath,
    ['tools/supply-chain/run-gates.ts', `--metafile=${metaPath}`],
    { cwd: root, stdio: 'inherit' },
  );
  return result.status === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const built = await buildBundle();
  const problems = await check(built);
  console.log(
    `ui-grid bundle: ${String(built.bytes)} bytes, ${String(built.gzipBytes)} gzip; packages: ${bundledPackages(built.metafile).join(', ')}`,
  );
  console.log(
    `adapter with AG Grid, without Angular: ${String(await adapterGzipBytes())} bytes gzip (budget of a feature chunk: 200 kB)`,
  );
  console.log(
    `registered modules: ${(await registeredModuleNames()).join(', ')}`,
  );
  if (problems.length > 0) {
    console.error(`ui-grid bundle check FAILED:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  if (!process.argv.includes('--no-gates') && !runGates(built.metaPath)) {
    process.exit(1);
  }
  console.log('ui-grid bundle check passed: no AG Grid Enterprise module.');
}
