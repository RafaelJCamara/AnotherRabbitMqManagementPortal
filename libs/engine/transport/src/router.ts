// The router is the action registry (ADR-003): every action with an `http` binding becomes exactly
// one route, and the route does nothing but assemble the input and call the executor. Validation,
// authorisation, planning and audit all happen there, never here (I-2). A path bound to one method
// answers every other method with 405 and an `Allow` header.
import type { ActionDef, EngineMode, Registry } from '@app/contracts';
import { planRequiredError, type ActionExecutor } from '@app/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { httpError } from './problem-handler.ts';

export const API_PREFIX = '/api/v1';

const METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;
type Method = (typeof METHODS)[number];
const SAFE_PATH = /^\/[A-Za-z0-9_/{}-]*$/;

type Coercion = 'number' | 'boolean' | 'string';

/** Query values are text; the field's JSON type says whether it is a number or a flag. */
function coercionOf(field: z.ZodType): { kind: Coercion; list: boolean } {
  const kinds = new Set<string>();
  let list = false;
  const walk = (schema: z.core.JSONSchema.BaseSchema): void => {
    for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
      walk(branch);
    }
    if (schema.type === 'array') {
      list = true;
      walk((schema.items ?? {}) as z.core.JSONSchema.BaseSchema);
    } else if (typeof schema.type === 'string') {
      kinds.add(schema.type);
    }
  };
  walk(z.toJSONSchema(field, { io: 'input' }));
  const numeric = kinds.has('number') || kinds.has('integer');
  if (kinds.has('string') || (numeric && kinds.has('boolean'))) {
    return { kind: 'string', list };
  }
  return {
    kind: numeric ? 'number' : kinds.has('boolean') ? 'boolean' : 'string',
    list,
  };
}

function coerce(value: string, kind: Coercion): unknown {
  if (kind === 'number' && /^-?\d+(?:\.\d+)?$/.test(value))
    return Number(value);
  if (kind === 'boolean' && (value === 'true' || value === 'false')) {
    return value === 'true';
  }
  return value;
}

/** How one action reads its input out of a request. */
function inputReader(def: ActionDef) {
  const fields: Record<string, z.ZodType> =
    def.input instanceof z.ZodObject ? def.input.shape : {};
  const coercions = new Map(
    Object.entries(fields).map(([name, field]) => [name, coercionOf(field)]),
  );

  return (request: FastifyRequest): Record<string, unknown> => {
    const input: Record<string, unknown> = { ...(request.params as object) };
    const add = (name: string, value: unknown): void => {
      if (Object.hasOwn(input, name)) {
        throw httpError(400, 'A parameter was given twice.');
      }
      // defineProperty, not assignment: a key named __proto__ must stay a key (and be refused).
      Object.defineProperty(input, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    };
    if (def.http?.method === 'GET') {
      const query = new URL(request.url, 'http://engine.internal').searchParams;
      for (const name of new Set(query.keys())) {
        const how = coercions.get(name);
        const values = query
          .getAll(name)
          .map((text) => coerce(text, how?.kind ?? 'string'));
        add(name, how?.list === true || values.length > 1 ? values : values[0]);
      }
    } else if (request.url.includes('?')) {
      throw httpError(400, 'Only a GET takes a query string.');
    } else if (request.body !== undefined && request.body !== null) {
      const body: unknown = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw httpError(400, 'The body must be a JSON object.');
      }
      for (const [name, value] of Object.entries(body)) add(name, value);
    }
    return input;
  };
}

function toFastifyPath(path: string): string {
  if (!SAFE_PATH.test(path)) throw new TypeError(`Unsupported path: ${path}`);
  return API_PREFIX + path.replace(/\{([^{}/]+)\}/g, ':$1');
}

export function registerActionRoutes(
  app: FastifyInstance,
  registry: Registry,
  executor: ActionExecutor,
  mode: EngineMode,
): void {
  const methodsByPath = new Map<string, Set<Method>>();

  for (const def of registry.actions) {
    if (def.http === undefined) continue;
    const url = toFastifyPath(def.http.path);
    const read = inputReader(def);
    app.route({
      method: def.http.method,
      url,
      handler: async (request, reply) => {
        const { principal } = request;
        if (principal === null)
          throw httpError(401, 'Authentication required.');
        const key = request.headers['idempotency-key'];
        const aborted = new AbortController();
        reply.raw.once('close', () => {
          if (!reply.raw.writableFinished) aborted.abort();
        });
        const outcome = await executor.run(def, read(request), {
          principal,
          mode,
          correlationId: request.correlationId,
          signal: aborted.signal,
          idempotencyKey: typeof key === 'string' ? key : undefined,
        });
        return answer(reply, outcome);
      },
    });
    const methods = methodsByPath.get(url) ?? new Set<Method>();
    methods.add(def.http.method);
    methodsByPath.set(url, methods);
  }

  for (const [url, bound] of methodsByPath) {
    const allow = [...bound].join(', ');
    app.route({
      method: METHODS.filter((method) => !bound.has(method)),
      url,
      handler: (_request, reply) => {
        reply.header('allow', allow);
        throw httpError(405, 'This method is not allowed on this path.');
      },
    });
  }

  // Anything else below the prefix is unknown, but a stranger learns that only after the token.
  app.route({
    method: [...METHODS],
    url: `${API_PREFIX}/*`,
    handler: () => {
      throw httpError(404, 'No such route.');
    },
  });
}

type Outcome = Awaited<ReturnType<ActionExecutor['run']>>;

function answer(reply: FastifyReply, outcome: Outcome): FastifyReply {
  const json = (status: number, body: unknown): FastifyReply =>
    reply
      .code(status)
      .header('content-type', 'application/json; charset=utf-8')
      .send(JSON.stringify(body ?? null));
  switch (outcome.kind) {
    case 'output':
      return json(200, outcome.output);
    case 'job':
      reply.header('location', `${API_PREFIX}/jobs/${outcome.jobId}`);
      return json(202, { jobId: outcome.jobId });
    case 'planRequired':
      // 428: the plan exists already, and the Location says where.
      reply.header('location', `${API_PREFIX}/plans/${outcome.plan.id}`);
      throw planRequiredError(outcome.plan);
  }
}
