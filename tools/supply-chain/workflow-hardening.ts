// Hardening check for the one workflow that records lab evidence (M0-71, amendment A-20, I-14).
// `.github/workflows/conformance-record.yml` is the only place evidence is recorded; its stamp
// (`provenance.kind: ci`) is believed because of what this file pins down: manual trigger on the
// default branch only, validated inputs that reach shell code only as environment variables, a
// read-only job that runs the brokers, a separate write job that installs nothing and holds the
// token in its last step only, and no way to merge, approve or push to the default branch.
//
// Pure functions over file text, so the self-test can plant violations (see
// workflow-hardening-selftest.ts). The generic pin rules (SHA pins, persist-credentials) come from
// actions-pinned.ts; zizmor and the pin gate run on every workflow in CI as well.
import { parse } from 'yaml';
import { checkActionsPinned } from './actions-pinned.ts';
import type { WorkflowFile } from './actions-pinned.ts';
import { asRecord } from './shared.ts';

export const RECORD_WORKFLOW_PATH = '.github/workflows/conformance-record.yml';

export const HARDENING_RULES = [
  'record.triggers',
  'record.inputs',
  'record.permissions',
  'record.concurrency',
  'record.job-shape',
  'record.env',
  'record.expression-placement',
  'record.expression-in-run',
  'record.expression-source',
  'record.default-branch',
  'record.token',
  'record.checkout',
  'record.steps',
  'record.recorder-command',
  'record.bundle-check',
  'record.write-job',
  'record.pr-step',
  'record.no-merge',
  'record.artifact',
  'record.pinned',
] as const;

export interface HardeningViolation {
  rule: string;
  message: string;
}

type Dict = Record<string, unknown>;

const BUNDLE = 'dist/lab-evidence-bundle';
const CLI = 'node apps/conformance/src/record/bundle-cli.ts';
const DEFAULT_BRANCH_IF =
  "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";

/** The expressions the workflow may use, by the environment variable they feed. */
const ENV_EXPRESSIONS: Readonly<Record<string, string>> = {
  CELLS: 'inputs.cells',
  VERSIONS: 'inputs.versions',
  DEFAULT_BRANCH: 'github.event.repository.default_branch',
  BASE_BRANCH: 'github.event.repository.default_branch',
  GH_TOKEN: 'github.token',
  GH_REPO: 'github.repository',
};

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const normal = (text: string): string => text.replace(/\s+/g, ' ').trim();

const stripExpression = (text: string): string =>
  normal(text.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1'));

const steps = (job: Dict): Dict[] =>
  Array.isArray(job.steps) ? job.steps.map(asRecord) : [];

const runOf = (step: Dict): string =>
  typeof step.run === 'string' ? step.run : '';

const usesOf = (step: Dict): string =>
  typeof step.uses === 'string' ? step.uses : '';

/** Every string of the document with the path it sits at (`jobs.record.steps.3.run`). */
function walk(
  value: unknown,
  path: string[],
  visit: (path: string[], text: string) => void,
): void {
  if (typeof value === 'string') visit(path, value);
  else if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, [...path, String(index)], visit);
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value))
      walk(item, [...path, key], visit);
  }
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length &&
  [...a].sort().join('\n') === [...b].sort().join('\n');

