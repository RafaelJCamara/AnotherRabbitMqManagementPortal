// Self-test for the hardening check of the conformance CI workflows
// (`nx run supply-chain:conformance-workflows-selftest`, M0-42). The real workflows
// (conformance-pr.yml and conformance-nightly.yml) must pass;
// every mutation below plants one weakening in a copy of one of them and the check must name the
// rule. The mutations start from the real file, so a rename in the workflow that makes a mutation a
// no-op fails the test instead of silently weakening it.
//
// AC-5 and AC-6 are one test each (the work package's acceptance criteria quote these names).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONFORMANCE_WORKFLOWS,
  LEG_STATUS_RUN,
  NIGHTLY_CONFIG,
  NIGHTLY_RULES,
  NIGHTLY_WORKFLOW_PATH,
  PR_CONFIG,
  PR_RULES,
  PR_WORKFLOW_PATH,
  WORKFLOW_RULES,
  checkNightly,
  checkPr,
  checkSingleConformanceJob,
  checkWorkflow,
} from './conformance-workflows.ts';
import type { WorkflowConfig } from './conformance-workflows.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string =>
  readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Every rule any planted violation fired, for the last test. */
const fired = new Set<string>();

interface Mutation {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly rule: string;
}

/** Plants every mutation in a copy of `base` and requires the named rule. */
function plant(
  base: string,
  check: (text: string) => { rule: string }[],
  mutations: readonly Mutation[],
): void {
  for (const mutation of mutations) {
    assert.ok(
      base.includes(mutation.from),
      `${mutation.name}: the workflow no longer contains: ${mutation.from}`,
    );
    const rules = new Set(
      check(base.replace(mutation.from, () => mutation.to)).map((v) => v.rule),
    );
    for (const rule of rules) fired.add(rule);
    assert.ok(
      rules.has(mutation.rule),
      `${mutation.name}: expected ${mutation.rule}, got [${[...rules].sort().join(', ')}]`,
    );
  }
}

const pr = read(PR_WORKFLOW_PATH);
const checkPrText = (text: string) => checkPr({ path: PR_WORKFLOW_PATH, text });

const LAB_SETUP =
  '      - uses: ./.github/actions/setup\n      - name: Run the conformance cells';
const LAB_COMMAND =
  'run: pnpm nx run conformance:test --versions="$VERSION" --shard="$SHARD"';

void test('the real conformance-pr.yml passes every rule, whatever its line endings', () => {
  assert.deepEqual(checkPrText(pr), []);
  assert.deepEqual(checkPrText(pr.replace(/\n/g, '\r\n')), []);
  assert.match(pr, /^name: conformance-pr$/m);
});

