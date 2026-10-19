// Architecture tests that read the repository's own source (M0-29). The specs in this project run
// them against the real tree and against planted violations; other projects can call the checks.
export { readFacts, type FileFacts } from './facts.ts';
export {
  registeredActions,
  type RegisteredAction,
} from './registered-actions.ts';
export {
  checkMutationFunnel,
  checkProofMinting,
  checkRecorderIndependence,
  findActionSites,
  FUNNEL_EXEMPT_PREFIXES,
  isActionModule,
  PROOF_MINTING_PREFIXES,
  RECORDER_PREFIXES,
  type ActionSite,
  type ArchViolation,
} from './rules.ts';
export { listSources, SCAN_ROOTS, type SourceFile } from './sources.ts';
