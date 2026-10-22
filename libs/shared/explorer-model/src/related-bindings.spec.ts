import { encodeObjectKey } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import type { ExplorerData } from './ports';
import {
  loadRelatedBindings,
  RELATED_SCAN_MAX,
  RELATED_SHOWN_MAX,
  type BindingRow,
} from './related-bindings';
import { createFakeExplorerData } from './testing';

const signal = (): AbortSignal => new AbortController().signal;

function binding(
  source: string,
  destination: string,
  destinationType: 'queue' | 'exchange',
  routingKey = '',
): BindingRow {
  return {
    key: encodeObjectKey(
      '/',
      [source, destinationType, destination, routingKey].join('\u0000'),
    ),
    vhost: '/',
    source,
    destination,
    destinationType,
    routingKey,
    propertiesKey: routingKey,
  };
}

function dataWith(rows: readonly BindingRow[]) {
  const data = createFakeExplorerData({
    rows: { queues: 0, exchanges: 0, connections: 0, bindings: 0 },
    vhosts: ['/'],
  });
  data.bump((all) => {
    all.bindings = [...rows];
  });
  return data;
}

const keysOf = (rows: readonly BindingRow[]): string[] =>
  rows.map((row) => row.key).sort();

describe('loadRelatedBindings (R5)', () => {
  it('AC-5 related bindings are exact, bounded to five windows, and say what was not scanned', async () => {
    // Exact rows among rows that only contain the name.
    const into = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) =>
      binding(`ex-${s}`, 'orders', 'queue', 'rk'),
    );
    const intoExchange = [1, 2].map((i) =>
      binding(`src-${String(i)}`, 'orders', 'exchange'),
    );
    const out = [1, 2, 3].map((i) =>
      binding('orders', `sink-${String(i)}`, 'queue'),
    );
    const noise = [
      ...[1, 2, 3, 4].map((i) =>
        binding(`n-${String(i)}`, 'orders.dlq', 'queue'),
      ),
      ...[1, 2, 3].map((i) => binding(`m-${String(i)}`, 'my-orders', 'queue')),
      ...[1, 2].map((i) =>
        binding(`k-${String(i)}`, 'other', 'queue', 'orders'),
      ),
      binding('ORDERS-ex', 'x', 'queue'), // a different case is a different name
    ];
    const data = dataWith([...into, ...intoExchange, ...out, ...noise]);

    const queue = await loadRelatedBindings(
      data,
      { cid: 'c1', vhost: '/', name: 'orders', as: 'queue' },
      signal(),
    );
    expect(keysOf(queue.bindingsIn)).toEqual(keysOf(into));
    expect(queue.bindingsOut).toEqual([]); // a queue is nobody's source
    expect(queue).toMatchObject({
      truncated: false,
      problem: null,
      skipped: null,
      moreIn: 0,
      moreOut: 0,
    });
    expect(queue.scanned).toBe(queue.matched); // everything that matched was read
    expect(data.queries).toHaveLength(1);
    expect(data.queries[0]).toMatchObject({
      kind: 'bindings',
      filter: { vhosts: ['/'], text: 'orders' },
    });

    const exchange = await loadRelatedBindings(
      data,
      { cid: 'c1', vhost: '/', name: 'orders', as: 'exchange' },
      signal(),
    );
    // Only destinations of the right type, and sources that equal the name.
    expect(keysOf(exchange.bindingsIn)).toEqual(keysOf(intoExchange));
    expect(keysOf(exchange.bindingsOut)).toEqual(keysOf(out));

    // A list shows at most 200 rows and counts the rest; two windows are read for 250 rows, not more.
    const many = Array.from({ length: 250 }, (_, i) =>
      binding(`s-${String(i).padStart(4, '0')}`, 'big', 'queue'),
    );
    const bigData = dataWith(many);
    const big = await loadRelatedBindings(
      bigData,
      { cid: 'c1', vhost: '/', name: 'big', as: 'queue' },
      signal(),
    );
    expect(big.bindingsIn).toHaveLength(RELATED_SHOWN_MAX);
    expect(big.moreIn).toBe(50);
    expect(big.scanned).toBe(250);
    expect(bigData.queries).toHaveLength(2);

    // The default exchange asks nothing and says why.
    const before = data.queries.length;
    const implicit = await loadRelatedBindings(
      data,
      { cid: 'c1', vhost: '/', name: '', as: 'exchange' },
      signal(),
    );
    expect(implicit).toMatchObject({
      skipped: 'default-exchange',
      bindingsIn: [],
      bindingsOut: [],
    });
    expect(data.queries).toHaveLength(before);

    // A scan stops at five windows of 200 however many rows match, and says what it did not read.
    const flood = [
      ...Array.from({ length: 1_500 }, (_, i) =>
        binding(
          `a-${String(i).padStart(5, '0')}`,
          `orders-${String(i)}`,
          'queue',
        ),
      ),
      binding('zz-last', 'orders', 'queue'), // sorts after everything scanned
    ];
    const floodData = dataWith(flood);
    const cut = await loadRelatedBindings(
      floodData,
      { cid: 'c1', vhost: '/', name: 'orders', as: 'queue' },
      signal(),
    );
    expect(floodData.queries).toHaveLength(5);
    for (const input of floodData.queries) {
      expect(input.window.limit).toBeLessThanOrEqual(200);
      expect(input.filter?.vhosts).toEqual(['/']);
    }
    expect(floodData.queries.map((q) => q.window.offset)).toEqual([
      0, 200, 400, 600, 800,
    ]);
    expect(cut.scanned).toBe(RELATED_SCAN_MAX);
    expect(cut.matched).toBe(1_501);
    expect(cut.truncated).toBe(true);
    expect(cut.bindingsIn).toEqual([]); // the one exact row was beyond the cap, and that is said

    // A window that fails keeps what was read and carries the Problem.
    const problem = new Error('503');
    const failing: ExplorerData = {
      ...floodData,
      follow: (params, listener) => floodData.follow(params, listener),
      query: (input, abort) =>
        input.window.offset >= 200
          ? Promise.reject(problem)
          : floodData.query(input, abort),
    };
    const partial = await loadRelatedBindings(
      failing,
      { cid: 'c1', vhost: '/', name: 'orders', as: 'queue' },
      signal(),
    );
    expect(partial.problem).toBe(problem);
    expect(partial.scanned).toBe(200);
    expect(partial.truncated).toBe(false);

    // An abort rejects: a page that went away does not turn it into a result.
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadRelatedBindings(
        data,
        { cid: 'c1', vhost: '/', name: 'orders', as: 'queue' },
        controller.signal,
      ),
    ).rejects.toBeDefined();
  });
});
