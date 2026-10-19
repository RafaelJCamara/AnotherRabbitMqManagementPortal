// The semantics-evidence check (invariant I-14, blueprint 5.2, amendment A-20). Pure: everything it
// looks at is passed in (the cells of the base and the head revision, the evidence tree, the paths
// the change touched, the image pins and a function that verifies a CI run), so it is tested
// offline and cannot be steered by the machine it runs on.
//
// It fails closed. A finding is raised when
//  - a file in the evidence tree is not a valid artefact, is misplaced, was not recorded by CI
//    (`local` stamp), names an image other than the pinned one, or (when its run is checked) does
//    not trace back to a successful run of the record workflow;
//  - a cell with a lab status, or any cell that lists evidence, does not have valid artefacts for
//    its own conformance ids and its own era;
//  - a cell's status or effect changed against the base and no valid artefact supports the cell
//    (turning an effect that was `null` on a code-derived cell with no evidence into a value is the
//    one exception: that is deriving a stub, and nothing exists yet to contradict).
// Cells are matched by key, not by id, so deleting a verified cell and adding another with the same
// key is still a change of that cell.
import {
  parseEvidence,
  type CiProvenance,
  type Evidence,
} from './evidence-format.ts';
import { effectKey, type CellSnapshot } from './snapshot.ts';

export interface Finding {
  readonly rule:
    | 'evidence-file'
    | 'evidence-local'
    | 'evidence-pin'
    | 'evidence-run'
    | 'cell-evidence'
    | 'cell-conformance'
    | 'status-evidence'
    | 'status-change'
    | 'effect-change';
  readonly subject: string;
  readonly message: string;
}

export const EVIDENCE_PREFIX = 'testing/lab-evidence/';
const OTHER_FILES = new Set(['schema.json', 'README.md']);
/** The part of an evidence path below the evidence root, or undefined when it is not below it. */
const below = (path: string): string | undefined =>
  path.startsWith(EVIDENCE_PREFIX)
    ? path.slice(EVIDENCE_PREFIX.length)
    : undefined;

const ARTEFACT_PATH = /^[0-9A-Za-z.+-]+\/CF-[A-Z0-9-]+\.json$/;

export interface CheckInput {
  readonly base: readonly CellSnapshot[];
  readonly head: readonly CellSnapshot[];
  /** Every file below testing/lab-evidence at the head (`4.3.6/CF-X.json`) with its text, or null when it could not be read as a plain file. */
  readonly tree: ReadonlyMap<string, string | null>;
  /** Paths below testing/lab-evidence that the change touched (a deleted path matches nothing in the tree). */
  readonly changed: ReadonlySet<string>;
  /** Broker version to the pinned base-image digest (testing/broker-lab/versions.json). */
  readonly pins: ReadonlyMap<string, string>;
  /** The semantics era of a broker version; undefined when the version is not a lab version. */
  readonly eraOf: (version: string) => string | undefined;
  /** A problem with the run behind a `ci` stamp, or null when the run is a good one. */
  readonly verifyRun: (provenance: CiProvenance) => Promise<string | null>;
  /** Check the run of every artefact, not only the ones the change touches. */
  readonly verifyAllRuns?: boolean;
}

interface Problem {
  readonly rule: 'evidence-file' | 'evidence-local' | 'evidence-pin';
  readonly message: string;
}

interface Checked {
  readonly evidence: Evidence | null;
  readonly problems: Problem[];
}

