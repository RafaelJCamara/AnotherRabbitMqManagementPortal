// `ops.arm` and `ops.disarm`: the only code that can arm or disarm a connection. They go through the
// executor like every command, so each call leaves an audit attempt and outcome row and a receipt;
// arming outside the executor is not possible (the policy sees only the read side of the lock).
import { opsArm, opsDisarm } from '@app/contracts';

import { implementAction } from '../actions/implement-action.ts';
import type { ActionImpl, PlanDraft } from '../actions/types.ts';
import { AppError } from '../problem/problem.ts';
import { ARM_WINDOW_MS, canArm, type ArmingControl } from './policy.ts';

/** Arming reads nothing and warns of nothing: the draft is the preview and nothing else. */
const draft = <P>(preview: P): Promise<PlanDraft<P>> =>
  Promise.resolve({ preview, gates: [], warnings: [], consentsRequired: [] });

/** The two implementations, ready to `executor.register(...)`. */
export function createArmActions(arming: ArmingControl): ActionImpl[] {
  const arm = implementAction(opsArm, {
    plan: (input) =>
      draft({ connectionId: input.connectionId, windowMs: ARM_WINDOW_MS }),
    revalidate: () => Promise.resolve('valid'),
    execute: (input, ctx) => {
      // The policy checks this too; a second check here costs nothing.
      if (!canArm(ctx.principal)) {
        throw new AppError('FORBIDDEN_RBAC', {
          detail: 'Only a person at the UI or the CLI can arm a connection.',
        });
      }
      const state = arming.arm(ctx.principal, input.connectionId);
      return Promise.resolve({
        armed: true as const,
        connectionId: input.connectionId,
        armedAt: state.armedAt,
        expiresAt: state.expiresAt,
      });
    },
  });

  const disarm = implementAction(opsDisarm, {
    plan: (input) => draft({ connectionId: input.connectionId }),
    revalidate: () => Promise.resolve('valid'),
    execute: (input, ctx) =>
      Promise.resolve({
        armed: false as const,
        connectionId: input.connectionId,
        wasArmed: arming.disarm(ctx.principal, input.connectionId),
      }),
  });

  return [arm, disarm];
}
