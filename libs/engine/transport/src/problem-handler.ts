// Problem mapping for the transport (blueprint 3.6): every answer that is not a success is an
// RFC 9457 `application/problem+json`, whatever refused it (a guard, Fastify, the executor or a bug).
import { AppError, toProblem, type Logger } from '@app/kernel';
import type { ErrorCode } from '@app/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

const HTTP_CODES: Readonly<Record<number, ErrorCode>> = {
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN_RBAC',
  404: 'NOT_FOUND',
};

/**
 * A refusal made by the transport itself. The contract has no code for "wrong method" or "wrong
 * media type" (OQ-280), so those carry `VALIDATION_FAILED` with their own HTTP status. `detail`
 * is fixed text: it never repeats what the client sent.
 */
export function httpError(status: number, detail: string): AppError {
  return new AppError(HTTP_CODES[status] ?? 'VALIDATION_FAILED', {
    detail,
    status,
  });
}

const CLIENT_ERRORS: Readonly<Record<number, string>> = {
  400: 'The request is malformed.',
  413: 'The request body is too large.',
  415: 'The body must be application/json.',
};

/** Fastify's own 4xx (bad JSON, body too large, wrong media type) become transport refusals. */
function normalise(error: unknown): unknown {
  const { statusCode, code } = (error ?? {}) as {
    statusCode?: unknown;
    code?: unknown;
  };
  if (
    typeof code === 'string' &&
    code.startsWith('FST_ERR_') &&
    typeof statusCode === 'number' &&
    statusCode >= 400 &&
    statusCode < 500
  ) {
    return httpError(
      statusCode,
      CLIENT_ERRORS[statusCode] ?? 'The request is malformed.',
    );
  }
  return error;
}

export function sendProblem(
  reply: FastifyReply,
  error: unknown,
  correlationId: string,
  log: Logger | undefined,
): FastifyReply {
  const problem = toProblem(normalise(error), { correlationId });
  if (problem.code === 'INTERNAL') {
    // The logger redacts (I-10); the answer carries no detail of an unexpected failure.
    log?.error({ err: error, requestId: correlationId }, 'request failed');
  }
  return reply
    .code(problem.status)
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .send(JSON.stringify(problem));
}

export function installProblemHandlers(
  app: FastifyInstance,
  log: Logger | undefined,
): void {
  app.setErrorHandler((error, request, reply) =>
    sendProblem(reply, error, request.correlationId, log),
  );
  app.setNotFoundHandler((request, reply) =>
    sendProblem(
      reply,
      httpError(404, 'No such route.'),
      request.correlationId,
      log,
    ),
  );
}
