// The checks around the evidence bundle of one `conformance-record` run (M0-71, amendment A-20).
//
// The workflow records into a bundle folder (`<broker-version>/<CF-id>.json`), checks it here, and
// only then does a second job (the only one with a write token) copy it into a branch and open the
// bot pull request. That second job has no `node_modules`, so this file imports nothing but Node
// built-ins: `bundle-cli.ts` runs it straight from the checkout. The full integrity check (zod and
// the SHA-256 over each artefact) is handed in as `verifyText` by the job that has the install.
//
// What this adds to the recorder's own guards: the bundle holds exactly the layout it should, every
// artefact carries a `ci` stamp for THIS run (commit, run URL, workflow file on the default branch),
// every image digest is the pin of `testing/broker-lab/versions.json`, and every requested cell
// was recorded on every requested version. The stamp still comes from the environment, so none of
// this stops a hostile recorder; the control for that is the human approval of the bot pull request
// (OQ-422).
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RECORD_WORKFLOW_FILE = 'conformance-record.yml';
export const MAX_ARTEFACTS = 100;
export const MAX_ARTEFACT_BYTES = 1024 * 1024;
const MAX_CELLS = 20;
const MAX_VERSIONS = 8;
const MAX_PROBLEMS = 50;

const CELL_PATTERN = /^CF-[A-Z0-9*-]+$/;
const CF_ID = /^CF-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const BROKER_VERSION = /^\d+\.\d+\.\d+$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

export interface RecordInputs {
  readonly cells: readonly string[];
  readonly versions: readonly string[];
}

/** Validates the two manual inputs of the workflow; anything unusual is an error, nothing is repaired. */
export function parseRecordInputs(
  cells: string | undefined,
  versions: string | undefined,
): RecordInputs {
  const split = (name: string, text: string | undefined, max: number) => {
    if (text === undefined || text === '') {
      throw new BundleError(`${name} is empty`);
    }
    const items = text.split(',');
    if (items.length > max) {
      throw new BundleError(`${name} names more than ${String(max)} entries`);
    }
    return items;
  };
  const cellList = split('cells', cells, MAX_CELLS);
  for (const cell of cellList) {
    if (!CELL_PATTERN.test(cell)) {
      throw new BundleError(
        `cells: "${cell}" is not a conformance id or a pattern such as CF-SETTLE-* (comma separated, no spaces)`,
      );
    }
  }
  const versionList = split('versions', versions, MAX_VERSIONS);
  for (const version of versionList) {
    if (!BROKER_VERSION.test(version)) {
      throw new BundleError(
        `versions: "${version}" is not a RabbitMQ version such as 4.3.6 (comma separated, no spaces)`,
      );
    }
  }
  return {
    cells: [...new Set(cellList)],
    versions: [...new Set(versionList)],
  };
}

/** What every artefact of this run must say about itself. */
export interface RunExpectation extends RecordInputs {
  readonly gitSha: string;
  readonly runUrl: string;
  readonly workflowRef: string;
  /** The image digest each broker version is pinned to (testing/broker-lab/versions.json). */
  readonly pins: Readonly<Record<string, string>>;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string, pattern: RegExp): string {
  const value = env[name];
  if (value === undefined || !pattern.test(value)) {
    throw new BundleError(`${name} is missing or malformed`);
  }
  return value;
}

/**
 * The stamp this run must have made, built from the variables GitHub sets for the job (and
 * `DEFAULT_BRANCH`, `github.event.repository.default_branch`). It mirrors `provenanceFromEnv`, and
 * is stricter: the workflow must be this repository's own file on its default branch.
 */
export function expectationFromEnv(
  env: Env,
  inputs: RecordInputs,
  pins: Readonly<Record<string, string>>,
): RunExpectation {
  if (env.GITHUB_ACTIONS !== 'true') {
    throw new BundleError('this check runs only inside GitHub Actions');
  }
  const server = required(env, 'GITHUB_SERVER_URL', /^https:\/\/[^/\s@]+$/);
  const repository = required(env, 'GITHUB_REPOSITORY', /^[^/\s@]+\/[^/\s@]+$/);
  const runId = required(env, 'GITHUB_RUN_ID', /^\d+$/);
  const attempt = required(env, 'GITHUB_RUN_ATTEMPT', /^\d+$/);
  const branch = required(env, 'DEFAULT_BRANCH', BRANCH);
  const workflowRef = required(env, 'GITHUB_WORKFLOW_REF', /^\S+$/);
  const expectedRef = `${repository}/.github/workflows/${RECORD_WORKFLOW_FILE}@refs/heads/${branch}`;
  if (workflowRef !== expectedRef) {
    throw new BundleError(
      `GITHUB_WORKFLOW_REF is ${workflowRef}, not ${expectedRef}: evidence is recorded only by this workflow on the default branch`,
    );
  }
  return {
    ...inputs,
    gitSha: required(env, 'GITHUB_SHA', GIT_SHA),
    runUrl: `${server}/${repository}/actions/runs/${runId}/attempts/${attempt}`,
    workflowRef,
    pins,
  };
}

export interface BundleFile {
  readonly path: string;
  readonly cfId: string;
  readonly brokerVersion: string;
  readonly imageDigest: string;
  readonly integrityDigest: string;
}

