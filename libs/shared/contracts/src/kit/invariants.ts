// Kit invariants (blueprint 3.1). `checkRegistry` returns every violation; `assertRegistry` throws.
// The emitters call `assertRegistry` first, so an invalid registry never produces a spec.
import { z } from 'zod';
import { hasSecretField } from '../secret.ts';
import type { ActionDef } from './define-action.ts';
import type { TopicDef } from './define-topic.ts';
import {
  inputShape,
  isMutating,
  isOptionalField,
  pathParamNames,
} from './http.ts';

export interface Registry {
  readonly actions: readonly ActionDef[];
  readonly topics: readonly TopicDef[];
}

export interface Violation {
  readonly rule: string;
  readonly subject: string;
  readonly message: string;
}

const ID_FORMAT = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

/** A GET input is flat: scalars, or arrays of scalars. */
function isFlat(schema: z.core.JSONSchema.BaseSchema): boolean {
  const nested = [schema.anyOf, schema.oneOf]
    .flat()
    .filter((s) => s !== undefined);
  if (nested.length > 0) return nested.every((s) => isFlat(s));
  if (schema.type === 'object') return false;
  if (schema.type === 'array') {
    const items = schema.items as z.core.JSONSchema.BaseSchema | undefined;
    return items !== undefined && items.type !== 'array' && isFlat(items);
  }
  return true;
}

/** Input fields that address a connection, a vhost or a broker object: a local action has none. */
const BROKER_ADDRESS_FIELDS: ReadonlySet<string> = new Set([
  'cid',
  'connectionId',
  'vhost',
  'qkey',
  'queue',
  'exchange',
]);

/**
 * `scope: 'local'` (define-action.ts) is the one way past the prod lock for an action with no
 * target connection, so its declaration is checked hard. The input rules are static; the target
 * itself is checked by the executor on every call, and the module by the architecture test.
 */
function checkLocalScope(
  action: ActionDef,
  shape: Record<string, z.ZodType> | undefined,
  fail: (rule: string, message: string) => void,
): void {
  const scope: unknown = action.scope;
  if (scope === undefined) return;
  if (scope !== 'local') {
    fail('local-scope', `scope must be 'local' or left out`);
    return;
  }
  if (action.kind !== 'command' && action.kind !== 'query') {
    fail(
      'local-scope',
      `a ${action.kind} action touches messages or runs on a broker and cannot be scope 'local'`,
    );
  }
  const addressed = [
    ...Object.keys(shape ?? {}),
    ...(action.http ? pathParamNames(action.http.path) : []),
  ].filter((name) => BROKER_ADDRESS_FIELDS.has(name));
  if (addressed.length > 0) {
    fail(
      'local-scope',
      `scope 'local' means no broker target, but the input addresses one through '${[...new Set(addressed)].join("', '")}'`,
    );
  }
  if (action.mcp?.expose === true && action.mcp.mutating) {
    fail(
      'local-scope',
      `scope 'local' is not for an action an AI client may call to mutate`,
    );
  }
}

