// The local guardrail policy (blueprint 5.1 step 7 and 5.9, DC-40/42): the prod lock.
//
//   - An unset or unknown environment class means prod (the executor already applies that), and
//     "not a known non-prod class" is read as prod here too, so a new class fails closed.
//   - In prod, a mutation is locked until the person ARMS the connection (`ops.arm`, 15 minutes, an
//     audited action). Peeks count as mutations: `mutating` is true for every kind but a query.
//     There is no sliding window: when the 15 minutes pass, the person arms again.
//   - The lock is checked when a call is prepared (run, plan) and again when a plan is executed, so
//     a window that closed in between wins over the plan.
//   - An AI client (the MCP surface, however far down the chain) has no mutations in prod at all:
//     it can neither arm nor use someone else's arming (blueprint 5.9, table row "AI").
//   - Only a person at the UI or CLI can arm: not an unattended principal, not a delegate.
//   - Arming is per person and per connection, and lives in memory: a restart locks everything again.
//   - One exception to "no target, no way in": a contract that declares `scope: 'local'` (it changes
//     only the engine's own state, such as a saved profile or a view) and names no target is not
//     locked, since there is no connection to arm. Nothing else is exempt: not an action by name,
//     not an environment class. It is still authorised, audited and refused to an AI client.
//
// Besides the lock the policy keeps the rules of the M0-29 stand-in: the action's own typed phrase,
// a plan for a high-risk or critical mutation in prod and staging, and a plan for everything an
// unattended principal asks for.
import { actionId, type EnvClass, type GateDecision } from '@app/contracts';
import type { Principal } from '@app/ports';

import { chainOf } from '../actions/principal.ts';
import type { GuardrailInput, GuardrailPolicy } from '../actions/hooks.ts';
import { isLocalCall } from '../actions/local-scope.ts';
import type { GuardrailDecision } from '../actions/types.ts';
import type { Clock } from '../clock/clock.ts';
import { AppError } from '../problem/problem.ts';

/** How long an arming lasts: 15 minutes, with an explicit re-arm (critique fix). */
export const ARM_WINDOW_MS = 15 * 60_000;
/** The `source` of the gate that a locked call is refused with. */
export const PROD_LOCK_GATE = 'prod-lock';
export const ARM_ACTION_ID = 'ops.arm';
export const DISARM_ACTION_ID = 'ops.disarm';

/** Classes the lock does not apply to. Anything else, an unknown one included, is prod. */
const OPEN_ENVS: ReadonlySet<string> = new Set<EnvClass>([
  'staging',
  'test',
  'dev',
  'local',
]);

/** Arming records kept at once: one per person and connection, so a bound far above real use. */
const MAX_ARMED = 1000;

export interface ArmStatus {
  armed: boolean;
  armedAt?: number;
  expiresAt?: number;
}

/**
 * The write side of the lock. It is handed to the `ops.arm` and `ops.disarm` actions and to nothing
 * else; the policy itself can only read it.
 */
export interface ArmingControl {
  /** Arms (or re-arms) for the window. Throws `FORBIDDEN_RBAC` unless `principal` is a person. */
  arm(principal: Principal, connectionId: string): Required<ArmStatus>;
  /** True when the person was armed. */
  disarm(principal: Principal, connectionId: string): boolean;
  status(principal: Principal, connectionId: string): ArmStatus;
}

export interface GuardrailsOptions {
  clock: Clock;
  /** Shorter than 15 minutes for tests; never longer. */
  armWindowMs?: number;
}

export interface Guardrails {
  readonly policy: GuardrailPolicy;
  readonly arming: ArmingControl;
}

/** A person at the UI or CLI who acts for no one. The only kind of principal that can arm. */
export function canArm(principal: Principal): boolean {
  return (
    !principal.unattended &&
    principal.onBehalfOf === undefined &&
    (principal.surface === 'ui' || principal.surface === 'cli') &&
    // Whatever surface a principal claims, an AI client, a job or the system is never a person.
    principal.kind !== 'mcp-client' &&
    principal.kind !== 'job' &&
    principal.kind !== 'system'
  );
}

/** The principal at the end of the chain: the person a job or a delegate is accountable to. */
function accountable(principal: Principal): Principal {
  return chainOf(principal).at(-1) ?? principal;
}

const PLANNING_ORDER = ['none', 'optional', 'required'] as const;

function stricter(
  a: GuardrailDecision['planning'],
  b: GuardrailDecision['planning'],
): GuardrailDecision['planning'] {
  return PLANNING_ORDER.indexOf(a) >= PLANNING_ORDER.indexOf(b) ? a : b;
}

/** What the rules above the lock decide: the typed phrase, planning, approvals. */
function baseDecision(input: GuardrailInput): GuardrailDecision {
  const { def, risk, env, principal, mutating } = input;
  let planning = def.planning;
  const phrase = def.confirm?.requiredWhen(env, risk)
    ? def.confirm.phrase(input.input)
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
  return {
    risk,
    planning,
    // Team approvals arrive with M3.
    approvalsRequired: 0,
    ...(phrase === undefined ? {} : { confirmationPhrase: phrase }),
    forbidLetBrokerHandle: false,
    extraConsents: [],
  };
}

