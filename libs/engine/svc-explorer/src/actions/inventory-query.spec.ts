// inventory.query over the index (M0-48 slice C). Every title starts with `explorer` so
// `--testNamePattern=explorer` selects the set; each AC is one test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkRegistry,
  ConnectionIdSchema,
  encodeObjectKey,
} from '@app/contracts';
import {
  createRoleAuthorizer,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  denyAllAuthorizer,
  type TestExecutor,
} from '@app/kernel';
import type { MgmtGetRequest, MgmtReadPort } from '@app/ports';
import { describe, expect, it, vi } from 'vitest';

import {
  createExplorerFakeDeps,
  createScriptedBroker,
  type ExplorerFakeDeps,
  type ScriptedBroker,
} from '../testing';

import { createInventoryQueryAction } from './inventory-query';
import { createSubject, sampleInput } from './inventory-query.fixture';

const { def } = createSubject();
const cid = ConnectionIdSchema.parse('c1');
const KEY = 'explorer-spec-key-0001';

type Row = Record<string, string | number | boolean | undefined>;
type Raw = Record<string, unknown>;
type Input = Record<string, unknown>;

/** The action under the executor, over fakes: `ask` returns the output or throws what the engine throws. */
function harness(options: Parameters<typeof createExplorerFakeDeps>[0] = {}) {
  const deps = createExplorerFakeDeps(options);
  const engine = createTestExecutor();
  engine.executor.register(createInventoryQueryAction(deps));
  const ask = async (input: Input) => {
    const outcome = await engine.executor.run(
      def,
      input,
      createTestContext({ idempotencyKey: KEY }),
    );
    if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
    return outcome.output;
  };
  const sweepNow = async () => {
    deps.sweeper.touch(cid);
    return deps.sweeper.sweepNow(cid, new AbortController().signal);
  };
  return { deps, engine, ask, sweepNow };
}

const query = (
  kind: string,
  window: Record<string, unknown>,
  more: Input = {},
): Input => ({ cid: 'c1', kind, window, ...more });

/** What the scripted broker serves, written out independently of the service. */
function queuesOf(broker: ScriptedBroker): Row[] {
  return Array.from({ length: broker.queueCount }, (_, i) => {
    const vhost = broker.vhosts[i % broker.vhosts.length] ?? '';
    const name = `queue-${String(i).padStart(6, '0')}`;
    return {
      key: encodeObjectKey(vhost, name),
      vhost,
      name,
      type: 'classic',
      durable: true,
      messages: i % 100,
    };
  });
}
function exchangesOf(broker: ScriptedBroker, perVhost: number): Row[] {
  return broker.vhosts.flatMap((vhost) =>
    Array.from({ length: perVhost }, (_, j) => ({
      key: encodeObjectKey(vhost, `exchange-${String(j)}`),
      vhost,
      name: `exchange-${String(j)}`,
      type: 'direct',
      durable: true,
    })),
  );
}

function connectionsOf(broker: ScriptedBroker): Row[] {
  return Array.from({ length: broker.connectionCount }, (_, i) => {
    const vhost = broker.vhosts[i % broker.vhosts.length] ?? '';
    const name = `connection-${String(i).padStart(6, '0')}`;
    return {
      key: encodeObjectKey(vhost, name),
      vhost,
      name,
      user: i % 2 === 0 ? 'guest' : 'app',
      node: 'rabbit@fake',
      state: i % 4 === 0 ? 'blocked' : 'running',
      protocol: i % 3 === 0 ? 'AMQP 1.0' : 'AMQP 0-9-1',
      channels: i % 5,
      peerHost: `192.0.2.${String((i % 250) + 1)}`,
      ssl: i % 7 === 0,
    };
  });
}

