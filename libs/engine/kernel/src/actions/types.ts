// The types of the action layer (blueprint 5.1, core-interfaces.md "Action layer"). Where this file
// differs from core-interfaces.md, open questions OQ-220 to OQ-246 say why.
import {
  ActionIdSchema,
  type ActionDef,
  type ActionId,
  type EngineMode,
  type EnvClass,
  type ErrorCode,
  type InputOf,
  type JobId,
  type OutputOf,
  type PlanId,
  type ReceiptId,
  type Risk,
  type TargetRef,
  type WarningRef,
} from '@app/contracts';
import type {
  ConnectionManager,
  MgmtWritePort,
  PlanState,
  Principal,
} from '@app/ports';
import { z } from 'zod';

export type { PlanState, Principal };

/** A reason an action cannot be planned or run right now, with the action that would fix it. */
export const GateSchema = z.strictObject({
  id: z.string().min(1),
  blocking: z.boolean(),
  reason: z.string(),
  source: z.string().optional(),
  fix: z
    .strictObject({ actionId: ActionIdSchema, input: z.unknown() })
    .optional(),
});
export type Gate = z.infer<typeof GateSchema>;

/** What the caller (a transport, a job, a test) supplies for one call. */
export interface ExecutorContext {
  principal: Principal;
  mode: EngineMode;
  /** An unset or unknown environment class means `prod` (ADR-006). */
  env?: EnvClass | undefined;
  correlationId?: string | undefined;
  /** The caller's cancellation; the executor adds its own (stop, deadline). */
  signal?: AbortSignal | undefined;
  /** Absolute time in epoch milliseconds after which the call is aborted. */
  deadline?: number | undefined;
  /** Required to run a mutating action without a plan; executing a plan carries its own. */
  idempotencyKey?: string | undefined;
}

/** What `plan()` and `revalidate()` see: no write capability of any kind. */
export interface ActionContext {
  readonly principal: Principal;
  readonly mode: EngineMode;
  readonly env: EnvClass;
  readonly correlationId: string;
  readonly signal: AbortSignal;
  readonly deadline?: number;
  now(): number;
}

/**
 * The write-capable ports (I-2; the "typed executorWrite" of the amendments' minor fixes). The
 * executor hands them to `execute` and to nothing else.
 */
export interface ExecutorWrite {
  readonly mgmt: MgmtWritePort;
  readonly connections: ConnectionManager;
}

export interface PlanDraft<P = unknown> {
  preview: P;
  gates: Gate[];
  warnings: WarningRef[];
  /** Consent ids the person must give; a warning of severity `consent` adds its own id. */
  consentsRequired: string[];
  /** Encrypted at rest with the input (publish bodies, edited replay payloads); purged with it. */
  sensitivePayload?: unknown;
}

/** A plan as callers see it. It never carries the input: that stays encrypted until execution. */
export interface PlanView<P = unknown> {
  readonly id: PlanId;
  readonly actionId: ActionId;
  /** sha256 over everything the plan is bound to. An approval and an execute name it. */
  readonly digest: string;
  readonly principalId: string;
  /** Set when the requester acted for someone else (an MCP client for a person). */
  readonly onBehalfOfId?: string;
  readonly profileFingerprint?: string;
  readonly env: EnvClass;
  readonly risk: Risk;
  readonly gates: readonly Gate[];
  readonly warnings: readonly WarningRef[];
  readonly consentsRequired: readonly string[];
  readonly confirmationPhrase?: string;
  readonly approvals: {
    readonly required: number;
    readonly granted: readonly {
      readonly by: string;
      readonly at: number;
      readonly decision: 'approve' | 'reject';
    }[];
  };
  readonly preview: P;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly state: PlanState;
}

/** A plan with the input it was made from: what `revalidate` and `execute` get. */
export interface Plan<I = unknown, P = unknown> extends PlanView<P> {
  readonly input: I;
  readonly sensitivePayload?: unknown;
}

export interface ExecuteContext<
  I = unknown,
  P = unknown,
> extends ActionContext {
  readonly plan?: Plan<I, P>;
  readonly consents: ReadonlySet<string>;
  readonly writes: ExecutorWrite;
}

export interface ActionImpl<A extends ActionDef = ActionDef, P = unknown> {
  readonly def: A;
  /** Reads only. Tested against write ports that throw. */
  plan?(input: InputOf<A>, ctx: ActionContext): Promise<PlanDraft<P>>;
  /** The TOCTOU re-check: cheap preflight again, `stale` says what drifted. */
  revalidate?(
    plan: Plan<InputOf<A>, P>,
    ctx: ActionContext,
  ): Promise<'valid' | { stale: string }>;
  execute(
    input: InputOf<A>,
    ctx: ExecuteContext<InputOf<A>, P>,
  ): Promise<OutputOf<A> | { jobId: JobId }>;
}

/** What `implementAction` accepts: the implementation without the definition. */
export type ActionBody<A extends ActionDef, P = unknown> = Omit<
  ActionImpl<A, P>,
  'def'
>;

export interface GuardrailDecision {
  risk: Risk;
  planning: 'none' | 'optional' | 'required';
  approvalsRequired: number;
  confirmationPhrase?: string;
  denied?: { code: ErrorCode; reason: string };
  forbidLetBrokerHandle: boolean;
  extraConsents: string[];
}

export type RunOutcome<A extends ActionDef = ActionDef> =
  | { kind: 'output'; output: OutputOf<A>; receiptId?: ReceiptId }
  | { kind: 'planRequired'; plan: PlanView }
  | { kind: 'job'; jobId: JobId };

export type ExecuteOutcome =
  | { kind: 'output'; output: unknown; receiptId?: ReceiptId }
  | { kind: 'job'; jobId: JobId };

export interface ExecuteRequest {
  planId: PlanId;
  /** The consent ids the person gave. Must include every id in the plan's `consentsRequired`. */
  consents: readonly string[];
  /** What the person typed; checked against the plan's phrase on the engine side. */
  confirmation?: string | undefined;
  /** Required, and used once per principal. */
  idempotencyKey: string;
  /** The digest the person saw. When given, it must be the plan's current digest. */
  expectedDigest?: string | undefined;
}

export type ExecutorState =
  | 'accepting'
  | 'draining'
  | 'frozen-partial'
  | 'stopped';

export type { ActionDef, ActionId, TargetRef, WarningRef };
