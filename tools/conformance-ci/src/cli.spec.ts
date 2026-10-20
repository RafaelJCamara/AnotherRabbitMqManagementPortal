// The command-line entry points the workflows run (`node tools/conformance-ci/src/<tool>-cli.ts`),
// run here as processes: the environment goes in, the exit code and the files the workflow reads
// ($GITHUB_OUTPUT, the step summary, the report) come out. The pure functions behind them are
// tested in their own specs; this file pins what only the process shows: that the wiring is right,
// that an unreadable input fails closed, and that nothing is written when the tool refuses.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { readLabVersions, VERSIONS_FILE } from './lab-versions.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const cli = (name: string): string => join(import.meta.dirname, name);

const scratch = mkdtempSync(join(tmpdir(), 'conformance-ci-cli-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let n = 0;
let legDirectories = 0;
let summary: string;
let outputs: string;
beforeEach(() => {
  n += 1;
  summary = join(scratch, `summary-${String(n)}.md`);
  outputs = join(scratch, `output-${String(n)}.txt`);
});

/** The variables a workflow run would hand the tool; none of this process's own GitHub ones leak in. */
const environment = (
  extra: Readonly<Record<string, string>>,
): Record<string, string> => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^(GITHUB_|BASE$|HEAD$|SHARDS$|AFFECTED$|PLAN_|LAB_|RELEASE_|ALPHA_)/.test(
          entry[0],
        ),
    ),
  );
  return { ...inherited, ...extra };
};

