// Self-test for the hardening check of conformance-record.yml (`nx run supply-chain:workflow-hardening-selftest`).
// The real workflow must pass; every mutation below plants one weakening in a copy of it and the
// check must name the rule. The mutations start from the real file, so a rename in the workflow
// that makes a mutation a no-op fails the test instead of silently weakening it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HARDENING_RULES,
  RECORD_WORKFLOW_PATH,
  checkRecordWorkflow,
} from './workflow-hardening.ts';

const root = join(import.meta.dirname, '..', '..');
const base = readFileSync(join(root, RECORD_WORKFLOW_PATH), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const SHA = '0123456789abcdef0123456789abcdef01234567';

function rulesOf(text: string): string[] {
  return [
    ...new Set(
      checkRecordWorkflow({ path: RECORD_WORKFLOW_PATH, text }).map(
        (v) => v.rule,
      ),
    ),
  ].sort();
}

/** Replaces the first occurrence of `from`; the text must contain it. */
function mutate(from: string, to: string): string {
  assert.ok(base.includes(from), `the workflow no longer contains: ${from}`);
  return base.replace(from, () => to);
}

function spec(name: string, body: () => void | Promise<void>): void {
  void test(name, body);
}

const fired = new Set<string>();
function expectRule(name: string, text: string, rule: string): void {
  spec(`${rule}: ${name}`, () => {
    const rules = rulesOf(text);
    for (const found of rules) fired.add(found);
    assert.ok(
      rules.includes(rule),
      `expected ${rule}, got [${rules.join(', ')}]`,
    );
  });
}

spec('the real conformance-record.yml passes every rule', () => {
  assert.deepEqual(rulesOf(base), []);
});

spec('the check does not depend on line endings', () => {
  assert.deepEqual(rulesOf(base.replace(/\n/g, '\r\n')), []);
});

spec('the file name is the one the recorder stamps as ci', () => {
  const provenance = readFileSync(
    join(root, 'apps/conformance/src/record/provenance.ts'),
    'utf8',
  );
  assert.ok(
    provenance.includes('\\.github\\/workflows\\/conformance-record\\.yml@'),
    'provenance.ts no longer names conformance-record.yml',
  );
  assert.equal(
    RECORD_WORKFLOW_PATH,
    '.github/workflows/conformance-record.yml',
  );
  assert.match(base, /^name: conformance-record$/m);
});
// Triggers
for (const trigger of [
  'pull_request_target',
  'pull_request',
  'push',
  'schedule',
  'workflow_run',
  'issue_comment',
  'workflow_call',
]) {
  expectRule(
    `a ${trigger} trigger`,
    mutate(
      'on:\n  workflow_dispatch:',
      `on:\n  ${trigger}:\n  workflow_dispatch:`,
    ),
    'record.triggers',
  );
}
expectRule(
  'no manual trigger',
  mutate('  workflow_dispatch:\n    inputs:', '  push:\n    inputs:'),
  'record.triggers',
);

// Inputs
expectRule(
  'dry run defaults to false',
  mutate(
    'type: boolean\n        default: true',
    'type: boolean\n        default: false',
  ),
  'record.inputs',
);
expectRule(
  'cells is optional',
  mutate(
    'required: true\n        default: CF-SMOKE-01',
    'required: false\n        default: CF-SMOKE-01',
  ),
  'record.inputs',
);
expectRule(
  'versions is a boolean',
  mutate(
    '        description: Lab broker versions, comma separated, no spaces (see testing/broker-lab/versions.json)\n        type: string',
    '        description: Lab broker versions\n        type: boolean',
  ),
  'record.inputs',
);
expectRule(
  'an extra input',
  mutate(
    '      dry_run:\n',
    '      branch:\n        type: string\n      dry_run:\n',
  ),
  'record.inputs',
);

// Permissions
expectRule(
  'write-all at the top',
  mutate('permissions: {}', 'permissions: write-all'),
  'record.permissions',
);
expectRule(
  'no top-level permissions',
  mutate('permissions: {}\n\nconcurrency', 'concurrency'),
  'record.permissions',
);
expectRule(
  'record may write contents',
  mutate('contents: read # checkout only', 'contents: write # checkout only'),
  'record.permissions',
);
expectRule(
  'record gets id-token',
  mutate(
    'contents: read # checkout only',
    'id-token: write\n      contents: read # checkout only',
  ),
  'record.permissions',
);
expectRule(
  'propose gets actions write',
  mutate(
    '      pull-requests: write #',
    '      actions: write\n      pull-requests: write #',
  ),
  'record.permissions',
);
expectRule(
  'propose loses pull-requests',
  mutate(
    '      pull-requests: write # opens the pull request and creates its label\n',
    '',
  ),
  'record.permissions',
);
expectRule(
  'propose has no permissions block',
  mutate(
    '    permissions:\n      contents: write # pushes',
    '    xpermissions:\n      contents: write # pushes',
  ),
  'record.permissions',
);

// Concurrency, runner, time limits, jobs
expectRule(
  'runs may be cancelled',
  mutate('cancel-in-progress: false', 'cancel-in-progress: true'),
  'record.concurrency',
);
expectRule(
  'another concurrency group',
  mutate('group: conformance-record', 'group: ${{ github.ref }}'),
  'record.concurrency',
);
expectRule(
  'a moving runner label',
  mutate('runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest'),
  'record.job-shape',
);
expectRule(
  'a self-hosted runner',
  mutate(
    'runs-on: ubuntu-24.04\n    timeout-minutes: 15',
    'runs-on: self-hosted\n    timeout-minutes: 15',
  ),
  'record.job-shape',
);
expectRule(
  'no time limit',
  mutate('    timeout-minutes: 120\n', ''),
  'record.job-shape',
);
expectRule(
  'a third job',
  `${base}  extra:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 1\n    steps:\n      - run: echo hi\n`,
  'record.job-shape',
);

// Environment
expectRule(
  'workflow-level env',
  mutate('permissions: {}', 'env:\n  X: y\n\npermissions: {}'),
  'record.env',
);
expectRule(
  'job-level env',
  mutate(
    '    timeout-minutes: 120\n',
    '    timeout-minutes: 120\n    env:\n      X: y\n',
  ),
  'record.env',
);
expectRule(
  'defaults',
  mutate(
    'permissions: {}',
    'defaults:\n  run:\n    shell: bash\n\npermissions: {}',
  ),
  'record.env',
);

// Expressions
expectRule(
  'an input in a run block',
  mutate(
    'run: node apps/conformance/src/record/bundle-cli.ts validate-inputs',
    'run: echo ${{ inputs.cells }}',
  ),
  'record.expression-in-run',
);
expectRule(
  'an input in the recorder command',
  mutate('--cells="$CELLS"', '--cells=${{ inputs.cells }}'),
  'record.expression-in-run',
);
expectRule(
  'an event field in a run block',
  mutate(
    'echo "Dry run:',
    'echo "${{ github.event.head_commit.message }} Dry run:',
  ),
  'record.expression-in-run',
);
expectRule(
  'an expression in a step name',
  mutate('- name: Validate the inputs', '- name: ${{ inputs.cells }}'),
  'record.expression-placement',
);
expectRule(
  'an expression in a with value',
  mutate(
    'persist-credentials: false',
    'persist-credentials: false\n          ref: ${{ inputs.cells }}',
  ),
  'record.expression-placement',
);
expectRule(
  'cells from a commit message',
  mutate(
    'CELLS: ${{ inputs.cells }}',
    'CELLS: ${{ github.event.head_commit.message }}',
  ),
  'record.expression-source',
);
expectRule(
  'cells from the versions input',
  mutate('CELLS: ${{ inputs.cells }}', 'CELLS: ${{ inputs.versions }}'),
  'record.expression-source',
);
expectRule(
  'the base branch from a head ref',
  mutate(
    'BASE_BRANCH: ${{ github.event.repository.default_branch }}',
    'BASE_BRANCH: ${{ github.head_ref }}',
  ),
  'record.expression-source',
);
expectRule(
  'text around an expression',
  mutate('CELLS: ${{ inputs.cells }}', 'CELLS: x${{ inputs.cells }}'),
  'record.expression-source',
);
expectRule(
  'an unknown variable name',
  mutate('CELLS: ${{ inputs.cells }}', 'EVIL: ${{ inputs.cells }}'),
  'record.expression-source',
);

// Branch guards
expectRule(
  'record without the default-branch guard',
  mutate(
    "    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)\n",
    '',
  ),
  'record.default-branch',
);
expectRule(
  'record guard on another ref',
  mutate(
    "format('refs/heads/{0}', github.event.repository.default_branch)",
    "'refs/heads/feature'",
  ),
  'record.default-branch',
);
expectRule(
  'propose runs on a dry run',
  mutate('if: ${{ !inputs.dry_run }}', 'if: ${{ inputs.dry_run }}'),
  'record.default-branch',
);
expectRule(
  'propose without a guard',
  mutate('    if: ${{ !inputs.dry_run }}\n', ''),
  'record.default-branch',
);
expectRule(
  'propose does not need record',
  mutate('    needs: record\n', ''),
  'record.default-branch',
);

// Token
expectRule(
  'the token in an earlier step',
  mutate(
    'DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}',
    'DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}\n          GH_TOKEN: ${{ github.token }}',
  ),
  'record.token',
);
expectRule(
  'the token under another name',
  mutate(
    'GH_TOKEN: ${{ github.token }}',
    'GH_TOKEN: ${{ github.token }}\n          TOKEN2: ${{ github.token }}',
  ),
  'record.expression-source',
);
expectRule(
  'the token as a checkout input',
  mutate(
    'persist-credentials: false',
    'persist-credentials: false\n          token: ${{ github.token }}',
  ),
  'record.checkout',
);
expectRule(
  'a repository secret',
  mutate('GH_REPO: ${{ github.repository }}', 'GH_REPO: ${{ secrets.PAT }}'),
  'record.token',
);
expectRule(
  'the token step is not last',
  `${base}      - run: echo done\n`,
  'record.token',
);

// Checkout
expectRule(
  'a checkout of another ref',
  mutate(
    'persist-credentials: false',
    'persist-credentials: false\n          ref: refs/heads/other',
  ),
  'record.checkout',
);
expectRule(
  'a checkout of another repository',
  mutate(
    'persist-credentials: false',
    'persist-credentials: false\n          repository: other/repo',
  ),
  'record.checkout',
);
expectRule(
  'persisted credentials',
  mutate('persist-credentials: false', 'persist-credentials: true'),
  'record.pinned',
);

// Step order and content
expectRule(
  'no clean-tree check',
  mutate('git status --porcelain', 'git status'),
  'record.steps',
);
expectRule(
  'no input validation in record',
  mutate(
    '      - name: Validate the inputs\n        env:\n          CELLS: ${{ inputs.cells }}\n          VERSIONS: ${{ inputs.versions }}\n        run: node apps/conformance/src/record/bundle-cli.ts validate-inputs',
    '      - name: Validate the inputs\n        env:\n          CELLS: ${{ inputs.cells }}\n          VERSIONS: ${{ inputs.versions }}\n        run: echo skipped',
  ),
  'record.steps',
);
expectRule(
  'validation twice',
  mutate(
    '      - name: The working tree',
    '      - run: node apps/conformance/src/record/bundle-cli.ts validate-inputs\n      - name: The working tree',
  ),
  'record.steps',
);
expectRule(
  'no upload',
  mutate(
    'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2',
    'actions/cache@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2',
  ),
  'record.steps',
);
expectRule(
  'the record step before the clean-tree check',
  mutate(
    '      - name: The working tree is the commit that is stamped\n        run: |\n          if [ -n',
    '      - name: The working tree is the commit that is stamped\n        run: |\n          pnpm nx run conformance:record\n          if [ -n',
  ),
  'record.steps',
);
expectRule(
  'no integrity check',
  mutate(
    'check --dir=dist/lab-evidence-bundle --integrity',
    'check --dir=dist/lab-evidence-bundle',
  ),
  'record.bundle-check',
);
expectRule(
  'the propose check writes no description',
  mutate(
    '--dir=dist/lab-evidence-bundle --pr-body=dist/pr-body.md',
    '--dir=dist/lab-evidence-bundle',
  ),
  'record.bundle-check',
);
expectRule(
  'the recorder writes to the evidence tree',
  mutate('--out=dist/lab-evidence-bundle', '--out=testing/lab-evidence'),
  'record.recorder-command',
);
expectRule(
  'unquoted cells',
  mutate('--cells="$CELLS"', '--cells=$CELLS'),
  'record.recorder-command',
);
expectRule(
  'unquoted versions',
  mutate('--versions="$VERSIONS"', '--versions=$VERSIONS'),
  'record.recorder-command',
);
expectRule(
  'another recorder command',
  mutate(
    'pnpm nx run conformance:record --cells',
    'pnpm nx run conformance:record --local --cells',
  ),
  'record.recorder-command',
);

// The write job
expectRule(
  'an install in the write job',
  mutate(
    '      - name: Put the bundle into the evidence tree of the branch',
    '      - run: pnpm install\n      - name: Put the bundle into the evidence tree of the branch',
  ),
  'record.write-job',
);
expectRule(
  'the setup action in the write job',
  mutate(
    '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version-file: .nvmrc\n',
    '      - uses: ./.github/actions/setup\n',
  ),
  'record.write-job',
);
expectRule(
  'another script run in the write job',
  mutate(
    '      - name: Put the bundle',
    '      - run: node dist/lab-evidence-bundle/run.js\n      - name: Put the bundle',
  ),
  'record.write-job',
);
expectRule(
  'an extra action in the write job',
  mutate(
    '      - name: Put the bundle',
    `      - uses: actions/cache@${SHA} # v4.0.0\n      - name: Put the bundle`,
  ),
  'record.write-job',
);
expectRule(
  'a copy that is not exactly the bundle into the tree',
  mutate(
    'cp -R dist/lab-evidence-bundle/. testing/lab-evidence/',
    'cp -R dist/lab-evidence-bundle/. .',
  ),
  'record.write-job',
);
expectRule(
  'a commit in the record job',
  mutate('git status --short >&2', 'git status --short >&2; git commit -am x'),
  'record.write-job',
);
expectRule(
  'gh in the record job',
  mutate('git status --short >&2', 'git status --short >&2; gh pr list'),
  'record.write-job',
);
expectRule(
  'the copy before the check',
  mutate(
    '      - name: Check the bundle again (nothing from it is run)',
    '      - run: cp -R dist/lab-evidence-bundle/. testing/lab-evidence/\n      - name: Check the bundle again (nothing from it is run)',
  ),
  'record.steps',
);
expectRule(
  'no download',
  mutate(
    'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2',
    'actions/cache@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2',
  ),
  'record.steps',
);

// The pull request step
expectRule('no label', mutate(' --label lab-evidence', ''), 'record.pr-step');
expectRule(
  'another label',
  mutate(' --label lab-evidence', ' --label chore'),
  'record.pr-step',
);
expectRule(
  'a push to the default branch',
  mutate(
    'git push origin "refs/heads/${branch}:refs/heads/${branch}"',
    'git push origin "HEAD:main"',
  ),
  'record.pr-step',
);
expectRule(
  'a second push',
  mutate(
    '          if ! gh label list',
    '          git push origin "refs/heads/${branch}:refs/heads/${branch}" --atomic\n          if ! gh label list',
  ),
  'record.pr-step',
);
expectRule(
  'a forced push',
  mutate(
    'git push origin "refs/heads/${branch}:refs/heads/${branch}"',
    'git push --force origin "refs/heads/${branch}:refs/heads/${branch}"',
  ),
  'record.pr-step',
);
expectRule(
  'no sign-off',
  mutate('git commit --signoff', 'git commit'),
  'record.pr-step',
);
expectRule(
  'no strict shell',
  mutate('set -euo pipefail', 'set +e'),
  'record.pr-step',
);
expectRule(
  'another branch name',
  mutate('branch="lab-evidence/run-', 'branch="main-'),
  'record.pr-step',
);
expectRule(
  'stage everything',
  mutate('git add -- testing/lab-evidence', 'git add --all'),
  'record.pr-step',
);
expectRule(
  'no path guard',
  mutate(
    "grep -Ev '^testing/lab-evidence/[0-9]+\\.[0-9]+\\.[0-9]+/CF-[A-Z0-9-]+\\.json$'",
    "grep -Ev '^testing/'",
  ),
  'record.pr-step',
);
expectRule(
  'the token echoed',
  mutate(
    'git config user.name',
    'echo "$GH_TOKEN"\n          git config user.name',
  ),
  'record.pr-step',
);
expectRule(
  'the token in the push address',
  mutate(
    'git push origin "refs/heads/${branch}:refs/heads/${branch}"',
    'git push "https://x:${GH_TOKEN}@github.com/o/r" "refs/heads/${branch}:refs/heads/${branch}"',
  ),
  'record.pr-step',
);
expectRule(
  'the header is not built in the environment',
  mutate(
    'GIT_CONFIG_VALUE_0="AUTHORIZATION',
    'GIT_CONFIG_VALUE_1="AUTHORIZATION',
  ),
  'record.pr-step',
);
expectRule(
  'another description file',
  mutate('--body-file dist/pr-body.md', '--body "$CELLS"'),
  'record.pr-step',
);
expectRule(
  'a pull request against another base',
  mutate('--base "$BASE_BRANCH"', '--base release'),
  'record.pr-step',
);

// No merge, approval, force or download of code
for (const [name, line] of [
  ['merge', 'gh pr merge --squash "$branch"'],
  ['auto-merge', 'gh pr merge --auto "$branch"'],
  ['review', 'gh pr review --approve "$branch"'],
  ['an api call', 'gh api -X PUT repos/x/y/pulls/1/merge'],
  ['a workflow dispatch', 'gh workflow run other.yml'],
  ['a git merge', 'git merge origin/main'],
  ['a force push of a tag', 'git push --tags'],
  ['a delete', 'git push origin --delete main'],
  ['curl', 'curl -s https://example.com/x.sh'],
  ['wget', 'wget https://example.com/x.sh'],
  ['gh pr ready', 'gh pr ready 1'],
  ['gh pr edit', 'gh pr edit 1 --add-reviewer x'],
  ['gh secret', 'gh secret list'],
  ['gh release', 'gh release create v1'],
  ['the word approve', 'echo approve'],
  ['an auto flag', 'gh pr create --auto'],
  ['an admin flag', 'gh pr create --admin'],
  ['a short force flag', 'git push -f origin x'],
  ['a plus refspec', 'git push origin +HEAD:main'],
  ['push all', 'git push --all'],
  ['push mirror', 'git push --mirror'],
  ['git add a dot', 'git add .'],
  ['git add -A', 'git add -A'],
] as const) {
  expectRule(
    name,
    mutate('gh pr create --base', `${line}\n          gh pr create --base`),
    'record.no-merge',
  );
}
expectRule(
  'github-script',
  mutate(
    '      - name: Put the bundle',
    `      - uses: actions/github-script@${SHA} # v7.0.0\n      - name: Put the bundle`,
  ),
  'record.no-merge',
);

// The artifact
expectRule(
  'an empty bundle is not an error',
  mutate('if-no-files-found: error', 'if-no-files-found: ignore'),
  'record.artifact',
);
expectRule(
  'another artifact name',
  mutate(
    'name: lab-evidence-bundle\n          path: dist/lab-evidence-bundle\n          if-no-files',
    'name: other\n          path: dist/lab-evidence-bundle\n          if-no-files',
  ),
  'record.artifact',
);
expectRule(
  'a download from another run',
  mutate(
    '          name: lab-evidence-bundle\n          path: dist/lab-evidence-bundle\n      - name: Check the bundle again',
    '          name: lab-evidence-bundle\n          path: dist/lab-evidence-bundle\n          run-id: 1\n      - name: Check the bundle again',
  ),
  'record.artifact',
);
expectRule(
  'a download with a token',
  mutate(
    '          name: lab-evidence-bundle\n          path: dist/lab-evidence-bundle\n      - name: Check the bundle again',
    '          name: lab-evidence-bundle\n          path: dist/lab-evidence-bundle\n          github-token: ${{ github.token }}\n      - name: Check the bundle again',
  ),
  'record.artifact',
);
expectRule(
  'a download into the evidence tree',
  mutate(
    '          name: lab-evidence-bundle\n          path: dist/lab-evidence-bundle\n      - name: Check the bundle again',
    '          name: lab-evidence-bundle\n          path: testing/lab-evidence\n      - name: Check the bundle again',
  ),
  'record.artifact',
);

// Pins
expectRule(
  'an action on a tag',
  mutate(
    'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2',
    'actions/download-artifact@v8',
  ),
  'record.pinned',
);
expectRule(
  'a pin without a version comment',
  mutate(
    'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0',
    'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
  ),
  'record.pinned',
);

spec('every rule of the check is exercised by at least one mutation', () => {
  for (const rule of HARDENING_RULES) {
    assert.ok(fired.has(rule), `no mutation fires ${rule}`);
  }
});

spec('a workflow that does not parse is refused', () => {
  assert.deepEqual(rulesOf('a: [unclosed'), ['record.triggers']);
});
