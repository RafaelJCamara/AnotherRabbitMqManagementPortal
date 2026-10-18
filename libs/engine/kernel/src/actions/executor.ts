// The ActionExecutor (ADR-006, blueprint 5.1): the single fail-closed pipeline for every
// mutation and every message touch. The UI, the CLI, MCP and jobs all come through here.
//
//   run / plan   1 resolve  2 validate  3 authenticate  4 profile  5 gates  6 authorise  7 guardrails
//                8 plan (reads only; persisted, bound, encrypted)
//   execute      the same up to 7, then: owner, state and expiry, idempotency, consents, typed phrase,
//                approvals, digest seal, TOCTOU revalidate, claim the key, mark executing,
//                9 audit attempt (a failed write denies), 10 run, 11 audit outcome, receipt, purge
//
// Every refusal is an `AppError` with a stable code. Nothing here reads the delivery mode, and
// nothing runs `execute()` of an action before every check has passed.
import {
  EngineModeSchema,
  EnvClassSchema,
  ErrorCodeSchema,
  PlanIdSchema,
  RiskSchema,
  WarningRefSchema,
  type ActionDef,
  type ActionId,
  type EngineMode,
  type EnvClass,
  type JobId,
  type PlanId,
  type ReceiptId,
  type Risk,
  type TargetRef,
} from '@app/contracts';
import { z, ZodError } from 'zod';

