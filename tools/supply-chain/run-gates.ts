// Entry point for `nx run supply-chain:gates`.
//   node tools/supply-chain/run-gates.ts --metafile=<esbuild metafile>... [--shipped=<json>]
//   node tools/supply-chain/run-gates.ts --dev-only
// Exits 1 when any gate fails. Needs `pnpm install` first: licences come from node_modules.
//
// Two licence gates (A-19): the dev/build gate always runs over the installed packages; the
// shipped-artefact gate (exact DC-50) runs over the packages bundled into the release artefacts.
// The shipped input is required: pass one `--metafile=` per bundle (engine `meta.json`, web
// `browser-stats.json`) and/or a prepared `--shipped=` list, or opt out explicitly with `--dev-only`.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packagesFromMetafile } from './bundled-packages.ts';
import { formatViolations, runAllGates } from './gates.ts';
import { appliedExceptions } from './licence-gate.ts';
import {
  asRecord,
  asStringList,
  loadRealWorkspace,
  readJsonList,
  violation,
} from './shared.ts';
import type { Licence, Violation } from './shared.ts';

const root = resolve(import.meta.dirname, '..', '..');

/** `pnpm licenses list --json` groups packages by licence; flatten to one row per name@version. */
function installedLicences(): Licence[] {
  // One command string through the shell: `pnpm` is a .cmd shim on Windows.
  const result = spawnSync('pnpm licenses list --json', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `\`pnpm licenses list --json\` failed (run \`pnpm install\` first):\n${result.stderr}`,
    );
  }
  const licences: Licence[] = [];
  for (const [license, packages] of Object.entries(
    asRecord(JSON.parse(result.stdout)),
  )) {
    for (const pkg of Array.isArray(packages) ? packages : []) {
      const entry = asRecord(pkg);
      for (const version of asStringList(entry['versions'])) {
        licences.push({ name: String(entry['name']), version, license });
      }
    }
  }
  return licences;
}

function argValues(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length));
}

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  const path = resolve(root, dir, 'package.json');
  return existsSync(path)
    ? asRecord(JSON.parse(readFileSync(path, 'utf8')))
    : undefined;
}

/** Bundled packages of every `--metafile`, plus the optional prepared `--shipped` list. */
function shippedInputs(): { shipped: Licence[]; problems: Violation[] } {
  const shipped: Licence[] = [];
  const problems: Violation[] = [];
  for (const file of argValues('metafile')) {
    const path = resolve(file);
    let meta: unknown;
    try {
      meta = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      problems.push(
        violation(
          'licence',
          'licence.shipped-input',
          file,
          `${file}: cannot read the metafile (${error instanceof Error ? error.message : String(error)}). Build the bundle first: \`nx run-many -t build -p engine,web\`.`,
        ),
      );
      continue;
    }
    const result = packagesFromMetafile(file, meta, readPackageJson);
    shipped.push(...result.packages);
    problems.push(...result.problems);
  }
  for (const file of argValues('shipped')) {
    shipped.push(...readJsonList<Licence>(resolve(file)));
  }
  return { shipped, problems };
}

const devOnly = process.argv.includes('--dev-only');
const wantsShipped =
  argValues('metafile').length > 0 || argValues('shipped').length > 0;
if (!devOnly && !wantsShipped) {
  console.error(
    'supply-chain gates: no shipped-artefact input. Pass --metafile=<esbuild metafile> (or --shipped=<json>), or --dev-only to skip the shipped gate on purpose.',
  );
  process.exit(2);
}

const ws = loadRealWorkspace(root);
const licences = installedLicences();
const { shipped, problems } = devOnly
  ? { shipped: undefined, problems: [] }
  : shippedInputs();
const violations = runAllGates(ws, {
  licences,
  ...(shipped === undefined ? {} : { shipped, shippedProblems: problems }),
});

for (const line of appliedExceptions(licences, 'dev/build')) {
  console.log(`licence exception (dev/build): ${line}`);
}
for (const line of appliedExceptions(shipped ?? [], 'shipped')) {
  console.log(`licence exception (shipped): ${line}`);
}

if (violations.length > 0) {
  console.error(
    `supply-chain gates FAILED (${violations.length} violation${violations.length === 1 ? '' : 's'}):
${formatViolations(violations)}`,
  );
  process.exit(1);
}
console.log(
  `supply-chain gates passed: lockfile, pins, allow-list, ${licences.length} installed package versions licence-checked (dev/build)` +
    (shipped === undefined
      ? ', shipped-artefact gate skipped (--dev-only).'
      : `, ${shipped.length} bundled packages licence-checked (shipped, DC-50).`),
);
