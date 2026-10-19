// The provenance stamp of an artefact (amendment A-20): the commit, the workflow and the run that
// recorded it. Only the `conformance-record.yml` workflow of the CI service makes a `ci` stamp; any
// other run, on a developer machine or in another workflow, makes a `local` one, and the writer
// refuses to put a `local` artefact into the evidence tree.
//
// The variables come from the environment, so this is a guard against mistakes, not against
// someone who sets them by hand. What makes a stamp believable is the bot pull request, the human
// approval, and a reviewer (later `tools/semantics-evidence`) following `runUrl` to the run.
import { EvidenceError, type EvidenceProvenance } from './evidence.ts';

/** `GITHUB_WORKFLOW_REF` is `<owner>/<repo>/.github/workflows/<file>@<ref>`. */
const RECORD_WORKFLOW =
  /^[^/@\s]+\/[^/@\s]+\/\.github\/workflows\/conformance-record\.yml@/;

type Env = Readonly<Record<string, string | undefined>>;

/** The stamp for this process: `ci` in the record workflow, `local` anywhere else. */
export function provenanceFromEnv(
  env: Env,
  now: Date = new Date(),
): EvidenceProvenance {
  const recordedAt = now.toISOString();
  const workflowRef = env.GITHUB_WORKFLOW_REF ?? '';
  if (env.GITHUB_ACTIONS !== 'true' || !RECORD_WORKFLOW.test(workflowRef)) {
    const sha = env.GITHUB_SHA;
    return {
      kind: 'local',
      recorder: 'conformance:record',
      gitSha: sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : null,
      recordedAt,
    };
  }
  const server = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  const sha = env.GITHUB_SHA;
  if (
    server === undefined ||
    repository === undefined ||
    runId === undefined ||
    sha === undefined
  ) {
    throw new EvidenceError(
      'refused',
      'the record workflow did not provide GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_SHA',
    );
  }
  const suffix =
    attempt !== undefined && attempt !== '' ? `/attempts/${attempt}` : '';
  return {
    kind: 'ci',
    recorder: 'conformance:record',
    gitSha: sha,
    runUrl: `${server}/${repository}/actions/runs/${runId}${suffix}`,
    workflow: workflowRef,
    recordedAt,
  };
}
