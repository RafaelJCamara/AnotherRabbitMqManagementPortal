// How an action's input becomes an HTTP request. The rule is the one the OpenAPI emitter and the
// engine's router share (contracts/kit/http.ts): `{name}` segments of the path come from the input
// object; for GET the other fields are query parameters, for every other method they are the JSON
// body. Paths are below `/api/v1`.
import type { ActionDef, HttpMethod } from '@app/contracts';
import { API_PREFIX } from '@app/ui-platform';

export type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | readonly QueryScalar[];

export interface EngineRequest {
  readonly method: HttpMethod;
  /** Path with the parameters filled in and no query string. */
  readonly url: string;
  readonly params?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
}

const PATH_PARAM = /\{([^{}/]+)\}/g;

const isScalar = (value: unknown): value is QueryScalar =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Field names of an object input schema, found without importing zod. */
function inputFields(action: ActionDef): string[] {
  const shape = (action.input as { shape?: unknown }).shape;
  return isRecord(shape) ? Object.keys(shape) : [];
}

export function buildEngineRequest(
  action: ActionDef,
  input: unknown,
): EngineRequest {
  const http = action.http;
  if (http === undefined) {
    throw new Error(`${action.id} has no HTTP binding.`);
  }
  const fields = input ?? {};
  if (!isRecord(fields)) {
    throw new TypeError(`${action.id}: the input must be an object.`);
  }
  const inPath = new Set<string>();
  const url =
    API_PREFIX +
    http.path.replace(PATH_PARAM, (_match, name: string) => {
      inPath.add(name);
      const value = fields[name];
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new TypeError(
          `${action.id}: path parameter '${name}' must be a string or a number.`,
        );
      }
      return encodeURIComponent(String(value));
    });
  const rest = Object.entries(fields).filter(
    ([name, value]) => !inPath.has(name) && value !== undefined,
  );

  if (http.method === 'GET') {
    const params: Record<string, QueryValue> = {};
    for (const [name, value] of rest) {
      if (value === null) continue;
      if (isScalar(value)) {
        params[name] = value;
      } else if (Array.isArray(value) && value.every(isScalar)) {
        params[name] = value;
      } else {
        throw new TypeError(
          `${action.id}: GET input field '${name}' must be a scalar or an array of scalars.`,
        );
      }
    }
    return Object.keys(params).length === 0
      ? { method: http.method, url }
      : { method: http.method, url, params };
  }

  const hasBodyFields = inputFields(action).some((name) => !inPath.has(name));
  return rest.length > 0 || hasBodyFields
    ? { method: http.method, url, body: Object.fromEntries(rest) }
    : { method: http.method, url };
}