const run = (
  tool: string,
  env: Readonly<Record<string, string>>,
  args: string[] = [],
) => {
  const result = spawnSync(process.execPath, [cli(tool), ...args], {
    cwd: scratch,
    env: environment(env),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const read = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8') : null;

describe('the command-line tools of the conformance workflows', () => {
  it('AC-7a (M0-FIX-1) verdict-cli exits 0 only on a pass, and writes its line to the step summary', () => {
    const cases: [
      name: string,
      env: Record<string, string>,
      status: number,
      line: RegExp,
    ][] = [
      [
        'not affected, lab skipped',
        { AFFECTED: 'false', PLAN_RESULT: 'success', LAB_RESULT: 'skipped' },
        0,
        /^conformance: pass: not affected/,
      ],
      [
        'affected, lab succeeded',
        { AFFECTED: 'true', PLAN_RESULT: 'success', LAB_RESULT: 'success' },
        0,
        /^conformance: pass: affected: every lab version and shard succeeded/,
      ],
      [
        'affected, lab failed',
        { AFFECTED: 'true', PLAN_RESULT: 'success', LAB_RESULT: 'failure' },
        1,
        /^conformance: FAIL: affected: the lab job was failure/,
      ],
      [
        'affected, lab skipped (nobody ran the matrix)',
        { AFFECTED: 'true', PLAN_RESULT: 'success', LAB_RESULT: 'skipped' },
        1,
        /^conformance: FAIL: affected: the lab job was skipped/,
      ],
      [
        'the plan failed',
        { AFFECTED: 'false', PLAN_RESULT: 'failure', LAB_RESULT: 'skipped' },
        1,
        /^conformance: FAIL: the plan job did not succeed \(failure\)/,
      ],
      [
        'the plan said nothing usable',
        { AFFECTED: 'TRUE', PLAN_RESULT: 'success', LAB_RESULT: 'success' },
        1,
        /^conformance: FAIL: the plan did not say whether/,
      ],
      [
        'a job result it does not know',
        { AFFECTED: 'true', PLAN_RESULT: 'success', LAB_RESULT: 'passed' },
        1,
        /^conformance: FAIL: affected: the lab job was failure/,
      ],
      [
        'nothing in the environment at all',
        {},
        1,
        /^conformance: FAIL: the plan job did not succeed \(failure\)/,
      ],
    ];
    for (const [name, env, status, line] of cases) {
      rmSync(summary, { force: true });
      const result = run('verdict-cli.ts', {
        ...env,
        GITHUB_STEP_SUMMARY: summary,
      });
      expect([name, result.status], result.stderr).toEqual([name, status]);
      expect(result.stdout.trim(), name).toMatch(line);
      expect(read(summary), name).toBe(`${result.stdout.trim()}\n`);
    }
    // Without a step summary (a local run) the verdict is the same and nothing is written.
    rmSync(summary, { force: true });
    const local = run('verdict-cli.ts', {
      AFFECTED: 'false',
      PLAN_RESULT: 'success',
      LAB_RESULT: 'skipped',
    });
    expect(local.status).toBe(0);
    expect(read(summary)).toBeNull();
  });

  describe('report-cli', () => {
    const planned = JSON.stringify({
      include: [
        { version: '4.3.6', node: '24.22.0' },
        { version: '4.3.6', node: '26.12.0' },
      ],
    });
    const noAlpha = JSON.stringify({ include: [] });
    const legs = (statuses: Record<string, string>): string => {
      legDirectories += 1;
      const directory = join(scratch, `legs-${String(legDirectories)}`);
      for (const [name, status] of Object.entries(statuses)) {
        mkdirSync(join(directory, name), { recursive: true });
        writeFileSync(join(directory, name, 'result'), `${status}\n`);
      }
      mkdirSync(directory, { recursive: true });
      return directory;
    };
    const base = {
      PLAN_RESULT: 'success',
      PLAN_RELEASE: planned,
      PLAN_ALPHA: noAlpha,
      RELEASE_RESULT: 'success',
      ALPHA_RESULT: 'skipped',
    };
    const report = (
      env: Record<string, string>,
      directory: string,
    ): { status: number | null; markdown: string | null } => {
      const out = join(directory, 'out', 'report.md');
      const result = run(
        'report-cli.ts',
        { ...env, GITHUB_STEP_SUMMARY: summary },
        [`--legs=${directory}`, `--out=${out}`],
      );
      expect(result.stderr).not.toMatch(/Error/);
      return { status: result.status, markdown: read(out) };
    };

    it('AC-7b (M0-FIX-1) report-cli exits 0 when every blocking leg succeeded and 1 when one did not, and never shows a missing leg as a pass', () => {
      const ok = legs({
        'leg-node-24.22.0-release-4.3.6': 'success',
        'leg-node-26.12.0-release-4.3.6': 'success',
      });
      const good = report(base, ok);
      expect(good.status).toBe(0);
      expect(good.markdown).toContain('Every blocking leg succeeded.');
      expect(good.markdown).toContain(
        '| node-26.12.0 | release | 4.3.6 | pass |',
      );
      // The same table goes to the step summary, and to --out.
      expect(read(summary)).toBe(`${good.markdown ?? ''}\n`);

      const failed = report(
        { ...base, RELEASE_RESULT: 'failure' },
        legs({
          'leg-node-24.22.0-release-4.3.6': 'success',
          'leg-node-26.12.0-release-4.3.6': 'failure',
        }),
      );
      expect(failed.status).toBe(1);
      expect(failed.markdown).toContain(
        '| node-26.12.0 | release | 4.3.6 | FAIL |',
      );

      // A planned leg nobody reported, and a status word that is not one, both read as "did not run".
      for (const statuses of [
        { 'leg-node-24.22.0-release-4.3.6': 'success' },
        {
          'leg-node-24.22.0-release-4.3.6': 'success',
          'leg-node-26.12.0-release-4.3.6': 'passed',
        },
      ]) {
        const missing = report(base, legs(statuses));
        expect(missing.status).toBe(1);
        expect(missing.markdown).toContain(
          '| node-26.12.0 | release | 4.3.6 | did not run |',
        );
      }

      // Directories that are not legs are ignored; no legs directory at all is a run that did not happen.
      const stray = legs({
        'leg-node-24.22.0-release-4.3.6': 'success',
        'leg-node-26.12.0-release-4.3.6': 'success',
        'not-a-leg': 'failure',
      });
      expect(report(base, stray).status).toBe(0);
      const absent = report(base, join(scratch, 'no-such-directory'));
      expect(absent.status).toBe(1);
      expect(absent.markdown).toContain('did not run');

      // The plan or its output cannot be read: the nightly fails, with a row that says so.
      for (const env of [
        { ...base, PLAN_RESULT: 'failure' },
        { ...base, PLAN_RELEASE: 'not json' },
        { ...base, PLAN_ALPHA: '' },
        {},
      ]) {
        const result = report(env, ok);
        expect(result.status, JSON.stringify(env)).toBe(1);
        expect(result.markdown, JSON.stringify(env)).toContain(
          'plan (no leg was planned)',
        );
      }
    });
  });

  it('AC-7c (M0-FIX-1) plan-cli plans the whole matrix on any doubt, writes only the two output lines, and refuses a bad shard count without writing', () => {
    const versions = readLabVersions(join(root, VERSIONS_FILE));
    const parsed = (text: string | null) => {
      const lines = (text ?? '').split('\n');
      expect(lines.at(-1), 'ends with a newline').toBe('');
      expect(lines.map((line) => line.split('=')[0])).toEqual([
        'affected',
        'matrix',
        '',
      ]);
      return {
        affected: lines[0],
        matrix: JSON.parse(lines[1]?.slice('matrix='.length) ?? 'null') as {
          include: { version: string; shard: string }[];
        },
      };
    };
    const expected = (shards: number) =>
      versions.flatMap((version) =>
        Array.from({ length: shards }, (_, i) => ({
          version,
          shard: `${String(i + 1)}/${String(shards)}`,
        })),
      );

    // No base: affected, the full matrix, a note saying why.
    const none = run('plan-cli.ts', {
      HEAD: 'HEAD',
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(none.status, none.stderr).toBe(0);
    const plan = parsed(read(outputs));
    expect(plan.affected).toBe('affected=true');
    expect(plan.matrix.include).toEqual(expected(2));
    expect(none.stdout).toContain('conformance plan: affected');
    expect(none.stdout).toContain('note: no usable base revision');
    // What the log shows is what the step summary keeps.
    expect(read(summary)).toBe(none.stdout);

    // The shard count is the environment's.
    rmSync(outputs, { force: true });
    const three = run('plan-cli.ts', { SHARDS: '3', GITHUB_OUTPUT: outputs });
    expect(three.status, three.stderr).toBe(0);
    expect(parsed(read(outputs)).matrix.include).toEqual(expected(3));

    // A base that is not a safe revision is never passed to git, and a commit the checkout lacks
    // counts as doubt: both run the matrix.
    for (const [base, note] of [
      ['--output=/tmp/x', 'no usable base revision'],
      ['0000000000000000000000000000000000000000', 'no usable base revision'],
      [
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        'is not a commit of this checkout',
      ],
    ] as const) {
      rmSync(outputs, { force: true });
      const doubt = run('plan-cli.ts', { BASE: base, GITHUB_OUTPUT: outputs });
      expect([base, doubt.status], doubt.stderr).toEqual([base, 0]);
      expect(doubt.stdout, base).toContain(note);
      expect(parsed(read(outputs)).affected, base).toBe('affected=true');
    }

    // Not in a workflow: the lines go to stdout.
    const printed = run('plan-cli.ts', {});
    expect(printed.status).toBe(0);
    expect(printed.stdout).toContain('affected=true\nmatrix={"include":[');

    // A shard count that cannot be trusted stops the tool before it writes anything.
    for (const bad of ['0', '17', 'two', '2.5']) {
      rmSync(outputs, { force: true });
      const refused = run('plan-cli.ts', {
        SHARDS: bad,
        GITHUB_OUTPUT: outputs,
      });
      expect([bad, refused.status === 0], refused.stderr).toEqual([bad, false]);
      expect(refused.stderr, bad).toContain('SHARDS must be a whole number');
      expect(read(outputs), bad).toBeNull();
    }
  }, 120_000);
});
