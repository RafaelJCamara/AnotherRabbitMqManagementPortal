// search.query over the index (M0-48 slice G). The title starts with `explorer` so
// `--testNamePattern=explorer` selects the set; the AC is one test.
import {
  ConnectionIdSchema,
  SEARCH_RESULT_MAX,
  checkRegistry,
  encodeObjectKey,
} from '@app/contracts';
import {
  createRoleAuthorizer,
  createTestContext,
  createTestExecutor,
  createTestPrincipal,
  denyAllAuthorizer,
} from '@app/kernel';
import type { MgmtGetRequest, MgmtReadPort } from '@app/ports';
import { describe, expect, it } from 'vitest';

import {
  brokerFailure,
  createExplorerFakeDeps,
  createScriptedBroker,
} from '../testing';

import { mergeFreshness } from '../internal/search';

import { createSearchQueryAction } from './search-query';
import { createSubject, sampleInput } from './search-query.fixture';

const { def } = createSubject();
const cid = ConnectionIdSchema.parse('c1');
const KEY = 'explorer-search-key-0001';

type Input = Record<string, unknown>;
interface Name {
  kind: 'queues' | 'exchanges';
  vhost: string;
  name: string;
  key: string;
}

/** Names the scripted broker would not make: they show every rank, a tie and a mixed case. */
const RENAMED: Record<string, string> = {
  'queue-000000': 'Orders', // vhost '/'
  'queue-000001': 'orders-retry', // vhost-1
  'queue-000002': 'my-orders', // vhost-2
  'queue-000003': 'ORDERS', // vhost-3
  'queue-000004': 'orders-dead-letter', // vhost '/'
  'queue-000005': 'x-orders-y', // vhost-1
};

