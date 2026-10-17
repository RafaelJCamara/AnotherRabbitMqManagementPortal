// node --test tools/agent-hooks/on-stop.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluate } from './on-stop.mjs';
import { runHook, tempTree } from './test-utils.mjs';

/**
 * A fake git and nx that record their calls.
 * @param {{ refs?: string[], changed?: string[], nxStatus?: number, nxOutput?: string,
 *   docsStatus?: number, hasContractsTarget?: boolean, timedOut?: boolean }} options
 */
function fakeIo({
  refs = ['origin/main', 'main'],
  changed = ['libs/shared/contracts/src/index.ts'],
  nxStatus = 0,
  nxOutput = '',
  docsStatus = 0,
  hasContractsTarget = false,
  timedOut = false,
} = {}) {
  const calls = { git: [], nx: [] };
  return {
    calls,
    git(args) {
      calls.git.push(args.join(' '));
      if (args[0] === 'rev-parse') {
        const ref = (args.at(-1) ?? '').replace('^{commit}', '');
        return { status: refs.includes(ref) ? 0 : 1, stdout: '' };
      }
      if (args[0] === 'merge-base') return { status: 0, stdout: 'abc123\n' };
      if (args[0] === 'diff')
        return { status: 0, stdout: `${changed.join('\n')}\n` };
      return { status: 0, stdout: '' }; // ls-files: no untracked files
    },
    nx(args) {
      calls.nx.push(args.join(' '));
      const docs = args[0] === 'run';
      return {
        status: docs ? docsStatus : nxStatus,
        output: docs ? 'api docs drifted' : nxOutput,
        timedOut,
      };
    },
    hasTarget: (project, target) =>
      hasContractsTarget &&
      project === 'contracts' &&
      target === 'api-docs-check',
  };
}

test('AC: failing affected tests make on-stop exit 2 with a summary', () => {
  const io = fakeIo({
    nxStatus: 1,
    nxOutput: 'a.spec.ts\n  FAIL  adds numbers\nFailed tasks:\n- engine:test\n',
  });
  const result = evaluate({}, io);
  assert.equal(result.code, 2);
  assert.match(result.message, /the affected checks fail/);
  assert.match(
    result.message,
    /nx affected -t lint typecheck test --base=origin\/main failed \(exit 1\)/,
  );
  assert.match(result.message, /FAIL {2}adds numbers/);
  assert.match(result.message, /engine:test/);
  assert.deepEqual(io.calls.nx, [
    'affected -t lint typecheck test --base=origin/main --parallel=3',
  ]);
});

test('AC: stop_hook_active makes on-stop exit 0 without running anything', () => {
  const io = fakeIo({ nxStatus: 1 });
  assert.deepEqual(evaluate({ stop_hook_active: true }, io), { code: 0 });
  assert.deepEqual(io.calls, { git: [], nx: [] });
});

test('passing checks exit 0', () => {
  const io = fakeIo({ nxStatus: 0 });
  assert.deepEqual(evaluate({ stop_hook_active: false }, io), { code: 0 });
  assert.equal(io.calls.nx.length, 1);
});

test('no changes since the merge base: nothing to check, nx is not started', () => {
  const io = fakeIo({ changed: [] });
  assert.deepEqual(evaluate({}, io), { code: 0 });
  assert.deepEqual(io.calls.nx, []);
});

test('the base falls back from origin/main to main to HEAD', () => {
  const noRemote = fakeIo({ refs: ['main'] });
  evaluate({}, noRemote);
  assert.match(noRemote.calls.nx[0] ?? '', /--base=main /);

  const nothing = fakeIo({ refs: [] });
  evaluate({}, nothing);
  assert.match(nothing.calls.nx[0] ?? '', /--base=HEAD /);
});

test('a timeout is reported as a timeout', () => {
  const result = evaluate({}, fakeIo({ nxStatus: 1, timedOut: true }));
  assert.equal(result.code, 2);
  assert.match(result.message, /timed out/);
});

