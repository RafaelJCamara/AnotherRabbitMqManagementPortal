// The three-way assertion (blueprint 5.2, invariant I-14): for one conformance id on one broker
// version, the live run, the recorded evidence and the registry cell must agree.
//
//   live      the scenario run now against a lab broker      vs  the recorded artefact (field by field)
//   evidence  the artefact in testing/lab-evidence           must verify, be recorded by CI, be where
//                                                            its content says and be on the pinned image
//   registry  the cell's effect                              vs  what the evidence shows of that cell
//                                                            (a per-CF `Projection`)
//
// A verdict of `pass` needs all three to agree. Any disagreement, and any lab status that the
// evidence does not carry, is `fail`. Anything the run could not establish (no evidence recorded
// yet, no live broker, no registry cell for the id, no projection for the id) is `unverified`: shown,
// never green. This file only reads: it writes no evidence and changes no cell (I-14).
import type { SemanticsCell, SettleEffect } from '@app/semantics';
import {
  verifyEvidenceText,
  type EvidenceArtefact,
  type EvidenceObservation,
  type EvidenceStep,
  type Json,
} from '../record/evidence.ts';
import { diffJson, formatDiffs, type FieldDiff } from './diff.ts';

export type Verdict = 'pass' | 'fail' | 'unverified';

/** What a live run of a scenario produced, the same facts an artefact records. */
export interface LiveRun {
  readonly cfId: string;
  readonly title: string;
  readonly protocol: string;
  readonly brokerVersion: string;
  readonly imageDigest: string;
  readonly steps: readonly EvidenceStep[];
  readonly observations: readonly EvidenceObservation[];
}

export type EvidenceLeg =
  | { readonly state: 'valid'; readonly path: string; readonly digest: string }
  | { readonly state: 'missing'; readonly path: string }
  | {
      readonly state: 'invalid';
      readonly path: string;
      readonly reason: string;
    };

export type LiveLeg =
  | { readonly state: 'match' }
  | { readonly state: 'not-run' }
  /** The run happened, but there is no valid recorded evidence to compare it with. */
  | { readonly state: 'no-baseline' }
  | { readonly state: 'mismatch'; readonly diffs: readonly FieldDiff[] };

export type RegistryLeg =
  | { readonly state: 'match' }
  /** The evidence is not valid, so there is nothing to compare the cell with. */
  | { readonly state: 'not-checked' }
  | { readonly state: 'no-cell' }
  | { readonly state: 'no-effect' }
  | { readonly state: 'no-projection' }
  | { readonly state: 'mismatch'; readonly diffs: readonly FieldDiff[] };

export interface CellResult {
  /** The registry cell, or null when no cell names this conformance id for this era. */
  readonly cellId: string | null;
  readonly cfId: string;
  readonly version: string;
  readonly live: LiveLeg;
  readonly evidence: EvidenceLeg;
  readonly registry: RegistryLeg;
  readonly verdict: Verdict;
  /** Why the verdict is not `pass`; empty for a pass. */
  readonly reasons: readonly string[];
}

/** The part of a cell's effect that an artefact shows. Fields it does not show are left out. */
export type Observed = Partial<SettleEffect>;

/**
 * What the evidence of one conformance id says about a cell, or null when it says nothing about
 * that cell. Written by the work package that owns the conformance id, from the scenario's steps.
 */
export type Projection = (
  evidence: EvidenceArtefact,
  cell: SemanticsCell,
) => Observed | null;

/** One evidence file as the store found it; path is `<broker-version>/<CF-id>.json` below testing/lab-evidence. */
export type EvidenceFile =
  | { readonly kind: 'present'; readonly path: string; readonly text: string }
  | { readonly kind: 'missing'; readonly path: string }
  /** A link, or a file too large to be evidence. */
  | { readonly kind: 'unreadable'; readonly path: string };

export interface EvaluateInput {
  readonly cfId: string;
  readonly version: string;
  /** The semantics era of `version`. */
  readonly era: string;
  /** The base-image digest pinned for `version` in testing/broker-lab/versions.json. */
  readonly pin: string;
  readonly cells: readonly SemanticsCell[];
  readonly file: EvidenceFile;
  readonly live: LiveRun | null;
  readonly projection: Projection | undefined;
}

