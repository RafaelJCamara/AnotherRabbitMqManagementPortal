// OpenAPI 3.1 from the action registry (ADR-003). Every action with an `http` binding becomes one
// operation under `/api/v1`. Path parameters and (for GET) query parameters come from the input
// object; for other methods the remaining fields are the JSON request body.
import { z } from 'zod';
import { ProblemSchema } from '../errors.ts';
import type { ActionDef } from '../kit/define-action.ts';
import { inputShape, isOptionalField, pathParamNames } from '../kit/http.ts';
import { assertRegistry, type Registry } from '../kit/invariants.ts';
import {
  SPEC_TITLE,
  SPEC_VERSION,
  schemaOf,
  type Json,
  type JsonObject,
} from './json-schema.ts';

const PROBLEM_REF = { $ref: '#/components/schemas/Problem' };

function operation(action: ActionDef): JsonObject {
  const http = action.http;
  const shape = inputShape(action);
  if (!http || !shape) throw new Error(`${action.id} has no HTTP binding`);
  const inPath = pathParamNames(http.path);
  const rest = Object.entries(shape).filter(([name]) => !inPath.includes(name));
  const parameters: Json[] = inPath.map((name) => {
    const field = shape[name];
    if (!field) throw new Error(`${action.id}: no input field ${name}`);
    return {
      name,
      in: 'path',
      required: true,
      schema: schemaOf(field, 'input'),
    };
  });
  const op: JsonObject = {
    operationId: action.id,
    summary: action.summary,
    tags: [action.id.split('.')[0] ?? action.id],
    'x-kind': action.kind,
    'x-permission': action.permission,
    'x-risk': typeof action.risk === 'string' ? action.risk : 'dynamic',
    'x-planning': action.planning,
    'x-audit': action.audit,
    'x-since': action.since,
  };
  if (action.scope) op['x-scope'] = action.scope;
  if (action.mcp) op['x-mcp'] = { ...action.mcp };
  if (action.cli) op['x-cli'] = { ...action.cli };

  if (http.method === 'GET') {
    for (const [name, field] of rest) {
      parameters.push({
        name,
        in: 'query',
        required: !isOptionalField(field),
        schema: schemaOf(field, 'input'),
      });
    }
  } else if (rest.length > 0) {
    const mask: Record<string, true> = Object.fromEntries(
      inPath.map((name) => [name, true as const]),
    );
    const body = (action.input as z.ZodObject<Record<string, z.ZodType>>).omit(
      mask,
    );
    op.requestBody = {
      required: !isOptionalField(body),
      content: { 'application/json': { schema: schemaOf(body, 'input') } },
    };
  }
  if (parameters.length > 0) op.parameters = parameters;
  op.responses = {
    '200': {
      description: 'Success',
      content: {
        'application/json': { schema: schemaOf(action.output, 'output') },
      },
    },
    default: {
      description: 'Problem',
      content: { 'application/problem+json': { schema: PROBLEM_REF } },
    },
  };
  return op;
}

export function emitOpenApi(registry: Registry): JsonObject {
  assertRegistry(registry);
  const paths: Record<string, JsonObject> = {};
  const tags = new Set<string>();
  for (const action of [...registry.actions].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (!action.http) continue;
    const item = (paths[action.http.path] ??= {});
    item[action.http.method.toLowerCase()] = operation(action);
    tags.add(action.id.split('.')[0] ?? action.id);
  }
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: SPEC_TITLE,
      version: SPEC_VERSION,
      description:
        'Generated from the @app/contracts action registry (ADR-003). Do not edit by hand: run `pnpm nx run contracts:api-docs`.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: { schemas: { Problem: schemaOf(ProblemSchema, 'output') } },
  };
}
