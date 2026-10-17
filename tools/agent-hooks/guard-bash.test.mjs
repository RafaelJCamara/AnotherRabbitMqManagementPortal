// node --test tools/agent-hooks/guard-bash.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { check, parseSpec, tokenize } from './guard-bash.mjs';
import { runHook } from './test-utils.mjs';

const allowlist = new Set(['eslint', 'vitest', 'zod', '@nx/js', '@types/node']);
const onFeatureBranch = {
  allowlist: () => allowlist,
  currentBranch: () => 'wi/M0-07-agents',
};
const onMain = { allowlist: () => allowlist, currentBranch: () => 'main' };
const noAllowlist = { allowlist: () => undefined, currentBranch: () => 'wi/x' };

/** [command, text the reason must contain] */
const blocked = [
  // dependencies
  ['pnpm add left-pad@1.3.0', 'not in tools/supply-chain/deps-allowlist.json'],
  ['pnpm add -D eslint', 'exact version'],
  ['pnpm add -D eslint@^10.12.0', 'exact version'],
  ['pnpm add zod@latest', 'exact version'],
  ['pnpm i zod', 'exact version'],
  ['pnpm install zod@~4.6.7', 'exact version'],
  ['pnpm --filter web add left-pad@1.3.0', 'allow-list'],
  ['pnpm -C apps/web add left-pad@1.3.0', 'allow-list'],
  ['pnpm add github:foo/bar', 'git, tarball and local-path'],
  ['pnpm add https://example.com/x.tgz', 'git, tarball and local-path'],
  ['pnpm add ./vendor/x', 'git, tarball and local-path'],
  ['pnpm add file:../x', 'git, tarball and local-path'],
  ['pnpm add zod@git+https://github.com/colinhacks/zod', 'exact version'],
  ['pnpm up', 'bulk'],
  ['pnpm update --latest', '--latest'],
  ['pnpm up -L zod', '--latest'],
  ['pnpm up left-pad@1.3.0', 'allow-list'],
  ['pnpm add -g typescript@6.0.3', 'global'],
  ['pnpm install --global zod@4.6.7', 'global'],
  ['npm i -g typescript', 'global'],
  ['npm install --global typescript', 'global'],
  ['yarn global add typescript', 'global'],
  ['npm install left-pad', 'outside the pnpm workspace rules'],
  ['bun add left-pad', 'outside the pnpm workspace rules'],
  // hooks
  ['git commit --no-verify -m "fix: x"', '--no-verify'],
  ['git commit -nm "fix: x"', '--no-verify'],
  ['git commit -n -m "fix: x"', '--no-verify'],
  ['git push --no-verify origin wi/x', '--no-verify'],
  ['git rebase --no-verify origin/main', '--no-verify'],
  // force and main
  ['git push --force', 'force'],
  ['git push -f origin wi/x', 'force'],
  ['git push -uf origin wi/x', 'force'],
  ['git push --force-with-lease origin wi/x', 'force'],
  ['git push --force-with-lease=wi/x:abc origin wi/x', 'force'],
  ['git push origin +wi/x', 'force'],
  ['git push origin main', 'main'],
  ['git push origin master', 'main'],
  ['git push origin HEAD:main', 'main'],
  ['git push origin HEAD:refs/heads/main', 'main'],
  ['git push origin wi/x:main', 'main'],
  ['git push origin :main', 'main'],
  ['git push origin --delete main', 'main'],
  ['git push --all', 'main'],
  ['git push --mirror origin', 'main'],
  ['git push -u origin main', 'main'],
  // wrappers and compound commands
  ['cd /tmp && git push origin main', 'main'],
  ['pnpm install; git push -f', 'force'],
  ['FOO=1 git push -f origin wi/x', 'force'],
  ['env GIT_TRACE=1 git push --force', 'force'],
  ['sudo npm i -g x', 'global'],
  ['bash -c "git push --force"', 'force'],
  ["sh -c 'pnpm add left-pad@1.3.0'", 'allow-list'],
  ['bash -lc "cd x && git push origin main"', 'main'],
  ['pwsh -Command "git push -f"', 'force'],
  ['git -C ../other push origin main', 'main'],
  ['git -c core.editor=true push --force', 'force'],
  ['echo $(git push --force)', 'force'],
  ['(git push --no-verify)', '--no-verify'],
  ['git commit -m x\ngit push --force', 'force'],
  ['/usr/bin/git push --force', 'force'],
  ['pnpm.cmd add left-pad@1.3.0', 'allow-list'],
];
for (const [command, text] of blocked) {
  test(`blocks: ${command.replaceAll('\n', '\\n')}`, () => {
    const reasons = check(command, onFeatureBranch);
    assert.ok(reasons.length > 0, 'expected a reason');
    assert.ok(
      reasons.some((reason) => reason.includes(text)),
      `reasons ${JSON.stringify(reasons)} should mention "${text}"`,
    );
  });
}

