// Public API of this library: the pure check, the run verifier and the evidence reader. The CLI
// (cli.ts) is run as a command, not imported.
export { checkEvidence, EVIDENCE_PREFIX } from './check.ts';
export type { CheckInput, Finding } from './check.ts';
export {
  canonicalJson,
  digestOf,
  EvidenceFormatError,
  parseEvidence,
} from './evidence-format.ts';
export type { CiProvenance, Evidence } from './evidence-format.ts';
export { createRunVerifier, DEFAULT_POLICY, githubRunApi } from './runs.ts';
export type { RunApi, RunInfo, RunPolicy } from './runs.ts';
export type { CellSnapshot } from './snapshot.ts';
