// @app/peek-planner: the pure peek planner (M1-12, blueprint 5.4). Isomorphic, trust-critical.
// Every era-dependent fact is asked of the semantics registry (I-3); this library compares no
// broker version. See docs/specs/M1-12.md for the rules R1..R12 and the evaluation order.
export {
  HONEST_LABEL_KEY,
  isRejection,
  REASON_CODES,
  reasonTextKey,
  REJECTION_CODES,
  rejectionTextKey,
  TEXT_SCOPE,
  TEXT_VERSION,
  type PeekRejection,
  type ReasonCode,
  type RejectionCode,
  type SuggestedFix,
} from './rejections.ts';
export { PEEK_FEATURE, peekPlanner, planPeek } from './plan.ts';
export { isHumanInteractive } from './principal.ts';
export {
  PLANNER_WARNING_IDS,
  plannerWarning,
  type PlannerWarningId,
} from './warnings.ts';
export type {
  CapBound,
  DelayedRetryType,
  Disposition,
  DlxEvidence,
  EnvClass,
  HoldBound,
  LimitBasis,
  LimitReason,
  PeekFacts,
  PeekMethod,
  PeekPlanDraft,
  PeekPlanPreview,
  PeekPreflight,
  PeekPrincipal,
  PeekProfile,
  PeekRequest,
  PlanGate,
  PlannedDisposition,
  PlannerRegistry,
  PreferredMethod,
  PreflightQueue,
  RescueFacts,
} from './types.ts';