interface Spec {
  filter?:
    | {
        text?: string;
        vhosts?: string[];
        types?: string[];
        states?: string[];
        minMessages?: number;
      }
    | undefined;
  sort?: { column: string; dir: 'asc' | 'desc' } | undefined;
  offset: number;
  limit: number;
}
/**
 * Filter, sort (the key breaks ties) and slice, the plain way. The `types` facet is the field
 * named by `typeField`: the type of a queue or exchange, the protocol of a connection.
 */
function reference(rows: Row[], spec: Spec, typeField = 'type') {
  // The filtered and sorted rows depend on (filter, sort) only, never on the window, so they are
  // computed once per combination and each window is a slice of that (the slow part over 20k rows).
  const memo = referenceMemo.get(rows) ?? new Map<string, Row[]>();
  referenceMemo.set(rows, memo);
  const id = JSON.stringify([spec.filter, spec.sort, typeField]);
  const kept = memo.get(id) ?? filterAndSort(rows, spec, typeField);
  memo.set(id, kept);
  return {
    rows: kept.slice(spec.offset, spec.offset + spec.limit),
    matched: kept.length,
  };
}
const referenceMemo = new WeakMap<Row[], Map<string, Row[]>>();

function filterAndSort(rows: Row[], spec: Spec, typeField: string): Row[] {
  const text = spec.filter?.text?.toLowerCase();
  const kept = rows.filter(
    (r) =>
      (text === undefined || String(r.name).toLowerCase().includes(text)) &&
      (spec.filter?.vhosts === undefined ||
        spec.filter.vhosts.includes(String(r.vhost))) &&
      (spec.filter?.types === undefined ||
        spec.filter.types.includes(String(r[typeField]))) &&
      (spec.filter?.states === undefined ||
        spec.filter.states.includes(String(r.state))) &&
      (spec.filter?.minMessages === undefined ||
        Number(r.messages ?? -1) >= spec.filter.minMessages),
  );
  const column = spec.sort?.column ?? 'name';
  const sign = spec.sort?.dir === 'desc' ? -1 : 1;
  kept.sort((a, b) => {
    const x = a[column];
    const y = b[column];
    if (x !== undefined && y !== undefined && x !== y) {
      return (x < y ? -1 : 1) * sign;
    }
    return String(a.key) < String(b.key) ? -1 : 1;
  });
  return kept;
}

