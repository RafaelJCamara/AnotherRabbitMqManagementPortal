// Entry point for `nx run supply-chain:gates`.
//   node tools/supply-chain/run-gates.ts [--shipped=<json file of bundled packages>]
// Exits 1 when any gate fails. Needs `pnpm install` first: licences come from node_modules.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { formatViolations, runAllGates } from './gates.ts';
import {
  asRecord,
  asStringList,
  loadRealWorkspace,
  readJsonList,
} from './shared.ts';
import type { Licence } from './shared.ts';

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

const shippedArg = process.argv.find((arg) => arg.startsWith('--shipped='));
const ws = loadRealWorkspace(root);
const licences = installedLicences();
const shipped =
  shippedArg === undefined
    ? undefined
    : readJsonList<Licence>(resolve(shippedArg.slice('--shipped='.length)));
const violations = runAllGates(ws, {
  licences,
  ...(shipped === undefined ? {} : { shipped }),
});

if (violations.length > 0) {
  console.error(
    `supply-chain gates FAILED (${violations.length} violation${violations.length === 1 ? '' : 's'}):\n${formatViolations(violations)}`,
  );
  process.exit(1);
}
console.log(
  `supply-chain gates passed: lockfile, pins, allow-list, ${licences.length} installed package versions licence-checked` +
    (shipped === undefined ? '' : `, ${shipped.length} shipped`) +
    '.',
);