void test('AC-5 conformance-pr.yml keeps the shape of the required check', () => {
  assert.deepEqual(checkPrText(pr), []);
  plant(pr, checkPrText, [
    {
      name: 'no job named conformance',
      from: '    name: conformance\n',
      to: '    name: gate\n',
      rule: 'pr.check-name',
    },
    {
      name: 'the check can be skipped',
      from: '    if: always()\n',
      to: '',
      rule: 'pr.check-always',
    },
    {
      name: 'the check only runs on success',
      from: '    if: always()\n',
      to: '    if: success()\n',
      rule: 'pr.check-always',
    },
    {
      name: 'needs misses plan',
      from: 'needs: [plan, lab]',
      to: 'needs: [lab]',
      rule: 'pr.check-needs',
    },
    {
      name: 'needs misses lab',
      from: 'needs: [plan, lab]',
      to: 'needs: [plan]',
      rule: 'pr.check-needs',
    },
    {
      name: 'a literal version list instead of the plan matrix',
      from: 'matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}',
      to: "matrix:\n        version: ['3.13.7', '4.3.6']",
      rule: 'pr.matrix',
    },
    {
      name: 'a Node override on the lab job',
      from: LAB_SETUP,
      to: '      - uses: ./.github/actions/setup\n        with:\n          node-version: 26.12.0\n      - name: Run the conformance cells',
      rule: 'pr.node-override',
    },
    {
      name: 'setup-node with another Node on the lab job',
      from: LAB_SETUP,
      to: `      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 20\n${LAB_SETUP}`,
      rule: 'pr.node-override',
    },
    {
      name: 'fail-fast left on',
      from: 'fail-fast: false',
      to: 'fail-fast: true',
      rule: 'pr.fail-fast',
    },
    {
      name: 'fail-fast missing',
      from: '      fail-fast: false\n',
      to: '',
      rule: 'pr.fail-fast',
    },
    {
      name: '--versions missing',
      from: ' --versions="$VERSION"',
      to: '',
      rule: 'pr.lab-command',
    },
    {
      name: '--shard missing',
      from: ' --shard="$SHARD"',
      to: '',
      rule: 'pr.lab-command',
    },
    {
      name: 'unquoted versions',
      from: '--versions="$VERSION"',
      to: '--versions=$VERSION',
      rule: 'pr.lab-command',
    },
    {
      name: 'strict on the pull request gate (another command)',
      from: LAB_COMMAND,
      to: `${LAB_COMMAND} --strict`,
      rule: 'pr.lab-command',
    },
    {
      name: 'an expression inside the lab run block',
      from: '--versions="$VERSION"',
      to: '--versions=${{ matrix.version }}',
      rule: 'wf.expression-in-run',
    },
    {
      name: 'an expression inside the verdict run block',
      from: 'run: node tools/conformance-ci/src/verdict-cli.ts',
      to: 'run: node tools/conformance-ci/src/verdict-cli.ts ${{ needs.lab.result }}',
      rule: 'wf.expression-in-run',
    },
    {
      name: 'an action pinned by tag',
      from: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
      to: 'actions/setup-node@v7',
      rule: 'wf.pinned',
    },
    {
      name: 'a pin without a version comment',
      from: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      to: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      rule: 'wf.pinned',
    },
    {
      name: 'the push trigger on every branch',
      from: 'branches: [main]',
      to: "branches: ['**']",
      rule: 'pr.triggers',
    },
    {
      name: 'the lab job runs when the change is not affected',
      from: "    if: needs.plan.outputs.affected == 'true'\n",
      to: '',
      rule: 'pr.lab-shape',
    },
    {
      name: 'a third job',
      from: '\n  conformance:\n',
      to: '\n  extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n    steps:\n      - run: echo hi\n\n  conformance:\n',
      rule: 'pr.jobs',
    },
    {
      name: 'the plan job runs something else',
      from: 'run: node tools/conformance-ci/src/plan-cli.ts',
      to: 'run: echo planned',
      rule: 'pr.plan-command',
    },
    {
      name: 'the check installs the workspace',
      from: '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version-file: .nvmrc\n',
      to: '      - uses: ./.github/actions/setup\n',
      rule: 'pr.check-command',
    },
    {
      name: 'the check reads the wrong lab result',
      from: 'LAB_RESULT: ${{ needs.lab.result }}',
      to: 'LAB_RESULT: ${{ needs.plan.result }}',
      rule: 'pr.check-command',
    },
    {
      name: 'the check runs another command',
      from: 'run: node tools/conformance-ci/src/verdict-cli.ts',
      to: 'run: echo ok',
      rule: 'pr.check-command',
    },
  ]);
});

