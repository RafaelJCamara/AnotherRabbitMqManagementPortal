import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { registry } from '../registry/index.ts';
import { defineAction, type ActionInit } from './define-action.ts';
import { defineTopic } from './define-topic.ts';
import { assertRegistry, checkRegistry, type Registry } from './invariants.ts';

const Cid = z.string().min(1);

/** A valid command, overridden per test. */
function command(over: Partial<ActionInit<z.ZodType, z.ZodType>> = {}) {
  return defineAction({
    id: 'queues.purge',
    kind: 'command',
    summary: 'Purge a queue',
    input: z.strictObject({ cid: Cid, qkey: z.string(), reason: z.string() }),
    output: z.strictObject({ purged: z.number().int() }),
    permission: 'messages.purge',
    risk: 'critical',
    planning: 'required',
    audit: 'attempt+outcome',
    target: () => ({}),
    http: { method: 'POST', path: '/connections/{cid}/queues/{qkey}/purge' },
    since: '1.0',
    ...over,
  });
}

function query(over: Partial<ActionInit<z.ZodType, z.ZodType>> = {}) {
  return defineAction({
    id: 'queues.get',
    kind: 'query',
    summary: 'Get a queue',
    input: z.strictObject({ cid: Cid, qkey: z.string() }),
    output: z.strictObject({ name: z.string() }),
    permission: 'queues.read',
    risk: 'none',
    planning: 'none',
    audit: 'none',
    target: () => ({}),
    http: { method: 'GET', path: '/connections/{cid}/queues/{qkey}' },
    since: '1.0',
    ...over,
  });
}

const rulesOf = (r: Registry) => checkRegistry(r).map((v) => v.rule);
const actions = (...a: Registry['actions']): Registry => ({
  actions: a,
  topics: [],
});

