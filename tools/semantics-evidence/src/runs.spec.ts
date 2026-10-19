// The run verifier (I-14) against a fake GitHub API: one test per way a stamp can lie.
import { describe, expect, it, vi } from 'vitest';
import {
  createRunVerifier,
  DEFAULT_POLICY,
  githubRunApi,
  type RunApi,
  type RunInfo,
} from './runs.ts';
import { ciStamp, REPOSITORY, SHA } from './testing.ts';

const policy = { ...DEFAULT_POLICY, repository: REPOSITORY };

const goodRun: RunInfo = {
  repository: REPOSITORY,
  headRepository: REPOSITORY,
  path: '.github/workflows/conformance-record.yml',
  headSha: SHA,
  headBranch: 'main',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
  runAttempt: 1,
  startedAt: '2026-10-19T09:50:00Z',
  updatedAt: '2026-10-19T10:05:00Z',
};

function verify(
  run: Partial<RunInfo> | null,
  stamp = ciStamp(),
  options: { ancestor?: boolean; policy?: Partial<typeof policy> } = {},
) {
  const getRun = vi.fn(() =>
    Promise.resolve(run === null ? null : { ...goodRun, ...run }),
  );
  const api: RunApi = { getRun };
  const verifier = createRunVerifier(
    { ...policy, ...options.policy },
    api,
    () => Promise.resolve(options.ancestor ?? true),
  );
  return verifier(stamp).then((problem) => ({ problem, getRun }));
}

describe('run verifier', () => {
  it('AC-1 accepts a completed, successful run of the record workflow on main for the stamped commit', async () => {
    const { problem, getRun } = await verify({});

    expect(problem).toBeNull();
    expect(getRun).toHaveBeenCalledWith(REPOSITORY, '777', '1');
  });

  it('AC-1 accepts a stamp without an attempt number (the run endpoint)', async () => {
    const { problem, getRun } = await verify(
      {},
      ciStamp({ runUrl: `https://github.com/${REPOSITORY}/actions/runs/777` }),
    );

    expect(problem).toBeNull();
    expect(getRun).toHaveBeenCalledWith(REPOSITORY, '777', undefined);
  });

  it.each([
    [
      'a run on another server',
      { runUrl: `https://evil.example/${REPOSITORY}/actions/runs/777` },
    ],
    [
      'a run of another repository',
      { runUrl: 'https://github.com/mallory/portal/actions/runs/777' },
    ],
    [
      'a stamp for another workflow file',
      { workflow: `${REPOSITORY}/.github/workflows/ci.yml@refs/heads/main` },
    ],
    [
      'a stamp for a branch the policy does not allow',
      {
        workflow: `${REPOSITORY}/.github/workflows/conformance-record.yml@refs/heads/feature`,
      },
    ],
    [
      'a stamp for another repository workflow',
      {
        workflow:
          'mallory/portal/.github/workflows/conformance-record.yml@refs/heads/main',
      },
    ],
  ])(
    'AC-1 refuses %s before it asks the API anything',
    async (_name, change) => {
      const { problem, getRun } = await verify({}, ciStamp(change));

      expect(problem).not.toBeNull();
      expect(getRun).not.toHaveBeenCalled();
    },
  );

  it('AC-1 refuses a run the API does not know', async () => {
    const { problem } = await verify(null);

    expect(problem).toBe('run 777 was not found');
  });

  it.each([
    [
      'another repository',
      { repository: 'mallory/portal' },
      'the run is in mallory/portal',
    ],
    [
      'a fork',
      { headRepository: 'mallory/portal' },
      'the run built mallory/portal',
    ],
    [
      'no head repository',
      { headRepository: null },
      'the run built no repository',
    ],
    [
      'another workflow',
      { path: '.github/workflows/ci.yml' },
      'the run is of .github/workflows/ci.yml',
    ],
    ['another commit', { headSha: 'c'.repeat(40) }, 'not ' + SHA],
    ['another branch', { headBranch: 'feature' }, 'branch feature'],
    ['no branch', { headBranch: null }, 'branch (none)'],
    ['another event', { event: 'push' }, 'started by push'],
    [
      'a run still going',
      { status: 'in_progress', conclusion: null },
      'in_progress',
    ],
    ['a failed run', { conclusion: 'failure' }, 'completed, failure'],
    ['a cancelled run', { conclusion: 'cancelled' }, 'cancelled'],
    ['another attempt', { runAttempt: 2 }, 'attempt 1'],
    [
      'a stamp before the run began',
      { startedAt: '2026-10-19T11:00:00Z', updatedAt: '2026-10-19T11:30:00Z' },
      'outside the time of the run',
    ],
    [
      'a stamp long after the run ended',
      { startedAt: '2026-10-19T08:00:00Z', updatedAt: '2026-10-19T08:30:00Z' },
      'outside the time of the run',
    ],
  ])('AC-1 refuses %s', async (_name, change, message) => {
    const { problem } = await verify(change);

    expect(problem).toContain(message);
  });

  it('AC-1 refuses a commit that is not in the history of the change', async () => {
    const { problem } = await verify({}, ciStamp(), { ancestor: false });

    expect(problem).toContain('is not in the history of this change');
  });

  it('takes the repository, the workflow and the branches from the policy, not from the artefact', async () => {
    const { problem } = await verify(
      {
        headBranch: 'release',
        repository: 'acme/other',
        headRepository: 'acme/other',
      },
      ciStamp({
        runUrl: 'https://github.com/acme/other/actions/runs/777/attempts/1',
        workflow:
          'acme/other/.github/workflows/conformance-record.yml@refs/heads/release',
      }),
      { policy: { repository: 'acme/other', branches: ['release'] } },
    );

    expect(problem).toBeNull();
  });

  it('collects every problem of a run, not only the first', async () => {
    const { problem } = await verify({
      event: 'push',
      headBranch: 'dev',
      conclusion: 'failure',
    });

    expect(problem).toContain('branch dev');
    expect(problem).toContain('started by push');
    expect(problem).toContain('completed, failure');
  });
});

