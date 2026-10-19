// The CLI against real git repositories in temporary folders: it must read the base from the base
// commit (not the disk), see untracked evidence, and fail closed. The registry is a small data
// module in each repository (`--data`); the real registry is checked by the last test.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, readTree, UsageError } from './cli.ts';
import type { RunApi, RunInfo } from './runs.ts';
import { ciStamp, DIGEST, fakeEvidence, REPOSITORY } from './testing.ts';

const CELL = {
  id: 'SEM-4.3-quorum-amqp091-nack',
  key: {
    era: '4.3',
    queueType: 'quorum',
    protocol: 'amqp091',
    action: 'amqp091.nack_requeue',
  },
  effect: { deltaAC: 1, deltaDC: 0, position: 'head' },
  citations: [],
  conformance: ['CF-SMOKE-01'],
  status: 'code-derived',
  evidence: [] as string[],
};

let dir: string;
const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const write = (path: string, text: string): void => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};
const registry = (cell: Partial<typeof CELL>): void => {
  write(
    'registry.ts',
    `export const registryData = { cells: ${JSON.stringify([{ ...CELL, ...cell }])} };\n`,
  );
};
const commit = (message: string): string => {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};

const run = (api?: RunApi, ...extra: string[]) =>
  main(
    [
      '--base=HEAD',
      `--root=${dir}`,
      '--data=registry.ts',
      `--repo=${REPOSITORY}`,
      ...extra,
    ],
    {},
    api === undefined ? {} : { runApi: api },
  );

const goodRun = (sha: string): RunInfo => ({
  repository: REPOSITORY,
  headRepository: REPOSITORY,
  path: '.github/workflows/conformance-record.yml',
  headSha: sha,
  headBranch: 'main',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  runAttempt: 1,
  startedAt: '2026-10-19T09:50:00Z',
  updatedAt: '2026-10-19T10:05:00Z',
});

