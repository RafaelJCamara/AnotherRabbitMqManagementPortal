// The prod lock's two actions (blueprint 5.9, M0-30): arming a production connection for 15 minutes
// and putting the lock back. Both are audited like any command (attempt, then outcome), which is
// how "every arm and disarm is audited" is kept. Their behaviour lives in the kernel
// (guardrails/ops-actions.ts); the engine has no other way to arm.
import { z } from 'zod';
import { ConnectionIdSchema } from '../brands.ts';
import { defineAction } from '../kit/define-action.ts';

export const OpsArmInputSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
});

export const OpsArmOutputSchema = z.strictObject({
  armed: z.literal(true),
  connectionId: ConnectionIdSchema,
  /** Epoch milliseconds. */
  armedAt: z.number().int(),
  /** Epoch milliseconds; 15 minutes after `armedAt`. Arm again to continue. */
  expiresAt: z.number().int(),
});

export const opsArm = defineAction({
  id: 'ops.arm',
  kind: 'command',
  summary:
    'Arm a production connection for 15 minutes so that changes are allowed on it',
  input: OpsArmInputSchema,
  output: OpsArmOutputSchema,
  permission: 'ops.arm',
  risk: 'low',
  planning: 'none',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.connectionId }),
  http: { method: 'POST', path: '/connections/{connectionId}/arm' },
  since: '1.0',
});

export const OpsDisarmOutputSchema = z.strictObject({
  armed: z.literal(false),
  connectionId: ConnectionIdSchema,
  /** False when the connection was not armed (or the window had already passed). */
  wasArmed: z.boolean(),
});

export const opsDisarm = defineAction({
  id: 'ops.disarm',
  kind: 'command',
  summary: 'Lock a production connection again before its arming runs out',
  input: OpsArmInputSchema,
  output: OpsDisarmOutputSchema,
  permission: 'ops.arm',
  risk: 'none',
  planning: 'none',
  audit: 'attempt+outcome',
  target: (input) => ({ connectionId: input.connectionId }),
  http: { method: 'POST', path: '/connections/{connectionId}/disarm' },
  since: '1.0',
});
