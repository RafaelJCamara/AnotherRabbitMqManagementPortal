// The bindings kind of inventory.query (M0-48 slice H): per vhost, on demand, bounded and counted.
import { ConnectionIdSchema } from '@app/contracts';
import { createTestContext, createTestExecutor } from '@app/kernel';
import { describe, expect, it } from 'vitest';

import { createSubject } from '../actions/inventory-query.fixture';
import { createInventoryQueryAction } from '../actions/inventory-query';
import { brokerFailure, createExplorerFakeDeps } from '../testing';

const { def } = createSubject();
const cid = ConnectionIdSchema.parse('c1');

function harness(options: Parameters<typeof createExplorerFakeDeps>[0]) {
  const deps = createExplorerFakeDeps(options);
  const engine = createTestExecutor();
  engine.executor.register(createInventoryQueryAction(deps));
  const ask = async (input: Record<string, unknown>) => {
    const outcome = await engine.executor.run(
      def,
      input,
      createTestContext({ idempotencyKey: 'explorer-bindings-spec-key' }),
    );
    if (outcome.kind !== 'output') throw new Error(`got ${outcome.kind}`);
    return outcome.output;
  };
  const bindings = (
    vhosts: string[] | undefined,
    more: Record<string, unknown> = {},
    window: Record<string, unknown> = { offset: 0, limit: 200 },
  ) => ({
    cid: 'c1',
    kind: 'bindings',
    window,
    ...(vhosts === undefined ? {} : { filter: { vhosts } }),
    ...more,
  });
  return { deps, ask, bindings };
}