let errors: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'semantics-evidence-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  write(
    'testing/broker-lab/versions.json',
    JSON.stringify({ brokers: [{ version: '4.3.6', digest: DIGEST }] }),
  );
  registry({});
  commit('base');
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('semantics-evidence CLI', () => {
  it('AC-1 passes when nothing changed', async () => {
    await expect(run()).resolves.toBe(0);
  });

  it('AC-1 fails a cell flipped to lab-verified in the working tree with no evidence', async () => {
    registry({ status: 'lab-verified' });

    await expect(run()).resolves.toBe(1);
    expect(errors.join('\n')).toContain(
      'status changed from code-derived to lab-verified',
    );
  }, 60_000);

  it('AC-1 reads the base from the base commit, not from the disk', async () => {
    const first = git('rev-parse', 'HEAD');
    registry({ effect: { deltaAC: 0, deltaDC: 1, position: 'tail' } });
    commit('change the effect');

    await expect(run(undefined, `--base=${first}`)).resolves.toBe(1);
    expect(errors.join('\n')).toContain(
      'effect changed without a valid evidence artefact',
    );
    errors.length = 0;
    await expect(run()).resolves.toBe(0);
  }, 60_000);

  it('AC-1 sees an untracked artefact, checks its run and lets the flip through when the run is good', async () => {
    const sha = git('rev-parse', 'HEAD');
    const fake = fakeEvidence({ provenance: ciStamp({ gitSha: sha }) });
    write(`testing/lab-evidence/${fake.path}`, fake.text);
    registry({
      status: 'lab-verified',
      evidence: [`testing/lab-evidence/${fake.path}`],
    });
    const getRun = vi.fn(() => Promise.resolve(goodRun(sha)));

    await expect(run({ getRun })).resolves.toBe(0);
    expect(getRun).toHaveBeenCalledWith(REPOSITORY, '777', '1');
  }, 60_000);

  it('AC-1 fails the same flip when the run the stamp names is not a good one, or cannot be asked', async () => {
    const sha = git('rev-parse', 'HEAD');
    const fake = fakeEvidence({ provenance: ciStamp({ gitSha: sha }) });
    write(`testing/lab-evidence/${fake.path}`, fake.text);
    registry({
      status: 'lab-verified',
      evidence: [`testing/lab-evidence/${fake.path}`],
    });

    const failed = await run({
      getRun: () => Promise.resolve({ ...goodRun(sha), conclusion: 'failure' }),
    });
    const down = await run({
      getRun: () => Promise.reject(new Error('offline')),
    });
    const unknownRepository = await main(
      ['--base=HEAD', `--root=${dir}`, '--data=registry.ts'],
      {},
      { runApi: { getRun: () => Promise.resolve(goodRun(sha)) } },
    );

    expect([failed, down, unknownRepository]).toEqual([1, 1, 1]);
    const text = errors.join('\n');
    expect(text).toContain('completed, failure');
    expect(text).toContain('offline');
    expect(text).toContain('the repository is unknown');
  }, 60_000);

  it('AC-1 checks the run of an untracked artefact no cell lists, and of one the change committed or modified, but not of one the base already had', async () => {
    const first = git('rev-parse', 'HEAD');
    const api = (info: (sha: string) => RunInfo, sha: string) => {
      const getRun = vi.fn(() => Promise.resolve(info(sha)));
      return { api: { getRun } satisfies RunApi, getRun };
    };
    const bad = (sha: string) =>
      api((s) => ({ ...goodRun(s), conclusion: 'failure' }), sha);
    const good = (sha: string) => api(goodRun, sha);
    const fake = fakeEvidence({ provenance: ciStamp({ gitSha: first }) });

    // Untracked.
    write(`testing/lab-evidence/${fake.path}`, fake.text);
    expect(await run(bad(first).api)).toBe(1);
    expect(await run(good(first).api)).toBe(0);

    // Committed after the base: still the change's.
    const second = commit('add the artefact');
    expect(await run(bad(second).api, `--base=${first}`)).toBe(1);

    // Already in the base: nothing asks the API.
    const unchanged = good(second);
    expect(await run(unchanged.api)).toBe(0);
    expect(unchanged.getRun).not.toHaveBeenCalled();

    // Modified in the working tree (resealed with another title): the change's again.
    const edited = fakeEvidence({
      provenance: ciStamp({ gitSha: first }),
      body: { title: 'edited' },
    });
    write(`testing/lab-evidence/${edited.path}`, edited.text);
    expect(await run(bad(second).api)).toBe(1);

    // Deleted: there is nothing left to check.
    rmSync(join(dir, 'testing', 'lab-evidence', fake.path));
    const none = good(second);
    expect(await run(none.api)).toBe(0);
    expect(none.getRun).not.toHaveBeenCalled();
  }, 120_000);

  it('AC-1 reads the base from the base commit when the repository is reached through a link (a temporary folder on macOS)', async () => {
    const first = git('rev-parse', 'HEAD');
    registry({ effect: { deltaAC: 0, deltaDC: 1, position: 'tail' } });
    commit('change the effect');
    const link = `${dir}-link`;
    symlinkSync(dir, link, 'junction');
    try {
      const code = await main(
        [
          `--base=${first}`,
          `--root=${link}`,
          '--data=registry.ts',
          `--repo=${REPOSITORY}`,
        ],
        {},
        {},
      );

      expect(code).toBe(1);
      expect(errors.join('\n')).toContain(
        'effect changed without a valid evidence artefact',
      );
    } finally {
      unlinkSync(link);
    }
  }, 60_000);

  it('I-10 reads the registry in a child process that does not hold the GitHub token', async () => {
    // The data module of this repository plays the part of the registry code of a change under check.
    write(
      'registry.ts',
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'seen.txt'))}, String(process.env.GITHUB_TOKEN) + '|' + String(process.env.GH_TOKEN));
export const registryData = { cells: ${JSON.stringify([CELL])} };
`,
    );
    commit('a registry that looks for tokens');
    vi.stubEnv('GITHUB_TOKEN', 'canary-one');
    vi.stubEnv('GH_TOKEN', 'canary-two');

    await expect(run()).resolves.toBe(0);

    expect(readFileSync(join(dir, 'seen.txt'), 'utf8')).toBe(
      'undefined|undefined',
    );
  }, 60_000);

  it('AC-1 fails an untracked artefact with local provenance, listed by a cell or not', async () => {
    const fake = fakeEvidence({
      provenance: {
        kind: 'local',
        recorder: 'conformance:record',
        gitSha: null,
        recordedAt: '2026-10-19T10:00:00.000Z',
      },
    });
    write(`testing/lab-evidence/${fake.path}`, fake.text);

    await expect(run()).resolves.toBe(1);
    expect(errors.join('\n')).toContain('provenance is local');
  }, 60_000);

  it('refuses a missing or unsafe base, an unknown argument and a base that is not an ancestor relation', async () => {
    await expect(main([`--root=${dir}`])).rejects.toThrow(UsageError);
    await expect(
      main(['--base=--upload-pack=x', `--root=${dir}`]),
    ).rejects.toThrow(UsageError);
    await expect(
      main(['--base=no-such-branch', `--root=${dir}`, '--data=registry.ts']),
    ).rejects.toThrow('common ancestor');
    expect(() => parseArgs(['--base=origin/main', '--colour'])).toThrow(
      'unknown argument',
    );
    expect(() => parseArgs(['--base=origin/main', '--repo=nope'])).toThrow(
      'owner/name',
    );
  });

  it('reads the policy from the options', () => {
    expect(
      parseArgs([
        '--base=a',
        '--branches=main,release',
        '--events=workflow_dispatch,schedule',
        '--workflow=r.yml',
        '--verify-all-runs',
      ]),
    ).toMatchObject({
      branches: ['main', 'release'],
      events: ['workflow_dispatch', 'schedule'],
      workflow: 'r.yml',
      verifyAllRuns: true,
    });
  });

  it('reads the evidence tree without following links and notes what it cannot read', () => {
    write('testing/lab-evidence/4.3.6/CF-A-01.json', '{}');
    write('testing/lab-evidence/schema.json', '{}');

    const tree = readTree(join(dir, 'testing', 'lab-evidence'));

    expect([...tree.keys()].sort()).toEqual([
      '4.3.6/CF-A-01.json',
      'schema.json',
    ]);
    expect(readTree(join(dir, 'no-such-folder')).size).toBe(0);
  });

  it('AC-1 does not follow a link in the evidence tree, to a file or to a folder', () => {
    write('real/CF-REAL-01.json', '{}');
    mkdirSync(join(dir, 'testing', 'lab-evidence', '4.3.6'), {
      recursive: true,
    });
    let made = 0;
    try {
      symlinkSync(
        join(dir, 'real', 'CF-REAL-01.json'),
        join(dir, 'testing', 'lab-evidence', '4.3.6', 'CF-LINK-01.json'),
        'file',
      );
      made += 1;
    } catch {
      // no permission to make file links here (Windows without developer mode)
    }
    symlinkSync(
      join(dir, 'real'),
      join(dir, 'testing', 'lab-evidence', '4.2.9'),
      'junction',
    );

    const tree = readTree(join(dir, 'testing', 'lab-evidence'));

    expect(tree.get('4.2.9')).toBeNull();
    expect([...tree.keys()].some((key) => key.startsWith('4.2.9/'))).toBe(
      false,
    );
    if (made > 0) expect(tree.get('4.3.6/CF-LINK-01.json')).toBeNull();
  });

  it('AC-1 refuses a tree with more files than any evidence tree has', () => {
    for (const name of ['a', 'b', 'c'])
      write(`testing/lab-evidence/4.3.6/CF-${name}-01.json`, '{}');

    expect(() => readTree(join(dir, 'testing', 'lab-evidence'), 2)).toThrow(
      'more than 2 files',
    );
    expect(readTree(join(dir, 'testing', 'lab-evidence'), 3).size).toBe(3);
  });

  it('AC-1 reads no file larger than evidence can be, and reads the largest allowed one', () => {
    write(
      'testing/lab-evidence/4.3.6/CF-BIG-01.json',
      'x'.repeat(4 * 1024 * 1024 + 1),
    );
    write(
      'testing/lab-evidence/4.3.6/CF-EDGE-01.json',
      'x'.repeat(4 * 1024 * 1024),
    );

    const tree = readTree(join(dir, 'testing', 'lab-evidence'));

    expect(tree.get('4.3.6/CF-BIG-01.json')).toBeNull();
    expect(tree.get('4.3.6/CF-EDGE-01.json')).toHaveLength(4 * 1024 * 1024);
  });
});

describe('semantics-evidence CLI on the shipped registry', () => {
  it('AC-1 passes the repository as it is (no lab evidence yet, so no cell may claim any)', async () => {
    const real = await main(['--base=HEAD'], {}, {});

    expect(real).toBe(0);
  }, 60_000);
});
