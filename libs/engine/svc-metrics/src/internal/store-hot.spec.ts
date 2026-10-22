import { describe, expect, it } from 'vitest';

import type { ConnectionId } from '@app/contracts';

import { createHotStore, seriesKey, type SeriesParts } from './store-hot';

const A = 'a' as ConnectionId;
const B = 'b' as ConnectionId;
const C = 'c' as ConnectionId;
const META = { source: 'prometheus', approximate: false } as const;

const limits = (over: Partial<Parameters<typeof createHotStore>[0]> = {}) => ({
  ringPoints: 100,
  maxQueueSeries: 10,
  maxBrokers: 64,
  ...over,
});

const queueSeries = (
  name: string,
  metric: SeriesParts['metric'],
): SeriesParts => ({
  metric,
  vhost: '/',
  queue: name,
});

describe('hot store', () => {
  it('AC-14 a series keeps its newest points and counts the ones it evicted', () => {
    const store = createHotStore(limits({ ringPoints: 100 }));
    const parts: SeriesParts = { metric: 'messages' };
    for (let t = 1; t <= 1_000; t++) {
      expect(store.append(A, parts, META, { t, v: t * 2 })).toBe(true);
    }
    const series = store.read(A, parts);
    expect(series?.points).toHaveLength(100);
    expect(series?.points[0]).toEqual({ t: 901, v: 1802 });
    expect(series?.points.at(-1)).toEqual({ t: 1_000, v: 2000 });
    expect(series?.dropped).toBe(900);
    expect(store.status(A)).toMatchObject({
      series: 1,
      droppedPoints: 900,
      droppedSeries: 0,
      newest: 1_000,
    });
    // Unknown series and unknown brokers are absent, not empty.
    expect(store.read(A, { metric: 'channels' })).toBeUndefined();
    expect(store.read(B, parts)).toBeUndefined();
    expect(store.status(B).series).toBe(0);
  });

  it('AC-14 past the queue-series cap the lowest backlogs leave, pinned queues and node series stay', () => {
    const store = createHotStore(limits({ maxQueueSeries: 10 }));
    store.append(A, { metric: 'messages' }, META, { t: 1, v: 5 });
    store.append(A, { metric: 'memory_bytes', node: 'rabbit@n1' }, META, {
      t: 1,
      v: 9,
    });
    store.pin(A, [{ vhost: '/', name: 'q00' }]);
    // 30 queues of two series each: 60 queue series against a cap of 10.
    for (let i = 0; i < 30; i++) {
      const name = `q${String(i).padStart(2, '0')}`;
      store.append(A, queueSeries(name, 'queue_messages'), META, {
        t: 2,
        v: i,
      });
      store.append(A, queueSeries(name, 'queue_messages_ready'), META, {
        t: 2,
        v: i,
      });
    }
    // A round may overshoot the cap while it runs, but never double it for unpinned queues.
    expect(store.status(A).queueSeries).toBeLessThanOrEqual(20);
    const midRoundRefusals = store.status(A).droppedSeries;
    expect(midRoundRefusals).toBeGreaterThan(0);

    store.endRound(A);
    const status = store.status(A);
    expect(status.queueSeries).toBeLessThanOrEqual(10);
    // The pinned queue q00 has the lowest backlog and is kept; the rest are the highest backlogs
    // among the ones that got in.
    expect(store.read(A, queueSeries('q00', 'queue_messages'))).toBeDefined();
    const kept = store
      .latest(
        A,
        (info) =>
          info.def.scope === 'queue' && info.parts.metric === 'queue_messages',
      )
      .map((entry) => entry.info.parts.queue)
      .sort();
    expect(kept.length).toBe(5);
    expect(kept).toContain('q00');
    // Evicted queues are gone whole, never half a queue.
    for (const name of kept) {
      expect(
        store.read(A, queueSeries(name ?? '', 'queue_messages_ready')),
      ).toBeDefined();
    }
    // Cluster and node series are never touched by the cap.
    expect(store.read(A, { metric: 'messages' })).toBeDefined();
    expect(
      store.read(A, { metric: 'memory_bytes', node: 'rabbit@n1' }),
    ).toBeDefined();
    // Counted, never silent (I-13).
    expect(status.droppedSeries).toBeGreaterThanOrEqual(60 - 10);
  });

  it('AC-14 a pinned queue is admitted even when a round is over the hard guard', () => {
    const store = createHotStore(limits({ maxQueueSeries: 2 }));
    for (let i = 0; i < 4; i++) {
      store.append(A, queueSeries(`q${String(i)}`, 'queue_messages'), META, {
        t: 1,
        v: i,
      });
    }
    expect(
      store.append(A, queueSeries('late', 'queue_messages'), META, {
        t: 1,
        v: 0,
      }),
    ).toBe(false);
    store.pin(A, [{ vhost: '/', name: 'late' }]);
    expect(
      store.append(A, queueSeries('late', 'queue_messages'), META, {
        t: 1,
        v: 0,
      }),
    ).toBe(true);
    store.endRound(A);
    expect(store.read(A, queueSeries('late', 'queue_messages'))).toBeDefined();
  });

  it('AC-14 at most maxBrokers brokers are held, the least recently used goes first', () => {
    const store = createHotStore(limits({ maxBrokers: 2 }));
    store.append(A, { metric: 'messages' }, META, { t: 1, v: 1 });
    store.append(B, { metric: 'messages' }, META, { t: 1, v: 2 });
    // Reading A makes B the least recently used.
    store.read(A, { metric: 'messages' });
    store.append(C, { metric: 'messages' }, META, { t: 1, v: 3 });
    expect(store.brokers).toBe(2);
    expect(store.brokersEvicted).toBe(1);
    expect(store.read(B, { metric: 'messages' })).toBeUndefined();
    expect(store.read(A, { metric: 'messages' })).toBeDefined();
    store.forget(A);
    expect(store.read(A, { metric: 'messages' })).toBeUndefined();
  });

  it('AC-14 the source of a series follows its newest point, and latest reads the newest of each', () => {
    const store = createHotStore(limits());
    const parts: SeriesParts = { metric: 'messages' };
    store.append(A, parts, META, { t: 1, v: 1 });
    store.append(
      A,
      parts,
      { source: 'management', approximate: true },
      { t: 2, v: 2 },
    );
    const series = store.read(A, parts);
    expect(series?.info).toMatchObject({
      source: 'management',
      approximate: true,
    });
    expect(store.latest(A).map((entry) => entry.point)).toEqual([
      { t: 2, v: 2 },
    ]);
    expect(seriesKey(parts)).not.toBe(
      seriesKey({ metric: 'messages', node: 'n' }),
    );
  });
});