describe('github run API client', () => {
  const body = {
    path: '.github/workflows/conformance-record.yml',
    head_sha: SHA,
    head_branch: 'main',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    run_started_at: '2026-10-19T09:50:00Z',
    created_at: '2026-10-19T09:49:00Z',
    updated_at: '2026-10-19T10:05:00Z',
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
  };
  const reply = (status: number, text: string): Response =>
    new Response(text, { status });

  it('asks the run endpoint with the token in a header only, and reads the answer', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const api = githubRunApi({
      token: 'ghs_secret',
      apiBase: 'https://api.test',
      fetch: (url, init) => {
        calls.push({ url: url as string, init });
        return Promise.resolve(reply(200, JSON.stringify(body)));
      },
    });

    const run = await api.getRun(REPOSITORY, '777', '2');

    expect(calls[0]?.url).toBe(
      `https://api.test/repos/${REPOSITORY}/actions/runs/777/attempts/2`,
    );
    expect(calls[0]?.url).not.toContain('ghs_secret');
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: 'Bearer ghs_secret',
    });
    expect(calls[0]?.init?.redirect).toBe('error');
    expect(run).toMatchObject({
      headSha: SHA,
      startedAt: '2026-10-19T09:50:00Z',
      headRepository: REPOSITORY,
    });
  });

  it('sends no Authorization header without a token and falls back to created_at', async () => {
    let headers: unknown;
    const api = githubRunApi({
      apiBase: 'https://api.test',
      fetch: (_url, init) => {
        headers = init?.headers;
        return Promise.resolve(
          reply(
            200,
            JSON.stringify({
              ...body,
              run_started_at: null,
              head_repository: null,
            }),
          ),
        );
      },
    });

    const run = await api.getRun(REPOSITORY, '777', undefined);

    expect(headers).not.toHaveProperty('Authorization');
    expect(run?.startedAt).toBe('2026-10-19T09:49:00Z');
    expect(run?.headRepository).toBeNull();
  });

  it('answers null for 404 and throws for every other failure, a wrong shape and a huge body', async () => {
    const make = (status: number, text: string) =>
      githubRunApi({ fetch: () => Promise.resolve(reply(status, text)) });

    await expect(
      make(404, '{}').getRun(REPOSITORY, '1', undefined),
    ).resolves.toBeNull();
    await expect(
      make(403, '{}').getRun(REPOSITORY, '1', undefined),
    ).rejects.toThrow('403');
    await expect(
      make(500, '{}').getRun(REPOSITORY, '1', undefined),
    ).rejects.toThrow('500');
    await expect(
      make(200, '{"id":1}').getRun(REPOSITORY, '1', undefined),
    ).rejects.toThrow('unexpected shape');
    await expect(
      make(200, 'x'.repeat(1024 * 1024 + 1)).getRun(REPOSITORY, '1', undefined),
    ).rejects.toThrow('too large');
  });

  it('refuses a repository or run id that is not plain, so the artefact cannot steer the request', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(reply(200, '{}')));
    const api = githubRunApi({ fetch: fetchSpy });

    await expect(
      api.getRun('acme/portal/../../user', '1', undefined),
    ).rejects.toThrow('malformed');
    await expect(api.getRun(REPOSITORY, '1/../2', undefined)).rejects.toThrow(
      'malformed',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