describe('kit invariants', () => {
  it('a sound registry has no violations', () => {
    expect(checkRegistry(actions(command(), query()))).toEqual([]);
    expect(() => {
      assertRegistry(actions(command(), query()));
    }).not.toThrow();
  });

  it('the committed registry satisfies the invariants', () => {
    expect(checkRegistry(registry)).toEqual([]);
  });

  it('AC-1 fails a GET bound to kind:command', () => {
    const bad = command({ http: { method: 'GET', path: '/purge/{cid}' } });
    expect(rulesOf(actions(bad))).toEqual(['get-only-query']);
  });

  it('AC-1 fails a path parameter missing from the input', () => {
    const bad = command({
      http: {
        method: 'POST',
        path: '/connections/{cid}/queues/{missing}/purge',
      },
    });
    const violations = checkRegistry(actions(bad));
    expect(violations.map((v) => v.rule)).toEqual(['path-param-in-input']);
    expect(violations[0]?.message).toContain("'missing'");
  });

  it('AC-1 fails a mutating action without audit attempt+outcome', () => {
    for (const audit of ['none', 'outcome'] as const) {
      expect(rulesOf(actions(command({ audit })))).toEqual(['mutating-audit']);
    }
    // jobs, peeks and an MCP-mutating query count as mutating too
    for (const kind of ['job', 'peek'] as const) {
      expect(rulesOf(actions(command({ kind, audit: 'outcome' })))).toEqual([
        'mutating-audit',
      ]);
    }
    const mcp = { expose: true, mutating: true, title: 't', description: 'd' };
    expect(rulesOf(actions(query({ mcp })))).toEqual(['mutating-audit']);
  });

  it('a pure query needs no audit', () => {
    expect(rulesOf(actions(query({ audit: 'none' })))).toEqual([]);
  });

  it('a path parameter must be a required field', () => {
    const bad = query({
      input: z.strictObject({ cid: Cid, qkey: z.string().optional() }),
    });
    expect(rulesOf(actions(bad))).toEqual(['path-param-in-input']);
  });

  it('every endpoint is exactly one action', () => {
    const twin = query({ id: 'queues.fetch' });
    const renamed = query({
      id: 'queues.other',
      input: z.strictObject({ cid: Cid, other: z.string() }),
      http: { method: 'GET', path: '/connections/{cid}/queues/{other}' },
    });
    expect(rulesOf(actions(query(), twin))).toEqual([
      'one-endpoint-one-action',
    ]);
    // the parameter name does not make a different endpoint
    expect(rulesOf(actions(query(), renamed))).toEqual([
      'one-endpoint-one-action',
    ]);
    expect(rulesOf(actions(query(), query()))).toContain('unique-id');
  });

  it('GET carries flat inputs only', () => {
    const nested = query({
      input: z.strictObject({
        cid: Cid,
        qkey: z.string(),
        filter: z.strictObject({ a: z.string() }),
      }),
    });
    expect(rulesOf(actions(nested))).toEqual(['get-flat-input']);
    const flat = query({
      input: z.strictObject({
        cid: Cid,
        qkey: z.string(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().optional(),
      }),
    });
    expect(rulesOf(actions(flat))).toEqual([]);
    const matrix = query({
      input: z.strictObject({
        cid: Cid,
        qkey: z.string(),
        rows: z.array(z.array(z.string())),
      }),
    });
    expect(rulesOf(actions(matrix))).toEqual(['get-flat-input']);
  });

  it('input must be an object schema; ids must be namespaced', () => {
    const unbound = defineAction({
      id: 'queues.get',
      kind: 'query',
      summary: 'Get a queue',
      input: z.string(),
      output: z.string(),
      permission: 'queues.read',
      risk: 'none',
      planning: 'none',
      audit: 'none',
      target: () => ({}),
      since: '1.0',
    });
    expect(rulesOf(actions(unbound))).toEqual(['input-object']);
    expect(rulesOf(actions(query({ id: 'Nope' })))).toEqual([
      'action-id-format',
    ]);
  });

  it("OQ-783 scope 'local' is accepted on a command that addresses no broker object", () => {
    const local = command({
      id: 'views.create',
      scope: 'local',
      input: z.strictObject({ name: z.string() }),
      http: { method: 'POST', path: '/views' },
    });

    expect(rulesOf(actions(local))).toEqual([]);
  });

  it("OQ-783 scope 'local' is refused on a peek, a job and any other value", () => {
    const base = {
      scope: 'local' as const,
      input: z.strictObject({ name: z.string() }),
      http: { method: 'POST', path: '/x' } as const,
    };

    for (const kind of ['peek', 'job'] as const) {
      expect(rulesOf(actions(command({ ...base, kind })))).toEqual([
        'local-scope',
      ]);
    }
    const other = command({
      ...base,
      scope: 'global' as unknown as 'local',
    });
    expect(rulesOf(actions(other))).toEqual(['local-scope']);
  });

  it("OQ-783 scope 'local' is refused when the input or the path addresses a connection or a broker object", () => {
    for (const field of ['cid', 'connectionId', 'vhost', 'qkey']) {
      const bad = command({
        scope: 'local',
        input: z.strictObject({ [field]: z.string() }),
        http: { method: 'POST', path: `/things/{${field}}` },
      });

      const violations = checkRegistry(actions(bad));

      expect(violations.map((v) => v.rule)).toEqual(['local-scope']);
      expect(violations[0]?.message).toContain(`'${field}'`);
    }
  });

  it("OQ-783 scope 'local' is refused on an action an AI client may call to mutate", () => {
    const mcp = { expose: true, mutating: true, title: 't', description: 'd' };
    const bad = command({
      scope: 'local',
      mcp,
      input: z.strictObject({ name: z.string() }),
      http: { method: 'POST', path: '/x' },
    });

    expect(rulesOf(actions(bad))).toEqual(['local-scope']);
  });

  it('assertRegistry lists every violation in its message', () => {
    expect(() => {
      assertRegistry(actions(command({ audit: 'none', id: 'x' })));
    }).toThrow(/action-id-format[\s\S]*mutating-audit/);
  });
});

describe('topic invariants', () => {
  const topic = (over: Record<string, unknown> = {}) =>
    defineTopic({
      id: 'queues.depth',
      params: z.strictObject({ cid: Cid }),
      item: z.strictObject({ name: z.string(), depth: z.number() }),
      qos: 'latest',
      flow: 'snapshot-delta',
      permission: 'queues.read',
      key: (item: { name: string }) => item.name,
      maxHz: 2,
      ring: { items: 100, bytes: 65536 },
      ...over,
    });
  const topics = (...t: Registry['topics']): Registry => ({
    actions: [],
    topics: t,
  });

  it('accepts a bounded topic', () => {
    expect(checkRegistry(topics(topic()))).toEqual([]);
  });

  it('every buffer is bounded by items and bytes', () => {
    expect(rulesOf(topics(topic({ ring: { items: 0, bytes: 10 } })))).toEqual([
      'topic-bounded',
    ]);
    expect(rulesOf(topics(topic({ ring: { items: 10, bytes: 1.5 } })))).toEqual(
      ['topic-bounded'],
    );
  });

  it('snapshot-delta needs key(), and maxHz is positive', () => {
    expect(rulesOf(topics(topic({ key: undefined })))).toEqual(['topic-key']);
    expect(rulesOf(topics(topic({ flow: 'credit', key: undefined })))).toEqual(
      [],
    );
    expect(rulesOf(topics(topic({ maxHz: 0 })))).toEqual(['topic-max-hz']);
  });

  it('ids are unique and namespaced', () => {
    expect(rulesOf(topics(topic(), topic()))).toEqual(['unique-id']);
    expect(rulesOf(topics(topic({ id: 'bad' })))).toEqual(['topic-id-format']);
  });
});