function checkAction(action: ActionDef, out: Violation[]): void {
  const subject = action.id;
  const fail = (rule: string, message: string) =>
    out.push({ rule, subject, message });

  if (!ID_FORMAT.test(action.id)) {
    fail('action-id-format', `id must look like 'namespace.verb'`);
  }
  const shape = inputShape(action);
  if (shape === undefined) fail('input-object', 'input must be a z.object');
  if (isMutating(action) && action.audit !== 'attempt+outcome') {
    fail(
      'mutating-audit',
      `a ${action.kind} action that mutates or touches messages needs audit 'attempt+outcome'`,
    );
  }
  checkLocalScope(action, shape, fail);
  if (!action.http) return;

  const { method, path } = action.http;
  if (method === 'GET' && action.kind !== 'query') {
    fail('get-only-query', `GET cannot be bound to kind '${action.kind}'`);
  }
  for (const name of pathParamNames(path)) {
    const field = shape?.[name];
    if (field === undefined) {
      fail(
        'path-param-in-input',
        `path parameter '${name}' is not an input field`,
      );
    } else if (isOptionalField(field)) {
      fail('path-param-in-input', `path parameter '${name}' must be required`);
    }
  }
  // I-10: a secret is write-only. It is not in the output, and not in a URL (a path parameter, or
  // any field of a GET, which is a query string).
  if (hasSecretField(action.output, 'output')) {
    fail('secret-write-only', 'the output contains a write-only secret field');
  }
  if (shape) {
    const inPath = new Set(pathParamNames(path));
    for (const [name, field] of Object.entries(shape)) {
      if (
        (method === 'GET' || inPath.has(name)) &&
        hasSecretField(field, 'input')
      ) {
        fail(
          'secret-write-only',
          `input field '${name}' is a write-only secret and would travel in the URL`,
        );
      }
    }
  }
  if (method === 'GET' && shape) {
    const inPath = new Set(pathParamNames(path));
    for (const [name, field] of Object.entries(shape)) {
      if (
        !inPath.has(name) &&
        !isFlat(z.toJSONSchema(field, { io: 'input' }))
      ) {
        fail('get-flat-input', `GET input field '${name}' is not flat`);
      }
    }
  }
}

function checkTopic(topic: TopicDef, out: Violation[]): void {
  const subject = topic.id;
  const fail = (rule: string, message: string) =>
    out.push({ rule, subject, message });
  if (!ID_FORMAT.test(topic.id)) {
    fail('topic-id-format', `id must look like 'namespace.name'`);
  }
  // I-10: a topic frame goes to every subscriber and into the live buffers; no secret rides on it.
  if (
    hasSecretField(topic.params, 'input') ||
    hasSecretField(topic.item, 'output')
  ) {
    fail('secret-write-only', 'a topic carries a write-only secret field');
  }
  if (!Number.isInteger(topic.ring.items) || topic.ring.items <= 0) {
    fail('topic-bounded', 'ring.items must be a positive integer');
  }
  if (!Number.isInteger(topic.ring.bytes) || topic.ring.bytes <= 0) {
    fail('topic-bounded', 'ring.bytes must be a positive integer');
  }
  if (topic.maxHz !== undefined && !(topic.maxHz > 0)) {
    fail('topic-max-hz', 'maxHz must be positive');
  }
  if (topic.flow === 'snapshot-delta' && topic.key === undefined) {
    fail(
      'topic-key',
      `flow 'snapshot-delta' needs key(): delta frames remove items by key`,
    );
  }
}

export function checkRegistry(registry: Registry): Violation[] {
  const out: Violation[] = [];
  const ids = new Set<string>();
  const endpoints = new Map<string, string>();
  for (const action of registry.actions) {
    if (ids.has(action.id)) {
      out.push({
        rule: 'unique-id',
        subject: action.id,
        message: 'duplicate id',
      });
    }
    ids.add(action.id);
    if (action.http) {
      // Path parameter names do not matter: /q/{a} and /q/{b} are one endpoint.
      const endpoint = `${action.http.method} ${action.http.path.replace(/\{[^{}/]+\}/g, '{}')}`;
      const other = endpoints.get(endpoint);
      if (other !== undefined) {
        out.push({
          rule: 'one-endpoint-one-action',
          subject: action.id,
          message: `${endpoint} is already bound to ${other}`,
        });
      }
      endpoints.set(endpoint, action.id);
    }
    checkAction(action, out);
  }
  const topicIds = new Set<string>();
  for (const topic of registry.topics) {
    if (topicIds.has(topic.id)) {
      out.push({
        rule: 'unique-id',
        subject: topic.id,
        message: 'duplicate id',
      });
    }
    topicIds.add(topic.id);
    checkTopic(topic, out);
  }
  return out;
}

export function assertRegistry(registry: Registry): void {
  const violations = checkRegistry(registry);
  if (violations.length > 0) {
    const lines = violations.map(
      (v) => `${v.rule} [${v.subject}]: ${v.message}`,
    );
    throw new Error(`Invalid contract registry:\n${lines.join('\n')}`);
  }
}
