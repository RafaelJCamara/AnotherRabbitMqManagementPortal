// The plan of the `conformance-pr` workflow (M0-42, invariant I-14): does this change need the
// conformance matrix, and which (broker version, shard) pairs does it run? Pure, so the unit tests
// pin it; `plan-cli.ts` gathers the inputs from git and Nx.
//
// Fail closed: when the base is unreachable, the affected query failed or the changed files are
// unknown, the matrix runs. The matrix is never skipped on doubt.
import { EXACT_VERSION } from './lab-versions.ts';

/** The Nx projects whose change can change what the conformance matrix shows. */
export const CONFORMANCE_PROJECTS: readonly string[] = [
  'semantics',
  'conformance',
  'adapter-amqp091',
  'adapter-mgmt-http',
  'broker-lab',
  'testkit',
];

/**
 * Files outside those projects that also decide the matrix: the conformance workflows (the
 * recorder too), the shared `setup` action they all use, this project (it plans and judges the
 * run) and the recorded evidence.
 */
export const WATCHED_PATHS: readonly string[] = [
  '.github/workflows/conformance-',
  '.github/actions/setup/',
  'tools/conformance-ci/',
  'testing/lab-evidence/',
];

export interface PlanInput {
  /** `nx show projects --affected` output, or null when it could not be computed. */
  readonly affectedProjects: readonly string[] | null;
  /** Files changed against the base, or null when unknown. */
  readonly changedFiles: readonly string[] | null;
  /** Versions pinned in testing/broker-lab/versions.json. */
  readonly versions: readonly string[];
  readonly shards: number;
}

export interface MatrixEntry {
  readonly version: string;
  /** 'i/n', the form `conformance:test --shard` takes. */
  readonly shard: string;
}

export interface Plan {
  readonly affected: boolean;
  readonly reasons: readonly string[];
  readonly matrix: { readonly include: readonly MatrixEntry[] };
}

const MAX_FILE_REASONS = 5;

/**
 * A file name as it may appear in a reason, which `plan-cli.ts` prints to the job log and writes to
 * the step summary. A name is repository content (a pull request can choose it), and git allows a
 * newline in one, so a name could start a new log line (`::error::...`, a workflow command) or move
 * the text with a control or direction character. Control, format and line-separator characters
 * become `?`; the name is otherwise kept.
 */
export const printableName = (file: string): string =>
  file.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?');

export function planConformance(input: PlanInput): Plan {
  const { affectedProjects, changedFiles, versions, shards } = input;
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(
      `shards must be a whole number of at least 1, not ${String(shards)}`,
    );
  }
  if (versions.length === 0)
    throw new Error('no lab broker version to plan over');
  for (const version of versions) {
    if (!EXACT_VERSION.test(version)) {
      throw new Error(`"${version}" is not an exact broker version`);
    }
  }

  const reasons: string[] = [];
  if (affectedProjects === null) {
    reasons.push(
      'the affected projects could not be computed (the base is missing or unreachable, or Nx failed); the matrix runs',
    );
  }
  if (changedFiles === null) {
    reasons.push(
      'the changed files are unknown (the base is missing or unreachable); the matrix runs',
    );
  }
  for (const project of CONFORMANCE_PROJECTS) {
    if (affectedProjects?.includes(project) === true) {
      reasons.push(`project ${project} is affected`);
    }
  }
  const watched = (changedFiles ?? []).filter((file) =>
    WATCHED_PATHS.some((prefix) => file.startsWith(prefix)),
  );
  for (const file of watched.slice(0, MAX_FILE_REASONS)) {
    reasons.push(`${printableName(file)} changed`);
  }
  if (watched.length > MAX_FILE_REASONS) {
    reasons.push(
      `and ${String(watched.length - MAX_FILE_REASONS)} more watched file(s) changed`,
    );
  }

  if (reasons.length === 0) {
    return {
      affected: false,
      reasons: [
        'not affected: no conformance project, workflow, setup action or evidence file changed',
      ],
      matrix: { include: [] },
    };
  }
  const include: MatrixEntry[] = [];
  for (const version of versions) {
    for (let shard = 1; shard <= shards; shard += 1) {
      include.push({ version, shard: `${String(shard)}/${String(shards)}` });
    }
  }
  return { affected: true, reasons, matrix: { include } };
}