function evidenceLeg(input: EvaluateInput): {
  leg: EvidenceLeg;
  artefact: EvidenceArtefact | null;
} {
  const { path } = input.file;
  if (input.file.kind === 'missing') {
    return { leg: { state: 'missing', path }, artefact: null };
  }
  const invalid = (reason: string) => ({
    leg: { state: 'invalid', path, reason } as const,
    artefact: null,
  });
  if (input.file.kind === 'unreadable') {
    return invalid('is a link or too large to be an evidence file');
  }
  let artefact: EvidenceArtefact;
  try {
    artefact = verifyEvidenceText(path, input.file.text);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  if (artefact.provenance.kind !== 'ci') {
    return invalid('was not recorded by the CI workflow (provenance is local)');
  }
  if (
    artefact.cfId !== input.cfId ||
    artefact.brokerVersion !== input.version
  ) {
    return invalid(
      `is the evidence of ${artefact.cfId} on ${artefact.brokerVersion}`,
    );
  }
  if (artefact.imageDigest !== input.pin) {
    return invalid(
      `was recorded on ${artefact.imageDigest}, not the pinned ${input.pin}`,
    );
  }
  return {
    leg: { state: 'valid', path, digest: artefact.integrity.digest },
    artefact,
  };
}

const comparable = (
  value: Pick<
    LiveRun,
    | 'cfId'
    | 'title'
    | 'protocol'
    | 'brokerVersion'
    | 'imageDigest'
    | 'steps'
    | 'observations'
  >,
): Json =>
  JSON.parse(
    JSON.stringify({
      cfId: value.cfId,
      title: value.title,
      protocol: value.protocol,
      brokerVersion: value.brokerVersion,
      imageDigest: value.imageDigest,
      steps: value.steps,
      observations: value.observations,
    }),
  ) as Json;

function registryLeg(
  cell: SemanticsCell | undefined,
  artefact: EvidenceArtefact | null,
  projection: Projection | undefined,
): RegistryLeg {
  if (cell === undefined) return { state: 'no-cell' };
  if (artefact === null) return { state: 'not-checked' };
  if (cell.effect === null) return { state: 'no-effect' };
  const observed = projection?.(artefact, cell) ?? null;
  if (observed === null || Object.keys(observed).length === 0) {
    return { state: 'no-projection' };
  }
  const effect: Record<string, Json> = { ...cell.effect };
  const diffs = Object.entries(observed).flatMap(([field, value]) =>
    diffJson(effect[field], value as Json, `effect.${field}`),
  );
  return diffs.length === 0 ? { state: 'match' } : { state: 'mismatch', diffs };
}

function verdictOf(
  cell: SemanticsCell | undefined,
  evidence: EvidenceLeg,
  live: LiveLeg,
  registry: RegistryLeg,
): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  const fail = (reason: string): void => {
    reasons.push(reason);
  };
  if (evidence.state === 'invalid')
    fail(`the evidence ${evidence.path} ${evidence.reason}`);
  if (live.state === 'mismatch')
    fail('the live run differs from the recorded evidence');
  if (registry.state === 'mismatch')
    fail('the registry cell differs from the recorded evidence');
  if (cell !== undefined && cell.status !== 'code-derived') {
    if (evidence.state !== 'valid') {
      fail(
        `the cell is ${cell.status} but has no valid recorded evidence here`,
      );
    } else if (cell.status === 'lab-contradicted') {
      fail(
        'the cell is marked lab-contradicted: a human must correct it against the evidence',
      );
    } else if (registry.state !== 'match') {
      fail(
        `the cell is ${cell.status} but the evidence does not confirm its effect (${registry.state})`,
      );
    }
  }
  if (reasons.length > 0) return { verdict: 'fail', reasons };
  if (evidence.state === 'missing')
    reasons.push(
      `no evidence is recorded at testing/lab-evidence/${evidence.path}`,
    );
  if (live.state === 'not-run')
    reasons.push('no live run (no lab broker for this version)');
  if (registry.state === 'no-cell')
    reasons.push('no registry cell names this conformance id for this era');
  if (registry.state === 'no-effect')
    reasons.push('the registry cell has no derived effect yet');
  if (registry.state === 'no-projection')
    reasons.push(
      'the evidence of this id is not projected onto cell effects yet',
    );
  return reasons.length === 0
    ? { verdict: 'pass', reasons }
    : { verdict: 'unverified', reasons };
}

/** One result per registry cell that names the id for this era, or one with `cellId: null`. */
export function evaluate(input: EvaluateInput): CellResult[] {
  const { leg, artefact } = evidenceLeg(input);
  let live: LiveLeg = { state: 'not-run' };
  if (input.live !== null) {
    if (artefact === null) live = { state: 'no-baseline' };
    else {
      const diffs = diffJson(comparable(artefact), comparable(input.live));
      live =
        diffs.length === 0 ? { state: 'match' } : { state: 'mismatch', diffs };
    }
  }
  const cells = input.cells.filter(
    (cell) =>
      cell.conformance.some((id) => id === input.cfId) &&
      cell.key.era === input.era,
  );
  const targets: (SemanticsCell | undefined)[] =
    cells.length === 0 ? [undefined] : cells;
  return targets.map((cell) => {
    const registry = registryLeg(cell, artefact, input.projection);
    return {
      cellId: cell?.id ?? null,
      cfId: input.cfId,
      version: input.version,
      live,
      evidence: leg,
      registry,
      ...verdictOf(cell, leg, live, registry),
    };
  });
}

export function formatResult(result: CellResult): string {
  const lines = [
    `${result.cfId} on ${result.version} (cell ${result.cellId ?? 'none'}): ${result.verdict}`,
    ...result.reasons.map((reason) => `  - ${reason}`),
  ];
  if (result.live.state === 'mismatch') {
    lines.push(
      'live run vs recorded evidence:',
      formatDiffs(result.live.diffs, { expected: 'recorded', actual: 'live' }),
    );
  }
  if (result.registry.state === 'mismatch') {
    lines.push(
      'registry cell vs recorded evidence:',
      formatDiffs(result.registry.diffs, {
        expected: 'registry',
        actual: 'evidence',
      }),
    );
  }
  return lines.join('\n');
}

/** Throws with the field-level diff on a `fail`; with `strict`, also on `unverified`. */
export function assertResult(
  result: CellResult,
  options: { strict: boolean },
): void {
  if (
    result.verdict === 'fail' ||
    (options.strict && result.verdict === 'unverified')
  ) {
    throw new Error(formatResult(result));
  }
}
