import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineAction } from '../kit/define-action.ts';
import { defineTopic } from '../kit/define-topic.ts';
import type { Registry } from '../kit/invariants.ts';
import { registry as real } from '../registry/index.ts';
import { emitAsyncApi, emitOpenApi, emitSpecs, specDrift } from './index.ts';
import { schemaOf, serialize, type Json } from './json-schema.ts';

const Cid = z.string().min(1);

const purge = defineAction({
  id: 'queues.purge',
  kind: 'command',
  summary: 'Purge a queue',
  input: z.strictObject({
    cid: Cid,
    qkey: z.string(),
    reason: z.string().max(200),
  }),
  output: z.strictObject({ purged: z.number().int() }),
  permission: 'messages.purge',
  risk: () => 'critical',
  planning: 'required',
  audit: 'attempt+outcome',
  target: () => ({}),
  http: { method: 'POST', path: '/connections/{cid}/queues/{qkey}/purge' },
  mcp: {
    expose: true,
    mutating: true,
    title: 'Purge',
    description: 'Purge a queue',
  },
  cli: { command: 'queues purge' },
  since: '1.0',
});

const list = defineAction({
  id: 'queues.list',
  kind: 'query',
  summary: 'List queues',
  input: z.strictObject({
    cid: Cid,
    vhost: z.string().optional(),
    tags: z.array(z.string()),
  }),
  output: z.strictObject({ names: z.array(z.string()) }),
  permission: 'queues.read',
  risk: 'none',
  planning: 'none',
  audit: 'none',
  target: () => ({}),
  // Not a path a real action will use: this one is added to the committed registry below.
  http: { method: 'GET', path: '/spec-only/{cid}/queues' },
  since: '1.0',
});

const depth = defineTopic({
  id: 'queues.depth',
  params: z.strictObject({ cid: Cid }),
  item: z.strictObject({ name: z.string(), depth: z.number() }),
  qos: 'latest',
  flow: 'snapshot-delta',
  permission: 'queues.read',
  key: (item: { name: string }) => item.name,
  maxHz: 2,
  ring: { items: 100, bytes: 65536 },
});

const sample: Registry = { actions: [purge, list], topics: [depth] };
/** Reads `doc.a.b[0]` as `at(doc, 'a', 'b', 0)`; undefined when any step is missing. */
function at(node: unknown, ...path: (string | number)[]): unknown {
  let current = node;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** Follows every `$ref` in a document; a dangling one throws. */
function resolveRefs(document: Json): number {
  let count = 0;
  const walk = (node: Json) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        count += 1;
        if (at(document, ...value.slice(2).split('/')) === undefined) {
          throw new Error(`dangling ${value}`);
        }
      } else walk(value);
    }
  };
  walk(document);
  return count;
}

const PURGE = '/connections/{cid}/queues/{qkey}/purge';
const LIST = '/spec-only/{cid}/queues';

/** [name, in, required] of an operation's parameters. */
function parameters(op: unknown): unknown[] {
  return (
    at(op, 'parameters') as { name: unknown; in: unknown; required: unknown }[]
  ).map((p) => [p.name, p.in, p.required]);
}

