// Public API of this library: the plan and the verdict of the conformance CI workflows. The CLIs
// (plan-cli.ts, verdict-cli.ts) are run as commands by the workflows, not imported.
export {
  EXACT_VERSION,
  parseLabVersions,
  readLabVersions,
} from './lab-versions.ts';
export {
  CONFORMANCE_PROJECTS,
  WATCHED_PATHS,
  planConformance,
} from './plan.ts';
export type { MatrixEntry, Plan, PlanInput } from './plan.ts';
export {
  JOB_RESULTS,
  parseAffected,
  parseJobResult,
  verdict,
} from './verdict.ts';
export type { JobResult, Verdict, VerdictInput } from './verdict.ts';
