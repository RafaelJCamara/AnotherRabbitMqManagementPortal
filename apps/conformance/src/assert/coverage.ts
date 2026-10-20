// The coverage gate: which registry cells have recorded, agreeing evidence on every lab version of
// their era? Offline: it evaluates the recorded legs only (evidence and registry); the live leg is
// `conformance:test --versions=...`. The operational facts that no cell names (ops-facts.ts, M0-41) are counted
// too: a recorded contradiction always fails; with `--strict` so does an id without a scenario or a judging fact,
// and a fact without confirming evidence on every lab version it applies to.
//
// Always failing (a registry that claims more than the lab shows):
//   - a cell names a conformance id that has no lab-cell spec;
//   - the recorded legs of any cell disagree (a `fail` verdict);
//   - a cell with a lab status is not confirmed by recorded evidence on every lab version of its era,
//     or its era has no lab version at all.
// With `--strict` (the release gate: no Tier-1 claim and no "lab-verified" badge without a green run
// over every cell) also failing: any cell, whatever its status, without confirming evidence on
// every lab version of its era, and any conformance id with no scenario.
import type { SemanticsCell } from '@app/semantics';
import type { LabScenario } from '../dsl.ts';
import { readEvidenceFile } from './evidence-store.ts';
import type { LabVersion } from './lab-versions.ts';
import { factCoverage, type OpsFact } from './ops-facts.ts';
import { evaluate, type CellResult, type Projection } from './three-way.ts';

export interface CoverageInput {
  /** The facts no cell names (ops-facts.ts) and the ids the gate counts for them; none by default. */
  readonly facts?: readonly OpsFact[];
  readonly opsIds?: readonly string[];
  readonly cells: readonly SemanticsCell[];
  readonly versions: readonly LabVersion[];
  readonly scenarios: readonly LabScenario[];
  readonly projections: Readonly<Record<string, Projection>>;
  readonly evidenceRoot: string;
  readonly hasStub: (cfId: string) => boolean;
  readonly strict: boolean;
}

export interface Coverage {
  readonly results: readonly CellResult[];
  readonly failures: readonly string[];
  readonly totals: {
    readonly cells: number;
    readonly results: number;
    readonly confirmed: number;
    readonly unverified: number;
    readonly failed: number;
    readonly withoutScenario: number;
  };
}

/** Evidence valid and the registry cell confirmed by it, whatever the live leg did. */
const confirmed = (result: CellResult): boolean =>
  result.verdict !== 'fail' &&
  result.evidence.state === 'valid' &&
  result.registry.state === 'match';

export function coverageGate(input: CoverageInput): Coverage {
  const failures: string[] = [];
  const results: CellResult[] = [];
  const evaluated = new Set<string>();
  const scenarioIds = new Set(input.scenarios.map((scenario) => scenario.cfId));
  const withoutScenario = new Set<string>();

  const confirmedBy = new Map<string, Set<string>>();
  for (const cell of input.cells) {
    for (const cfId of cell.conformance) {
      if (!input.hasStub(cfId)) {
        failures.push(`${cell.id}: ${cfId} has no lab-cell spec`);
      }
      if (!scenarioIds.has(cfId)) withoutScenario.add(cfId);
    }
    const versions = input.versions.filter((lab) => lab.era === cell.key.era);
    if (versions.length === 0 && cell.status !== 'code-derived') {
      failures.push(
        `${cell.id}: is ${cell.status} but no lab version has era ${cell.key.era}`,
      );
    }
    if (versions.length === 0 && input.strict) {
      failures.push(`${cell.id}: no lab version has era ${cell.key.era}`);
    }
    for (const lab of versions) {
      for (const cfId of cell.conformance) {
        const key = `${cfId}@${lab.version}`;
        if (evaluated.has(key)) continue;
        evaluated.add(key);
        results.push(
          ...evaluate({
            cfId,
            version: lab.version,
            era: lab.era,
            pin: lab.digest,
            cells: input.cells,
            file: readEvidenceFile(input.evidenceRoot, lab.version, cfId),
            live: null,
            projection: input.projections[cfId],
          }),
        );
      }
    }
    confirmedBy.set(cell.id, new Set());
  }

  const ops = factCoverage({
    facts: input.facts ?? [],
    ids: input.opsIds ?? [],
    versions: input.versions,
    scenarioIds,
    evidenceRoot: input.evidenceRoot,
    strict: input.strict,
  });
  for (const cfId of ops.withoutScenario) withoutScenario.add(cfId);
  results.push(...ops.results);

  for (const result of results) {
    if (result.verdict === 'fail') {
      failures.push(
        `${result.cellId ?? result.cfId} on ${result.version} (${result.cfId}): ${result.reasons.join('; ')}`,
      );
    }
    if (result.cellId !== null && confirmed(result)) {
      confirmedBy.get(result.cellId)?.add(`${result.cfId}@${result.version}`);
    }
  }
  for (const cell of input.cells) {
    const versions = input.versions.filter((lab) => lab.era === cell.key.era);
    const need = versions.length * cell.conformance.length;
    const have = confirmedBy.get(cell.id)?.size ?? 0;
    if (have < need && (input.strict || cell.status !== 'code-derived')) {
      const claim =
        cell.status === 'code-derived' ? '' : `is ${cell.status} but `;
      failures.push(
        `${cell.id}: ${claim}only ${String(have)} of ${String(need)} recorded results confirm it`,
      );
    }
  }
  if (input.strict) {
    for (const cfId of [...withoutScenario].sort()) {
      failures.push(`${cfId}: no scenario can record it`);
    }
  }

  failures.push(...ops.failures);
  return {
    results,
    failures,
    totals: {
      cells: input.cells.length,
      results: results.length,
      confirmed: results.filter(confirmed).length,
      unverified: results.filter((result) => result.verdict === 'unverified')
        .length,
      failed: results.filter((result) => result.verdict === 'fail').length,
      withoutScenario: withoutScenario.size,
    },
  };
}
