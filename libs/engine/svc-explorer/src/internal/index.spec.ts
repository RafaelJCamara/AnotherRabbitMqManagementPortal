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