export interface BundleReport {
  readonly problems: readonly string[];
  readonly files: readonly BundleFile[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const patternExpression = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').join('[A-Z0-9-]*')}$`);

export interface CheckOptions {
  /** Full verification of one file (schema and integrity digest); throws to refuse it. */
  readonly verifyText?: (relativePath: string, text: string) => void;
}

/** Checks the bundle folder against the run's expectation. Never throws for a bad bundle. */
export function checkBundle(
  root: string,
  expected: RunExpectation,
  options: CheckOptions = {},
): BundleReport {
  const problems: string[] = [];
  const files: BundleFile[] = [];
  const complain = (message: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
  };
  const expressions = expected.cells.map((cell) => ({
    cell,
    expression: patternExpression(cell),
  }));

  let entries: string[];
  try {
    if (!lstatSync(root).isDirectory()) throw new Error('not a folder');
    entries = readdirSync(root).sort();
  } catch {
    return { problems: ['the bundle folder does not exist'], files };
  }

  const seen = new Map<string, Set<string>>();
  for (const version of entries) {
    const folder = join(root, version);
    if (!lstatSync(folder).isDirectory()) {
      complain(`${version} is not a folder`);
      continue;
    }
    if (!BROKER_VERSION.test(version) || !expected.versions.includes(version)) {
      complain(`${version}/ is not a requested broker version`);
      continue;
    }
    const recorded = new Set<string>();
    seen.set(version, recorded);
    for (const name of readdirSync(folder).sort()) {
      const relative = `${version}/${name}`;
      const path = join(folder, name);
      const stat = lstatSync(path);
      const cfId = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!stat.isFile()) {
        complain(`${relative} is not a regular file`);
        continue;
      }
      if (!CF_ID.test(cfId)) {
        complain(`${relative} is not named <CF-id>.json`);
        continue;
      }
      if (files.length >= MAX_ARTEFACTS) {
        complain(`more than ${String(MAX_ARTEFACTS)} artefacts`);
        break;
      }
      if (stat.size > MAX_ARTEFACT_BYTES) {
        complain(
          `${relative} is larger than ${String(MAX_ARTEFACT_BYTES)} bytes`,
        );
        continue;
      }
      if (!expressions.some(({ expression }) => expression.test(cfId))) {
        complain(`${relative} is not one of the requested cells`);
        continue;
      }
      const text = readFileSync(path, 'utf8');
      const found = checkArtefact(relative, text, version, cfId, expected);
      for (const message of found.problems) complain(message);
      if (options.verifyText !== undefined) {
        try {
          options.verifyText(relative, text);
        } catch (error) {
          complain(
            `${relative} does not verify: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      recorded.add(cfId);
      if (found.file !== undefined && found.problems.length === 0) {
        files.push(found.file);
      }
    }
  }

  for (const version of expected.versions) {
    for (const { cell, expression } of expressions) {
      const recorded = [...(seen.get(version) ?? [])];
      if (!recorded.some((cfId) => expression.test(cfId))) {
        complain(`${cell} has no artefact for ${version}`);
      }
    }
  }
  return { problems, files: problems.length === 0 ? files : [] };
}

function checkArtefact(
  relative: string,
  text: string,
  version: string,
  cfId: string,
  expected: RunExpectation,
): { problems: string[]; file?: BundleFile } {
  const problems: string[] = [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problems: [`${relative} is not valid JSON`] };
  }
  if (!isRecord(value)) return { problems: [`${relative} is not an object`] };
  if (value.cfId !== cfId) {
    problems.push(`${relative} holds the evidence of another cell`);
  }
  if (value.brokerVersion !== version) {
    problems.push(`${relative} holds the evidence of another broker version`);
  }
  const imageDigest = value.imageDigest;
  if (
    typeof imageDigest !== 'string' ||
    !IMAGE_DIGEST.test(imageDigest) ||
    imageDigest !== expected.pins[version]
  ) {
    problems.push(
      `${relative} was not recorded on the digest-pinned image of ${version}`,
    );
  }
  const provenance = value.provenance;
  if (!isRecord(provenance) || provenance.kind !== 'ci') {
    problems.push(`${relative} has no CI provenance`);
  } else {
    if (provenance.gitSha !== expected.gitSha) {
      problems.push(`${relative} was recorded at another commit`);
    }
    if (provenance.runUrl !== expected.runUrl) {
      problems.push(`${relative} was recorded by another run`);
    }
    if (provenance.workflow !== expected.workflowRef) {
      problems.push(`${relative} was recorded by another workflow`);
    }
    if (provenance.recorder !== 'conformance:record') {
      problems.push(`${relative} was recorded by another recorder`);
    }
  }
  const integrity = value.integrity;
  const digest = isRecord(integrity) ? integrity.digest : undefined;
  if (typeof digest !== 'string' || !HEX_64.test(digest)) {
    problems.push(`${relative} has no integrity digest`);
  }
  if (problems.length > 0) return { problems };
  return {
    problems,
    file: {
      path: relative,
      cfId,
      brokerVersion: version,
      imageDigest: imageDigest as string,
      integrityDigest: digest as string,
    },
  };
}

/** The description of the bot pull request: only values the checks above have pinned down. */
export function renderPrBody(
  expected: RunExpectation,
  files: readonly BundleFile[],
): string {
  const rows = files.map(
    (file) =>
      `| \`testing/lab-evidence/${file.path}\` | \`${file.imageDigest}\` | \`${file.integrityDigest}\` |`,
  );
  return [
    `Lab evidence recorded by the \`conformance-record\` workflow (amendment A-20).`,
    '',
    `- Run: ${expected.runUrl}`,
    `- Commit: \`${expected.gitSha}\``,
    `- Cells: \`${expected.cells.join(', ')}\``,
    `- Broker versions: \`${expected.versions.join(', ')}\``,
    '',
    '| Artefact | Image digest (pinned in `testing/broker-lab/versions.json`) | Integrity digest |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'Nothing here is merged or approved automatically. A maintainer reviews the files and follows the run URL to the run that recorded them before approving (CODEOWNERS, invariant I-14). Changing a registry cell status from this evidence is a separate, human-reviewed change.',
    '',
  ].join('\n');
}
