// `nx run conformance:coverage [--strict]`: the coverage gate over the registry and the recorded
// evidence (see coverage.ts). Node runs it directly through the alias hook of semantics-audit:
//   node --import ./tools/semantics-audit/register.mjs apps/conformance/src/assert/coverage-cli.ts
// It only reads.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryData } from '@app/semantics';
import { SCENARIOS } from '../scenarios/index.ts';
import { coverageGate } from './coverage.ts';
import { EVIDENCE_ROOT } from './evidence-store.ts';
import { labVersions } from './lab-versions.ts';
import { PROJECTIONS } from './projections.ts';

const CELLS_DIR = fileURLToPath(new URL('../cells/', import.meta.url));

export function main(argv: readonly string[]): number {
  let strict = false;
  let evidenceRoot = EVIDENCE_ROOT;
  for (const arg of argv) {
    if (arg === '--strict') strict = true;
    else if (arg.startsWith('--evidence-root=')) {
      evidenceRoot = resolve(arg.slice('--evidence-root='.length));
    } else {
      console.error(
        `unknown argument "${arg}"; use --strict or --evidence-root=<dir>`,
      );
      return 2;
    }
  }
  const coverage = coverageGate({
    cells: registryData.cells,
    versions: labVersions(),
    scenarios: SCENARIOS,
    projections: PROJECTIONS,
    evidenceRoot,
    hasStub: (cfId) =>
      existsSync(join(CELLS_DIR, `${cfId.toLowerCase()}.cell.spec.ts`)),
    strict,
  });
  const { totals } = coverage;
  console.log(
    `coverage: ${String(totals.cells)} cell(s), ${String(totals.results)} recorded result(s): ${String(totals.confirmed)} confirmed, ${String(totals.unverified)} unverified, ${String(totals.failed)} failed; ${String(totals.withoutScenario)} conformance id(s) have no scenario${strict ? ' (strict)' : ''}`,
  );
  for (const failure of coverage.failures)
    console.error(`coverage: ${failure}`);
  return coverage.failures.length === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