describe('explorer inventory.query', () => {
  it('M0-48 AC-6 explorer windows are served from the index and match the reference', async () => {
    expect(checkRegistry({ actions: [def], topics: [] })).toEqual([]);
    expect(def.input.safeParse(sampleInput).success).toBe(true);
    const { deps, engine, ask, sweepNow } = harness({
      queueCount: 20_000,
      vhostCount: 4,
      exchangesPerVhost: 3,
      connectionCount: 1_200,
    });
    await sweepNow();
    const before = deps.broker.requests.length;
    expect(before).toBeGreaterThan(0);
    const queues = queuesOf(deps.broker);
    const [, second = ''] = deps.broker.vhosts;
    const filters: (Spec['filter'] | undefined)[] = [
      undefined,
      { text: 'queue-0001' },
      { vhosts: [second] },
      { minMessages: 90 },
      { text: 'QUEUE-01', types: ['classic'] },
      { types: ['quorum'] },
    ];
    const sorts: (Spec['sort'] | undefined)[] = [
      undefined,
      { column: 'name', dir: 'desc' },
      { column: 'messages', dir: 'desc' },
      { column: 'vhost', dir: 'asc' },
      { column: 'messages', dir: 'asc' },
    ];

    // The same 200 windows as before (every filter x sort pair, several offsets and limits), grouped
    // by sort: the index keeps a few sorted copies, so five sorts in rotation re-sort 20k rows on
    // every query and that, not the check, was most of the time on a slow runner.
    const specs = Array.from({ length: 200 }, (_, i) => ({
      i,
      spec: {
        offset: (i * 977) % 20_000,
        limit: [1, 200, 500][i % 3] ?? 1,
        ...(filters[i % 6] ? { filter: filters[i % 6] } : {}),
        ...(sorts[i % 5] ? { sort: sorts[i % 5] } : {}),
      } satisfies Spec,
    })).sort((a, b) => (a.i % 5) - (b.i % 5) || a.i - b.i);

    for (const { spec } of specs) {
      const { offset, limit, ...more } = spec;
      const answer = await ask(query('queues', { offset, limit }, more));
      const expected = reference(queues, spec);
      expect(answer.rows).toEqual(expected.rows);
      expect(answer).toMatchObject({
        kind: 'queues',
        matched: expected.matched,
        total: 20_000,
        window: { offset, limit },
        freshness: { state: 'live', complete: true, loaded: 20_000 },
      });
    }
    const exchanges = exchangesOf(deps.broker, 3);
    for (const spec of [
      { offset: 0, limit: 500 },
      { offset: 5, limit: 4, sort: { column: 'name', dir: 'desc' as const } },
      { offset: 0, limit: 10, filter: { text: 'CHANGE-1' } },
    ] satisfies Spec[]) {
      const { offset, limit, ...more } = spec;
      const answer = await ask(query('exchanges', { offset, limit }, more));
      const expected = reference(exchanges, spec);
      expect(answer.rows).toEqual(expected.rows);
      expect(answer).toMatchObject({ kind: 'exchanges', total: 12 });
    }
    // Connections: the protocol is the `types` facet, a row may lack a vhost, and the columns are its own.
    const connections = connectionsOf(deps.broker);
    for (const spec of [
      { offset: 0, limit: 500 },
      {
        offset: 10,
        limit: 50,
        filter: { types: ['AMQP 1.0'] },
        sort: { column: 'channels', dir: 'desc' as const },
      },
      {
        offset: 0,
        limit: 200,
        filter: { vhosts: [second], states: ['blocked'] },
        sort: { column: 'peerHost', dir: 'asc' as const },
      },
      { offset: 0, limit: 20, filter: { text: 'CONNECTION-0001' } },
      { offset: 0, limit: 30, sort: { column: 'ssl', dir: 'desc' as const } },
    ] satisfies Spec[]) {
      const { offset, limit, ...more } = spec;
      const answer = await ask(query('connections', { offset, limit }, more));
      const expected = reference(connections, spec, 'protocol');
      expect(answer.rows).toEqual(expected.rows);
      expect(answer).toMatchObject({
        kind: 'connections',
        matched: expected.matched,
        total: 1_200,
        freshness: { state: 'live', complete: true, loaded: 1_200 },
      });
    }

    // Not one request to the broker, and a query leaves no audit row and no receipt.
    expect(deps.broker.requests).toHaveLength(before);
    expect(engine.audit.attempts).toEqual([]);
    expect(engine.receipts.records).toEqual([]);
    // A column the kind does not have is refused, not ignored.
    await expect(
      ask(
        query(
          'exchanges',
          { offset: 0, limit: 1 },
          {
            sort: { column: 'messages', dir: 'asc' },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      ask(
        query(
          'connections',
          { offset: 0, limit: 1 },
          { sort: { column: 'messages', dir: 'asc' } },
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('M0-48 AC-7 explorer scrolling is stable on a pinned version and says when the version is gone', async () => {
    let broker = createScriptedBroker({ queueCount: 1_200, vhostCount: 2 });
    const hidden = new Set<string>();
    const mgmt: MgmtReadPort = {
      async get<T>(request: MgmtGetRequest<T>, signal: AbortSignal) {
        const out = await broker.read.get(request, signal);
        const page = out as { items?: { name: string }[] };
        if (request.path.startsWith('/api/queues/') && page.items) {
          page.items = page.items.filter((item) => !hidden.has(item.name));
        }
        return out;
      },
      stream: (request, signal) => broker.read.stream(request, signal),
    };
    const { ask, sweepNow } = harness({ mgmt });
    const nameAt = (i: number) => `queue-${String(i).padStart(6, '0')}`;
    const scroll = async (version: number) => {
      const answers = [];
      for (let offset = 0; offset < 1_200; offset += 100) {
        answers.push(
          await ask(query('queues', { offset, limit: 100, version })),
        );
      }
      return answers;
    };
    const namesOf = (answers: { rows: unknown[] }[]) =>
      answers.flatMap((a) => a.rows.map((r) => (r as Row).name));

    await sweepNow();
    const v = (await ask(query('queues', { offset: 0, limit: 1 }))).version;
    // A queue is added and one is removed by the next sweep.
    broker = createScriptedBroker({ queueCount: 1_201, vhostCount: 2 });
    hidden.add(nameAt(5));
    await sweepNow();

    const pinned = await scroll(v);
    expect(pinned.every((a) => !a.freshness.versionChanged)).toBe(true);
    expect(pinned.every((a) => a.version === v)).toBe(true);
    expect(namesOf(pinned)).toEqual(
      Array.from({ length: 1_200 }, (_, i) => nameAt(i)),
    );
    const now = await ask(query('queues', { offset: 1_100, limit: 100 }));
    expect(now.version).toBeGreaterThan(v);
    expect(now.rows.map((r) => (r as Row).name)).toContain(nameAt(1_200));

    // Two sweeps on, the pinned version is gone: the answer is from the current one and says so.
    hidden.add(nameAt(6));
    await sweepNow();
    const gone = await ask(
      query('queues', { offset: 0, limit: 500, version: v }),
    );
    expect(gone.freshness.versionChanged).toBe(true);
    expect(gone.version).toBeGreaterThan(now.version);
    expect(gone.matched).toBe(1_199);
    expect(gone.rows.map((r) => (r as Row).name)).not.toContain(nameAt(5));
  });

  it('M0-48 explorer a key that two pages both carry appears once in every window and the answer says the read is partial', async () => {
    const broker = createScriptedBroker({ queueCount: 1_200 });
    let shifted = false;
    let last: { messages?: number } | undefined;
    const mgmt: MgmtReadPort = {
      async get<T>(request: MgmtGetRequest<T>, signal: AbortSignal) {
        const out = await broker.read.get(request, signal);
        const page = out as { items?: { messages?: number }[] };
        if (request.path.startsWith('/api/queues/') && page.items) {
          const before = request.query?.page === 1 ? undefined : last;
          last = page.items.at(-1);
          if (shifted && before !== undefined) {
            // A queue was created while the sweep paged: this page starts with the row that ended the
            // last one, now with other counts, and the last queue of the broker falls off the end.
            page.items = [
              { ...before, messages: 4_242 },
              ...page.items.slice(0, -1),
            ];
          }
        }
        return out;
      },
      stream: (request, signal) => broker.read.stream(request, signal),
    };
    const { deps, ask, sweepNow } = harness({ mgmt });
    const scroll = async (version?: number) => {
      const rows: Row[] = [];
      let seen: Awaited<ReturnType<typeof ask>> | undefined;
      for (let offset = 0; offset < 1_200; offset += 500) {
        seen = await ask(
          query('queues', {
            offset,
            limit: 500,
            ...(version ? { version } : {}),
          }),
        );
        rows.push(...(seen.rows as Row[]));
      }
      return { rows, last: seen };
    };

    expect((await sweepNow()).ended).toBe('complete');
    const clean = await scroll();
    expect(clean.last?.freshness).toMatchObject({
      state: 'live',
      complete: true,
      loaded: 1_200,
    });

    shifted = true;
    const outcome = await sweepNow();

    expect(outcome).toMatchObject({ ended: 'partial', duplicates: 1 });
    const { rows, last: answer } = await scroll();
    // One key, one row: the window never shows a row twice, and the first row of the key is the one kept.
    expect(rows).toHaveLength(1_199);
    expect(new Set(rows.map((r) => r.key)).size).toBe(1_199);
    expect(rows.find((r) => r.name === 'queue-000499')).toMatchObject({
      messages: 99,
    });
    expect(answer).toMatchObject({ total: 1_199, matched: 1_199 });
    // The inventory is not called whole: the broker said 1,200 and 1,199 were read.
    expect(answer?.freshness).toMatchObject({
      state: 'stale',
      complete: false,
      loaded: 1_199,
      expected: 1_200,
      reason: 'Part of the inventory could not be read.',
    });
    // Counted, not silent (I-13).
    expect(deps.sweeper.index(cid)?.stats.duplicates).toBe(1);

    // The next clean read is whole again.
    shifted = false;
    expect((await sweepNow()).ended).toBe('complete');
    const healed = await scroll();
    expect(healed.rows).toHaveLength(1_200);
    expect(healed.last?.freshness).toMatchObject({
      state: 'live',
      complete: true,
      loaded: 1_200,
    });
  });

  it('M0-48 AC-8 explorer cold start answers at once and never calls a partial index complete', async () => {
    const scripted = createScriptedBroker({ queueCount: 10_000 });
    const hold = (read: MgmtReadPort, prefix: string, nth: number) => {
      let seen = 0;
      let held = false;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const port: MgmtReadPort = {
        async get<T>(request: MgmtGetRequest<T>, signal: AbortSignal) {
          if (request.path.startsWith(prefix) && ++seen === nth) {
            held = true;
            await gate;
          }
          return read.get(request, signal);
        },
        stream: (request, signal) => read.stream(request, signal),
      };
      return { port, release, isHeld: () => held };
    };
    const tenOfTwenty = hold(scripted.read, '/api/queues/', 11);
    const exchangeRead = hold(tenOfTwenty.port, '/api/exchanges/', 1);
    const { ask, sweepNow, deps } = harness({ mgmt: exchangeRead.port });

    // The very first query starts the sweep and is answered without waiting for it.
    const first = await ask(query('queues', { offset: 0, limit: 200 }));
    expect(first).toMatchObject({
      rows: [],
      freshness: { state: 'loading', complete: false, loaded: 0 },
    });
    await vi.waitFor(() => {
      expect(tenOfTwenty.isHeld()).toBe(true);
    });

    // Ten of the twenty pages are in: nothing of the kind is installed, the count to come is known.
    const half = await ask(query('queues', { offset: 0, limit: 200 }));
    expect(half).toMatchObject({
      kind: 'queues',
      rows: [],
      total: 0,
      freshness: {
        state: 'loading',
        complete: false,
        loaded: 0,
        expected: 10_000,
      },
    });
    expect(half.freshness.reason).toBeDefined();

    // The queues are installed, the exchanges are not: the index is still not complete.
    tenOfTwenty.release();
    await vi.waitFor(() => {
      expect(exchangeRead.isHeld()).toBe(true);
    });
    const partial = await ask(query('queues', { offset: 0, limit: 200 }));
    expect(partial.rows).toHaveLength(200);
    expect(partial.freshness).toMatchObject({
      state: 'loading',
      complete: false,
      loaded: 10_000,
      expected: 10_000,
    });
    expect(
      (await ask(query('exchanges', { offset: 0, limit: 10 }))).freshness,
    ).toMatchObject({ state: 'loading', complete: false, loaded: 0 });

    exchangeRead.release();
    await sweepNow();
    const done = await ask(query('queues', { offset: 0, limit: 200 }));
    expect(done.freshness).toMatchObject({
      state: 'live',
      complete: true,
      loaded: 10_000,
      expected: 10_000,
    });
    expect(done.freshness.sweptAt).toBeDefined();
    expect(done.freshness.reason).toBeUndefined();

    // A connection that was never probed is not guessed at.
    const cold = harness({ seeded: false });
    await expect(
      cold.ask(query('queues', { offset: 0, limit: 10 })),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(cold.deps.broker.requests).toEqual([]);
    expect(deps.broker.requests).toEqual([]);
  });

  it('M0-48 AC-9 explorer stats-off rows show what the broker sent and name the hazard', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
    const fixture = (target: string, file: string) =>
      JSON.parse(
        readFileSync(
          join(root, 'testing/fixtures/mgmt', target, 'stats-off', file),
          'utf8',
        ),
      ) as unknown;
    const replay = (target: string): MgmtReadPort => {
      const queues = (fixture(target, 'queues.list.json') as { items: Raw[] })
        .items;
      const exchanges = (
        fixture(target, 'exchanges.list.json') as { items: Raw[] }
      ).items;
      return {
        get<T>(request: MgmtGetRequest<T>): Promise<T> {
          const [, , kind, raw] = request.path.split('/');
          const vhost = decodeURIComponent(raw ?? '');
          const items = (kind === 'queues' ? queues : exchanges).filter(
            (item) => item.vhost === vhost,
          );
          return Promise.resolve(
            request.schema.parse(
              request.path === '/api/vhosts'
                ? fixture(target, 'vhosts.list.json')
                : {
                    items,
                    page: 1,
                    page_count: 1,
                    total_count: items.length,
                  },
            ),
          );
        },
        stream: () => Promise.reject(new Error('never streams')),
      };
    };
    const fields: Record<string, string> = {
      vhost: 'vhost',
      name: 'name',
      type: 'type',
      state: 'state',
      node: 'node',
      durable: 'durable',
      autoDelete: 'auto_delete',
      exclusive: 'exclusive',
      messages: 'messages',
      messagesReady: 'messages_ready',
      messagesUnacknowledged: 'messages_unacknowledged',
      consumers: 'consumers',
      policy: 'policy',
      operatorPolicy: 'operator_policy',
      deliveryLimit: 'delivery_limit',
    };
    const unrelated = 'shovel-reject-loop';

    // The two recordings: what each broker sent for the policy fields, and the hazards its profile lists.
    const recordings = [
      {
        target: '4.0.9',
        profileHazards: ['stats-off-policy-fields-missing', unrelated],
        deliveryLimits: [],
        named: ['stats-off-policy-fields-missing'],
      },
      {
        target: '4.3.6',
        profileHazards: [unrelated],
        deliveryLimits: [{ name: 'golden.quorum', deliveryLimit: 7 }],
        named: [],
      },
    ];
    for (const {
      target,
      profileHazards,
      deliveryLimits,
      named,
    } of recordings) {
      const { ask, sweepNow } = harness({
        mgmt: replay(target),
        profile: { hazards: profileHazards },
      });
      await sweepNow();
      const answer = await ask(
        query(
          'queues',
          { offset: 0, limit: 500 },
          { sort: { column: 'name', dir: 'asc' } },
        ),
      );
      const recorded = (fixture(target, 'queues.list.json') as { items: Raw[] })
        .items;
      const rows = answer.rows as Row[];

      expect(rows.map((r) => r.name)).toEqual(
        recorded.map((r) => String(r.name)).sort(),
      );
      for (const row of rows) {
        const sent = recorded.find((r) => r.name === row.name);
        // The totals come from enable_queue_totals. A stream queue carries none in the recordings,
        // so its row has none: a missing figure is never shown as zero.
        for (const total of [
          'messages',
          'messagesReady',
          'messagesUnacknowledged',
        ]) {
          expect(typeof row[total]).toBe(
            row.type === 'stream' ? 'undefined' : 'number',
          );
        }
        // Every field is what the broker sent, and every field it sent is there: no default, no guess.
        for (const [field, column] of Object.entries(fields)) {
          const value = sent?.[column];
          if (value === null || value === undefined) {
            expect(field in row).toBe(false);
          } else {
            expect(row[field]).toEqual(value);
          }
        }
      }
      expect(rows.filter((r) => 'policy' in r).map((r) => r.name)).toEqual([
        'golden.classic',
        'golden.quorum',
      ]);
      expect(
        rows
          .filter((r) => 'deliveryLimit' in r)
          .map((r) => ({ name: r.name, deliveryLimit: r.deliveryLimit })),
      ).toEqual(deliveryLimits);
      // Only the hazard that concerns queue rows is named; the other one in the profile is not.
      expect(answer.freshness.hazards).toEqual(named);
      expect(
        (await ask(query('exchanges', { offset: 0, limit: 500 }))).freshness
          .hazards,
      ).toEqual([]);
    }
  });

  it('M0-48 AC-10 explorer inventory.query denies by default and hides connections the caller cannot see', async () => {
    const body = query('queues', { offset: 0, limit: 10 });
    const as = (roles: string[], deps: ExplorerFakeDeps, input = body) => {
      const engine: TestExecutor = createTestExecutor({
        executor: {
          authorizer: createRoleAuthorizer({ operator: ['broker.read'] }),
        },
      });
      engine.executor.register(createInventoryQueryAction(deps));
      return engine.executor.run(
        def,
        input,
        createTestContext({
          principal: createTestPrincipal({ roles }),
          idempotencyKey: KEY,
        }),
      );
    };
    const refused = {
      noRole: createExplorerFakeDeps(),
      denyAll: createExplorerFakeDeps(),
      someoneElses: createExplorerFakeDeps({ ownerId: 'someone-else' }),
      unknown: createExplorerFakeDeps(),
    };

    await expect(as(['intruder'], refused.noRole)).rejects.toMatchObject({
      code: 'FORBIDDEN_RBAC',
    });
    const none = createTestExecutor({
      executor: { authorizer: denyAllAuthorizer },
    });
    none.executor.register(createInventoryQueryAction(refused.denyAll));
    await expect(
      none.executor.run(def, body, createTestContext({ idempotencyKey: KEY })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_RBAC' });
    const hidden = await as(['operator'], refused.someoneElses).catch(
      (error: unknown) => error,
    );
    const missing = await as(['operator'], refused.unknown, {
      ...body,
      cid: 'c2',
    }).catch((error: unknown) => error);

    // The same answer for a connection that is not yours and one that does not exist.
    expect(hidden).toMatchObject({ code: 'NOT_FOUND' });
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });
    expect((hidden as Error).message).toBe((missing as Error).message);
    for (const deps of Object.values(refused)) {
      expect(deps.broker.requests).toEqual([]);
    }

    const allowed = createExplorerFakeDeps();
    const answer = await as(['operator'], allowed);
    expect(answer.kind).toBe('output');
  });

  it('M0-48 AC-27 explorer connections kind is swept, paged and shows only what the broker sent', async () => {
    const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
    const recorded = (target: string, mode: string) =>
      JSON.parse(
        readFileSync(
          join(
            root,
            'testing/fixtures/mgmt',
            target,
            mode,
            'connections.list.json',
          ),
          'utf8',
        ),
      ) as { items: Raw[] };
    /** The scripted broker for everything but the connection list, which answers `list`. */
    const answering = (list: unknown): MgmtReadPort => {
      const scripted = createScriptedBroker();
      return {
        get<T>(request: MgmtGetRequest<T>, signal: AbortSignal) {
          return request.path === '/api/connections'
            ? Promise.resolve(request.schema.parse(list))
            : scripted.read.get(request, signal);
        },
        stream: (request, signal) => scripted.read.stream(request, signal),
      };
    };
    const connectionsOfAnswer = async (
      list: unknown,
      hazards: string[] = [],
    ) => {
      const { ask, sweepNow } = harness({
        mgmt: answering(list),
        profile: { hazards },
      });
      await sweepNow();
      return ask(query('connections', { offset: 0, limit: 500 }));
    };

    // Swept and paged: one global list (never one per vhost) at 500 per page, statistics off, in
    // the background lane, and without the queue totals only a queue list can use.
    const { deps, ask, sweepNow } = harness({
      connectionCount: 1_100,
      vhostCount: 3,
    });
    const outcome = await sweepNow();
    const lists = deps.broker.requests.filter((r) =>
      r.path.startsWith('/api/connections'),
    );
    expect(outcome.ended).toBe('complete');
    expect(lists.map((r) => [r.path, r.query])).toEqual(
      [1, 2, 3].map((page) => [
        '/api/connections',
        { page, page_size: 500, disable_stats: true },
      ]),
    );
    expect(lists.every((r) => r.lane === 'background')).toBe(true);
    const all = await ask(query('connections', { offset: 1_000, limit: 500 }));
    expect(all).toMatchObject({
      kind: 'connections',
      total: 1_100,
      matched: 1_100,
      freshness: {
        state: 'live',
        complete: true,
        loaded: 1_100,
        expected: 1_100,
      },
    });
    expect(all.rows).toHaveLength(100);
    expect(
      (await ask(query('connections', { offset: 0, limit: 1 }))).freshness,
    ).toMatchObject({ complete: true, hazards: [] });

    // A broker that sends the static information (4.3.6, statistics on): exactly the mapped fields,
    // a false stays false, and nothing else of the recording (client properties, TLS, counters) leaks.
    const on = recorded('4.3.6', 'stats-on').items[0] ?? {};
    const full = await connectionsOfAnswer(recorded('4.3.6', 'stats-on'));
    expect(full.rows).toEqual([
      {
        key: encodeObjectKey(String(on.vhost), String(on.name)),
        vhost: on.vhost,
        name: on.name,
        user: on.user,
        node: on.node,
        state: on.state,
        protocol: on.protocol,
        channels: on.channels,
        peerHost: on.peer_host,
        ssl: false,
      },
    ]);
    expect(JSON.stringify(full)).not.toMatch(
      /client_properties|auth_mechanism|amqplib|peer_cert/,
    );

    // A broker that drops it (4.0.9 and 4.2.9, statistics off; the 4.2.9 recording lacks it although
    // the registry says 4.2.6 and later keep it, OQ-691): the row has the four fields it sent, and
    // no other is shown, defaulted or guessed. The profile lists a hazard of the queue rows, which
    // the registry does not tie to connections, so it is not named here.
    for (const target of ['4.0.9', '4.2.9']) {
      const off = recorded(target, 'stats-off').items[0] ?? {};
      const sparse = await connectionsOfAnswer(recorded(target, 'stats-off'), [
        'stats-off-policy-fields-missing',
      ]);
      expect(sparse.rows).toEqual([
        {
          key: encodeObjectKey(String(off.vhost), String(off.name)),
          vhost: off.vhost,
          name: off.name,
          user: off.user,
          node: off.node,
        },
      ]);
      expect(Object.keys(sparse.rows[0] ?? {}).sort()).toEqual([
        'key',
        'name',
        'node',
        'user',
        'vhost',
      ]);
      expect(sparse.freshness).toMatchObject({ state: 'live', hazards: [] });
    }

    // No connection at all is an empty, complete list; a connection the broker gave no vhost, and
    // a field it sent as null, are absent (the key uses the empty vhost).
    expect(
      await connectionsOfAnswer(recorded('4.3.6', 'stats-off')),
    ).toMatchObject({
      rows: [],
      total: 0,
      freshness: { state: 'live', complete: true, loaded: 0 },
    });
    const odd = await connectionsOfAnswer({
      items: [{ name: 'no-vhost', state: null, ssl: null }],
      page: 1,
      page_count: 1,
      total_count: 1,
    });
    expect(odd.rows).toEqual([
      { key: encodeObjectKey('', 'no-vhost'), name: 'no-vhost' },
    ]);
  });
});
