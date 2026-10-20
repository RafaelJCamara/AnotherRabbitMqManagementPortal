// Hardening check for the conformance CI workflows (M0-42, invariant I-14, amendments A-20, A-23).
// These workflows RUN the conformance harness; only `conformance-record.yml` records evidence
// (see workflow-hardening.ts). So two things are pinned here:
//
//   1. `wf.*` rules, for every conformance CI workflow: it cannot record or write evidence, cannot
//      write to the repository, holds no secret and no write token, runs no expression in shell
//      code, uses only known expression sources, pins every action by SHA, and cannot hide a
//      failure (`continue-on-error` only where a workflow's config allows it).
//   2. `pr.*` rules, for `conformance-pr.yml`: it keeps the shape of the required check
//      `conformance` (always reports, needs plan and lab, the matrix is the plan's, no Node
//      override, no fail-fast).
//
// Pure functions over file text, so the self-test (conformance-workflows-selftest.ts) can plant
// violations. The generic pin rules come from actions-pinned.ts.
import { parse } from 'yaml';
import { checkActionsPinned } from './actions-pinned.ts';
import type { WorkflowFile } from './actions-pinned.ts';
import { asRecord } from './shared.ts';

export const PR_WORKFLOW_PATH = '.github/workflows/conformance-pr.yml';

/**
 * The conformance CI workflows that must stay read-only, with the triggers each may have.
 * Slice B adds conformance-nightly.yml, slice C mutation-nightly.yml.
 */
export interface WorkflowConfig {
  readonly path: string;
  readonly triggers: readonly string[];
  /** Jobs that may set `continue-on-error: true` (a job, never a step). */
  readonly continueOnErrorJobs: readonly string[];
}

export const PR_CONFIG: WorkflowConfig = {
  path: PR_WORKFLOW_PATH,
  triggers: ['pull_request', 'push', 'workflow_dispatch'],
  continueOnErrorJobs: [],
};

export const CONFORMANCE_WORKFLOWS: readonly WorkflowConfig[] = [PR_CONFIG];

export const WORKFLOW_RULES = [
  'wf.parse',
  'wf.triggers',
  'wf.permissions',
  'wf.job-shape',
  'wf.secrets',
  'wf.recorder',
  'wf.write',
  'wf.continue-on-error',
  'wf.expression-in-run',
  'wf.expression-source',
  'wf.checkout',
  'wf.github-script',
  'wf.pinned',
] as const;

export const PR_RULES = [
  'pr.triggers',
  'pr.jobs',
  'pr.check-name',
  'pr.check-always',
  'pr.check-needs',
  'pr.check-command',
  'pr.lab-shape',
  'pr.matrix',
  'pr.fail-fast',
  'pr.node-override',
  'pr.lab-command',
  'pr.plan-command',
] as const;

export interface ConformanceViolation {
  rule: string;
  message: string;
}

type Dict = Record<string, unknown>;

const FUNCTIONS = new Set([
  'fromJSON',
  'toJSON',
  'always',
  'success',
  'failure',
  'cancelled',
  'format',
  'contains',
  'join',
]);
const KEYWORDS = new Set(['true', 'false', 'null']);
/** Expression sources a conformance workflow may read: its own jobs, the matrix and a few event facts. */
const ALLOWED_PATHS = new Set([
  'github.sha',
  'github.ref',
  'github.event_name',
  'github.event.before',
  'github.event.pull_request.number',
  'github.event.pull_request.base.sha',
  'job.status',
]);
const ALLOWED_PREFIXES = ['matrix.', 'needs.', 'steps.'];

const normal = (text: string): string => text.replace(/\s+/g, ' ').trim();

const stripExpression = (text: string): string =>
  normal(text.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1'));

const steps = (job: Dict): Dict[] =>
  Array.isArray(job.steps) ? job.steps.map(asRecord) : [];

const runOf = (step: Dict): string =>
  typeof step.run === 'string' ? step.run : '';

const usesOf = (step: Dict): string =>
  typeof step.uses === 'string' ? step.uses : '';

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length &&
  [...a].sort().join('\n') === [...b].sort().join('\n');

/** Every string of the document with the path it sits at; keys are visited too (`keys: true`). */
function walk(
  value: unknown,
  path: string[],
  visit: (path: string[], text: string, isKey: boolean) => void,
): void {
  if (typeof value === 'string') visit(path, value, false);
  else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, [...path, String(index)], visit);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      visit([...path, key], key, true);
      walk(item, [...path, key], visit);
    }
  }
}