test('contracts:api-docs-check runs when contracts changed and the project has the target', () => {
  const io = fakeIo({ hasContractsTarget: true });
  assert.deepEqual(evaluate({}, io), { code: 0 });
  assert.deepEqual(io.calls.nx, [
    'affected -t lint typecheck test --base=origin/main --parallel=3',
    'run contracts:api-docs-check',
  ]);

  const drift = fakeIo({ hasContractsTarget: true, docsStatus: 1 });
  const result = evaluate({}, drift);
  assert.equal(result.code, 2);
  assert.match(result.message, /contracts:api-docs-check failed/);
});

test('contracts:api-docs-check is skipped when contracts did not change or the target does not exist', () => {
  const other = fakeIo({
    changed: ['apps/web/src/app/app.ts'],
    hasContractsTarget: true,
  });
  evaluate({}, other);
  assert.equal(other.calls.nx.length, 1);

  const noTarget = fakeIo({ hasContractsTarget: false });
  evaluate({}, noTarget);
  assert.equal(noTarget.calls.nx.length, 1);
});

test('both failures are reported together', () => {
  const result = evaluate(
    {},
    fakeIo({ nxStatus: 1, docsStatus: 1, hasContractsTarget: true }),
  );
  assert.equal(result.code, 2);
  assert.match(result.message, /nx affected/);
  assert.match(result.message, /api-docs-check/);
});

// ---------------------------------------------------------------------------------------------
// The real script against a throwaway repository with a fake nx
// ---------------------------------------------------------------------------------------------

const git = (cwd, ...args) => {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
};

/** A repository on `main` with one commit, a modified file, and a fake `nx` that exits with `exit`. */
function fakeRepo(exit) {
  const tree = tempTree({
    '.gitignore': 'node_modules\nnx-args.json\n',
    'a.txt': 'one\n',
    'node_modules/nx/package.json': JSON.stringify({
      name: 'nx',
      type: 'module',
      bin: { nx: './nx.js' },
    }),
    'node_modules/nx/nx.js': [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('nx-args.json', JSON.stringify(process.argv.slice(2)));",
      "console.log('FAILED: engine:test');",
      `process.exit(${exit});`,
      '',
    ].join('\n'),
  });
  git(tree.dir, 'init', '-q', '-b', 'main');
  git(tree.dir, 'add', '.');
  git(tree.dir, 'commit', '-q', '-m', 'init');
  writeFileSync(join(tree.dir, 'a.txt'), 'two\n');
  return tree;
}

test('script: failing nx exits 2 and the summary reaches stderr', () => {
  const repo = fakeRepo(1);
  try {
    const result = runHook(
      'on-stop.mjs',
      { hook_event_name: 'Stop' },
      { AGENT_HOOKS_ROOT: repo.dir },
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /the affected checks fail/);
    assert.match(result.stderr, /FAILED: engine:test/);
    const args = JSON.parse(
      readFileSync(join(repo.dir, 'nx-args.json'), 'utf8'),
    );
    assert.deepEqual(args, [
      'affected',
      '-t',
      'lint',
      'typecheck',
      'test',
      '--base=main',
      '--parallel=3',
    ]);
  } finally {
    repo.cleanup();
  }
});

test('script: stop_hook_active exits 0 and never starts nx', () => {
  const repo = fakeRepo(1);
  try {
    const result = runHook(
      'on-stop.mjs',
      { hook_event_name: 'Stop', stop_hook_active: true },
      { AGENT_HOOKS_ROOT: repo.dir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(repo.dir, 'nx-args.json')), false);
  } finally {
    repo.cleanup();
  }
});

test('script: passing nx exits 0; an untouched repository skips nx', () => {
  const passing = fakeRepo(0);
  try {
    const result = runHook(
      'on-stop.mjs',
      { hook_event_name: 'Stop' },
      { AGENT_HOOKS_ROOT: passing.dir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(passing.dir, 'nx-args.json')), true);

    rmSync(join(passing.dir, 'nx-args.json'));
    git(passing.dir, 'checkout', '--', 'a.txt');
    const clean = runHook(
      'on-stop.mjs',
      { hook_event_name: 'Stop' },
      { AGENT_HOOKS_ROOT: passing.dir },
    );
    assert.equal(clean.status, 0);
    assert.equal(existsSync(join(passing.dir, 'nx-args.json')), false);
  } finally {
    passing.cleanup();
  }
});