export function checkRecordWorkflow(file: WorkflowFile): HardeningViolation[] {
  const out: HardeningViolation[] = [];
  const fail = (
    rule: (typeof HARDENING_RULES)[number],
    message: string,
  ): void => {
    out.push({ rule, message });
  };
  let doc: Dict;
  try {
    doc = asRecord(parse(file.text));
  } catch (error) {
    return [
      {
        rule: 'record.triggers',
        message: `YAML does not parse: ${String(error)}`,
      },
    ];
  }

  // Trigger: manual only. No pull request, push, schedule, workflow_run or comment trigger.
  const triggers = asRecord(doc.on);
  if (!sameSet(Object.keys(triggers), ['workflow_dispatch'])) {
    fail(
      'record.triggers',
      `the workflow may only run on workflow_dispatch, not ${Object.keys(triggers).join(', ') || 'nothing'}`,
    );
  }

  // Inputs: the two lists are strings, the dry run is a boolean that defaults to true.
  const inputs = asRecord(asRecord(triggers.workflow_dispatch).inputs);
  const input = (name: string): Dict => asRecord(inputs[name]);
  if (
    !sameSet(Object.keys(inputs), ['cells', 'versions', 'dry_run']) ||
    input('cells').type !== 'string' ||
    input('cells').required !== true ||
    input('versions').type !== 'string' ||
    input('versions').required !== true ||
    input('dry_run').type !== 'boolean' ||
    input('dry_run').default !== true
  ) {
    fail(
      'record.inputs',
      'inputs must be cells and versions (required strings) and dry_run (boolean, default true)',
    );
  }

  // Permissions: none at the top, read on `record`, write only on `propose`.
  const jobs = asRecord(doc.jobs);
  const jobNames = Object.keys(jobs);
  const record = asRecord(jobs.record);
  const propose = asRecord(jobs.propose);
  if (!sameSet(jobNames, ['record', 'propose'])) {
    fail(
      'record.job-shape',
      `the jobs must be record and propose, not ${jobNames.join(', ')}`,
    );
  }
  const top = doc.permissions;
  if (
    typeof top !== 'object' ||
    top === null ||
    Object.keys(top).length !== 0
  ) {
    fail(
      'record.permissions',
      'the workflow must start with `permissions: {}`',
    );
  }
  if (
    JSON.stringify(record.permissions) !== JSON.stringify({ contents: 'read' })
  ) {
    fail('record.permissions', 'the record job may only have `contents: read`');
  }
  if (
    JSON.stringify(propose.permissions) !==
    JSON.stringify({ contents: 'write', 'pull-requests': 'write' })
  ) {
    fail(
      'record.permissions',
      'the propose job may only have `contents: write` and `pull-requests: write`',
    );
  }

  // Concurrency, runner and time limit.
  const concurrency = asRecord(doc.concurrency);
  if (
    concurrency.group !== 'conformance-record' ||
    concurrency['cancel-in-progress'] !== false
  ) {
    fail(
      'record.concurrency',
      'one run at a time, never cancelled: group conformance-record, cancel-in-progress false',
    );
  }
  for (const [name, job] of Object.entries(jobs).map(
    ([n, j]) => [n, asRecord(j)] as const,
  )) {
    if (job['runs-on'] !== 'ubuntu-24.04') {
      fail(
        'record.job-shape',
        `${name} must run on ubuntu-24.04 (a pinned runner image with a Docker daemon)`,
      );
    }
    if (typeof job['timeout-minutes'] !== 'number') {
      fail('record.job-shape', `${name} needs timeout-minutes`);
    }
  }

  // No environment at the workflow or job level: variables are set on the steps that need them.
  if (
    'env' in doc ||
    'defaults' in doc ||
    Object.values(jobs).some((job) => 'env' in asRecord(job))
  ) {
    fail(
      'record.env',
      'no env or defaults at the workflow or job level; set variables on the step',
    );
  }

  // Expressions: only in step env and in the two `if` lines, and only the known sources.
  const tokenSites: string[] = [];
  walk(doc, [], (path, text) => {
    if (!text.includes('${{')) return;
    const where = path.join('.');
    const isEnv =
      path[0] === 'jobs' && path[2] === 'steps' && path[4] === 'env';
    const isJobIf = path[0] === 'jobs' && path.length === 3 && path[2] === 'if';
    if (path.at(-1) === 'run') {
      fail(
        'record.expression-in-run',
        `${where} interpolates an expression into shell code; pass it as an environment variable`,
      );
      return;
    }
    if (!isEnv && !isJobIf) {
      fail(
        'record.expression-placement',
        `${where} uses an expression outside a step env value or a job if`,
      );
      return;
    }
    const expression = stripExpression(text);
    if (isEnv) {
      const key = path[5] ?? '';
      if (
        ENV_EXPRESSIONS[key] !== expression ||
        text.trim() !== `\${{ ${expression} }}`
      ) {
        fail(
          'record.expression-source',
          `${where} must be exactly \${{ ${ENV_EXPRESSIONS[key] ?? '<an env var of this workflow>'} }}`,
        );
      }
      if (expression === 'github.token')
        tokenSites.push(`${path[1] ?? ''}.${path[3] ?? ''}`);
    }
  });
  walk(doc, [], (path, text) => {
    if (/\bsecrets\b/.test(text) && text.includes('${{')) {
      fail(
        'record.token',
        `${path.join('.')} uses a secret; the workflow uses only the default token`,
      );
    }
  });

  // Branch guards: `record` only on the default branch; `propose` only for a live run.
  if (stripExpression(str(record.if)) !== DEFAULT_BRANCH_IF) {
    fail(
      'record.default-branch',
      'the record job must run only on the default branch',
    );
  }
  if (
    stripExpression(str(propose.if)) !== '!inputs.dry_run' ||
    str(propose.needs) !== 'record'
  ) {
    fail(
      'record.default-branch',
      'the propose job must need record and run only when dry_run is off',
    );
  }

  const recordSteps = steps(record);
  const proposeSteps = steps(propose);

  // The token: given to the last step of `propose` only, as GH_TOKEN.
  const lastPropose = proposeSteps.at(-1);
  if (
    tokenSites[0] !== `propose.${String(proposeSteps.length - 1)}` ||
    asRecord(lastPropose?.env).GH_TOKEN === undefined
  ) {
    fail(
      'record.token',
      'github.token must reach the last step of the propose job, and no other step',
    );
  }

  // Checkouts keep no credentials and take the commit of the run (no `ref`, `repository` or `token`).
  for (const step of [...recordSteps, ...proposeSteps]) {
    if (usesOf(step).startsWith('actions/checkout@')) {
      const keys = Object.keys(asRecord(step.with));
      if (!sameSet(keys, ['persist-credentials'])) {
        fail(
          'record.checkout',
          `checkout may only set persist-credentials, not ${keys.join(', ')}`,
        );
      }
    }
  }

  // Order of the record job.
  const at = (list: Dict[], matches: (step: Dict) => boolean): number =>
    list.findIndex(matches);
  const runHas =
    (text: string) =>
    (step: Dict): boolean =>
      runOf(step).includes(text);
  const recordOrder = [
    at(recordSteps, (s) => usesOf(s).startsWith('actions/checkout@')),
    at(recordSteps, (s) => usesOf(s) === './.github/actions/setup'),
    at(recordSteps, runHas(`${CLI} validate-inputs`)),
    at(recordSteps, runHas('git status --porcelain')),
    at(recordSteps, runHas('pnpm nx run conformance:record')),
    at(recordSteps, runHas(`${CLI} check`)),
    at(recordSteps, (s) => usesOf(s).startsWith('actions/upload-artifact@')),
  ];
  if (
    recordOrder.some(
      (index, position) =>
        index < 0 ||
        (position > 0 && index <= (recordOrder[position - 1] ?? -1)),
    )
  ) {
    fail(
      'record.steps',
      'record job order: checkout, setup, validate inputs, clean tree, record, check the bundle, upload',
    );
  }
  const recorder = recordSteps.find(runHas('pnpm nx run conformance:record'));
  if (
    normal(runOf(recorder ?? {})) !==
    `pnpm nx run conformance:record --cells="$CELLS" --versions="$VERSIONS" --out=${BUNDLE}`
  ) {
    fail(
      'record.recorder-command',
      `the recorder must be run as \`pnpm nx run conformance:record --cells="$CELLS" --versions="$VERSIONS" --out=${BUNDLE}\` (quoted variables, never the evidence tree)`,
    );
  }
  const checks = recordSteps
    .filter(runHas(`${CLI} check`))
    .map((s) => normal(runOf(s)));
  if (!sameSet(checks, [`${CLI} check --dir=${BUNDLE} --integrity`])) {
    fail(
      'record.bundle-check',
      'the record job must check the bundle with --integrity',
    );
  }
  if (recordSteps.filter(runHas(`${CLI} validate-inputs`)).length !== 1) {
    fail(
      'record.steps',
      'the record job validates its inputs once, before anything runs',
    );
  }
  const recordScripts = recordSteps.map(runOf).join('\n');
  if (/\bgit\s+(push|commit|add)\b|\bgh\s/.test(recordScripts)) {
    fail('record.write-job', 'the record job must not commit, push or call gh');
  }

  // The write job: nothing installed, nothing from the bundle run, a fixed order.
  const proposeUses = proposeSteps.map(usesOf).filter((uses) => uses !== '');
  if (
    !sameSet(
      proposeUses.map((uses) => uses.split('@')[0] ?? ''),
      ['actions/checkout', 'actions/setup-node', 'actions/download-artifact'],
    ) ||
    /\b(pnpm|npm|npx|yarn|corepack)\b|\bnode\s+(?!apps\/conformance\/src\/record\/bundle-cli\.ts\b)/.test(
      proposeSteps.map(runOf).join('\n'),
    )
  ) {
    fail(
      'record.write-job',
      'the propose job installs nothing: only checkout, setup-node, download-artifact and the bundle-cli script',
    );
  }
  const proposeOrder = [
    at(proposeSteps, (s) => usesOf(s).startsWith('actions/checkout@')),
    at(proposeSteps, runHas(`${CLI} validate-inputs`)),
    at(proposeSteps, (s) => usesOf(s).startsWith('actions/download-artifact@')),
    at(proposeSteps, runHas(`${CLI} check`)),
    at(proposeSteps, runHas('cp -R')),
    at(proposeSteps, runHas('gh pr create')),
  ];
  if (
    proposeOrder.some(
      (index, position) =>
        index < 0 ||
        (position > 0 && index <= (proposeOrder[position - 1] ?? -1)),
    ) ||
    proposeOrder.at(-1) !== proposeSteps.length - 1
  ) {
    fail(
      'record.steps',
      'propose job order: checkout, validate inputs, download, check the bundle, copy, open the pull request (last)',
    );
  }
  const proposeChecks = proposeSteps
    .filter(runHas(`${CLI} check`))
    .map((s) => normal(runOf(s)));
  if (
    !sameSet(proposeChecks, [
      `${CLI} check --dir=${BUNDLE} --pr-body=dist/pr-body.md`,
    ])
  ) {
    fail(
      'record.bundle-check',
      'the propose job must check the bundle again and write the pull request description',
    );
  }
  const copies = proposeSteps
    .filter(runHas('cp -R'))
    .map((s) => normal(runOf(s)));
  if (
    !sameSet(copies, [
      `mkdir -p testing/lab-evidence cp -R ${BUNDLE}/. testing/lab-evidence/`,
    ])
  ) {
    fail(
      'record.write-job',
      'the bundle is copied into testing/lab-evidence with exactly `cp -R` and nothing else',
    );
  }

  // The last step: branch, commit, push of that branch only, label, pull request.
  const script = runOf(lastPropose ?? {});
  const lines = script.split('\n').map((line) => line.trim());
  const need = (
    rule: (typeof HARDENING_RULES)[number],
    text: string,
    message: string,
  ): void => {
    if (!script.includes(text)) fail(rule, message);
  };
  need(
    'record.pr-step',
    'set -euo pipefail',
    'the pull request step must stop on the first error',
  );
  need(
    'record.pr-step',
    'branch="lab-evidence/run-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    'the branch must be lab-evidence/run-<id>-<attempt>',
  );
  need(
    'record.pr-step',
    'git add -- testing/lab-evidence',
    'only testing/lab-evidence is staged',
  );
  need(
    'record.pr-step',
    "grep -Ev '^testing/lab-evidence/[0-9]+\\.[0-9]+\\.[0-9]+/CF-[A-Z0-9-]+\\.json$'",
    'every staged path must be an evidence artefact',
  );
  need(
    'record.pr-step',
    'git commit --signoff',
    'the commit carries a sign-off',
  );
  const tokenLines = lines.filter((line) => line.includes('GH_TOKEN'));
  if (
    tokenLines.length !== 1 ||
    !(tokenLines[0] ?? '').startsWith(
      'GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf',
    )
  ) {
    fail(
      'record.pr-step',
      'GH_TOKEN is used once, to build the git header in the environment; never echoed or put on a command line',
    );
  }
  const pushes = lines.filter((line) => /\bgit\s+push\b/.test(line));
  if (
    !sameSet(pushes, [
      'git push origin "refs/heads/${branch}:refs/heads/${branch}"',
    ])
  ) {
    fail(
      'record.pr-step',
      'the only push is `git push origin "refs/heads/${branch}:refs/heads/${branch}"`',
    );
  }
  const creates = lines.filter((line) => line.includes('gh pr create'));
  if (
    !sameSet(creates, [
      'gh pr create --base "$BASE_BRANCH" --head "$branch" --title "$title" --body-file dist/pr-body.md --label lab-evidence',
    ])
  ) {
    fail(
      'record.pr-step',
      'the pull request must be created with the label lab-evidence, from the branch, with the checked description',
    );
  }

  // No merge, approval, force, arbitrary API call or download of code anywhere.
  const allScripts = [...recordSteps, ...proposeSteps].map(runOf).join('\n');
  const forbidden =
    /\bgh\s+pr\s+(merge|review|ready|edit)\b|\bgh\s+api\b|\bgh\s+(workflow|run|release|secret)\b|--auto\b|--admin\b|approve|\bgit\s+merge\b|--force|--mirror|--tags|--delete|\bgit\s+push\b[^\n]*(\s-f\b|\s\+|--all)|\bcurl\b|\bwget\b|\bgit\s+add\s+(-A|--all|\.)/i;
  const hit = forbidden.exec(allScripts);
  if (hit) {
    fail(
      'record.no-merge',
      `\`${hit[0]}\` is not allowed: the workflow never merges, approves or forces, and a human reviews the pull request`,
    );
  }
  const usesAll = [...recordSteps, ...proposeSteps].map(usesOf).join('\n');
  if (usesAll.includes('github-script')) {
    fail(
      'record.no-merge',
      'actions/github-script is not allowed here (its script is an injection sink)',
    );
  }

  // Artifact hand-over: one name, an error if empty.
  const upload = recordSteps.find((s) =>
    usesOf(s).startsWith('actions/upload-artifact@'),
  );
  const download = proposeSteps.find((s) =>
    usesOf(s).startsWith('actions/download-artifact@'),
  );
  const uploadWith = asRecord(upload?.with);
  const downloadWith = asRecord(download?.with);
  if (
    uploadWith.name !== 'lab-evidence-bundle' ||
    downloadWith.name !== 'lab-evidence-bundle' ||
    uploadWith.path !== BUNDLE ||
    downloadWith.path !== BUNDLE ||
    uploadWith['if-no-files-found'] !== 'error' ||
    'run-id' in downloadWith ||
    'github-token' in downloadWith
  ) {
    fail(
      'record.artifact',
      'the bundle moves as the artifact lab-evidence-bundle of this run (fails when empty, no run-id or token for the download)',
    );
  }

  // Pinned actions, persisted credentials.
  for (const violation of checkActionsPinned([file])) {
    fail('record.pinned', `${violation.rule}: ${violation.message}`);
  }
  return out;
}

export function formatHardeningViolations(
  violations: HardeningViolation[],
): string {
  return violations.map((v) => `  [${v.rule}] ${v.message}`).join('\n');
}