/** The planted violations of the shared rules (workflow-independent text in conformance-pr.yml). */
function sharedMutations(): Mutation[] {
  return [
    {
      name: 'write-all at the top',
      from: 'permissions: {}',
      to: 'permissions: write-all',
      rule: 'wf.permissions',
    },
    {
      name: 'no top-level permissions',
      from: 'permissions: {}\n\n',
      to: '',
      rule: 'wf.permissions',
    },
    {
      name: 'a job may write contents',
      from: 'contents: read # checkout only\n',
      to: 'contents: write # checkout only\n',
      rule: 'wf.permissions',
    },
    {
      name: 'a job may write pull requests',
      from: 'contents: read # checkout only\n',
      to: 'contents: read # checkout only\n      pull-requests: write\n',
      rule: 'wf.permissions',
    },
    {
      name: 'a job gets an id token',
      from: 'contents: read # checkout only\n',
      to: 'contents: read # checkout only\n      id-token: write\n',
      rule: 'wf.permissions',
    },
    {
      name: 'a moving runner label',
      from: 'runs-on: ubuntu-24.04',
      to: 'runs-on: ubuntu-latest',
      rule: 'wf.job-shape',
    },
    {
      name: 'a self-hosted runner',
      from: 'runs-on: ubuntu-24.04',
      to: 'runs-on: self-hosted',
      rule: 'wf.job-shape',
    },
    {
      name: 'no time limit',
      from: '    timeout-minutes: 15\n',
      to: '',
      rule: 'wf.job-shape',
    },
    {
      name: 'a repository secret',
      from: "SHARDS: '2'",
      to: 'SHARDS: ${{ secrets.PAT }}',
      rule: 'wf.secrets',
    },
    {
      name: 'a secret in a run block',
      from: 'run: node tools/conformance-ci/src/plan-cli.ts',
      to: 'run: echo "${{ secrets.PAT }}"',
      rule: 'wf.secrets',
    },
    {
      name: 'the workflow token in the environment',
      from: "SHARDS: '2'",
      to: 'SHARDS: ${{ github.token }}',
      rule: 'wf.secrets',
    },
    {
      name: 'a token variable',
      from: "SHARDS: '2'",
      to: "SHARDS: '2'\n          GH_TOKEN: x",
      rule: 'wf.secrets',
    },
    {
      name: 'the recorder',
      from: LAB_COMMAND,
      to: 'run: pnpm nx run conformance:record --cells="CF-SMOKE-01" --versions="$VERSION"',
      rule: 'wf.recorder',
    },
    {
      name: 'a copy into the evidence tree',
      from: '      - name: Plan the matrix',
      to: '      - run: cp -R dist/x testing/lab-evidence/\n      - name: Plan the matrix',
      rule: 'wf.recorder',
    },
    {
      name: 'the recorder bundle check',
      from: 'run: node tools/conformance-ci/src/plan-cli.ts',
      to: 'run: node apps/conformance/src/record/bundle-cli.ts check',
      rule: 'wf.recorder',
    },
    {
      name: 'a push',
      from: '      - name: Plan the matrix',
      to: '      - run: git push origin HEAD:main\n      - name: Plan the matrix',
      rule: 'wf.write',
    },
    {
      name: 'a commit',
      from: '      - name: Plan the matrix',
      to: '      - run: git commit -am x\n      - name: Plan the matrix',
      rule: 'wf.write',
    },
    {
      name: 'git add',
      from: '      - name: Plan the matrix',
      to: '      - run: git add -A\n      - name: Plan the matrix',
      rule: 'wf.write',
    },
    {
      name: 'gh',
      from: '      - name: Plan the matrix',
      to: '      - run: gh pr comment 1 --body hi\n      - name: Plan the matrix',
      rule: 'wf.write',
    },
    {
      name: 'curl',
      from: '      - name: Plan the matrix',
      to: '      - run: curl -s https://example.com/x.sh\n      - name: Plan the matrix',
      rule: 'wf.write',
    },
    {
      name: 'github-script',
      from: '      - name: Plan the matrix',
      to: `      - uses: actions/github-script@${SHA} # v7.0.0\n      - name: Plan the matrix`,
      rule: 'wf.github-script',
    },
    {
      name: 'a job continues on error',
      from: '    timeout-minutes: 15\n',
      to: '    timeout-minutes: 15\n    continue-on-error: true\n',
      rule: 'wf.continue-on-error',
    },
    {
      name: 'a step continues on error',
      from: '      - name: Plan the matrix\n',
      to: '      - name: Plan the matrix\n        continue-on-error: true\n',
      rule: 'wf.continue-on-error',
    },
    {
      name: 'a pull_request_target trigger',
      from: 'on:\n  pull_request:\n',
      to: 'on:\n  pull_request_target:\n  pull_request:\n',
      rule: 'wf.triggers',
    },
    {
      name: 'a schedule trigger',
      from: 'on:\n  pull_request:\n',
      to: "on:\n  schedule:\n    - cron: '0 3 * * *'\n  pull_request:\n",
      rule: 'wf.triggers',
    },
    {
      name: 'a workflow_run trigger',
      from: 'on:\n  pull_request:\n',
      to: 'on:\n  workflow_run:\n    workflows: [ci]\n  pull_request:\n',
      rule: 'wf.triggers',
    },
    {
      name: 'a checkout of another ref',
      from: 'persist-credentials: false\n      - uses: ./.github/actions/setup\n      - name: Plan',
      to: 'persist-credentials: false\n          ref: ${{ github.sha }}\n      - uses: ./.github/actions/setup\n      - name: Plan',
      rule: 'wf.checkout',
    },
    {
      name: 'a checkout with the token',
      from: 'persist-credentials: false\n      - uses: ./.github/actions/setup\n      - name: Plan',
      to: 'persist-credentials: false\n          token: ${{ github.sha }}\n      - uses: ./.github/actions/setup\n      - name: Plan',
      rule: 'wf.checkout',
    },
    {
      name: 'persisted credentials',
      from: 'persist-credentials: false\n      - uses: ./.github/actions/setup\n      - name: Plan',
      to: 'persist-credentials: true\n      - uses: ./.github/actions/setup\n      - name: Plan',
      rule: 'wf.pinned',
    },
    {
      name: 'the base from the head ref',
      from: 'BASE: ${{ github.event.pull_request.base.sha || github.event.before }}',
      to: 'BASE: ${{ github.head_ref }}',
      rule: 'wf.expression-source',
    },
    {
      name: 'the head from a pull request title',
      from: 'HEAD: ${{ github.sha }}',
      to: 'HEAD: ${{ github.event.pull_request.title }}',
      rule: 'wf.expression-source',
    },
    {
      name: 'the head from a commit message',
      from: 'HEAD: ${{ github.sha }}',
      to: 'HEAD: ${{ github.event.head_commit.message }}',
      rule: 'wf.expression-source',
    },
    {
      name: 'an expression in a with value reading the branch name',
      from: 'fetch-depth: 0',
      to: 'fetch-depth: ${{ github.ref_name }}',
      rule: 'wf.expression-source',
    },
    {
      name: 'an unknown function',
      from: 'HEAD: ${{ github.sha }}',
      to: "HEAD: ${{ toUpper('x') }}",
      rule: 'wf.expression-source',
    },
    {
      name: 'a workflow that does not parse',
      from: 'permissions: {}',
      to: 'permissions: [unclosed',
      rule: 'wf.parse',
    },
  ];
}