test('a bare push on main is blocked, a bare push on a work branch is not', () => {
  for (const command of [
    'git push',
    'git push origin',
    'git push origin HEAD',
    'git push -u origin HEAD',
  ]) {
    assert.ok(
      check(command, onMain).some((reason) => reason.includes('main')),
      command,
    );
    assert.deepEqual(check(command, onFeatureBranch), [], command);
  }
});

test('an unreadable allow-list blocks dependency adds (fail closed)', () => {
  const reasons = check('pnpm add zod@4.6.7', noAllowlist);
  assert.ok(reasons.some((reason) => reason.includes('could not be read')));
});

const allowed = [
  'pnpm install',
  'pnpm i',
  'pnpm install --frozen-lockfile',
  'pnpm add -D eslint@10.12.0',
  'pnpm add zod@4.6.7',
  'pnpm add zod@catalog:',
  'pnpm add -D @types/node@24.19.2',
  'pnpm add @app/contracts@workspace:*',
  'pnpm --filter web add zod@catalog:',
  'pnpm up zod@4.6.8',
  'pnpm remove zod',
  'pnpm nx run-many -t build test typecheck lint',
  'pnpm nx affected -t lint typecheck test --base=origin/main --parallel=3',
  'pnpm exec eslint --fix tools/agent-hooks',
  'pnpm format:check',
  'npm view zod version',
  'npm ci',
  'git status',
  'git diff origin/main',
  'git log --oneline -5',
  'git checkout main',
  'git fetch origin && git rebase origin/main',
  'git commit -s -m "feat(agents): add hooks"',
  'git commit -sm "feat(agents): add hooks"',
  'git commit -m "docs: never use --no-verify or git push --force"',
  'git commit -m "-n"',
  'git commit --amend --no-edit',
  'git push origin wi/M0-07-agents',
  'git push -u origin HEAD',
  'git push origin HEAD:wi/M0-07-agents',
  'git push origin v1.0.0',
  'git push --tags',
  'git worktree add ../wt/M0-14 -b wi/M0-14-x origin/main',
  'echo "pnpm add left-pad"',
  "grep -rn 'git push --force' docs",
  'ls > out.txt',
  'pnpm add zod@4.6.7 2>&1',
  'pnpm nx test agent-hooks > /dev/null 2>&1',
  '',
  '   ',
  '# git push --force',
  'cat <<EOF\nnothing here\nEOF',
];
for (const command of allowed) {
  test(`allows: ${JSON.stringify(command)}`, () => {
    assert.deepEqual(check(command, onFeatureBranch), []);
  });
}

test('tokenize: quotes group words and hide separators', () => {
  assert.deepEqual(tokenize('git commit -m "a && b; c" && echo \'x | y\''), [
    ['git', 'commit', '-m', 'a && b; c'],
    ['echo', 'x | y'],
  ]);
  assert.deepEqual(tokenize('a\\ b c'), [['a b', 'c']]);
  assert.deepEqual(tokenize('x # trailing comment\ny'), [['x'], ['y']]);
});

test('parseSpec keeps the scope', () => {
  assert.deepEqual(parseSpec('zod'), { name: 'zod' });
  assert.deepEqual(parseSpec('zod@4.6.7'), { name: 'zod', version: '4.6.7' });
  assert.deepEqual(parseSpec('@nx/js@23.3.0'), {
    name: '@nx/js',
    version: '23.3.0',
  });
  assert.deepEqual(parseSpec('@nx/js'), { name: '@nx/js' });
});

test('CLI: exit 2 with the reason on stderr; exit 0 for a harmless command', () => {
  const bad = runHook('guard-bash.mjs', {
    tool_name: 'Bash',
    tool_input: { command: 'git commit --no-verify -m x' },
  });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /guard-bash: blocked/);
  assert.match(bad.stderr, /--no-verify/);

  const good = runHook('guard-bash.mjs', {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm nx test agent-hooks' },
  });
  assert.equal(good.status, 0);
});

test('CLI: reads the real allow-list (pnpm add of an unlisted package is blocked)', () => {
  const unlisted = runHook('guard-bash.mjs', {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm add left-pad@1.3.0' },
  });
  assert.equal(unlisted.status, 2);
  assert.match(unlisted.stderr, /deps-allowlist\.json/);

  const listed = runHook('guard-bash.mjs', {
    tool_name: 'Bash',
    tool_input: { command: 'pnpm add -D eslint@10.12.0' },
  });
  assert.equal(listed.status, 0);
});

test('CLI: force-push is blocked; a malformed payload fails closed; empty input passes', () => {
  const push = runHook('guard-bash.mjs', {
    tool_name: 'Bash',
    tool_input: { command: 'git push --force origin wi/x' },
  });
  assert.equal(push.status, 2);
  assert.equal(runHook('guard-bash.mjs', '{oops').status, 2);
  assert.equal(runHook('guard-bash.mjs', '').status, 0);
  assert.equal(
    runHook('guard-bash.mjs', { tool_name: 'Bash', tool_input: {} }).status,
    0,
  );
});
