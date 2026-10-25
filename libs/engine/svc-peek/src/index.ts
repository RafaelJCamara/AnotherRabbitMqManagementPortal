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