const NIGHTLY_STEP = '      - name: Plan the legs';
const RELEASE_COMMAND =
  'run: pnpm nx run conformance:test --versions="$VERSION"';

/** The planted violations of the shared rules, as they read in conformance-nightly.yml. */
function nightlySharedMutations(): Mutation[] {
  const insert = (step: string): string => `${step}\n${NIGHTLY_STEP}`;
  return [
    {
      name: 'write-all at the top',
      from: 'permissions: {}',
      to: 'permissions: write-all',
      rule: 'wf.permissions',
    },
    {
      name: 'a job may write contents',
      from: 'contents: read # checkout only\n',
      to: 'contents: write # checkout only\n',
      rule: 'wf.permissions',
    },
    {
      name: 'a job gets an id token',
      from: 'contents: read # checkout only\n',
      to: 'contents: read # checkout only\n      id-token: write\n',
      rule: 'wf.permissions',
    },
    {
      name: 'a moving runner label',
      from: 'runs-on: ubuntu-24.04',
      to: 'runs-on: ubuntu-latest',
      rule: 'wf.job-shape',
    },
    {
      name: 'no time limit',
      from: '    timeout-minutes: 15\n',
      to: '',
      rule: 'wf.job-shape',
    },
    {
      name: 'a repository secret',
      from: 'VERSION: ${{ matrix.version }}',
      to: 'VERSION: ${{ secrets.PAT }}',
      rule: 'wf.secrets',
    },
    {
      name: 'the workflow token',
      from: 'RESULT: ${{ job.status }}',
      to: 'RESULT: ${{ github.token }}',
      rule: 'wf.secrets',
    },
    {
      name: 'the recorder',
      from: RELEASE_COMMAND,
      to: 'run: pnpm nx run conformance:record --cells="CF-SMOKE-01" --versions="$VERSION"',
      rule: 'wf.recorder',
    },
    {
      name: 'a copy into the evidence tree',
      from: NIGHTLY_STEP,
      to: insert('      - run: cp -R dist/x testing/lab-evidence/'),
      rule: 'wf.recorder',
    },
    {
      name: 'a push',
      from: NIGHTLY_STEP,
      to: insert('      - run: git push origin HEAD:main'),
      rule: 'wf.write',
    },
    {
      name: 'a commit',
      from: NIGHTLY_STEP,
      to: insert('      - run: git commit -am x'),
      rule: 'wf.write',
    },
    {
      name: 'gh',
      from: NIGHTLY_STEP,
      to: insert('      - run: gh issue create --title x'),
      rule: 'wf.write',
    },
    {
      name: 'github-script',
      from: NIGHTLY_STEP,
      to: insert(`      - uses: actions/github-script@${SHA} # v7.0.0`),
      rule: 'wf.github-script',
    },
    {
      name: 'a pull_request_target trigger',
      from: 'on:\n  schedule:',
      to: 'on:\n  pull_request_target:\n  schedule:',
      rule: 'wf.triggers',
    },
    {
      name: 'a push trigger',
      from: 'on:\n  schedule:',
      to: 'on:\n  push:\n  schedule:',
      rule: 'wf.triggers',
    },
    {
      name: 'the release job continues on error',
      from: '    timeout-minutes: 90\n',
      to: '    timeout-minutes: 90\n    continue-on-error: true\n',
      rule: 'wf.continue-on-error',
    },
    {
      name: 'a step continues on error',
      from: '      - name: Keep the status of this leg\n',
      to: '      - name: Keep the status of this leg\n        continue-on-error: true\n',
      rule: 'wf.continue-on-error',
    },
    {
      name: 'the report job continues on error',
      from: '    timeout-minutes: 10\n',
      to: '    timeout-minutes: 10\n    continue-on-error: true\n',
      rule: 'wf.continue-on-error',
    },
    {
      name: 'the alpha job continues on error only when it says true',
      from: '    continue-on-error: true #',
      to: "    continue-on-error: ${{ matrix.version != '0.0.0' }} #",
      rule: 'wf.continue-on-error',
    },
    {
      name: 'an expression in the report run block',
      from: 'run: node tools/conformance-ci/src/report-cli.ts',
      to: 'run: node tools/conformance-ci/src/report-cli.ts ${{ needs.release.result }}',
      rule: 'wf.expression-in-run',
    },
    {
      name: 'a plan output read from the event',
      from: 'PLAN_ALPHA: ${{ needs.plan.outputs.alpha }}',
      to: 'PLAN_ALPHA: ${{ github.event.inputs.alpha }}',
      rule: 'wf.expression-source',
    },
    {
      name: 'a checkout of another ref',
      from: 'persist-credentials: false\n      - uses: ./.github/actions/setup\n      - name: Plan',
      to: 'persist-credentials: false\n          ref: ${{ github.sha }}\n      - uses: ./.github/actions/setup\n      - name: Plan',
      rule: 'wf.checkout',
    },
    {
      name: 'an action pinned by tag',
      from: 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2',
      to: 'actions/download-artifact@v8',
      rule: 'wf.pinned',
    },
    {
      name: 'a workflow that does not parse',
      from: 'permissions: {}',
      to: 'permissions: [unclosed',
      rule: 'wf.parse',
    },
  ];
}

