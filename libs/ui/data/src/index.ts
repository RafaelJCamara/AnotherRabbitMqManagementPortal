// Public API of this library. Export only what other projects need.
export {
  EngineApi,
  type EnginePlan,
  type ExecuteRequest,
  type ExecuteResult,
  type PlanGate,
} from './engine-api';
export {
  buildEngineRequest,
  type EngineRequest,
  type QueryScalar,
  type QueryValue,
} from './engine-request';
export { engineResource, type EngineResourceOptions } from './engine-resource';
export {
  EngineProblemError,
  isEngineProblem,
  parseProblem,
  syntheticProblem,
  type EngineProblemOptions,
} from './errors';
export {
  ENGINE_INTERCEPTORS,
  REQUEST_ID_HEADER,
  authInterceptor,
  correlationInterceptor,
  problemInterceptor,
} from './interceptors';
export {
  DEFAULT_LIVE_CLIENT_CONFIG,
  LIVE_CLIENT_CONFIG,
  LiveClient,
  type GapReason,
  type LiveClientConfig,
  type LiveClientState,
  type LiveClientStats,
  type LiveEvent,
  type LiveSubscribeOptions,
  type StatusState,
} from './live-client';
export { ENGINE_PARSE } from './parse-mode';
export { provideEngineData } from './provide-engine-data';
