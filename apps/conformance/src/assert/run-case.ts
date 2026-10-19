// One lab cell on one broker version, outside of any test runner: gather the three legs, evaluate
// them and decide the outcome. `cell-spec.ts` wraps this in a test; the specs call it directly.
import { registryData, type SemanticsCell } from '@app/semantics';
import type { LabScenario } from '../dsl.ts';
import { SCENARIOS } from '../scenarios/index.ts';
import { EVIDENCE_ROOT, readEvidenceFile } from './evidence-store.ts';
import type { LabVersion } from './lab-versions.ts';
import { runLive, type LiveBroker } from './live.ts';
import { PROJECTIONS } from './projections.ts';
import {
  assertResult,
  evaluate,
  formatResult,
  type CellResult,
  type Projection,
} from './three-way.ts';

export interface CaseOptions {
  readonly evidenceRoot?: string;
  readonly cells?: readonly SemanticsCell[];
  readonly scenarios?: readonly LabScenario[];
  readonly projections?: Readonly<Record<string, Projection>>;
}

/** The results for `cfId` on `lab`. The live leg runs only when `broker` is the lab broker of this version. */
export async function evaluateCase(
  cfId: string,
  lab: LabVersion,
  broker: LiveBroker | null,
  options: CaseOptions = {},
): Promise<CellResult[]> {
  const scenario = (options.scenarios ?? SCENARIOS).find(
    (item) => item.cfId === cfId,
  );
  const live =
    broker !== null &&
    broker.endpoint.version === lab.version &&
    scenario !== undefined
      ? await runLive(broker, scenario)
      : null;
  return evaluate({
    cfId,
    version: lab.version,
    era: lab.era,
    pin: lab.digest,
    cells: options.cells ?? registryData.cells,
    file: readEvidenceFile(
      options.evidenceRoot ?? EVIDENCE_ROOT,
      lab.version,
      cfId,
    ),
    live,
    projection: (options.projections ?? PROJECTIONS)[cfId],
  });
}

/**
 * Shows what is not a pass, throws (with the field-level diff) on a `fail`, and with `strict` also on
 * `unverified`. Returns `unverified` when nothing failed but something could not be established.
 */
export function settleCase(
  results: readonly CellResult[],
  strict: boolean,
  log: (text: string) => void = (text) => {
    console.info(text);
  },
): 'pass' | 'unverified' {
  for (const result of results) {
    if (result.verdict !== 'pass') log(formatResult(result));
  }
  for (const result of results) assertResult(result, { strict });
  return results.some((result) => result.verdict === 'unverified')
    ? 'unverified'
    : 'pass';
}