void test('conformance-nightly.yml keeps the shape of the nightly', () => {
  const nightly = read(NIGHTLY_WORKFLOW_PATH);
  const check = (text: string) =>
    checkNightly({ path: NIGHTLY_WORKFLOW_PATH, text });
  assert.deepEqual(check(nightly), []);
  assert.deepEqual(check(nightly.replace(/\n/g, '\r\n')), []);
  assert.match(nightly, /^name: conformance-nightly$/m);
  plant(nightly, check, [
    {
      name: 'no schedule',
      from: "  schedule:\n    - cron: '17 2 * * *'\n",
      to: '',
      rule: 'nightly.schedule',
    },
    {
      name: 'two schedules',
      from: "    - cron: '17 2 * * *'\n",
      to: "    - cron: '17 2 * * *'\n    - cron: '17 3 * * *'\n",
      rule: 'nightly.schedule',
    },
    {
      name: 'a fifth job',
      from: '\n  report:\n',
      to: '\n  extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n    steps:\n      - run: echo hi\n\n  report:\n',
      rule: 'nightly.jobs',
    },
    {
      name: 'the plan runs something else',
      from: 'run: node tools/conformance-ci/src/nightly-plan-cli.ts',
      to: 'run: echo planned',
      rule: 'nightly.plan',
    },
    {
      name: 'a Node override on the plan job',
      from: '      - uses: ./.github/actions/setup\n      - name: Plan the legs',
      to: '      - uses: ./.github/actions/setup\n        with:\n          node-version: 20\n      - name: Plan the legs',
      rule: 'nightly.plan',
    },
    {
      name: 'a literal Node range for the release legs',
      from: 'node-version: ${{ matrix.node }}',
      to: "node-version: '>=24'",
      rule: 'nightly.release',
    },
    {
      name: 'a setup-node step on the release job',
      from: '      - name: Run the conformance cells on one broker version',
      to: `      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 20\n      - name: Run the conformance cells on one broker version`,
      rule: 'nightly.release',
    },
    {
      name: 'a literal node list for the release legs',
      from: 'matrix: ${{ fromJSON(needs.plan.outputs.release) }}',
      to: "matrix:\n        version: ['4.3.6']\n        node: ['24.22.0', '26.12.0']",
      rule: 'nightly.release',
    },
    {
      name: 'the release legs stop at the first failure',
      from: 'fail-fast: false',
      to: 'fail-fast: true',
      rule: 'nightly.release',
    },
    {
      name: 'the release job can be skipped',
      from: '    needs: plan\n    runs-on',
      to: "    needs: plan\n    if: github.event_name == 'schedule'\n    runs-on",
      rule: 'nightly.release',
    },
    {
      name: 'the release legs do not fail the run',
      from: '    timeout-minutes: 90\n',
      to: '    timeout-minutes: 90\n    continue-on-error: true\n',
      rule: 'nightly.release',
    },
    {
      name: 'the release command is another command',
      from: RELEASE_COMMAND,
      to: `${RELEASE_COMMAND} --non-blocking=$VERSION`,
      rule: 'nightly.release',
    },
    {
      name: 'the alpha job cannot fail',
      from: '    continue-on-error: true # the only job that may fail without failing the run; the report lists it\n',
      to: '',
      rule: 'nightly.alpha',
    },
    {
      name: 'the alpha job runs with no alpha build',
      from: "    if: needs.plan.outputs.has_alpha == 'true'\n",
      to: '',
      rule: 'nightly.alpha',
    },
    {
      name: 'the alpha matrix is the release matrix',
      from: 'matrix: ${{ fromJSON(needs.plan.outputs.alpha) }}',
      to: 'matrix: ${{ fromJSON(needs.plan.outputs.release) }}',
      rule: 'nightly.alpha',
    },
    {
      name: 'a leg status written only on success',
      from: '      - name: Keep the status of this leg\n        if: always()\n',
      to: '      - name: Keep the status of this leg\n',
      rule: 'nightly.leg-status',
    },
    {
      name: 'a leg status that is a constant',
      from: 'RESULT: ${{ job.status }}',
      to: 'RESULT: success',
      rule: 'nightly.leg-status',
    },
    {
      name: 'a leg uploaded under another name',
      from: 'name: leg-node-${{ matrix.node }}-release-${{ matrix.version }}',
      to: 'name: leg-release-${{ matrix.version }}',
      rule: 'nightly.leg-status',
    },
    {
      name: 'a leg upload that is skipped after a failure',
      from: '      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n        if: always()\n        with:\n          name: leg-node-${{ matrix.node }}-release',
      to: '      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2\n        with:\n          name: leg-node-${{ matrix.node }}-release',
      rule: 'nightly.leg-status',
    },
    {
      name: 'a report that can be skipped',
      from: '    needs: [plan, release, alpha]\n    if: always()\n',
      to: '    needs: [plan, release, alpha]\n',
      rule: 'nightly.report',
    },
    {
      name: 'a report that does not wait for alpha',
      from: 'needs: [plan, release, alpha]',
      to: 'needs: [plan, release]',
      rule: 'nightly.report',
    },
    {
      name: 'a report that reads no legs',
      from: 'pattern: leg-*',
      to: 'pattern: nothing-*',
      rule: 'nightly.report',
    },
    {
      name: 'a report that ignores the release result',
      from: 'RELEASE_RESULT: ${{ needs.release.result }}',
      to: 'RELEASE_RESULT: ${{ needs.alpha.result }}',
      rule: 'nightly.report',
    },
    {
      name: 'a report that installs the workspace',
      from: '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version-file: .nvmrc\n',
      to: '      - uses: ./.github/actions/setup\n',
      rule: 'nightly.report',
    },
    {
      name: 'a report that is not uploaded',
      from: 'name: conformance-nightly-report',
      to: 'name: other',
      rule: 'nightly.report',
    },
  ]);
});

