// Errors the UI handles (blueprint 3.6). An engine error is always a Problem; the interceptor
// turns it into an EngineProblemError so a feature reads `gate` and `warnings` from the error and
// never parses a response itself. Carrier failures stay TransportErrors (ui-platform).
import {
  ProblemSchema,
  type ErrorCode,
  type GateDecision,
  type Problem,
  type WarningRef,
} from '@app/contracts';

export interface EngineProblemOptions {
  /** The `Location` header of the answer: the plan the engine created for a 428 PLAN_REQUIRED. */
  readonly location?: string | undefined;
  /** True when the engine did not send a Problem and the UI made one up from the HTTP status. */
  readonly synthetic?: boolean;
}

export class EngineProblemError extends Error {
  readonly problem: Problem;
  readonly location: string | undefined;
  readonly synthetic: boolean;

  constructor(problem: Problem, options: EngineProblemOptions = {}) {
    super(problem.detail ?? problem.title);
    this.name = 'EngineProblemError';
    this.problem = problem;
    this.location = options.location;
    this.synthetic = options.synthetic ?? false;
  }

  get code(): ErrorCode {
    return this.problem.code;
  }

  get status(): number {
    return this.problem.status;
  }

  get retryable(): boolean {
    return this.problem.retryable;
  }

  get correlationId(): string {
    return this.problem.correlationId;
  }

  /** Why an action is blocked, with the fixing action when there is one. */
  get gate(): GateDecision | undefined {
    return this.problem.gate;
  }

  get warnings(): readonly WarningRef[] {
    return this.problem.warnings ?? [];
  }
}

export const isEngineProblem = (value: unknown): value is EngineProblemError =>
  value instanceof EngineProblemError;

const PROBLEM_KEYS = Object.keys(ProblemSchema.shape);

/**
 * The Problem in a response body, or undefined. Keys this build does not know are dropped first, so
 * an engine that adds a field does not turn every error into a made-up one.
 */
export function parseProblem(body: unknown): Problem | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }
  const known = Object.fromEntries(
    Object.entries(body).filter(([key]) => PROBLEM_KEYS.includes(key)),
  );
  const parsed = ProblemSchema.safeParse(known);
  return parsed.success ? parsed.data : undefined;
}

const SYNTHETIC_CODES = new Map<number, ErrorCode>([
  [401, 'UNAUTHENTICATED'],
  [404, 'NOT_FOUND'],
  [429, 'RATE_LIMITED'],
]);

/** A Problem for an error answer that carries none (a proxy page, a crashed route). */
export function syntheticProblem(
  status: number,
  correlationId: string,
): Problem {
  const http = Math.min(599, Math.max(100, Math.trunc(status)));
  return {
    type: 'about:blank',
    title: `HTTP ${String(http)}`,
    status: http,
    code: SYNTHETIC_CODES.get(http) ?? 'INTERNAL',
    correlationId,
    retryable: http === 429 || (http >= 502 && http <= 504),
  };
}