function harness(
  options: Parameters<typeof createExplorerFakeDeps>[0] = {},
  roles?: string[],
) {
  const deps = createExplorerFakeDeps(options);
  const engine = createTestExecutor(
    roles
      ? {
          executor: {
            authorizer: createRoleAuthorizer({ operator: ['broker.read'] }),
          },
        }
      : {},
  );
  engine.executor.register(createSearchQueryAction(deps));
  const ask = async (input: Input) => {
    const outcome = await engine.executor.run(
      def,
      input,
      createTestContext({
        idempotencyKey: KEY,
        ...(roles ? { principal: createTestPrincipal({ roles }) } : {}),
      }),
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

/** The plain way, written out independently of the service. */
function reference(names: Name[], text: string) {
  const needle = text.toLowerCase();
  const rank = (n: Name) => {
    const lower = n.name.toLowerCase();
    return lower === needle ? 0 : lower.startsWith(needle) ? 1 : 2;
  };
  const found = names.filter((n) => n.name.toLowerCase().includes(needle));
  found.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.length - b.name.length ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return {
    matched: found.length,
    names: found.slice(0, SEARCH_RESULT_MAX).map((n) => `${n.kind}:${n.key}`),
    ranks: found
      .slice(0, SEARCH_RESULT_MAX)
      .map((n) => ['exact', 'prefix', 'substring'][rank(n)]),
  };
}

describe('explorer search.query', () => {
  it('AC-25 explorer search is bounded, ranked and answered from the index', async () => {
    expect(checkRegistry({ actions: [def], topics: [] })).toEqual([]);
    expect(def.input.safeParse(sampleInput).success).toBe(true);
    const scripted = createScriptedBroker({
      queueCount: 20_000,
      vhostCount: 4,
      exchangesPerVhost: 3,
    });
    const mgmt: MgmtReadPort = {
      async get<T>(request: MgmtGetRequest<T>, signal: AbortSignal) {
        const out = await scripted.read.get(request, signal);
        const page = out as { items?: { name: string }[] };
        if (request.path.startsWith('/api/queues/') && page.items) {
          for (const item of page.items) {
            item.name = RENAMED[item.name] ?? item.name;
          }
        }
        return out;
      },
      stream: (request, signal) => scripted.read.stream(request, signal),
    };
    const { ask, sweepNow } = harness({ mgmt });

    // Everything the index should hold, written out from the broker's own definition.
    const names: Name[] = [
      ...Array.from({ length: 20_000 }, (_, i): Name => {
        const vhost = scripted.vhosts[i % 4] ?? '';
        const original = `queue-${String(i).padStart(6, '0')}`;
        const name = RENAMED[original] ?? original;
        return {
          kind: 'queues',
          vhost,
          name,
          key: encodeObjectKey(vhost, name),
        };
      }),
      ...scripted.vhosts.flatMap((vhost) =>
        [0, 1, 2].map((j): Name => {
          const name = `exchange-${String(j)}`;
          return {
            kind: 'exchanges',
            vhost,
            name,
            key: encodeObjectKey(vhost, name),
          };
        }),
      ),
    ];
    const search = (text: string, more: Input = {}) =>
      ask({ cid: 'c1', text, ...more });

    await sweepNow();
    const before = scripted.requests.length;
    expect(before).toBeGreaterThan(0);

    // Ranked: exact (by key), then prefix (the shorter name first), then substring (the shorter first).
    const orders = await search('orders');
    // The two exact names differ only by case and vhost: the key decides.
    const exact = [
      ['exact', 'Orders', '/'],
      ['exact', 'ORDERS', 'vhost-3'],
    ].sort((a, b) =>
      encodeObjectKey(a[2] ?? '', a[1] ?? '') <
      encodeObjectKey(b[2] ?? '', b[1] ?? '')
        ? -1
        : 1,
    );
    expect(orders.results.map((r) => [r.rank, r.name, r.vhost])).toEqual([
      ...exact,
      ['prefix', 'orders-retry', 'vhost-1'],
      ['prefix', 'orders-dead-letter', '/'],
      ['substring', 'my-orders', 'vhost-2'],
      ['substring', 'x-orders-y', 'vhost-1'],
    ]);
    expect(orders).toMatchObject({ matched: 6, truncated: false });
    expect(orders.results.map((r) => r.key)).toEqual(
      orders.results.map((r) => encodeObjectKey(r.vhost, r.name)),
    );
    // Case never matters, in the text or the name.
    expect(await search('ORDERS')).toEqual(orders);
    expect(await search('oRdErS')).toEqual(orders);

    // Bounded: 19,994 names start with the text, 50 are shown, and the count is still exact.
    const all = await search('queue');
    expect(all.results).toHaveLength(SEARCH_RESULT_MAX);
    expect(all).toMatchObject({ matched: 19_994, truncated: true });
    expect(all.results.every((r) => r.rank === 'prefix')).toBe(true);
    expect(all.freshness).toMatchObject({
      state: 'live',
      complete: true,
      loaded: 20_012,
      expected: 20_012,
    });

    // The kinds: exchanges by name, only the one asked for, and a kind the text does not match.
    const exchanges = await search('exchange-1');
    expect(exchanges.results.map((r) => `${r.kind}:${r.key}`)).toEqual(
      reference(names, 'exchange-1').names,
    );
    expect(exchanges.results.map((r) => [r.kind, r.rank])).toEqual(
      Array.from({ length: 4 }, () => ['exchanges', 'exact']),
    );
    expect(exchanges.matched).toBe(4);
    expect((await search('exchange-1', { kinds: ['queues'] })).results).toEqual(
      [],
    );
    expect(
      (await search('exchange-1', { kinds: ['exchanges', 'exchanges'] }))
        .matched,
    ).toBe(4);

    // The text is never a pattern.
    for (const text of ['queue-.*', '(', '[a-z]+', '^queue', 'e$', '\\']) {
      expect(await search(text)).toMatchObject({ results: [], matched: 0 });
    }

    // The answers equal the plain reference over many texts.
    const texts = [
      'queue-000123',
      'QUEUE-0001',
      '000012',
      'e-1',
      'exchange',
      'x',
      '5',
      '99',
      'queue-19999',
      'vhost',
      ' ',
      'orders-',
    ];
    for (const text of texts) {
      const answer = await search(text);
      const expected = reference(names, text);
      expect(
        answer.results.map((r) => `${r.kind}:${r.key}`),
        text,
      ).toEqual(expected.names);
      expect(
        answer.results.map((r) => r.rank),
        text,
      ).toEqual(expected.ranks);
      expect(answer.matched, text).toBe(expected.matched);
      expect(answer.truncated, text).toBe(expected.matched > SEARCH_RESULT_MAX);
    }

    // Fast: 500 searches, from the common to the rare, p95 printed and asserted generously.
    const needles = [
      '0',
      'queue',
      'e-0',
      'queue-01',
      '17',
      'queue-00123',
      'zz',
    ];
    const took: number[] = [];
    for (let i = 0; i < 500; i++) {
      const text = `${needles[i % needles.length] ?? ''}${i % 3 === 0 ? String(i) : ''}`;
      const start = performance.now();
      await search(text);
      took.push(performance.now() - start);
    }
    took.sort((a, b) => a - b);
    const p95 = took[Math.floor(took.length * 0.95)] ?? Infinity;
    process.stdout.write(
      `explorer search over ${String(names.length)} names: p95 ${p95.toFixed(2)} ms, max ${(took.at(-1) ?? 0).toFixed(2)} ms over 500 searches\n`,
    );
    expect(p95).toBeLessThanOrEqual(50);

    // Not one request to the broker, and a query leaves no audit row and no receipt.
    expect(scripted.requests).toHaveLength(before);

    // The refusals: nothing is searched for an empty text, a long one, a kind that does not exist or a pattern field.
    const bad: Input[] = [
      { cid: 'c1', text: '' },
      { cid: 'c1', text: 'x'.repeat(201) },
      { cid: 'c1', text: 'queue', kinds: [] },
      { cid: 'c1', text: 'queue', kinds: ['connections'] },
      { cid: 'c1', text: 'queue', regex: true },
      { cid: 'c1' },
    ];
    for (const input of bad) {
      await expect(ask(input), JSON.stringify(input)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    expect(scripted.requests).toHaveLength(before);

    // A failed sweep keeps the last good names and the answer says stale.
    scripted.intercept = () => brokerFailure(503);
    await sweepNow();
    const stale = await search('orders');
    expect(stale.results).toEqual(orders.results);
    expect(stale.freshness).toMatchObject({ state: 'stale', complete: true });
    expect(stale.freshness.reason).toBeDefined();
    scripted.intercept = undefined;

    // One freshness for several kinds: the worst state, complete only when all are, counts summed.
    const part = (over: Partial<typeof stale.freshness>) => ({
      ...stale.freshness,
      ...over,
    });
    expect(
      mergeFreshness(
        part({ state: 'live', loaded: 3, expected: 3 }),
        part({
          state: 'loading',
          complete: false,
          loaded: 0,
          expected: 4,
          reason: 'r',
        }),
      ),
    ).toMatchObject({
      state: 'loading',
      complete: false,
      loaded: 3,
      expected: 7,
      reason: 'r',
    });
    expect(
      mergeFreshness(part({ expected: 3 }), part({ expected: undefined })),
    ).not.toHaveProperty('expected');

    // A cold connection is answered at once from what is installed, labelled loading.
    const cold = harness({ queueCount: 50 });
    const first = await cold.ask({ cid: 'c1', text: 'queue' });
    expect(first).toMatchObject({
      results: [],
      matched: 0,
      truncated: false,
      freshness: { state: 'loading', complete: false, loaded: 0 },
    });
    await cold.sweepNow();
    expect(await cold.ask({ cid: 'c1', text: 'queue-00004' })).toMatchObject({
      matched: 10,
      freshness: { state: 'live', complete: true, loaded: 50 },
    });

    // Deny by default; a connection the caller cannot see is the same NOT_FOUND as one that is not there.
    const refused = {
      noRole: harness({}, ['intruder']),
      someoneElses: harness({ ownerId: 'someone-else' }, ['operator']),
      unknown: harness({}, ['operator']),
      unprobed: harness({ seeded: false }, ['operator']),
    };
    await expect(refused.noRole.ask(sampleInput)).rejects.toMatchObject({
      code: 'FORBIDDEN_RBAC',
    });
    const none = createTestExecutor({
      executor: { authorizer: denyAllAuthorizer },
    });
    none.executor.register(createSearchQueryAction(createExplorerFakeDeps()));
    await expect(
      none.executor.run(
        def,
        sampleInput,
        createTestContext({ idempotencyKey: KEY }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN_RBAC' });
    const hidden = await refused.someoneElses
      .ask(sampleInput)
      .catch((error: unknown) => error);
    const missing = await refused.unknown
      .ask({ ...sampleInput, cid: 'c2' })
      .catch((error: unknown) => error);
    expect(hidden).toMatchObject({ code: 'NOT_FOUND' });
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });
    expect((hidden as Error).message).toBe((missing as Error).message);
    await expect(refused.unprobed.ask(sampleInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    for (const { deps } of Object.values(refused)) {
      expect(deps.broker.requests).toEqual([]);
    }
    expect((await harness({}, ['operator']).ask(sampleInput)).results).toEqual(
      [],
    );
  });
});