describe('explorer bindings', () => {
  it('AC-26 explorer bindings are per vhost, bounded and counted', async () => {
    const { deps, ask, bindings } = harness({
      vhostCount: 3,
      bindingsPerVhost: { '/': 3_000, 'vhost-1': 1_000, 'vhost-2': 50 },
      limits: { maxBindingsResident: 2_000 },
    });
    const { broker } = deps;

    // No "list all" (I-7): without exactly one vhost the query is refused and the broker is not asked.
    for (const vhosts of [undefined, [], ['/', 'vhost-1']]) {
      await expect(ask(bindings(vhosts))).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await expect(
      ask(bindings(['/'], { sort: { column: 'name', dir: 'asc' } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(broker.requests).toHaveLength(0);

    // The first query reads the vhost: 3,000 bindings, 500 a page, in the interactive lane, and stops
    // at the cap (4 pages) because the broker's own count says what is left.
    const first = await ask(bindings(['/']));
    expect(first.kind).toBe('bindings');
    expect(first).toMatchObject({
      total: 2_000,
      matched: 2_000,
      window: { offset: 0, limit: 200 },
      freshness: {
        state: 'live',
        complete: true,
        loaded: 2_000,
        expected: 3_000,
        truncated: true,
        dropped: 1_000,
      },
    });
    expect(first.rows).toHaveLength(200);
    expect(broker.requests.map((r) => r.path)).toEqual(
      Array.from({ length: 4 }, () => '/api/bindings/%2F'),
    );
    expect(broker.requests.map((r) => r.query.page)).toEqual([1, 2, 3, 4]);
    for (const r of broker.requests) {
      expect(r).toMatchObject({
        lane: 'interactive',
        query: { page_size: 500 },
      });
    }
    // Bindings are not part of the sweep: nothing swept, nothing else asked.
    expect(deps.sweeper.index(cid)).toBeUndefined();

    // Resident now: other windows, filters and sorts make no request.
    const tail = await ask(bindings(['/'], {}, { offset: 1_990, limit: 50 }));
    expect(tail.rows).toHaveLength(10);
    const found = await ask(
      bindings(['/'], { filter: { vhosts: ['/'], text: 'rk-12' } }),
    );
    expect(found.matched).toBe(111); // rk-12, rk-120..129, rk-1200..1299
    const sorted = await ask(
      bindings(
        ['/'],
        { sort: { column: 'routingKey', dir: 'asc' } },
        { offset: 0, limit: 3 },
      ),
    );
    expect(
      sorted.rows.map((r) => (r as { routingKey?: string }).routingKey),
    ).toEqual(['rk-0', 'rk-1', 'rk-10']);
    expect(sorted.rows[0]).toMatchObject({
      vhost: '/',
      source: 'exchange-0',
      destination: 'queue-000000',
      destinationType: 'queue',
      propertiesKey: 'rk-0',
    });
    expect(broker.requests).toHaveLength(4);
    expect(deps.bindings.stats(cid)).toMatchObject({
      vhosts: ['/'],
      rows: 2_000,
      dropped: 1_000,
      evictions: 0,
    });

    // A second vhost does not fit beside the first: the least recently used one is evicted, counted.
    const second = await ask(bindings(['vhost-1']));
    expect(second).toMatchObject({
      total: 1_000,
      freshness: { truncated: false, dropped: 0, expected: 1_000 },
    });
    expect(deps.bindings.stats(cid)).toEqual({
      vhosts: ['vhost-1'],
      rows: 1_000,
      dropped: 0,
      evictions: 1,
      evictedRows: 2_000,
    });
    // Asking for the evicted vhost reads it again and evicts the other, also counted.
    await ask(bindings(['/']));
    expect(broker.requests).toHaveLength(4 + 2 + 4);
    expect(deps.bindings.stats(cid)).toMatchObject({
      vhosts: ['/'],
      evictions: 2,
      evictedRows: 3_000,
    });
  });

  it('explorer bindings evict the least recently used vhost, not the oldest loaded', async () => {
    const { deps, ask, bindings } = harness({
      vhostCount: 3,
      bindingsPerVhost: 800,
      limits: { maxBindingsResident: 2_000 },
    });
    await ask(bindings(['/']));
    await ask(bindings(['vhost-1']));
    await ask(bindings(['/'])); // uses the first again
    await ask(bindings(['vhost-2'])); // 2,400 rows: one vhost has to go
    expect(deps.bindings.stats(cid)).toMatchObject({
      vhosts: ['/', 'vhost-2'],
      rows: 1_600,
      evictions: 1,
      evictedRows: 800,
    });
  });

  it('explorer bindings are read again after their age and served stale when that fails', async () => {
    const { deps, ask, bindings } = harness({
      bindingsPerVhost: 20,
      limits: { bindingsMaxAgeMs: 60_000 },
    });
    const first = await ask(bindings(['/']));
    deps.clock.advance(59_000);
    const same = await ask(bindings(['/']));
    expect(deps.broker.requests).toHaveLength(1);
    expect(same.version).toBe(first.version);

    deps.clock.advance(1_000);
    const again = await ask(bindings(['/']));
    expect(deps.broker.requests).toHaveLength(2);
    expect(again.version).toBeGreaterThan(first.version);
    const pinned = await ask(
      bindings(['/'], {}, { offset: 0, limit: 5, version: first.version }),
    );
    expect(pinned.freshness.versionChanged).toBe(true);

    // The next read fails: the resident rows are served, labelled stale, with a fixed reason (I-10).
    deps.clock.advance(60_000);
    deps.broker.intercept = () => brokerFailure();
    const stale = await ask(bindings(['/']));
    expect(stale.total).toBe(20);
    expect(stale.freshness.state).toBe('stale');
    expect(JSON.stringify(stale)).not.toContain('secret-broker-text');
    const calls = deps.broker.requests.length;
    await ask(bindings(['/'])); // not asked again at once
    expect(deps.broker.requests).toHaveLength(calls);

    // A vhost that was never read has nothing to show: a Problem with fixed text.
    const failed = await ask(bindings(['nope'])).catch((e: unknown) => e);
    expect(failed).toMatchObject({ code: 'BROKER_UNREACHABLE' });
    expect(JSON.stringify(failed)).not.toContain('secret-broker-text');
  });
});
