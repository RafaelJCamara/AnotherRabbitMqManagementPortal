// Errors are Problem objects (blueprint 3.6, RFC 9457 shape): a stable `code`, never a stack trace.
import { z } from 'zod';
import { ActionIdSchema, PermissionSchema, WarningIdSchema } from './brands.ts';

export const ErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN_RBAC',
  'FORBIDDEN_BROKER',
  'NOT_FOUND',
  'PLAN_STALE',
  'PLAN_EXPIRED',
  'CAPABILITY_MISSING',
  'GATE_BLOCKED',
  'PLAN_REQUIRED',
  'CONSENT_REQUIRED',
  'APPROVAL_REQUIRED',
  'CONFIRMATION_MISMATCH',
  'BUDGET_EXCEEDED',
  'RATE_LIMITED',
  'FROZEN',
  'BROKER_ERROR',
  'BROKER_RESOURCE_LOCKED',
  'BROKER_PRECONDITION_FAILED',
  'BROKER_UNREACHABLE',
  'ENGINE_SHUTTING_DOWN',
  'TOKEN_EXPIRED',
  'TOKEN_TOO_LARGE',
  'EGRESS_DENIED',
  'TLS_UNTRUSTED',
  'SEMANTICS_GAP',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Whether a feature or action is available on this broker, and the action that fixes it. */
export const GateDecisionSchema = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(['full', 'degraded']).optional(),
  reason: z.string().optional(),
  source: z.string().optional(),
  // The input of the fixing action depends on that action; `unknown` is the honest type here.
  fix: z
    .strictObject({ actionId: ActionIdSchema, input: z.unknown() })
    .optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

export const WarningRefSchema = z.strictObject({
  id: WarningIdSchema,
  severity: z.enum(['info', 'warn', 'consent', 'block']),
  textKey: z.string(),
  textVersion: z.number().int().nonnegative(),
});
export type WarningRef = z.infer<typeof WarningRefSchema>;

export const ProblemSchema = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(100).max(599),
  code: ErrorCodeSchema,
  detail: z.string().optional(),
  correlationId: z.string(),
  retryable: z.boolean(),
  gate: GateDecisionSchema.optional(),
  warnings: z.array(WarningRefSchema).optional(),
  missingPermission: PermissionSchema.optional(),
  broker: z
    .strictObject({
      protocol: z.enum(['http', 'amqp091', 'amqp10', 'stream']),
      classId: z.number().int().optional(),
      code: z.union([z.number(), z.string()]).optional(),
      text: z.string().optional(),
    })
    .optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;
