export { createPeekModule } from './module';
export type { PeekModuleDeps } from './deps';
export type { EngineModule } from './module';
// The peek executor (M1-14): reached only through an implementAction module (wired in M1-16).
export { createPeekExecutor } from './internal/executor.ts';
export type {
  ExecutionHooks,
  ExecutionResult,
  ExecutorPorts,
  PeekExecution,
  PeekExecutor,
  StopReason,
} from './internal/executor.ts';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export { createPeekFakeDeps } from './testing';
// The quarantine of the rescue preflight (M1-13): its name, its literal shape and the one declare
// that arms it. `ensureQuarantine` is exported because the peek action (M1-16) calls it from execute().
export {
  buildQuarantineSpec,
  conformsToSpec,
  ensureQuarantine,
  QUARANTINE_SUFFIX,
  quarantineName,
} from './internal/quarantine.ts';
export type {
  ClassicQuarantineSpec,
  EnsureOutcome,
  FoundQueue,
  QuarantineQueueSpec,
  QuarantineSend,
  QuorumQuarantineSpec,
} from './internal/quarantine.ts';
// The peek preflight (M1-13, DC-06): fills the planner's input with HTTP GET requests only.
export {
  createPeekPreflight,
  DEFAULT_PREFLIGHT_LIMITS,
} from './internal/preflight.ts';
export type {
  PeekPreflightDeps,
  PeekPreflightRequest,
  PeekPreflightService,
  PreflightLimits,
  PreflightOutcome,
  PreflightProfile,
  QuarantineRead,
  Read,
  RescueReads,
} from './internal/preflight.ts';
