// The seams of the executor that other work packages fill (blueprint 5.1). Each one is an
// interface with a conservative stand-in, so the pipeline is complete and testable now:
//
//   GuardrailPolicy  steps 7: environment class, prod lock, freeze, quotas   -> M0-30 (policy.ts)
//   AuditSink        steps 10 and 12: hash-chained attempt and outcome rows  -> M0-30 (audit/chain.ts)
//   ProfileResolver  steps 4 and 5: BrokerProfile fingerprint and gates      -> svc-capabilities
//   ReceiptSink      step 12: the side-effect receipt                        -> M0-30 (receipts/store.ts)
//
// The executor has no default audit sink: wiring none is a start-up error, not a silent skip.
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
  decide(input: GuardrailInput): Promise<GuardrailDecision>;
}

const PLANNING_ORDER = ['none', 'optional', 'required'] as const;

function stricter(
  a: GuardrailDecision['planning'],
  b: GuardrailDecision['planning'],
): GuardrailDecision['planning'] {
  return PLANNING_ORDER.indexOf(a) >= PLANNING_ORDER.indexOf(b) ? a : b;
}

/**
 * The stand-in policy until M0-30 lands the real one (prod lock, arming, freeze, quotas):
 *
 * - an action's own `confirm` rule fixes the typed phrase, and a phrase forces a plan;
 * - a mutating action of high or critical risk needs a plan in `prod` and `staging`;
 * - an unattended principal (MCP, a job, an automation) only ever plans a mutation;
 * - no approvals are required (team approvals arrive with M3).
 */
export const defaultGuardrails: GuardrailPolicy = {
  decide({ def, input, risk, env, principal, mutating }) {
    let planning = def.planning;
    const phrase = def.confirm?.requiredWhen(env, risk)
      ? def.confirm.phrase(input)
      : undefined;
    if (phrase !== undefined) planning = stricter(planning, 'required');
    if (
      mutating &&
      (env === 'prod' || env === 'staging') &&
      (risk === 'high' || risk === 'critical')
    ) {
      planning = stricter(planning, 'required');
    }
    if (mutating && principal.unattended) {
      planning = stricter(planning, 'required');
    }
    return Promise.resolve({
      risk,
      planning,
      approvalsRequired: 0,
      ...(phrase === undefined ? {} : { confirmationPhrase: phrase }),
      forbidLetBrokerHandle: false,
      extraConsents: [],
    });
  },
};

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
}

export interface AuditOutcome extends AuditEntry {
  result: 'ok' | 'error';
  code?: ErrorCode;
  jobId?: JobId;
}

export interface AuditSink {
  /** If this rejects, the action is not run (ADR-006). */
  attempt(entry: AuditEntry): Promise<void>;
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
}

export interface ReceiptSink {
  /** Records the receipt; the id travels back with the result. Failures are logged, not thrown. */
  record(execution: ExecutionRecord): Promise<ReceiptId | undefined>;
}