import type { Clock } from '../clock/clock.ts';
import type { IdGenerator } from '../ids/ids.ts';
import type { Logger } from '../log/logger.ts';
import { AppError } from '../problem/problem.ts';
import { sha256Hex } from './canonical.ts';
import type { Authorizer } from './authorizer.ts';
import {
  defaultGuardrails,
  noProfiles,
  type AuditEntry,
  type AuditOutcome,
  type AuditSink,
  type GuardrailPolicy,
  type ProfileResolver,
  type ProfileSnapshot,
  type ReceiptSink,
} from './hooks.ts';
import { isImplementedAction } from './implement-action.ts';
import {
  createIdempotencyGuard,
  type IdempotencyGuard,
} from './idempotency.ts';
import type { PlanStore } from './plan-store.ts';
import {
  isPrincipal,
  isRequester,
  mayActFor,
  snapshotPrincipal,
} from './principal.ts';
import {
  GateSchema,
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
import type { IdempotencyRepository } from '@app/ports';

/** The permission an approver needs besides the action's own. */
export const APPROVE_PERMISSION = 'plans.approve';

/**
 * The refusal a transport answers a direct call with when the action needs a plan (428): the plan
 * was already created, and its id goes in the Location header (/plans/{id}).
 */
export function planRequiredError(plan: PlanView): AppError {
  return new AppError('PLAN_REQUIRED', {
    detail: `This action needs a plan; plan ${plan.id} was created. Review it, then execute it.`,
  });
}

export interface ActionExecutorOptions {
  plans: PlanStore;
  idempotency: IdempotencyRepository;
  authorizer: Authorizer;
  /** Required: there is no silent default (a failed attempt write denies the action). */
  audit: AuditSink;
  /** The write-capable ports; handed to `execute` and to nothing else (I-2). */
  writes: ExecutorWrite;
  clock: Clock;
  ids: IdGenerator;
  guardrails?: GuardrailPolicy;
  profiles?: ProfileResolver;
  receipts?: ReceiptSink;
  logger?: Logger;
}

export interface ActionExecutor {
  /** Registers what `implementAction` returned. Anything else, and a repeated id, is refused. */
  register(...impls: readonly ActionImpl[]): void;
  registered(): readonly ActionDef[];
  /** A direct call: runs the action, or answers that a plan is needed and creates it. */
  run<A extends ActionDef>(
    def: A,
    input: unknown,
    ctx: ExecutorContext,
  ): Promise<RunOutcome<A>>;
  /** Creates and persists a plan (`POST actions/{id}/plans`). */
  plan(def: ActionDef, input: unknown, ctx: ExecutorContext): Promise<PlanView>;
  /** `ctx.principal` is the approver; it must differ from the requester. */
  approve(
    planId: PlanId,
    decision: 'approve' | 'reject',
    ctx: ExecutorContext,
    note?: string,
  ): Promise<PlanView>;
  execute(req: ExecuteRequest, ctx: ExecutorContext): Promise<ExecuteOutcome>;
  /** `GET plans/{id}`: the requester, whoever acts for them, and approvers. */
  getPlan(planId: PlanId, ctx: ExecutorContext): Promise<PlanView>;
  state(): ExecutorState;
  /** Executions running now. */
  inFlight(): number;
  /** New mutations are refused; running ones finish. */
  beginDrain(): void;
  /** Mutations are refused with FROZEN; queries still run. */
  freeze(): void;
  unfreeze(): void;
  /** Everything is refused and running executions are aborted. */
  stop(): void;
}

const ExecuteRequestSchema = z.strictObject({
  planId: PlanIdSchema,
  consents: z.array(z.string().min(1).max(200)).max(100),
  confirmation: z.string().max(500).optional(),
  idempotencyKey: z.unknown(),
  expectedDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const DraftSchema = z.strictObject({
  preview: z.unknown(),
  gates: z.array(GateSchema),
  warnings: z.array(WarningRefSchema),
  consentsRequired: z.array(z.string().min(1).max(200)),
  sensitivePayload: z.unknown().optional(),
});

const DecisionSchema = z.strictObject({
  risk: RiskSchema,
  planning: z.enum(['none', 'optional', 'required']),
  approvalsRequired: z.number().int().min(0).max(10),
  confirmationPhrase: z.string().min(1).max(500).optional(),
  denied: z
    .strictObject({ code: ErrorCodeSchema, reason: z.string() })
    .optional(),
  forbidLetBrokerHandle: z.boolean(),
  extraConsents: z.array(z.string().min(1).max(200)).max(100),
});

const JobResultSchema = z.strictObject({ jobId: z.string().min(1) });
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface Prepared {
  impl: ActionImpl;
  input: unknown;
  ctx: ActionContext;
  target: TargetRef;
  mutating: boolean;
  decision: GuardrailDecision;
  profile: ProfileSnapshot;
}

const isMutating = (def: ActionDef): boolean => def.kind !== 'query';

function describeIssues(error: ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join('.')}: ${issue.message}`,
    )
    .join('; ');
}

/** Anything a caller sees from an action's own failure is an AppError; the rest is INTERNAL. */
function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError('INTERNAL', {
      detail: 'An action produced data that breaks its contract.',
      cause: error,
    });
  }
  return new AppError('INTERNAL', { cause: error });
}

function sameText(typed: string, expected: string): boolean {
  const normal = (text: string): string => text.normalize('NFC').trim();
  const a = Buffer.from(sha256Hex(normal(typed)), 'hex');
  const b = Buffer.from(sha256Hex(normal(expected)), 'hex');
  return a.equals(b) && normal(typed).length === normal(expected).length;
}

export function createActionExecutor(
  options: ActionExecutorOptions,
): ActionExecutor {
  const { plans, authorizer, audit, writes, clock, ids } = options;
  const guardrails = options.guardrails ?? defaultGuardrails;
  const profiles = options.profiles ?? noProfiles;
  const idempotency: IdempotencyGuard = createIdempotencyGuard(
    options.idempotency,
  );
  const impls = new Map<ActionId, ActionImpl>();
  const stopper = new AbortController();
  let phase: ExecutorState = 'accepting';
  let running = 0;

  const refuse = (error: AppError, ctx?: ActionContext): AppError => {
    options.logger?.warn(
      {
        event: 'action.refused',
        code: error.code,
        ...(ctx === undefined ? {} : { correlationId: ctx.correlationId }),
      },
      'action refused',
    );
    return error;
  };

  // ---- step 1: resolve ------------------------------------------------------------------------
  function resolve(def: ActionDef): ActionImpl {
    const impl = impls.get(def.id);
    // The registered definition, not the caller's copy, decides everything below.
    if (impl?.def !== def) {
      throw new AppError('NOT_FOUND', { detail: 'Unknown action.' });
    }
    return impl;
  }

  function ensureAccepting(def: ActionDef | undefined): void {
    const mutating = def === undefined || isMutating(def);
    switch (phase) {
      case 'accepting':
        return;
      case 'frozen-partial':
        if (mutating) {
          throw new AppError('FROZEN', { detail: 'Changes are frozen.' });
        }
        return;
      case 'draining':
        if (mutating) {
          throw new AppError('ENGINE_SHUTTING_DOWN', {
            detail: 'The engine is shutting down.',
          });
        }
        return;
      case 'stopped':
        throw new AppError('ENGINE_SHUTTING_DOWN', {
          detail: 'The engine has stopped.',
        });
    }
  }

  // ---- step 3: authenticate -------------------------------------------------------------------
  function buildContext(init: ExecutorContext): ActionContext {
    const candidate: unknown = init.principal;
    if (!isPrincipal(candidate)) {
      throw new AppError('UNAUTHENTICATED', {
        detail: 'No valid principal.',
      });
    }
    const mode: EngineMode | undefined = EngineModeSchema.safeParse(
      init.mode,
    ).data;
    if (mode === undefined) {
      throw new AppError('INTERNAL', { detail: 'The call has no valid mode.' });
    }
    // An unset or unknown environment class means prod (ADR-006).
    const env: EnvClass = EnvClassSchema.safeParse(init.env).data ?? 'prod';
    const correlationId =
      typeof init.correlationId === 'string' &&
      CORRELATION_ID.test(init.correlationId)
        ? init.correlationId
        : ids.correlationId();
    const signals = [stopper.signal];
    if (init.signal !== undefined) signals.push(init.signal);
    if (init.deadline !== undefined) {
      const remaining = init.deadline - clock.now();
      signals.push(
        remaining <= 0 ? AbortSignal.abort() : AbortSignal.timeout(remaining),
      );
    }
    return Object.freeze({
      principal: snapshotPrincipal(candidate),
      mode,
      env,
      correlationId,
      signal: AbortSignal.any(signals),
      ...(init.deadline === undefined ? {} : { deadline: init.deadline }),
      now: () => clock.now(),
    });
  }

  function targetOf(def: ActionDef, input: unknown): TargetRef {
    try {
      return def.target(input);
    } catch (cause) {
      throw new AppError('INTERNAL', {
        detail: 'The action could not name its target.',
        cause,
      });
    }
  }

  function riskOf(def: ActionDef, input: unknown, env: EnvClass): Risk {
    try {
      const risk =
        typeof def.risk === 'function' ? def.risk(input, env) : def.risk;
      return RiskSchema.parse(risk);
    } catch (cause) {
      throw new AppError('INTERNAL', {
        detail: 'The action could not rate its risk.',
        cause,
      });
    }
  }

  async function authorise(
    def: ActionDef,
    ctx: ActionContext,
    target: TargetRef,
  ): Promise<void> {
    const decision = await authorizer.authorize({
      principal: ctx.principal,
      permission: def.permission,
      actionId: def.id,
      target,
      mode: ctx.mode,
      env: ctx.env,
    });
    // `allowed` must be exactly true: anything else a buggy authorizer returns is a refusal.
    if ((decision as { allowed?: unknown }).allowed !== true) {
      throw new AppError('FORBIDDEN_RBAC', {
        detail:
          'allowed' in decision && !decision.allowed
            ? decision.reason
            : 'Not permitted.',
        missingPermission: def.permission,
      });
    }
  }

  function blockingGate(
    gates: readonly Gate[],
    code: 'CAPABILITY_MISSING' | 'GATE_BLOCKED',
  ): void {
    const gate = gates.find((candidate) => candidate.blocking);
    if (gate === undefined) return;
    throw new AppError(code, {
      detail: gate.reason,
      gate: {
        enabled: false,
        reason: gate.reason,
        ...(gate.source === undefined ? {} : { source: gate.source }),
        ...(gate.fix === undefined ? {} : { fix: gate.fix }),
      },
    });
  }

  async function guard(
    def: ActionDef,
    input: unknown,
    ctx: ActionContext,
    target: TargetRef,
  ): Promise<GuardrailDecision> {
    const risk = riskOf(def, input, ctx.env);
    let raw: unknown;
    try {
      raw = await guardrails.decide({
        def,
        input,
        risk,
        env: ctx.env,
        principal: ctx.principal,
        target,
        mutating: isMutating(def),
      });
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError('INTERNAL', {
        detail: 'The guardrail policy failed; the action was not run.',
        cause,
      });
    }
    // A policy is code from another work package: anything off the contract is a denial.
    const checked = DecisionSchema.safeParse(raw);
    if (!checked.success) {
      throw new AppError('INTERNAL', {
        detail:
          'The guardrail policy answered off its contract; the action was not run.',
      });
    }
    const decision = checked.data as GuardrailDecision;
    if (decision.denied !== undefined) {
      throw new AppError(decision.denied.code, {
        detail: decision.denied.reason,
      });
    }
    return decision;
  }

  /** Steps 1 to 7. */
  async function prepare(
    def: ActionDef,
    rawInput: unknown,
    init: ExecutorContext,
  ): Promise<Prepared> {
    const impl = resolve(def);
    ensureAccepting(def);
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', {
        detail: describeIssues(parsed.error),
      });
    }
    const input: unknown = parsed.data;
    const ctx = buildContext(init);
    const target = targetOf(def, input);
    const profile = await profiles.resolve({ def, input, target, ctx });
    blockingGate(profile.gates, 'CAPABILITY_MISSING');
    await authorise(def, ctx, target);
    const decision = await guard(def, input, ctx, target);
    return {
      impl,
      input,
      ctx,
      target,
      mutating: isMutating(def),
      decision,
      profile,
    };
  }

  // ---- step 8: plan ---------------------------------------------------------------------------
  async function draftOf(p: Prepared): Promise<{
    draft: PlanDraft;
    gates: Gate[];
    consents: string[];
  }> {
    let raw: unknown = {
      preview: {},
      gates: [],
      warnings: [],
      consentsRequired: [],
    };
    if (p.impl.plan !== undefined) {
      try {
        raw = await p.impl.plan(p.input, p.ctx);
      } catch (error) {
        throw toAppError(error);
      }
    }
    const checked = DraftSchema.safeParse(raw);
    if (!checked.success) {
      throw new AppError('INTERNAL', {
        detail: 'plan() returned a draft that breaks its contract.',
      });
    }
    const draft = checked.data as PlanDraft;
    const gates = [...p.profile.gates, ...draft.gates];
    blockingGate(gates, 'GATE_BLOCKED');
    const blocked = draft.warnings.find((w) => w.severity === 'block');
    if (blocked !== undefined) {
      throw new AppError('GATE_BLOCKED', {
        detail: `Blocked by warning ${blocked.id}.`,
        warnings: [blocked],
      });
    }
    const consents = [
      ...new Set([
        ...draft.consentsRequired,
        ...draft.warnings
          .filter((w) => w.severity === 'consent')
          .map((w) => w.id),
        ...p.decision.extraConsents,
      ]),
    ];
    return { draft, gates, consents };
  }

  async function createPlan(
    p: Prepared,
    drafted?: Awaited<ReturnType<typeof draftOf>>,
  ): Promise<PlanView> {
    const { draft, gates, consents } = drafted ?? (await draftOf(p));
    const { principal } = p.ctx;
    return plans.create({
      actionId: p.impl.def.id,
      input: p.input,
      ...(draft.sensitivePayload === undefined
        ? {}
        : { sensitivePayload: draft.sensitivePayload }),
      principalId: principal.id,
      onBehalfOfId: principal.onBehalfOf?.id ?? null,
      profileFingerprint: p.profile.fingerprint,
      env: p.ctx.env,
      risk: p.decision.risk,
      gates,
      warnings: draft.warnings,
      consentsRequired: consents,
      confirmationPhrase: p.decision.confirmationPhrase ?? null,
      approvalsRequired: p.decision.approvalsRequired,
      preview: draft.preview,
    });
  }

  // ---- steps 9 to 12: audit attempt, run, audit outcome, receipt ------------------------------
  interface Invocation {
    impl: ActionImpl;
    input: unknown;
    ctx: ActionContext;
    target: TargetRef;
    risk: Risk;
    consents: ReadonlySet<string>;
    plan?: Plan;
  }

  async function invoke(call: Invocation): Promise<ExecuteOutcome> {
    const { impl, ctx } = call;
    const { def } = impl;
    const startedAt = clock.now();
    const entry: AuditEntry = {
      at: startedAt,
      correlationId: ctx.correlationId,
      actionId: def.id,
      kind: def.kind,
      principal: ctx.principal,
      target: call.target,
      env: ctx.env,
      risk: call.risk,
      ...(call.plan === undefined
        ? {}
        : { planId: call.plan.id, planDigest: call.plan.digest }),
    };

    if (ctx.signal.aborted) {
      throw new AppError(
        phase === 'stopped' ? 'ENGINE_SHUTTING_DOWN' : 'INTERNAL',
        { detail: 'The call was cancelled before it started.' },
      );
    }
    if (def.audit === 'attempt+outcome') {
      try {
        await audit.attempt(entry);
      } catch (cause) {
        throw new AppError('INTERNAL', {
          detail:
            'The audit attempt could not be written, so the action was not run.',
          cause,
        });
      }
    }

    let result: ExecuteOutcome | undefined;
    let failure: AppError | undefined;
    const execCtx: ExecuteContext = {
      ...ctx,
      consents: call.consents,
      writes,
      ...(call.plan === undefined ? {} : { plan: call.plan }),
    };
    try {
      const raw: unknown = await impl.execute(call.input, execCtx);
      const job =
        def.kind === 'job' ? JobResultSchema.safeParse(raw) : undefined;
      if (job?.success === true) {
        result = { kind: 'job', jobId: job.data.jobId as JobId };
      } else {
        const output = def.output.safeParse(raw);
        if (!output.success) {
          failure = new AppError('INTERNAL', {
            detail: 'The action ran but its result breaks its contract.',
          });
        } else {
          result = { kind: 'output', output: output.data };
        }
      }
    } catch (error) {
      failure = toAppError(error);
    }

    // The outcome row: the action ran (or failed), so a failed write is reported, not undone.
    let auditGap = false;
    if (def.audit !== 'none') {
      const outcome: AuditOutcome = {
        ...entry,
        at: clock.now(),
        result: failure === undefined ? 'ok' : 'error',
        ...(failure === undefined ? {} : { code: failure.code }),
        ...(result?.kind === 'job' ? { jobId: result.jobId } : {}),
      };
      try {
        await audit.outcome(outcome);
      } catch (cause) {
        auditGap = true;
        options.logger?.error(
          {
            event: 'audit.outcome.failed',
            actionId: def.id,
            correlationId: ctx.correlationId,
            cause: cause instanceof Error ? cause.name : 'unknown',
          },
          'the audit outcome could not be written',
        );
      }
    }

    let receiptId: ReceiptId | undefined;
    if (options.receipts !== undefined) {
      try {
        receiptId = await options.receipts.record({
          actionId: def.id,
          principal: ctx.principal,
          correlationId: ctx.correlationId,
          env: ctx.env,
          risk: call.risk,
          startedAt,
          finishedAt: clock.now(),
          result: failure === undefined ? 'ok' : 'error',
          ...(failure === undefined ? {} : { code: failure.code }),
          ...(call.plan === undefined
            ? {}
            : { planId: call.plan.id, planDigest: call.plan.digest }),
          ...(result?.kind === 'job' ? { jobId: result.jobId } : {}),
        });
      } catch {
        options.logger?.error(
          { event: 'receipt.failed', actionId: def.id },
          'the receipt could not be recorded',
        );
      }
    }

    if (failure !== undefined) throw failure;
    if (result === undefined) {
      throw new AppError('INTERNAL', {
        detail: 'The action produced no result.',
      });
    }
    if (result.kind === 'output') {
      return {
        ...result,
        ...(receiptId === undefined ? {} : { receiptId }),
        ...(auditGap ? { auditOutcomeFailed: true } : {}),
      };
    }
    return result;
  }

  /** Counts a running execution for the drain, whatever happens to it. */
  async function counted<T>(work: () => Promise<T>): Promise<T> {
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
    }
  }

  // ---- the public surface ---------------------------------------------------------------------
  return {
    register(...toRegister) {
      if (phase === 'stopped') {
        throw new TypeError('The executor has stopped.');
      }
      for (const impl of toRegister) {
        if (!isImplementedAction(impl)) {
          throw new TypeError(
            'Only implementAction(...) results can be registered.',
          );
        }
        if (impls.has(impl.def.id)) {
          throw new TypeError(`Action ${impl.def.id} is already registered.`);
        }
        impls.set(impl.def.id, impl);
      }
    },

    registered: () => [...impls.values()].map((impl) => impl.def),

    async run<A extends ActionDef>(
      def: A,
      rawInput: unknown,
      init: ExecutorContext,
    ): Promise<RunOutcome<A>> {
      try {
        const p = await prepare(def, rawInput, init);
        const { decision } = p;
        const mustPlan =
          decision.planning === 'required' ||
          decision.confirmationPhrase !== undefined ||
          decision.approvalsRequired > 0 ||
          decision.extraConsents.length > 0;
        if (mustPlan) {
          return { kind: 'planRequired', plan: await createPlan(p) };
        }
        if (decision.planning === 'optional') {
          // A direct call still honours what planning would have said (gates, consents).
          const drafted = await draftOf(p);
          if (drafted.consents.length > 0) {
            return {
              kind: 'planRequired',
              plan: await createPlan(p, drafted),
            };
          }
        }
        if (!p.mutating) {
          return (await counted(() =>
            invoke({
              impl: p.impl,
              input: p.input,
              ctx: p.ctx,
              target: p.target,
              risk: decision.risk,
              consents: new Set(),
            }),
          )) as RunOutcome<A>;
        }
        const principalId = p.ctx.principal.id;
        const key = await idempotency.ensureUnused(
          principalId,
          init.idempotencyKey,
        );
        return await counted(async () => {
          await idempotency.claim(principalId, key, {
            actionId: def.id,
            planId: null,
            at: clock.now(),
          });
          return (await invoke({
            impl: p.impl,
            input: p.input,
            ctx: p.ctx,
            target: p.target,
            risk: decision.risk,
            consents: new Set(),
          })) as RunOutcome<A>;
        });
      } catch (error) {
        throw refuse(toAppError(error));
      }
    },

    async plan(def, rawInput, init) {
      try {
        const p = await prepare(def, rawInput, init);
        if (p.decision.planning === 'none') {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'This action does not take a plan; call it directly.',
          });
        }
        return await createPlan(p);
      } catch (error) {
        throw refuse(toAppError(error));
      }
    },

    async getPlan(planId, init) {
      try {
        const ctx = buildContext(init);
        const view = await plans.view(planId);
        if (view === undefined) {
          throw new AppError('NOT_FOUND', { detail: 'Unknown plan.' });
        }
        const owner = {
          principalId: view.principalId,
          onBehalfOfId: view.onBehalfOfId ?? null,
        };
        if (mayActFor(ctx.principal, owner)) return view;
        const approver = await authorizer.authorize({
          principal: ctx.principal,
          permission: APPROVE_PERMISSION,
          actionId: view.actionId,
          target: {},
          mode: ctx.mode,
          env: ctx.env,
        });
        if (!approver.allowed) {
          throw new AppError('FORBIDDEN_RBAC', { detail: 'Not permitted.' });
        }
        return view;
      } catch (error) {
        throw refuse(toAppError(error));
      }
    },

    async approve(planId, decision, init, note) {
      try {
        ensureAccepting(undefined);
        const ctx = buildContext(init);
        const view = await plans.view(planId);
        if (view === undefined) {
          throw new AppError('NOT_FOUND', { detail: 'Unknown plan.' });
        }
        const impl = impls.get(view.actionId);
        if (impl === undefined) {
          throw new AppError('NOT_FOUND', { detail: 'Unknown action.' });
        }
        const { principal } = ctx;
        if (principal.unattended) {
          throw new AppError('FORBIDDEN_RBAC', {
            detail: 'An unattended principal cannot approve a plan.',
          });
        }
        if (
          isRequester(principal, {
            principalId: view.principalId,
            onBehalfOfId: view.onBehalfOfId ?? null,
          })
        ) {
          throw new AppError('FORBIDDEN_RBAC', {
            detail: 'An approver must differ from the requester.',
          });
        }
        for (const permission of [APPROVE_PERMISSION, impl.def.permission]) {
          const allowed = await authorizer.authorize({
            principal,
            permission: permission as typeof impl.def.permission,
            actionId: impl.def.id,
            target: {},
            mode: ctx.mode,
            env: ctx.env,
          });
          if (!allowed.allowed) {
            throw new AppError('FORBIDDEN_RBAC', {
              detail: 'Not permitted.',
              missingPermission: permission as typeof impl.def.permission,
            });
          }
        }
        return await plans.approve(planId, principal.id, decision, note);
      } catch (error) {
        throw refuse(toAppError(error));
      }
    },

    async execute(rawRequest, init) {
      try {
        const parsedRequest = ExecuteRequestSchema.safeParse(rawRequest);
        if (!parsedRequest.success) {
          throw new AppError('VALIDATION_FAILED', {
            detail: describeIssues(parsedRequest.error),
          });
        }
        const req = parsedRequest.data;
        const planId = req.planId;
        const ctx = buildContext(init);
        const { principal } = ctx;

        // Whose plan is it? Checked on the plain columns before anything is decrypted.
        const view = await plans.view(planId);
        if (view === undefined) {
          throw new AppError('NOT_FOUND', { detail: 'Unknown plan.' });
        }
        const owner = {
          principalId: view.principalId,
          onBehalfOfId: view.onBehalfOfId ?? null,
        };
        if (!mayActFor(principal, owner)) {
          throw new AppError('FORBIDDEN_RBAC', {
            detail: 'This plan belongs to another principal.',
          });
        }
        if (principal.surface === 'mcp') {
          throw new AppError('FORBIDDEN_RBAC', {
            detail: 'An MCP client can create plans; a person executes them.',
          });
        }
        const impl = impls.get(view.actionId);
        if (impl === undefined) {
          throw new AppError('NOT_FOUND', { detail: 'Unknown action.' });
        }
        const { def } = impl;
        ensureAccepting(def);

        // State and expiry (PLAN_EXPIRED, or PLAN_STALE for a plan that was already used), then the
        // seal: the digest sealed in the encrypted payload must match every bound field.
        const opened = await plans.open(planId);
        const key = await idempotency.ensureUnused(
          principal.id,
          req.idempotencyKey,
        );

        const parsedInput = def.input.safeParse(opened.input);
        if (!parsedInput.success) {
          throw new AppError('PLAN_STALE', {
            detail: 'The stored input no longer fits the action.',
          });
        }
        const input: unknown = parsedInput.data;
        const target = targetOf(def, input);

        await authorise(def, ctx, target);
        const decision = await guard(def, input, ctx, target);
        const granted = opened.view;
        if (
          ctx.env !== granted.env ||
          RiskSchema.options.indexOf(decision.risk) >
            RiskSchema.options.indexOf(granted.risk) ||
          decision.approvalsRequired > granted.approvals.required ||
          (decision.confirmationPhrase !== undefined &&
            granted.confirmationPhrase === undefined) ||
          decision.extraConsents.some(
            (consent) => !granted.consentsRequired.includes(consent),
          )
        ) {
          throw new AppError('PLAN_STALE', {
            detail: 'The policy changed since the plan was made; plan again.',
          });
        }

        // consents ⊇ required
        const given = new Set(req.consents);
        const missing = granted.consentsRequired.filter((c) => !given.has(c));
        if (missing.length > 0) {
          throw new AppError('CONSENT_REQUIRED', {
            detail: `Missing consent: ${missing.join(', ')}.`,
          });
        }
        // the typed phrase, checked here and not in the UI
        if (granted.confirmationPhrase !== undefined) {
          if (
            req.confirmation === undefined ||
            !sameText(req.confirmation, granted.confirmationPhrase)
          ) {
            throw new AppError('CONFIRMATION_MISMATCH', {
              detail: 'The typed confirmation does not match.',
            });
          }
        }
        // approvals from different principals, each of this very digest; one rejection vetoes
        if (granted.approvals.required > 0) {
          const approvals = opened.approvals;
          const approvers = new Set(
            approvals
              .filter(
                (a) =>
                  a.decision === 'approve' &&
                  a.digest === granted.digest &&
                  a.by !== owner.principalId &&
                  a.by !== owner.onBehalfOfId,
              )
              .map((a) => a.by),
          );
          if (
            approvals.some((a) => a.decision === 'reject') ||
            approvers.size < granted.approvals.required
          ) {
            throw new AppError('APPROVAL_REQUIRED', {
              detail: `${String(granted.approvals.required)} approval(s) from other principals are required.`,
            });
          }
        }
        if (
          req.expectedDigest !== undefined &&
          req.expectedDigest !== granted.digest
        ) {
          throw new AppError('PLAN_STALE', {
            detail: 'The plan is not the one you reviewed.',
          });
        }

        // TOCTOU: the broker profile and the action's own preflight must still agree.
        const profile = await profiles.resolve({ def, input, target, ctx });
        blockingGate(profile.gates, 'CAPABILITY_MISSING');
        if ((profile.fingerprint ?? undefined) !== granted.profileFingerprint) {
          throw new AppError('PLAN_STALE', {
            detail: 'The broker profile changed since the plan was made.',
          });
        }
        const plan: Plan = {
          ...granted,
          input,
          ...(opened.sensitivePayload === undefined
            ? {}
            : { sensitivePayload: opened.sensitivePayload }),
        };
        if (impl.revalidate !== undefined) {
          let verdict: Awaited<ReturnType<NonNullable<typeof impl.revalidate>>>;
          try {
            verdict = await impl.revalidate(plan, ctx);
          } catch (error) {
            throw toAppError(error);
          }
          if (verdict !== 'valid') {
            throw new AppError('PLAN_STALE', {
              detail:
                typeof verdict === 'object' && typeof verdict.stale === 'string'
                  ? verdict.stale
                  : 'The plan is stale.',
            });
          }
        }

        return await counted(async () => {
          await idempotency.claim(principal.id, key, {
            actionId: def.id,
            planId,
            at: clock.now(),
          });
          await plans.start(planId);
          // From here the plan is consumed, whatever happens. A failure to record the end of the
          // run must not hide a result the broker already acted on.
          const finish = async (
            state: 'executed' | 'failed',
          ): Promise<void> => {
            try {
              await plans.finish(planId, state);
            } catch {
              options.logger?.error(
                { event: 'plan.finish.failed', planId, state },
                'the end of a plan could not be recorded',
              );
            }
          };
          let outcome: ExecuteOutcome;
          try {
            outcome = await invoke({
              impl,
              input,
              ctx,
              target,
              risk: granted.risk,
              consents: given,
              plan,
            });
          } catch (error) {
            await finish('failed');
            throw error;
          }
          await finish('executed');
          return outcome;
        });
      } catch (error) {
        throw refuse(toAppError(error));
      }
    },

    state: () => phase,
    inFlight: () => running,
    beginDrain() {
      if (phase !== 'stopped') phase = 'draining';
    },
    freeze() {
      if (phase === 'accepting') phase = 'frozen-partial';
    },
    unfreeze() {
      if (phase === 'frozen-partial') phase = 'accepting';
    },
    stop() {
      phase = 'stopped';
      stopper.abort();
    },
  };
}
