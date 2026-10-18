// Problem mapping (blueprint 3.6, RFC 9457). Engine code throws `AppError` with a stable code;
// `toProblem` turns any thrown value into the Problem object that HTTP responses, live `error`
// and `end` frames, job records and receipts carry. A Problem never holds a stack trace, and
// text that came from a caught error is redacted (I-10).
import {
  ProblemSchema,
  type ErrorCode,
  type GateDecision,
  type Permission,
  type Problem,
  type WarningRef,
} from '@app/contracts';
import { ZodError } from 'zod';

import { createIdGenerator, type IdGenerator } from '../ids/ids.ts';
import { redactText } from '../log/redact.ts';

/** HTTP status per code. The first block is the table of blueprint 3.6; the rest is OQ-110. */
export const PROBLEM_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN_RBAC: 403,
  FORBIDDEN_BROKER: 403,
  NOT_FOUND: 404,
  PLAN_STALE: 409,
  CAPABILITY_MISSING: 412,
  GATE_BLOCKED: 422,
  PLAN_REQUIRED: 428,
  CONSENT_REQUIRED: 428,
  APPROVAL_REQUIRED: 428,
  BUDGET_EXCEEDED: 429,
  RATE_LIMITED: 429,
  BROKER_ERROR: 502,
  BROKER_RESOURCE_LOCKED: 502,
  BROKER_PRECONDITION_FAILED: 502,
  BROKER_UNREACHABLE: 503,
  ENGINE_SHUTTING_DOWN: 503,
  FROZEN: 503,
  INTERNAL: 500,
  // Codes the blueprint leaves to "as appropriate" or does not list (OQ-110).
  PLAN_EXPIRED: 409,
  CONFIRMATION_MISMATCH: 422,
  TOKEN_EXPIRED: 401,
  TOKEN_TOO_LARGE: 413,
  EGRESS_DENIED: 403,
  TLS_UNTRUSTED: 502,
  SEMANTICS_GAP: 422,
};

/** Codes for which repeating the same request later can succeed. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'BROKER_RESOURCE_LOCKED',
  'BROKER_UNREACHABLE',
  'ENGINE_SHUTTING_DOWN',
]);

const TITLES: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'Validation failed',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN_RBAC: 'Not permitted',
  FORBIDDEN_BROKER: 'Refused by the broker',
  NOT_FOUND: 'Not found',
  PLAN_STALE: 'Plan is stale',
  PLAN_EXPIRED: 'Plan has expired',
  CAPABILITY_MISSING: 'Capability missing',
  GATE_BLOCKED: 'Blocked by a gate',
  PLAN_REQUIRED: 'Plan required',
  CONSENT_REQUIRED: 'Consent required',
  APPROVAL_REQUIRED: 'Approval required',
  CONFIRMATION_MISMATCH: 'Confirmation does not match',
  BUDGET_EXCEEDED: 'Budget exceeded',
  RATE_LIMITED: 'Rate limited',
  FROZEN: 'Changes are frozen',
  BROKER_ERROR: 'Broker error',
  BROKER_RESOURCE_LOCKED: 'Broker resource is locked',
  BROKER_PRECONDITION_FAILED: 'Broker precondition failed',
  BROKER_UNREACHABLE: 'Broker unreachable',
  ENGINE_SHUTTING_DOWN: 'Engine is shutting down',
  TOKEN_EXPIRED: 'Token expired',
  TOKEN_TOO_LARGE: 'Token too large',
  EGRESS_DENIED: 'Outbound connection denied',
  TLS_UNTRUSTED: 'TLS certificate not trusted',
  SEMANTICS_GAP: 'Broker behaviour not established',
  INTERNAL: 'Internal error',
};

/** The `type` of a Problem: a URN, so it needs no host name (OQ-110). */
export function problemType(code: ErrorCode): string {
  return `urn:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

export interface AppErrorOptions {
  /** Shown to the user, so it must hold no secret; `toProblem` redacts it anyway. */
  detail?: string;
  /** Overrides the default for the code. */
  retryable?: boolean;
  /** Overrides the status of the code. */
  status?: number;
  gate?: GateDecision;
  warnings?: WarningRef[];
  missingPermission?: Permission;
  broker?: NonNullable<Problem['broker']>;
  /** The underlying error. It is never copied into the Problem. */
  cause?: unknown;
}

/** An expected failure with a stable code (blueprint 3.6). Throw this, not a bare Error. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;
  readonly retryable: boolean | undefined;
  readonly status: number | undefined;
  readonly gate: GateDecision | undefined;
  readonly warnings: WarningRef[] | undefined;
  readonly missingPermission: Permission | undefined;
  readonly broker: Problem['broker'];

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(
      options.detail === undefined ? code : `${code}: ${options.detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppError';
    this.code = code;
    this.detail = options.detail;
    this.retryable = options.retryable;
    this.status = options.status;
    this.gate = options.gate;
    this.warnings = options.warnings;
    this.missingPermission = options.missingPermission;
    this.broker = options.broker;
  }
}