function lockedGate(connectionId: string | undefined): GateDecision {
  return {
    enabled: false,
    reason:
      'This is a production connection and it is locked. Arm it to make changes for 15 minutes.',
    source: PROD_LOCK_GATE,
    ...(connectionId === undefined
      ? {}
      : {
          fix: {
            actionId: actionId(ARM_ACTION_ID),
            input: { connectionId },
          },
        }),
  };
}

export function createGuardrails(options: GuardrailsOptions): Guardrails {
  const { clock } = options;
  const window = Math.min(
    ARM_WINDOW_MS,
    Math.max(1, Math.trunc(options.armWindowMs ?? ARM_WINDOW_MS)),
  );
  const armed = new Map<string, { armedAt: number; expiresAt: number }>();

  // JSON, so that no id can be chosen to make two different pairs one key.
  const keyOf = (principal: Principal, connectionId: string): string =>
    JSON.stringify([accountable(principal).id, connectionId]);

  /** A record counts only inside its window; a clock that went back does not extend one. */
  const live = (
    record: { armedAt: number; expiresAt: number } | undefined,
    now: number,
  ): record is { armedAt: number; expiresAt: number } =>
    record !== undefined &&
    now >= record.armedAt &&
    now < record.expiresAt &&
    record.expiresAt - record.armedAt <= window;

  function sweep(now: number): void {
    for (const [key, record] of armed) {
      if (!live(record, now)) armed.delete(key);
    }
  }

  const arming: ArmingControl = {
    arm(principal, connectionId) {
      if (!canArm(principal)) {
        throw new AppError('FORBIDDEN_RBAC', {
          detail:
            'Only a person at the UI or the CLI can arm a connection; an unattended principal or a delegate cannot.',
        });
      }
      const now = clock.now();
      const key = keyOf(principal, connectionId);
      if (!armed.has(key) && armed.size >= MAX_ARMED) {
        sweep(now);
        if (armed.size >= MAX_ARMED) {
          throw new AppError('BUDGET_EXCEEDED', {
            detail: 'Too many connections are armed at once.',
          });
        }
      }
      const record = { armedAt: now, expiresAt: now + window };
      armed.set(key, record);
      return { armed: true, ...record };
    },

    disarm(principal, connectionId) {
      const key = keyOf(principal, connectionId);
      const wasArmed = live(armed.get(key), clock.now());
      armed.delete(key);
      return wasArmed;
    },

    status(principal, connectionId) {
      const record = armed.get(keyOf(principal, connectionId));
      return live(record, clock.now())
        ? { armed: true, ...record }
        : { armed: false };
    },
  };

  const policy: GuardrailPolicy = {
    decide(input) {
      const { def, env, principal, target, mutating } = input;
      const base = baseDecision(input);
      const deny = (
        code: 'GATE_BLOCKED' | 'FORBIDDEN_RBAC',
        reason: string,
        gate?: GateDecision,
      ): Promise<GuardrailDecision> =>
        Promise.resolve({
          ...base,
          denied: { code, reason, ...(gate === undefined ? {} : { gate }) },
        });

      const arms = def.id === ARM_ACTION_ID;
      if (arms && !canArm(principal)) {
        return deny(
          'FORBIDDEN_RBAC',
          'Only a person at the UI or the CLI can arm a connection.',
        );
      }
      // Reads are never locked, and neither is the way out of the lock (or back into it).
      if (
        !mutating ||
        OPEN_ENVS.has(env) ||
        arms ||
        def.id === DISARM_ACTION_ID
      ) {
        return Promise.resolve(base);
      }

      const connectionId = target.connectionId;
      if (chainOf(principal).some((member) => member.surface === 'mcp')) {
        return deny(
          'GATE_BLOCKED',
          `${PROD_LOCK_GATE}: an AI client cannot change a production connection.`,
          {
            enabled: false,
            reason:
              'AI clients have read tools only on a production connection.',
            source: PROD_LOCK_GATE,
          },
        );
      }
      if (
        connectionId !== undefined &&
        arming.status(principal, connectionId).armed
      ) {
        return Promise.resolve(base);
      }
      // The one other way past the lock: the contract declares `scope: 'local'` (engine-local state
      // only, never a broker) and the call names no target. There is nothing to arm for it. This
      // comes after the AI-client refusal above, and the permission check ran before this policy.
      if (isLocalCall(def, target)) return Promise.resolve(base);
      return deny(
        'GATE_BLOCKED',
        `${PROD_LOCK_GATE}: this connection is production and is not armed. Arm it with ops.arm to make changes for 15 minutes.`,
        lockedGate(connectionId),
      );
    },
  };

  return { policy, arming };
}