void test('AC-6 no conformance workflow can record evidence, write, or hide a failure', () => {
  assert.ok(CONFORMANCE_WORKFLOWS.length > 0);
  for (const config of CONFORMANCE_WORKFLOWS) {
    const text = read(config.path);
    const check = (candidate: string) =>
      checkWorkflow({ path: config.path, text: candidate }, config);
    assert.deepEqual(check(text), [], `${config.path} breaks a rule`);
    assert.deepEqual(check(text.replace(/\n/g, '\r\n')), []);
    plant(
      text,
      check,
      config === PR_CONFIG ? sharedMutations() : nightlySharedMutations(),
    );
  }
  // No planted violation may weaken the real files: the workflow list covers the new workflows.
  assert.ok(
    CONFORMANCE_WORKFLOWS.some((config) => config.path === PR_WORKFLOW_PATH),
  );
  // continue-on-error is allowed only where a workflow's config says so, and only as `true`.
  const lenient: WorkflowConfig = {
    ...PR_CONFIG,
    continueOnErrorJobs: ['lab'],
  };
  const withLab = pr.replace(
    '    timeout-minutes: 45\n',
    '    timeout-minutes: 45\n    continue-on-error: true\n',
  );
  assert.deepEqual(
    checkWorkflow({ path: PR_WORKFLOW_PATH, text: withLab }, lenient),
    [],
  );
  assert.ok(
    checkWorkflow({ path: PR_WORKFLOW_PATH, text: withLab }, PR_CONFIG).some(
      (v) => v.rule === 'wf.continue-on-error',
    ),
  );
  const conditional = withLab.replace(
    'continue-on-error: true',
    'continue-on-error: ${{ matrix.version == 4.0.9 }}',
  );
  assert.ok(
    checkWorkflow({ path: PR_WORKFLOW_PATH, text: conditional }, lenient).some(
      (v) => v.rule === 'wf.continue-on-error',
    ),
  );
});