function checkArtefact(
  path: string,
  text: string | null,
  pins: ReadonlyMap<string, string>,
): Checked {
  const refuse = (message: string): Checked => ({
    evidence: null,
    problems: [{ rule: 'evidence-file', message }],
  });
  if (!ARTEFACT_PATH.test(path)) {
    return refuse('is not <broker-version>/<CF-id>.json');
  }
  if (text === null) {
    return refuse('is not a plain readable file (a link, or too large)');
  }
  let evidence: Evidence;
  try {
    evidence = parseEvidence(path, text);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
  const problems: Problem[] = [];
  if (evidence.provenance.kind !== 'ci') {
    problems.push({
      rule: 'evidence-local',
      message: 'was not recorded by the CI workflow (provenance is local)',
    });
  }
  const pin = pins.get(evidence.brokerVersion);
  if (pin === undefined) {
    problems.push({
      rule: 'evidence-pin',
      message: `${evidence.brokerVersion} is not a broker-lab version`,
    });
  } else if (pin !== evidence.imageDigest) {
    problems.push({
      rule: 'evidence-pin',
      message: `was recorded on ${evidence.imageDigest}, not the pinned ${pin}`,
    });
  }
  return { evidence, problems };
}

export async function checkEvidence(input: CheckInput): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (
    rule: Finding['rule'],
    subject: string,
    message: string,
  ): void => {
    findings.push({ rule, subject, message });
  };

  const artefacts = new Map<string, Checked>();
  for (const [path, text] of input.tree) {
    if (OTHER_FILES.has(path)) continue;
    const checked = checkArtefact(path, text, input.pins);
    artefacts.set(path, checked);
    for (const problem of checked.problems) {
      add(problem.rule, `${EVIDENCE_PREFIX}${path}`, problem.message);
    }
  }

  const baseByKey = new Map(input.base.map((cell) => [cell.keyString, cell]));
  const needRun = new Set<string>(
    input.verifyAllRuns === true ? artefacts.keys() : input.changed,
  );

  for (const cell of input.head) {
    const problems: string[] = [];
    for (const path of cell.evidence) {
      const relative = below(path);
      const checked =
        relative === undefined ? undefined : artefacts.get(relative);
      if (relative === undefined) {
        problems.push(`${path} is not below ${EVIDENCE_PREFIX}`);
      } else if (checked === undefined) {
        problems.push(`${path} does not exist`);
      } else if (checked.evidence === null || checked.problems.length > 0) {
        const why = checked.problems.map((problem) => problem.message);
        problems.push(`${path} is not valid evidence (${why.join('; ')})`);
      } else {
        const { cfId, brokerVersion } = checked.evidence;
        if (!cell.conformance.includes(cfId)) {
          problems.push(
            `${path} is evidence of ${cfId}, which the cell does not name`,
          );
        }
        const era = input.eraOf(brokerVersion);
        if (era !== cell.era) {
          problems.push(
            `${path} was recorded on ${brokerVersion} (era ${era ?? 'unknown'}), the cell is for ${cell.era}`,
          );
        }
      }
    }
    for (const problem of problems) add('cell-evidence', cell.id, problem);
    if (cell.conformance.length === 0) {
      add('cell-conformance', cell.id, 'names no conformance id');
    }
    if (cell.status !== 'code-derived' && cell.evidence.length === 0) {
      add('status-evidence', cell.id, `is ${cell.status} without lab evidence`);
    }
    const supported = cell.evidence.length > 0 && problems.length === 0;

    const before = baseByKey.get(cell.keyString);
    let touched = before === undefined;
    if (before !== undefined && before.status !== cell.status) {
      touched = true;
      if (!supported) {
        add(
          'status-change',
          cell.id,
          `status changed from ${before.status} to ${cell.status} without a valid evidence artefact`,
        );
      }
    }
    if (before !== undefined && effectKey(before) !== effectKey(cell)) {
      touched = true;
      const deriving =
        before.effect === null &&
        before.status === 'code-derived' &&
        cell.status === 'code-derived' &&
        cell.evidence.length === 0;
      if (!supported && !deriving) {
        add(
          'effect-change',
          cell.id,
          'effect changed without a valid evidence artefact',
        );
      }
    }
    if (touched) {
      for (const path of cell.evidence) {
        const relative = below(path);
        if (relative !== undefined) needRun.add(relative);
      }
    }
  }

  const runs = new Map<string, string | null>();
  for (const path of [...needRun].sort()) {
    const provenance = artefacts.get(path)?.evidence?.provenance;
    if (provenance?.kind !== 'ci') continue;
    const key = `${provenance.runUrl}|${provenance.gitSha}|${provenance.workflow}|${provenance.recordedAt}`;
    if (!runs.has(key)) {
      runs.set(
        key,
        await input
          .verifyRun(provenance)
          .catch(
            (error: unknown) =>
              `the run could not be checked: ${error instanceof Error ? error.message : String(error)}`,
          ),
      );
    }
    const problem = runs.get(key);
    if (problem !== null && problem !== undefined) {
      add('evidence-run', `${EVIDENCE_PREFIX}${path}`, problem);
    }
  }
  return findings;
}