/** The bodies of the `${{ ... }}` expressions of a string. */
function expressionsOf(text: string): string[] {
  return [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1] ?? '');
}

/** The sources an expression reads that a conformance workflow may not (empty when it is fine). */
function forbiddenSources(expression: string): string[] {
  const withoutLiterals = expression.replace(/'[^']*'/g, "''");
  const bad: string[] = [];
  for (const match of withoutLiterals.matchAll(/[A-Za-z_][\w.-]*(\()?/g)) {
    const token = match[0].replace(/\($/, '');
    const isCall = match[1] === '(';
    if (isCall) {
      if (!FUNCTIONS.has(token)) bad.push(`${token}()`);
    } else if (
      !KEYWORDS.has(token) &&
      !ALLOWED_PATHS.has(token) &&
      !ALLOWED_PREFIXES.some((prefix) => token.startsWith(prefix))
    ) {
      bad.push(token);
    }
  }
  return bad;
}

function parseDocument(file: WorkflowFile): Dict | ConformanceViolation {
  try {
    return asRecord(parse(file.text));
  } catch (error) {
    return {
      rule: 'wf.parse',
      message: `YAML does not parse: ${String(error)}`,
    };
  }
}

const isViolation = (
  value: Dict | ConformanceViolation,
): value is ConformanceViolation =>
  typeof value.rule === 'string' && typeof value.message === 'string';

/** The rules every conformance CI workflow keeps. */
export function checkWorkflow(
  file: WorkflowFile,
  config: WorkflowConfig,
): ConformanceViolation[] {
  const doc = parseDocument(file);
  if (isViolation(doc)) return [doc];
  const out: ConformanceViolation[] = [];
  const fail = (
    rule: (typeof WORKFLOW_RULES)[number],
    message: string,
  ): void => {
    out.push({ rule, message });
  };
  const jobs = asRecord(doc.jobs);

  // Triggers.
  const triggers = Object.keys(asRecord(doc.on));
  if (!sameSet(triggers, config.triggers)) {
    fail(
      'wf.triggers',
      `the workflow may only run on ${config.triggers.join(', ')}, not ${triggers.join(', ') || 'nothing'}`,
    );
  }

  // Permissions: nothing at the top, at most contents: read per job.
  const top = doc.permissions;
  if (
    typeof top !== 'object' ||
    top === null ||
    Object.keys(top).length !== 0
  ) {
    fail('wf.permissions', 'the workflow must start with `permissions: {}`');
  }
  for (const [name, raw] of Object.entries(jobs)) {
    const job = asRecord(raw);
    if ('permissions' in job) {
      const allowed = [{}, { contents: 'read' }].map((p) => JSON.stringify(p));
      if (!allowed.includes(JSON.stringify(job.permissions))) {
        fail(
          'wf.permissions',
          `job ${name} may have at most \`contents: read\``,
        );
      }
    }
    if (job['runs-on'] !== 'ubuntu-24.04') {
      fail(
        'wf.job-shape',
        `job ${name} must run on ubuntu-24.04 (a pinned runner image)`,
      );
    }
    if (typeof job['timeout-minutes'] !== 'number') {
      fail('wf.job-shape', `job ${name} needs timeout-minutes`);
    }
    if ('secrets' in job || 'uses' in job) {
      fail(
        'wf.secrets',
        `job ${name} calls a reusable workflow or passes secrets`,
      );
    }
  }

  // Strings: secrets, tokens, evidence, expressions.
  walk(doc, [], (path, text, isKey) => {
    const where = path.join('.');
    if (
      /\bsecrets\b|\bgithub\.token\b|\bGITHUB_TOKEN\b|\bGH_TOKEN\b|\bGH_ENTERPRISE_TOKEN\b/.test(
        text,
      )
    ) {
      fail(
        'wf.secrets',
        `${where} reaches a secret or a token; the workflow holds none`,
      );
    }
    if (
      /conformance:record|conformance-record|lab-evidence|record\/bundle-cli|record\/cli\.ts|run-record/.test(
        text,
      )
    ) {
      fail(
        'wf.recorder',
        `${where} names the recorder or the evidence tree; only conformance-record.yml records evidence`,
      );
    }
    if (isKey || !text.includes('${{')) return;
    if (path.at(-1) === 'run') {
      fail(
        'wf.expression-in-run',
        `${where} interpolates an expression into shell code; pass it as an environment variable`,
      );
      return;
    }
    for (const expression of expressionsOf(text)) {
      const bad = forbiddenSources(expression);
      if (bad.length > 0) {
        fail(
          'wf.expression-source',
          `${where} reads ${bad.join(', ')}; only the matrix, needs, steps, job.status and a few event facts are allowed`,
        );
      }
    }
  });

  // Steps: nothing that writes, no github-script, checkouts with no extras.
  for (const [name, raw] of Object.entries(jobs)) {
    const job = asRecord(raw);
    for (const step of steps(job)) {
      if (
        /\bgit\s+(push|commit|add|tag|merge|rebase|config|am|apply|reset|checkout\s+-b|switch\s+-c)\b|\bgh\s|\bcurl\b|\bwget\b|--force\b|\bsudo\b/.test(
          runOf(step),
        )
      ) {
        fail(
          'wf.write',
          `job ${name} runs a command that writes to the repository, calls the GitHub API or fetches code`,
        );
      }
      if (usesOf(step).startsWith('actions/github-script@')) {
        fail(
          'wf.github-script',
          `job ${name} uses actions/github-script (its script is an injection sink)`,
        );
      }
      if (usesOf(step).startsWith('actions/checkout@')) {
        const keys = Object.keys(asRecord(step.with));
        if (
          keys.some(
            (key) => !['persist-credentials', 'fetch-depth'].includes(key),
          )
        ) {
          fail(
            'wf.checkout',
            `job ${name}: checkout may only set persist-credentials and fetch-depth, not ${keys.join(', ')}`,
          );
        }
      }
      if ('continue-on-error' in step) {
        fail(
          'wf.continue-on-error',
          `job ${name}: a step hides its failure with continue-on-error`,
        );
      }
    }
    if ('continue-on-error' in job) {
      const allowed =
        config.continueOnErrorJobs.includes(name) &&
        job['continue-on-error'] === true;
      if (!allowed) {
        fail(
          'wf.continue-on-error',
          `job ${name} may not set continue-on-error`,
        );
      }
    }
  }

  for (const violation of checkActionsPinned([file])) {
    fail('wf.pinned', `${violation.rule}: ${violation.message}`);
  }
  return out;
}

/** The shape of the required check in conformance-pr.yml. */
export function checkPrWorkflow(file: WorkflowFile): ConformanceViolation[] {
  const doc = parseDocument(file);
  if (isViolation(doc)) return [doc];
  const out: ConformanceViolation[] = [];
  const fail = (rule: (typeof PR_RULES)[number], message: string): void => {
    out.push({ rule, message });
  };

  const on = asRecord(doc.on);
  const pushBranches = asRecord(on.push).branches;
  if (
    !Array.isArray(pushBranches) ||
    pushBranches.length !== 1 ||
    pushBranches[0] !== 'main'
  ) {
    fail(
      'pr.triggers',
      'the push trigger must be limited to `branches: [main]`',
    );
  }

  const jobs = asRecord(doc.jobs);
  if (!sameSet(Object.keys(jobs), ['plan', 'lab', 'conformance'])) {
    fail(
      'pr.jobs',
      `the jobs must be plan, lab and conformance, not ${Object.keys(jobs).join(', ')}`,
    );
  }
  const plan = asRecord(jobs.plan);
  const lab = asRecord(jobs.lab);
  const check = asRecord(jobs.conformance);

  // The required check: its name, `if: always()`, its needs, and what it runs.
  if (check.name !== 'conformance') {
    fail(
      'pr.check-name',
      'the job `conformance` must be named exactly `conformance` (the required check)',
    );
  }
  if (
    stripExpression(typeof check.if === 'string' ? check.if : '') !== 'always()'
  ) {
    fail(
      'pr.check-always',
      'the conformance job must run `if: always()`, so it reports even when a job failed or was skipped',
    );
  }
  const needs = Array.isArray(check.needs) ? check.needs : [check.needs];
  if (
    !sameSet(
      needs.filter((n): n is string => typeof n === 'string'),
      ['plan', 'lab'],
    )
  ) {
    fail('pr.check-needs', 'the conformance job must need plan and lab');
  }
  const checkRuns = steps(check)
    .map(runOf)
    .filter((run) => run !== '');
  const checkEnv = steps(check).map((step) => asRecord(step.env));
  const verdictEnv = checkEnv.find((env) => 'PLAN_RESULT' in env) ?? {};
  if (
    checkRuns.length !== 1 ||
    normal(checkRuns[0] ?? '') !==
      'node tools/conformance-ci/src/verdict-cli.ts' ||
    steps(check).some((step) =>
      /^(\.\/\.github\/actions\/setup|pnpm\/)/.test(usesOf(step)),
    ) ||
    stripExpression(String(verdictEnv.AFFECTED)) !==
      'needs.plan.outputs.affected' ||
    stripExpression(String(verdictEnv.PLAN_RESULT)) !== 'needs.plan.result' ||
    stripExpression(String(verdictEnv.LAB_RESULT)) !== 'needs.lab.result'
  ) {
    fail(
      'pr.check-command',
      'the conformance job installs nothing and runs only `node tools/conformance-ci/src/verdict-cli.ts` with AFFECTED, PLAN_RESULT and LAB_RESULT from the plan and lab jobs',
    );
  }

  // The lab job: only when affected, the plan's matrix, no fail-fast, the pinned Node.
  if (
    lab.needs !== 'plan' ||
    stripExpression(typeof lab.if === 'string' ? lab.if : '') !==
      "needs.plan.outputs.affected == 'true'"
  ) {
    fail(
      'pr.lab-shape',
      "the lab job must need plan and run only `if: needs.plan.outputs.affected == 'true'`",
    );
  }
  const strategy = asRecord(lab.strategy);
  if (
    typeof strategy.matrix !== 'string' ||
    stripExpression(strategy.matrix) !== 'fromJSON(needs.plan.outputs.matrix)'
  ) {
    fail(
      'pr.matrix',
      'the lab matrix must be exactly `${{ fromJSON(needs.plan.outputs.matrix) }}`, never a literal list of versions',
    );
  }
  if (strategy['fail-fast'] !== false) {
    fail(
      'pr.fail-fast',
      'the lab matrix must set `fail-fast: false`, so every version reports',
    );
  }
  const labSteps = steps(lab);
  const setupSteps = labSteps.filter(
    (step) => usesOf(step) === './.github/actions/setup',
  );
  if (
    setupSteps.length !== 1 ||
    setupSteps.some((step) => step.with !== undefined) ||
    labSteps.some((step) => usesOf(step).startsWith('actions/setup-node@')) ||
    labSteps.some((step) => 'node-version' in asRecord(step.with))
  ) {
    fail(
      'pr.node-override',
      'the lab job must use the setup action as it is, with no Node override: Node comes from .nvmrc',
    );
  }
  const labRuns = labSteps.filter((step) => runOf(step) !== '');
  const command = labRuns.at(-1);
  const labEnv = asRecord(command?.env);
  if (
    labRuns.length !== 1 ||
    normal(runOf(command ?? {})) !==
      'pnpm nx run conformance:test --versions="$VERSION" --shard="$SHARD"' ||
    stripExpression(String(labEnv.VERSION)) !== 'matrix.version' ||
    stripExpression(String(labEnv.SHARD)) !== 'matrix.shard'
  ) {
    fail(
      'pr.lab-command',
      'the lab job must run only `pnpm nx run conformance:test --versions="$VERSION" --shard="$SHARD"`, with VERSION and SHARD from the matrix',
    );
  }

  // The plan job: the plan CLI, and the two outputs the other jobs read.
  const planRuns = steps(plan)
    .map(runOf)
    .filter((run) => run !== '');
  const planOutputs = Object.keys(asRecord(plan.outputs));
  if (
    planRuns.length !== 1 ||
    normal(planRuns[0] ?? '') !== 'node tools/conformance-ci/src/plan-cli.ts' ||
    !sameSet(planOutputs, ['affected', 'matrix'])
  ) {
    fail(
      'pr.plan-command',
      'the plan job must run `node tools/conformance-ci/src/plan-cli.ts` and expose the outputs affected and matrix',
    );
  }
  return out;
}

/** Every rule that applies to conformance-pr.yml. */
export function checkPr(file: WorkflowFile): ConformanceViolation[] {
  return [...checkWorkflow(file, PR_CONFIG), ...checkPrWorkflow(file)];
}

export function formatConformanceViolations(
  violations: ConformanceViolation[],
): string {
  return violations.map((v) => `  [${v.rule}] ${v.message}`).join('\n');
}
