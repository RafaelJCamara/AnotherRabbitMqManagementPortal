// The facts leg (M0-41, slice B, OQ-580): facts that no registry cell names (hazard rules, warnings,
// resolveEra) are judged with the three-way legs: the live run against the artefact, the artefact's own
// validity (both from evaluate), and OpsFact.check, what the artefact shows against the expectation.
// It only reads: no evidence is written, no status flips (I-14). A pass is a green check, not a cell.
import {
  verifyEvidenceText,
  type EvidenceArtefact,
  type Json,
} from '../record/evidence.ts';
import { readEvidenceFile } from './evidence-store.ts';
import { diffJson } from './diff.ts';
import type { LabVersion } from './lab-versions.ts';
import {
  evaluate,
  type CellResult,
  type EvaluateInput,
  type RegistryLeg,
} from './three-way.ts';

export interface OpsFact {
  readonly id: string;
  readonly cfId: string;
  readonly appliesTo: 'all-lab-versions' | readonly string[];
  /** The fact-sheet row or registry rule the expectation is read from. */
  readonly source: string;
  /** What the artefact shows against what is expected; null = the artefact does not speak of it. */
  readonly check: (
    evidence: EvidenceArtefact,
    lab: LabVersion,
  ) => { expected: Json; observed: Json } | null;
}

/** The eight operational ids; the coverage gate counts all of them, judged or not. */
export const OPS_CF_IDS: readonly string[] = [
  'CF-OPS-SAC-01',
  'CF-OPS-SAC-02',
  'CF-OPS-EXCL-01',
  'CF-OPS-STREAM-01',
  'CF-OPS-PASSIVE-01',
  'CF-OPS-VHOST-01',
  'CF-OPS-QQVER-01',
  'CF-OPS-UPGRADE-01',
];

/** Added by the slices that write the scenario each fact reads (C to F, H). */
export const OPS_FACTS: readonly OpsFact[] = [];

export const appliesToVersion = (fact: OpsFact, version: string): boolean =>
  fact.appliesTo === 'all-lab-versions' || fact.appliesTo.includes(version);

export type FactInput = Pick<
  EvaluateInput,
  'version' | 'era' | 'pin' | 'file' | 'live'
> & {
  readonly fact: OpsFact;
};

function factResult(input: FactInput): CellResult {
  const { fact, version, era, pin, file } = input;
  // No registry cell takes part: `evaluate` supplies only the evidence leg and the live leg.
  const base = evaluate({
    ...input,
    cfId: fact.cfId,
    cells: [],
    projection: undefined,
  })[0];
  if (base === undefined) throw new Error('evaluate returned no result');

  // Only an artefact that `evaluate` found valid (verified, CI-stamped, on the pinned image) is read.
  const artefact =
    base.evidence.state === 'valid' && file.kind === 'present'
      ? verifyEvidenceText(file.path, file.text)
      : null;
  let registry: RegistryLeg = { state: 'not-checked' };
  if (artefact !== null) {
    const checked = fact.check(artefact, { version, era, digest: pin });
    const diffs =
      checked === null
        ? null
        : diffJson(checked.expected, checked.observed, 'fact');
    registry =
      diffs === null
        ? { state: 'no-projection' }
        : diffs.length === 0
          ? { state: 'match' }
          : { state: 'mismatch', diffs };
  }

  const fails: string[] = [];
  if (base.evidence.state === 'invalid')
    fails.push(`the evidence ${base.evidence.path} ${base.evidence.reason}`);
  if (base.live.state === 'mismatch')
    fails.push('the live run differs from the recorded evidence');
  if (registry.state === 'mismatch')
    fails.push(
      `the recorded evidence contradicts the fact ${fact.id} (${fact.source})`,
    );
  const open: string[] = [];
  if (base.evidence.state === 'missing')
    open.push(
      `no evidence is recorded at testing/lab-evidence/${base.evidence.path}`,
    );
  if (base.live.state === 'not-run')
    open.push('no live run (no lab broker for this version)');
  if (registry.state === 'no-projection')
    open.push(`the recorded evidence does not speak of the fact ${fact.id}`);
  const reasons = fails.length > 0 ? fails : open;
  return {
    cellId: fact.id,
    cfId: fact.cfId,
    version,
    live: base.live,
    evidence: base.evidence,
    registry,
    verdict:
      fails.length > 0 ? 'fail' : open.length > 0 ? 'unverified' : 'pass',
    reasons,
    fact: { source: fact.source },
  };
}

export const evaluateFact = (input: FactInput): CellResult[] => [
  factResult(input),
];

export interface FactCoverageInput {
  readonly facts: readonly OpsFact[];
  readonly ids: readonly string[];
  readonly versions: readonly LabVersion[];
  readonly scenarioIds: ReadonlySet<string>;
  readonly evidenceRoot: string;
  readonly strict: boolean;
}

/** The recorded legs of every fact on the lab versions it applies to; `strict` adds what they do not confirm. */
export function factCoverage(input: FactCoverageInput) {
  const results: CellResult[] = [];
  const failures: string[] = [];
  for (const cfId of input.ids) {
    if (input.strict && !input.facts.some((fact) => fact.cfId === cfId))
      failures.push(`${cfId}: no fact judges it`);
  }
  for (const fact of input.facts) {
    const labs = input.versions.filter((lab) =>
      appliesToVersion(fact, lab.version),
    );
    if (input.strict && labs.length === 0)
      failures.push(`${fact.id}: applies to no lab version`);
    for (const lab of labs) {
      const result = factResult({
        fact,
        version: lab.version,
        era: lab.era,
        pin: lab.digest,
        file: readEvidenceFile(input.evidenceRoot, lab.version, fact.cfId),
        live: null,
      });
      results.push(result);
      // A contradiction is reported with every other failing result, by the caller.
      if (
        input.strict &&
        result.verdict !== 'fail' &&
        result.registry.state !== 'match'
      )
        failures.push(
          `${fact.id} on ${result.version} (${fact.cfId}): not confirmed by recorded evidence (${result.reasons.join('; ')})`,
        );
    }
  }
  return {
    results,
    failures,
    withoutScenario: input.ids.filter((id) => !input.scenarioIds.has(id)),
  };
}
