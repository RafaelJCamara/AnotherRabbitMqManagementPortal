// The seams of the executor that other parts fill (blueprint 5.1). Each one is an interface; the
// real parts live beside the executor and are wired by the composition root:
//
//   GuardrailPolicy  step 7: environment class, prod lock, unattended rules   guardrails/policy.ts
//   AuditSink        steps 10 and 12: hash-chained attempt and outcome rows   audit/chain.ts
//   ReceiptSink      step 12: the side-effect receipt                         receipts/store.ts
//   ProfileResolver  steps 4 and 5: BrokerProfile fingerprint and gates       svc-capabilities
//
// The executor has no default for the first three: wiring none is a start-up error, not a silent
// skip (a default that lets a production call through is how a lock gets forgotten).
import type {
  ActionDef,
  ActionId,
  ActionKind,
  EnvClass,
  ErrorCode,
  JobId,
  PlanId,
  ReceiptId,
  Risk,
  TargetRef,
} from '@app/contracts';
import type { Principal } from '@app/ports';

import type { ActionContext, Gate, GuardrailDecision } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------------------------

export interface GuardrailInput {
  def: ActionDef;
  input: unknown;
  risk: Risk;
  env: EnvClass;
  principal: Principal;
  target: TargetRef;
  /** Anything but a query. Peeks count as mutations. */
  mutating: boolean;
}

export interface GuardrailPolicy {
  /**
   * Called when a call is prepared (run, plan) and again when a plan is executed, so a lock that
   * closed in between wins. A rejection is a denial.
   */
  decide(input: GuardrailInput): Promise<GuardrailDecision>;
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

export interface AuditEntry {
  at: number;
  correlationId: string;
  actionId: ActionId;
  kind: ActionKind;
  /** A frozen snapshot of who acted, including whom they acted for. */
  principal: Principal;
  target: TargetRef;
  env: EnvClass;
  risk: Risk;
  planId?: PlanId;
  planDigest?: string;
  /** The principals whose approval the plan carried. */
  approvedBy?: readonly string[];
}

export interface AuditOutcome extends AuditEntry {
  result: 'ok' | 'error';
  code?: ErrorCode;
  jobId?: JobId;
  /** The `seq` that `attempt` returned for the same execution. */
  attemptSeq?: number;
  receiptId?: ReceiptId;
  /** The receipt could not be recorded; the outcome row says so. */
  receiptFailed?: boolean;
}

export interface AuditSink {
  /** Returns the sequence number of the row. If this rejects, the action is not run (ADR-006). */
  attempt(entry: AuditEntry): Promise<number>;
  /** Written after the action ran; a failure here is logged and surfaced, never undone. */
  outcome(entry: AuditOutcome): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Profiles and gates
// ---------------------------------------------------------------------------------------------

export interface ProfileSnapshot {
  /** The BrokerProfile fingerprint the plan is bound to; null for an action with no broker. */
  fingerprint: string | null;
  /** Capability gates that apply to this action on this broker; a blocking one refuses it (412). */
  gates: Gate[];
}

export interface ProfileResolver {
  resolve(request: {
    def: ActionDef;
    input: unknown;
    target: TargetRef;
    ctx: ActionContext;
  }): Promise<ProfileSnapshot>;
}

export const noProfiles: ProfileResolver = {
  resolve: () => Promise.resolve({ fingerprint: null, gates: [] }),
};

// ---------------------------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------------------------

export interface ExecutionRecord {
  actionId: ActionId;
  planId?: PlanId;
  planDigest?: string;
  principal: Principal;
  correlationId: string;
  env: EnvClass;
  risk: Risk;
  startedAt: number;
  finishedAt: number;
  result: 'ok' | 'error';
  code?: ErrorCode;
  jobId?: JobId;
  /** The `seq` of the audit attempt row of this execution. */
  auditSeq?: number;
  /**
   * The structured part of the receipt (per-message results, anomalies, warnings; blueprint 5.10),
   * filled by the actions that have one. Masked and bounded by the store.
   */
  detail?: unknown;
}

export interface ReceiptSink {
  /** Records the receipt and returns its id. A rejection is logged and flagged, never thrown. */
  record(execution: ExecutionRecord): Promise<ReceiptId>;
}
