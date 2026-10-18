// The action layer of the kernel (M0-29, ADR-006): ActionExecutor, PlanStore, implementAction.
export {
  ALLOW,
  allowUiPrincipals,
  createRoleAuthorizer,
  denyAllAuthorizer,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type Authorizer,
} from './authorizer.ts';
export { decodeValue, encodeValue, hashValue, sha256Hex } from './canonical.ts';
export {
  APPROVE_PERMISSION,
  createActionExecutor,
  planRequiredError,
  type ActionExecutor,
  type ActionExecutorOptions,
} from './executor.ts';
export {
  defaultGuardrails,
  noProfiles,
  type AuditEntry,
  type AuditOutcome,
  type AuditSink,
  type ExecutionRecord,
  type GuardrailInput,
  type GuardrailPolicy,
  type ProfileResolver,
  type ProfileSnapshot,
  type ReceiptSink,
} from './hooks.ts';
export {
  createIdempotencyGuard,
  IDEMPOTENCY_KEY_PATTERN,
  parseIdempotencyKey,
  type IdempotencyGuard,
} from './idempotency.ts';
export { implementAction, isImplementedAction } from './implement-action.ts';
export {
  computePlanDigest,
  createPlanStore,
  DEFAULT_PLAN_TTL,
  type DigestFields,
  type NewPlan,
  type OpenedPlan,
  type PayloadCipher,
  type PlanStore,
  type PlanStoreOptions,
  type PlanTtl,
} from './plan-store.ts';
export {
  chainOf,
  isPrincipal,
  isRequester,
  isUiPrincipal,
  mayActFor,
  ownerOf,
  snapshotPrincipal,
  type PlanOwner,
} from './principal.ts';
export {
  checkPlanPurity,
  createAesGcmTestCipher,
  createMemoryAuditSink,
  createMemoryIdempotencyRepository,
  createMemoryPlanRepository,
  createRecordingWrites,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  createWriteTrap,
  WriteDuringPlanError,
  type MemoryAuditSink,
  type PlanPurityFailure,
  type PlanPuritySample,
  type TestExecutor,
  type TestExecutorParts,
  type WriteTrap,
} from './testing.ts';
export {
  GateSchema,
  type ActionBody,
  type ActionContext,
  type ActionImpl,
  type ExecuteContext,
  type ExecuteOutcome,
  type ExecuteRequest,
  type ExecutorContext,
  type ExecutorState,
  type ExecutorWrite,
  type Gate,
  type GuardrailDecision,
  type Plan,
  type PlanDraft,
  type PlanView,
  type RunOutcome,
} from './types.ts';
