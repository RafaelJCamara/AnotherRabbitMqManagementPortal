import { describe, expect, it } from 'vitest';

import { createInventoryIndex, type IndexChange } from './index';
import { queueRow } from './rows';

const queues = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    queueRow({
      name: `q-${String(i).padStart(5, '0')}`,
      vhost: '/',
      messages: i,
    }),
  );
const roomy = { maxRowsPerConnection: 1_000, maxBytesPerConnection: 1 << 30 };
const meta = { sweptAt: 5, complete: true };
const all = { kind: 'queues', offset: 0, limit: 500 } as const;

describe('explorer index', () => {
  it('AC-2 explorer index is bounded and counts what it drops', () => {
    const index = createInventoryIndex(roomy);
    const version = index.install('queues', queues(1_500), meta);

    expect(index.stats).toMatchObject({ rows: 1_000, dropped: 500 });
    expect(version).toMatchObject({ dropped: 500, truncated: true });
    // The dropped rows are the ones past the cap in sweep order.
    expect(
      index.window({ ...all, offset: 995 }).rows.map((r) => r.name),
    ).toEqual(['q-00995', 'q-00996', 'q-00997', 'q-00998', 'q-00999']);
    // Another kind does not disturb it, and nothing more is dropped.
    index.install('exchanges', [], meta);
    expect(index.window(all)).toMatchObject({ total: 1_000, matched: 1_000 });
    expect(index.stats.dropped).toBe(500);

    // The byte cap drops too: 272 estimated bytes per row, so 11 of 25 fit in 3,000.
    const small = createInventoryIndex({
      ...roomy,
      maxBytesPerConnection: 3_000,
    });
    small.install('queues', queues(25), meta);
    expect(small.stats).toMatchObject({ rows: 11, dropped: 14 });
  });

  it('M0-48 explorer index keeps the first row of a key, counts the repeats and is never complete after one', () => {
    const index = createInventoryIndex(roomy);
    const everyKind = (queueRows: ReturnType<typeof queues>) =>
      index.installAll([
        { kind: 'queues', rows: queueRows, meta },
        { kind: 'exchanges', rows: [], meta },
        { kind: 'connections', rows: [], meta },
      ]);
    expect(everyKind(queues(3))).toMatchObject({
      complete: true,
      duplicates: 0,
    });

    // The pages moved under the read: q-00000 arrives again, with other counts, after q-00002.
    const again = queueRow({ name: 'q-00000', vhost: '/', messages: 4_242 });
    const version = everyKind([...queues(3), again]);

    const read = index.window(all);
    expect(read).toMatchObject({ total: 3, matched: 3 });
    expect(read.rows.map((r) => r.key)).toEqual([...new Set(read.rows.map((r) => r.key))]);
    // The first row wins, so the same read twice gives the same index.
    expect(read.rows.find((r) => r.name === 'q-00000')).toMatchObject({
      messages: 0,
    });
    expect(index.byKeys('queues', [again.key])).toHaveLength(1);
    // Counted, never silent (I-13), and the version is not claimed complete.
    expect(version).toMatchObject({ complete: false, duplicates: 1, dropped: 0 });
    expect(index.queueTotals()).toMatchObject({ complete: false, queues: 3 });
    expect(index.stats).toMatchObject({ rows: 3, dropped: 0, duplicates: 1 });

    // A clean read completes again; the counter keeps the history.
    expect(everyKind(queues(3))).toMatchObject({
      complete: true,
      duplicates: 0,
    });
    expect(index.stats.duplicates).toBe(1);

    // A repeat is not a drop: it takes no room from the rows behind it under the cap.
    const capped = createInventoryIndex(roomy);
    const full = queues(1_000);
    const crowded = capped.install(
      'queues',
      [...full.slice(0, 10), ...full.slice(0, 10), ...full.slice(10)],
      meta,
    );
    expect(crowded).toMatchObject({ dropped: 0, duplicates: 10 });
    expect(capped.window(all).total).toBe(1_000);
  });

  it('M0-48 explorer index retires the sorted copies of a version nobody can read and counts what it holds', () => {
    const index = createInventoryIndex(roomy);
    const byMessages = {
      ...all,
      sort: { column: 'messages', dir: 'desc' },
    } as const;
    const pinned = index.install('queues', queues(11), meta).version;
    index.window(byMessages);
    index.window(all);
    for (let n = 2; n <= 6; n++) {
      index.install('queues', queues(10 + n), meta);
      index.window(byMessages);
      index.window(all);
    }
    // Two sorts of the current version (16 rows) and of the previous one (15 rows): the copies of
    // versions 1 to 4 are gone, though the cache of 8 had room for them.
    expect(index.stats.sortCacheEntries).toBe(4);
    // Held beyond `bytes`: the previous version's 15 rows (272 bytes each) and 8 bytes a row in each copy.
    expect(index.stats.retainedBytes).toBe(15 * 272 + 2 * (16 + 15) * 8);
    expect(index.stats.bytes).toBe(16 * 272);
    // A pinned read of a retired version is answered from the current one and says so.
    expect(index.window({ ...all, version: pinned })).toMatchObject({
      versionChanged: true,
      total: 16,
    });
    // The next install retires the previous version's copies too, and the cache stays at the readable pair.
    index.install('queues', queues(17), meta);
    index.window(byMessages);
    expect(index.stats.sortCacheEntries).toBe(3);
  });

  it('M0-48 explorer index hasConsumers matches queues with a consumer count above zero only', () => {
    const index = createInventoryIndex(roomy);
    const queue = (name: string, consumers?: number) =>
      queueRow({ name, vhost: '/', ...(consumers === undefined ? {} : { consumers }) });
    index.install(
      'queues',
      [queue('a-none'), queue('b-idle', 0), queue('c-busy', 2)],
      meta,
    );
    const names = (hasConsumers: boolean) =>
      index.window({ ...all, filter: { hasConsumers } }).rows.map((r) => r.name);

    expect(names(true)).toEqual(['c-busy']);
    // A queue that did not report consumers matches neither answer.
    expect(names(false)).toEqual(['b-idle']);
  });

  it('explorer index orders by key on ties, pins a version and reports its changes', () => {
    const index = createInventoryIndex(roomy);
    const changes: IndexChange[] = [];
    index.subscribe((change) => changes.push(change));
    const pinned = index.install('queues', queues(10), meta).version;
    index.install('queues', queues(12), meta);

    expect(index.window({ ...all, version: pinned })).toMatchObject({
      matched: 10,
      versionChanged: false,
    });
    index.install('queues', queues(14).slice(2), meta);
    expect(index.window({ ...all, version: pinned })).toMatchObject({
      matched: 12,
      versionChanged: true,
    });
    const top = index.window({
      ...all,
      sort: { column: 'messages', dir: 'desc' },
      filter: { text: 'Q-000', minMessages: 11 },
    });
    expect(top.rows.map((r) => r.name)).toEqual([
      'q-00013',
      'q-00012',
      'q-00011',
    ]);
    expect(changes.at(-1)).toMatchObject({
      removes: [expect.any(String), expect.any(String)],
      upserts: [
        expect.anything(),
        expect.objectContaining({ name: 'q-00013' }),
      ],
      membershipChanged: true,
    });
  });
});