export interface ToProblemOptions {
  /** The id of the request, action or job this failure belongs to. Minted when absent. */
  correlationId?: string;
  /** Where a minted correlation id comes from. */
  ids?: IdGenerator;
}

const defaultIds = createIdGenerator();

/** The members a failure can contribute to a Problem besides its code. */
interface Parts {
  detail?: string | undefined;
  gate?: GateDecision | undefined;
  warnings?: WarningRef[] | undefined;
  missingPermission?: Permission | undefined;
  broker?: Problem['broker'];
}

/** `path: message` for each issue. Zod messages describe the rule, never the rejected value. */
function describeIssues(error: ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join('.')}: ${issue.message}`,
    )
    .join('; ');
}

function build(
  code: ErrorCode,
  correlationId: string,
  parts: Parts,
  overrides: { status?: number | undefined; retryable?: boolean | undefined },
): Problem {
  const problem: Problem = {
    type: problemType(code),
    title: TITLES[code],
    status: overrides.status ?? PROBLEM_STATUS[code],
    code,
    correlationId,
    retryable: overrides.retryable ?? RETRYABLE.has(code),
  };
  // Optional members are set only when present (exactOptionalPropertyTypes).
  if (parts.detail !== undefined) problem.detail = redactText(parts.detail);
  if (parts.gate !== undefined) problem.gate = parts.gate;
  if (parts.warnings !== undefined) problem.warnings = parts.warnings;
  if (parts.missingPermission !== undefined) {
    problem.missingPermission = parts.missingPermission;
  }
  if (parts.broker !== undefined) {
    problem.broker =
      parts.broker.text === undefined
        ? parts.broker
        : { ...parts.broker, text: redactText(parts.broker.text) };
  }
  return problem;
}

/**
 * Maps any thrown value to a Problem.
 *
 * - `AppError`: its code, detail and extensions.
 * - a Problem (for example one that crossed a port boundary): kept as it is, re-redacted.
 * - `ZodError`: `VALIDATION_FAILED` listing the failing paths.
 * - anything else: `INTERNAL` with no detail. The message of an unknown error can carry a
 *   secret or a path, so it is left to the logs, where it is redacted.
 */
export function toProblem(
  err: unknown,
  options: ToProblemOptions = {},
): Problem {
  const correlationId =
    options.correlationId ?? (options.ids ?? defaultIds).correlationId();

  if (err instanceof AppError) {
    return build(err.code, correlationId, err, {
      status: err.status,
      retryable: err.retryable,
    });
  }

  if (err instanceof ZodError) {
    return build(
      'VALIDATION_FAILED',
      correlationId,
      { detail: describeIssues(err) },
      {},
    );
  }

  const existing = ProblemSchema.safeParse(err);
  if (existing.success) {
    const problem = existing.data;
    return build(problem.code, problem.correlationId, problem, {
      status: problem.status,
      retryable: problem.retryable,
    });
  }

  return build('INTERNAL', correlationId, {}, {});
}