void test('AC-6 (M0-FIX-1) the run text of the nightly leg-status step is pinned', () => {
  const nightly = read(NIGHTLY_WORKFLOW_PATH);
  const check = (text: string) =>
    checkNightly({ path: NIGHTLY_WORKFLOW_PATH, text });
  assert.deepEqual(check(nightly), []);
  assert.equal(
    LEG_STATUS_RUN,
    'mkdir -p dist/leg printf \'%s\\n\' "$RESULT" > dist/leg/result',
  );
  const line = '          printf \'%s\\n\' "$RESULT" > dist/leg/result\n';
  const mkdir = '          mkdir -p dist/leg\n';
  const edits: [name: string, from: string, to: string][] = [
    [
      'a constant instead of the job status',
      line,
      "          printf '%s\\n' success > dist/leg/result\n",
    ],
    [
      'another file than the report reads',
      line,
      '          printf \'%s\\n\' "$RESULT" > dist/leg/status\n',
    ],
    [
      'an append instead of a write',
      line,
      '          printf \'%s\\n\' "$RESULT" >> dist/leg/result\n',
    ],
    [
      'a second line after it',
      line,
      `${line}          echo done >> dist/leg/result\n`,
    ],
    ['a trailing command', line, `${line.trimEnd()} || true\n`],
    ['no directory made', mkdir, ''],
    [
      'the status word swapped for a pipeline',
      line,
      '          echo "$RESULT" | tr a-z A-Z > dist/leg/result\n',
    ],
  ];
  // Both legs carry the step; the release job's comes first in the file and the alpha job's last.
  for (const [name, from, to] of edits) {
    const first = nightly.indexOf(from);
    const last = nightly.lastIndexOf(from);
    assert.ok(
      first >= 0 && last > first,
      `${name}: the step is not in both jobs`,
    );
    for (const [leg, at] of [
      ['release', first],
      ['alpha', last],
    ] as const) {
      const text = nightly.slice(0, at) + to + nightly.slice(at + from.length);
      const rules = new Set(check(text).map((v) => v.rule));
      for (const rule of rules) fired.add(rule);
      assert.ok(
        rules.has('nightly.leg-status'),
        `${name} (${leg}): expected nightly.leg-status, got [${[...rules].sort().join(', ')}]`,
      );
    }
  }
  // Whitespace and line endings do not matter; the words do.
  assert.deepEqual(check(nightly.replace(/\n/g, '\r\n')), []);
  assert.deepEqual(
    check(
      nightly.replaceAll(
        line,
        '          printf   \'%s\\n\'   "$RESULT"   > dist/leg/result\n',
      ),
    ),
    [],
  );
});

