import {
  ErrorCodeSchema,
  ProblemSchema,
  type ErrorCode,
  type Permission,
} from '@app/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createManualClock } from '../clock/clock.ts';
import { createIdGenerator, isUlid } from '../ids/ids.ts';
import { REDACTED } from '../log/redact.ts';
import { AppError, PROBLEM_STATUS, problemType, toProblem } from './problem.ts';

const CORRELATION_ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';

describe('PROBLEM_STATUS', () => {
  it('maps every code of the contract, and only those', () => {
    expect(Object.keys(PROBLEM_STATUS).sort()).toEqual(
      [...ErrorCodeSchema.options].sort(),
    );
  });

  it('follows the table of blueprint 3.6', () => {
    const table: Partial<Record<ErrorCode, number>> = {
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
    };
    for (const [code, status] of Object.entries(table)) {
      expect(PROBLEM_STATUS[code as ErrorCode], code).toBe(status);
    }
  });
});

describe('toProblem', () => {
  it('turns an AppError into a Problem that satisfies the contract', () => {
    const permission = 'messages.purge' as Permission;
    const problem = toProblem(
      new AppError('FORBIDDEN_RBAC', {
        detail: 'purge needs messages.purge',
        missingPermission: permission,
      }),
      { correlationId: CORRELATION_ID },
    );
    expect(problem).toEqual({
      type: 'urn:problem:forbidden-rbac',
      title: 'Not permitted',
      status: 403,
      code: 'FORBIDDEN_RBAC',
      detail: 'purge needs messages.purge',
      correlationId: CORRELATION_ID,
      retryable: false,
      missingPermission: permission,
    });
    expect(ProblemSchema.parse(problem)).toEqual(problem);
  });

  it('every code produces a Problem the contract accepts', () => {
    for (const code of ErrorCodeSchema.options) {
      const problem = toProblem(new AppError(code), {
        correlationId: CORRELATION_ID,
      });
      expect(ProblemSchema.safeParse(problem).success, code).toBe(true);
      expect(problem.status).toBe(PROBLEM_STATUS[code]);
      expect(problem.type).toBe(problemType(code));
    }
  });

  it('carries gate, warnings and broker details, and honours overrides', () => {
    const problem = toProblem(
      new AppError('BROKER_ERROR', {
        status: 504,
        retryable: true,
        gate: { enabled: false, reason: 'provider restriction' },
        warnings: [
          {
            id: 'W-1',
            severity: 'warn',
            textKey: 'warning.w1',
            textVersion: 1,
          },
        ],
        broker: {
          protocol: 'amqp091',
          classId: 50,
          code: 404,
          text: 'NOT_FOUND',
        },
      }),
      { correlationId: CORRELATION_ID },
    );
    expect(problem).toMatchObject({
      status: 504,
      retryable: true,
      gate: { enabled: false, reason: 'provider restriction' },
      broker: {
        protocol: 'amqp091',
        classId: 50,
        code: 404,
        text: 'NOT_FOUND',
      },
    });
    expect(problem.warnings).toHaveLength(1);
    expect(ProblemSchema.safeParse(problem).success).toBe(true);
  });

  it('marks only the transient codes as retryable by default', () => {
    const retryable = ErrorCodeSchema.options.filter(
      (code) =>
        toProblem(new AppError(code), { correlationId: CORRELATION_ID })
          .retryable,
    );
    expect(retryable.sort()).toEqual([
      'BROKER_RESOURCE_LOCKED',
      'BROKER_UNREACHABLE',
      'ENGINE_SHUTTING_DOWN',
      'RATE_LIMITED',
    ]);
  });

  it('maps a ZodError to VALIDATION_FAILED with the failing paths and no input values', () => {
    const schema = z.strictObject({
      port: z.number().int(),
      user: z.strictObject({ password: z.string().min(12) }),
    });
    const result = schema.safeParse({
      port: 'canary-port-value',
      user: { password: 'canary-x' },
    });
    expect(result.success).toBe(false);
    const problem = toProblem(result.error, { correlationId: CORRELATION_ID });
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain('port');
    expect(problem.detail).toContain('user.password');
    expect(JSON.stringify(problem)).not.toContain('canary');
  });

  it('maps an unknown error to INTERNAL and leaks neither its message nor its stack', () => {
    const problem = toProblem(
      new Error('connect failed for amqps://svc:canary-pw@broker'),
      { correlationId: CORRELATION_ID },
    );
    expect(problem).toEqual({
      type: 'urn:problem:internal',
      title: 'Internal error',
      status: 500,
      code: 'INTERNAL',
      correlationId: CORRELATION_ID,
      retryable: false,
    });
    for (const thrown of ['a string', 42, null, undefined, { message: 'x' }]) {
      expect(toProblem(thrown, { correlationId: CORRELATION_ID }).code).toBe(
        'INTERNAL',
      );
    }
  });

  it('redacts secrets that an author put in the detail or the broker text', () => {
    const problem = toProblem(
      new AppError('BROKER_UNREACHABLE', {
        detail: 'cannot reach amqps://svc:canary-pw@broker.example:5671',
        broker: {
          protocol: 'amqp091',
          text: 'refused for Bearer canary-bearer-token-value',
        },
      }),
      { correlationId: CORRELATION_ID },
    );
    expect(JSON.stringify(problem)).not.toContain('canary');
    expect(problem.detail).toBe(
      `cannot reach amqps://${REDACTED}@broker.example:5671`,
    );
  });

  it('keeps a Problem that is thrown as it is', () => {
    const original = toProblem(new AppError('NOT_FOUND', { detail: 'queue' }), {
      correlationId: CORRELATION_ID,
    });
    expect(toProblem(original, { correlationId: 'other' })).toEqual(original);
  });

  it('mints a ULID correlation id when none is given, from the injected generator', () => {
    const ids = createIdGenerator({ clock: createManualClock(1_000) });
    const problem = toProblem(new AppError('NOT_FOUND'), { ids });
    expect(isUlid(problem.correlationId)).toBe(true);
    expect(isUlid(toProblem(new Error('x')).correlationId)).toBe(true);
  });

  it('does not copy the cause into the Problem', () => {
    const problem = toProblem(
      new AppError('INTERNAL', { cause: new Error('canary-cause') }),
      { correlationId: CORRELATION_ID },
    );
    expect(JSON.stringify(problem)).not.toContain('canary');
  });
});

describe('AppError', () => {
  it('is an Error with its code, a readable message and the cause', () => {
    const cause = new Error('root');
    const error = new AppError('NOT_FOUND', { detail: 'no such queue', cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('NOT_FOUND: no such queue');
    expect(error.cause).toBe(cause);
    expect(new AppError('INTERNAL').message).toBe('INTERNAL');
  });
});
