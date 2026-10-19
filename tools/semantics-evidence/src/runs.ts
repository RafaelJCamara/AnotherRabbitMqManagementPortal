// Is the run a `ci` stamp names a real, successful run of the record workflow? (I-14)
//
// The stamp is written from environment variables, so on its own it proves nothing: anyone can set
// them. This asks the GitHub API about the run the stamp points to and refuses unless it is a
// completed, successful run of conformance-record.yml of THIS repository, on an allowed branch, for
// the commit the stamp names, started by an allowed event, with that commit in the history of the
// change under check, and with the stamp's time inside the run. The repository, the workflow and the
// host come from the policy, never from the artefact: the artefact only supplies a run number.
//
// The API client is injected (`RunApi`), so every rule is tested offline. What this cannot do is tell
// a genuine artefact from one a person edited and re-sealed under the same real run: that needs the
// workflow to attest the digest (OQ-450).
import { z } from 'zod';
import type { CiProvenance } from './evidence-format.ts';

export interface RunInfo {
  readonly repository: string;
  readonly headRepository: string | null;
  readonly path: string;
  readonly headSha: string;
  readonly headBranch: string | null;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runAttempt: number;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface RunApi {
  /** Null when the run does not exist or the token cannot see it. Throws on any other failure. */
  getRun(
    repository: string,
    runId: string,
    attempt: string | undefined,
  ): Promise<RunInfo | null>;
}

export interface RunPolicy {
  /** `https://github.com`. */
  readonly server: string;
  /** `owner/name`. */
  readonly repository: string;
  /** `conformance-record.yml`. */
  readonly workflowFile: string;
  readonly branches: readonly string[];
  readonly events: readonly string[];
  /** How far the stamp's time may lie outside the run's own start and last update. */
  readonly slackMs: number;
}

export const DEFAULT_POLICY: Omit<RunPolicy, 'repository'> = {
  server: 'https://github.com',
  workflowFile: 'conformance-record.yml',
  branches: ['main'],
  events: ['workflow_dispatch'],
  slackMs: 10 * 60 * 1000,
};

const RUN_PATH =
  /^\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/;

export function createRunVerifier(
  policy: RunPolicy,
  api: RunApi,
  isAncestor: (sha: string) => Promise<boolean>,
): (provenance: CiProvenance) => Promise<string | null> {
  const same = (a: string, b: string): boolean =>
    a.toLowerCase() === b.toLowerCase();
  return async (provenance) => {
    const url = new URL(provenance.runUrl);
    const match = RUN_PATH.exec(url.pathname);
    if (url.origin !== policy.server || match === null) {
      return `the run URL is not a run on ${policy.server}`;
    }
    const [, owner, name, runId, attempt] = match;
    if (
      owner === undefined ||
      name === undefined ||
      runId === undefined ||
      !same(`${owner}/${name}`, policy.repository)
    ) {
      return `the run belongs to ${String(owner)}/${String(name)}, not ${policy.repository}`;
    }
    const workflows = policy.branches.map(
      (branch) =>
        `${policy.repository}/.github/workflows/${policy.workflowFile}@refs/heads/${branch}`,
    );
    if (!workflows.some((workflow) => same(workflow, provenance.workflow))) {
      return `the stamp names the workflow ${provenance.workflow}, not ${workflows.join(' or ')}`;
    }
    const run = await api.getRun(policy.repository, runId, attempt);
    if (run === null) return `run ${runId} was not found`;

    const problems: string[] = [];
    if (!same(run.repository, policy.repository)) {
      problems.push(`the run is in ${run.repository}`);
    }
    if (
      run.headRepository === null ||
      !same(run.headRepository, policy.repository)
    ) {
      problems.push(`the run built ${run.headRepository ?? 'no repository'}`);
    }
    const path = run.path.split('@')[0];
    if (path !== `.github/workflows/${policy.workflowFile}`) {
      problems.push(`the run is of ${run.path}`);
    }
    if (run.headSha !== provenance.gitSha) {
      problems.push(`the run built ${run.headSha}, not ${provenance.gitSha}`);
    }
    if (run.headBranch === null || !policy.branches.includes(run.headBranch)) {
      problems.push(`the run was on branch ${run.headBranch ?? '(none)'}`);
    }
    if (!policy.events.includes(run.event)) {
      problems.push(`the run was started by ${run.event}`);
    }
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      problems.push(
        `the run is ${run.status}${run.conclusion === null ? '' : `, ${run.conclusion}`} (a run must finish successfully; re-run the check after it does)`,
      );
    }
    if (attempt !== undefined && run.runAttempt !== Number(attempt)) {
      problems.push(
        `the run URL names attempt ${attempt}, the API ${String(run.runAttempt)}`,
      );
    }
    const at = Date.parse(provenance.recordedAt);
    const from = Date.parse(run.startedAt) - policy.slackMs;
    const to = Date.parse(run.updatedAt) + policy.slackMs;
    if (!(at >= from && at <= to)) {
      problems.push('the stamp was written outside the time of the run');
    }
    if (problems.length === 0 && !(await isAncestor(provenance.gitSha))) {
      problems.push(
        `commit ${provenance.gitSha} is not in the history of this change`,
      );
    }
    return problems.length === 0 ? null : problems.join('; ');
  };
}

const RunResponse = z.object({
  path: z.string(),
  head_sha: z.string(),
  head_branch: z.string().nullable(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  run_attempt: z.number().int(),
  run_started_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  repository: z.object({ full_name: z.string() }),
  head_repository: z.object({ full_name: z.string() }).nullable().optional(),
});

const MAX_BODY = 1024 * 1024;

export interface GithubOptions {
  /** Read from GITHUB_TOKEN or GH_TOKEN by the CLI, never from an argument. */
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch;
  /** For the tests with a fake `fetch`; the real client always talks to api.github.com. */
  readonly apiBase?: string;
}

/** `RunApi` over the GitHub REST API. The token goes only to the API host, in a header. */
export function githubRunApi(options: GithubOptions = {}): RunApi {
  const doFetch = options.fetch ?? fetch;
  const base = options.apiBase ?? 'https://api.github.com';
  return {
    async getRun(repository, runId, attempt) {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+$/.test(runId)) {
        throw new Error('refusing to query a malformed repository or run id');
      }
      const path = `/repos/${repository}/actions/runs/${runId}${attempt === undefined ? '' : `/attempts/${attempt}`}`;
      const response = await doFetch(`${base}${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'semantics-evidence-check',
          ...(options.token === undefined || options.token === ''
            ? {}
            : { Authorization: `Bearer ${options.token}` }),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404) return null;
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `the GitHub API answered ${String(response.status)} for ${path}`,
        );
      }
      if (text.length > MAX_BODY)
        throw new Error('the GitHub answer is too large');
      const parsed = RunResponse.safeParse(JSON.parse(text));
      if (!parsed.success)
        throw new Error('the GitHub answer has an unexpected shape');
      const run = parsed.data;
      return {
        repository: run.repository.full_name,
        headRepository: run.head_repository?.full_name ?? null,
        path: run.path,
        headSha: run.head_sha,
        headBranch: run.head_branch,
        event: run.event,
        status: run.status,
        conclusion: run.conclusion,
        runAttempt: run.run_attempt,
        startedAt: run.run_started_at ?? run.created_at,
        updatedAt: run.updated_at,
      };
    },
  };
}