void test('AC-9 (M0-FIX-1) a push is its own concurrency group, so no intermediate commit loses its run', () => {
  assert.deepEqual(checkPrText(pr), []);
  const group =
    '  group: conformance-pr-${{ github.event.pull_request.number || github.sha }}\n';
  const cancel =
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n";
  plant(pr, checkPrText, [
    {
      name: 'every push to main shares the group of its ref',
      from: group,
      to: '  group: conformance-pr-${{ github.event.pull_request.number || github.ref }}\n',
      rule: 'pr.concurrency',
    },
    {
      name: 'one group for the whole workflow',
      from: group,
      to: '  group: conformance-pr\n',
      rule: 'pr.concurrency',
    },
    {
      name: 'a pull request group that is the commit (a new push no longer replaces the run)',
      from: group,
      to: '  group: conformance-pr-${{ github.sha }}\n',
      rule: 'pr.concurrency',
    },
    {
      name: 'no group at all',
      from: group,
      to: '',
      rule: 'pr.concurrency',
    },
    {
      name: 'a later push cancels the run of the commit before it',
      from: cancel,
      to: '  cancel-in-progress: true\n',
      rule: 'pr.concurrency',
    },
    {
      name: 'a pull request run is never replaced',
      from: cancel,
      to: '  cancel-in-progress: false\n',
      rule: 'pr.concurrency',
    },
    {
      name: 'no cancel-in-progress',
      from: cancel,
      to: '',
      rule: 'pr.concurrency',
    },
  ]);
  // The comment that explains the group is not part of the pin.
  assert.deepEqual(
    checkPrText(pr.replace('  # A pull request is one group', '  # one group')),
    [],
  );
});

void test('AC-11 (M0-FIX-1) only conformance-pr.yml defines a job named conformance', () => {
  const directory = join(root, '.github', 'workflows');
  const files = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({
      path: `.github/workflows/${name}`,
      text: read(`.github/workflows/${name}`),
    }));
  assert.ok(
    files.some((file) => file.path === PR_WORKFLOW_PATH),
    'conformance-pr.yml is among the files read',
  );
  assert.ok(files.length > 3, 'the workflow directory was read');
  assert.deepEqual(checkSingleConformanceJob(files), []);

  const job = (extra: string): string =>
    `name: other\non: [workflow_dispatch]\npermissions: {}\njobs:\n${extra}`;
  const planted: [name: string, text: string][] = [
    [
      'a job keyed conformance',
      job('  conformance:\n    runs-on: ubuntu-24.04\n    steps: []\n'),
    ],
    [
      'a job keyed conformance under another display name (the id is reserved too)',
      job(
        '  conformance:\n    name: something else\n    runs-on: ubuntu-24.04\n    steps: []\n',
      ),
    ],
    [
      'a job named conformance',
      job(
        '  gate:\n    name: conformance\n    runs-on: ubuntu-24.04\n    steps: []\n',
      ),
    ],
    [
      'a job named Conformance, padded',
      job(
        "  gate:\n    name: ' Conformance '\n    runs-on: ubuntu-24.04\n    steps: []\n",
      ),
    ],
    [
      'a job keyed Conformance',
      job('  Conformance:\n    runs-on: ubuntu-24.04\n    steps: []\n'),
    ],
    [
      'a job whose name is only an expression',
      job(
        '  gate:\n    name: ${{ vars.CHECK }}\n    runs-on: ubuntu-24.04\n    steps: []\n',
      ),
    ],
    ['a copy of the required check under another file name', pr],
    ['a file that does not parse', 'jobs: [unclosed'],
  ];
  for (const [name, text] of planted) {
    const found = checkSingleConformanceJob([
      ...files,
      { path: '.github/workflows/planted.yml', text },
    ]);
    for (const violation of found) fired.add(violation.rule);
    assert.deepEqual(
      found.map((violation) => violation.rule),
      ['pr.check-unique'],
      name,
    );
    assert.match(found[0]?.message ?? '', /planted\.yml/, name);
  }
  // Names that merely contain the word, or an expression inside a longer name, are not the check.
  const harmless = checkSingleConformanceJob([
    {
      path: '.github/workflows/planted.yml',
      text: job(
        '  conformance-record:\n    name: conformance record on ${{ matrix.version }}\n    runs-on: ubuntu-24.04\n    steps: []\n',
      ),
    },
  ]);
  assert.deepEqual(harmless, []);
  // The required check's own file is the one place the job belongs.
  assert.deepEqual(
    checkSingleConformanceJob([{ path: PR_WORKFLOW_PATH, text: pr }]),
    [],
  );
});

void test('every rule of the check is exercised by at least one planted violation', () => {
  for (const rule of [...WORKFLOW_RULES, ...PR_RULES, ...NIGHTLY_RULES]) {
    assert.ok(fired.has(rule), `no planted violation fires ${rule}`);
  }
});