describe('OpenAPI 3.1', () => {
  const doc = emitOpenApi(sample);

  it('declares 3.1 and the JSON Schema 2020-12 dialect', () => {
    expect(at(doc, 'openapi')).toBe('3.1.0');
    expect(at(doc, 'jsonSchemaDialect')).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(at(doc, 'servers')).toEqual([{ url: '/api/v1' }]);
  });

  it('turns path fields into path parameters and the rest into the JSON body', () => {
    const op = at(doc, 'paths', PURGE, 'post');
    expect(at(op, 'operationId')).toBe('queues.purge');
    expect(parameters(op)).toEqual([
      ['cid', 'path', true],
      ['qkey', 'path', true],
    ]);
    const body = at(op, 'requestBody', 'content', 'application/json', 'schema');
    expect(Object.keys(at(body, 'properties') as object)).toEqual(['reason']);
    expect(at(body, 'required')).toEqual(['reason']);
    expect(at(body, 'additionalProperties')).toBe(false);
    expect(at(op, 'requestBody', 'required')).toBe(true);
    expect(
      at(
        op,
        'responses',
        '200',
        'content',
        'application/json',
        'schema',
        'required',
      ),
    ).toEqual(['purged']);
  });

  it('turns the remaining GET fields into query parameters and sends no body', () => {
    const op = at(doc, 'paths', LIST, 'get');
    expect(at(op, 'requestBody')).toBeUndefined();
    expect(parameters(op)).toEqual([
      ['cid', 'path', true],
      ['vhost', 'query', false],
      ['tags', 'query', true],
    ]);
    expect(at(op, 'parameters', 2, 'schema')).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('carries the policy metadata and the MCP and CLI bindings', () => {
    const op = at(doc, 'paths', PURGE, 'post');
    expect(at(op, 'x-permission')).toBe('messages.purge');
    // a function: the risk depends on the input and the environment class
    expect(at(op, 'x-risk')).toBe('dynamic');
    expect(at(doc, 'paths', LIST, 'get', 'x-risk')).toBe('none');
    expect(at(op, 'x-audit')).toBe('attempt+outcome');
    expect(at(op, 'x-planning')).toBe('required');
    expect(at(op, 'x-mcp')).toEqual({
      expose: true,
      mutating: true,
      title: 'Purge',
      description: 'Purge a queue',
    });
    expect(at(op, 'x-cli')).toEqual({ command: 'queues purge' });
    expect(at(doc, 'tags')).toEqual([{ name: 'queues' }]);
  });

  it('every operation can fail with a Problem', () => {
    const op = at(doc, 'paths', LIST, 'get');
    expect(
      at(
        op,
        'responses',
        'default',
        'content',
        'application/problem+json',
        'schema',
      ),
    ).toEqual({ $ref: '#/components/schemas/Problem' });
    expect(
      at(doc, 'components', 'schemas', 'Problem', 'properties', 'code', 'enum'),
    ).toContain('PLAN_STALE');
    expect(resolveRefs(doc)).toBeGreaterThan(0);
  });

  it('AC-1 refuses to emit an invalid registry', () => {
    const bad = defineAction({ ...purge, audit: 'none', input: purge.input });
    expect(() => emitOpenApi({ actions: [bad], topics: [] })).toThrow(
      /mutating-audit/,
    );
  });

  it('the committed registry emits a document with the meta action', () => {
    expect(at(emitOpenApi(real), 'paths', '/meta', 'get', 'operationId')).toBe(
      'meta.get',
    );
  });
});

describe('AsyncAPI 3.0', () => {
  const doc = emitAsyncApi(sample);

  it('declares 3.0 and the live channel with both frame unions', () => {
    expect(at(doc, 'asyncapi')).toBe('3.0.0');
    expect(at(doc, 'channels', 'live', 'address')).toBe('/api/v1/live');
    const server = at(doc, 'components', 'messages', 'ServerFrame', 'payload');
    const tags = (at(server, 'oneOf') as unknown[]).map((frame) =>
      at(frame, 'properties', 't', 'const'),
    );
    expect(tags).toEqual([
      'welcome',
      'subok',
      'data',
      'snapshot',
      'delta',
      'status',
      'gap',
      'end',
      'goaway',
      'pong',
    ]);
    expect(
      at(doc, 'components', 'messages', 'ClientFrame', 'payload', 'oneOf'),
    ).toHaveLength(5);
    expect(at(doc, 'operations', 'receiveClientFrame', 'action')).toBe(
      'receive',
    );
    expect(at(doc, 'operations', 'sendServerFrame', 'action')).toBe('send');
  });

  it('documents each topic: params, item, QoS, flow and the ring bound', () => {
    const channel = at(doc, 'channels', 'queues_depth');
    expect(at(channel, 'address')).toBe('queues.depth');
    expect(at(channel, 'messages', 'params', 'payload', 'required')).toEqual([
      'cid',
    ]);
    expect(at(channel, 'messages', 'item', 'payload', 'required')).toEqual([
      'name',
      'depth',
    ]);
    expect(at(channel, 'x-qos')).toBe('latest');
    expect(at(channel, 'x-flow')).toBe('snapshot-delta');
    expect(at(channel, 'x-ring')).toEqual({ items: 100, bytes: 65536 });
    expect(at(channel, 'x-max-hz')).toBe(2);
    expect(at(doc, 'operations', 'publish_queues_depth', 'messages')).toEqual([
      { $ref: '#/channels/queues_depth/messages/item' },
    ]);
    expect(resolveRefs(doc)).toBeGreaterThan(0);
  });

  it('AC-1 refuses to emit an invalid registry', () => {
    const bad = defineTopic({ ...depth, ring: { items: 0, bytes: 0 } });
    expect(() => emitAsyncApi({ actions: [], topics: [bad] })).toThrow(
      /topic-bounded/,
    );
  });
});

describe('spec files', () => {
  it('are byte-for-byte reproducible, with sorted keys and a final newline', () => {
    const [first, second] = [emitSpecs(sample), emitSpecs(sample)];
    expect(first).toEqual(second);
    for (const text of Object.values(first)) {
      expect(text.endsWith('}\n')).toBe(true);
      expect(text).not.toContain('\r');
    }
    expect(serialize({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } })).toBe(
      '{\n  "a": {\n    "c": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ],\n    "d": 1\n  },\n  "b": 1\n}\n',
    );
  });

  it('AC-2 a new action without regenerated specs is drift', () => {
    const committed = emitSpecs(real);
    expect(specDrift(real, committed)).toEqual([]);
    const extended: Registry = { ...real, actions: [...real.actions, list] };
    expect(specDrift(extended, committed)).toEqual(['openapi.v1.json']);
    expect(specDrift(extended, emitSpecs(extended))).toEqual([]);
  });

  it('AC-2 a new topic is drift in the AsyncAPI document only; a missing file is drift', () => {
    const committed = emitSpecs(real);
    expect(specDrift({ ...real, topics: [depth] }, committed)).toEqual([
      'asyncapi.v1.json',
    ]);
    expect(specDrift(real, {})).toEqual([
      'openapi.v1.json',
      'asyncapi.v1.json',
    ]);
  });

  it('only schemas that need no $defs are accepted', () => {
    interface Tree {
      children: Tree[];
    }
    const tree: z.ZodType<Tree> = z.strictObject({
      children: z.array(z.lazy(() => tree)),
    });
    expect(() => schemaOf(tree, 'output')).toThrow(/Recursive/);
    expect(() => schemaOf(z.date(), 'output')).toThrow();
  });
});
