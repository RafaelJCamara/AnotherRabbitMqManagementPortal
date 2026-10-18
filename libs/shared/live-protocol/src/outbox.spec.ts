import type { Qos } from '@app/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createOutbox,
  type Outbox,
  type OutboxOptions,
  type Take,
} from './outbox.ts';

const BIG = 1_000_000;

function options(extra: Partial<OutboxOptions> = {}): OutboxOptions {
  return { bounds: { items: 4, bytes: 100 }, maxFrameBytes: 50, ...extra };
}

function put(
  box: Outbox<Qos, number>,
  value: number,
  bytes = 1,
  key?: string,
): void {
  box.push({ value, bytes }, key, BIG);
}

function drainAll<T>(box: Outbox<Qos, T>, now = 0): Take<T>[] {
  const out: Take<T>[] = [];
  for (let t = box.take(now); t !== null; t = box.take(now)) out.push(t);
  return out;
}

describe('lossless outbox', () => {
  it('delivers in order with consecutive seqs and never reorders', () => {
    const box = createOutbox<number>('lossless', options());
    [1, 2, 3].forEach((v) => {
      put(box, v);
    });
    expect(drainAll(box)).toEqual([{ kind: 'data', seq: 3, items: [1, 2, 3] }]);
    expect(box.take(0)).toBeNull();
    expect(box.readyAt(0)).toBeNull();
  });

  it('splits frames at the frame byte limit', () => {
    const roomy = createOutbox<number>(
      'lossless',
      options({ maxFrameBytes: 10, bounds: { items: 10, bytes: 100 } }),
    );
    [1, 2, 3, 4, 5].forEach((v) => {
      put(roomy, v, 4);
    });
    expect(drainAll(roomy)).toEqual([
      { kind: 'data', seq: 2, items: [1, 2] },
      { kind: 'data', seq: 4, items: [3, 4] },
      { kind: 'data', seq: 5, items: [5] },
    ]);
  });

  it('overflow becomes a gap over every undelivered seq, then a snapshot, and counts the loss', () => {
    const box = createOutbox<number>('lossless', options());
    put(box, 1);
    expect(drainAll(box)).toHaveLength(1);
    for (let v = 2; v <= 8; v++) put(box, v);
    expect(box.dropped).toBe(7);
    expect(box.readyAt(0)).toBe(0);
    expect(drainAll(box)).toEqual([
      {
        kind: 'snapshot',
        seq: 8,
        gap: { fromSeq: 2, toSeq: 8, reason: 'overflow' },
      },
    ]);
    // Delivery continues right after the snapshot.
    put(box, 9);
    expect(drainAll(box)).toEqual([{ kind: 'data', seq: 9, items: [9] }]);
  });

  it('keeps delivered items for resume and evicts them first, without a gap', () => {
    const box = createOutbox<number>('lossless', options());
    for (let v = 1; v <= 4; v++) put(box, v);
    drainAll(box);
    put(box, 5);
    expect(box.items).toBe(4);
    expect(drainAll(box)).toEqual([{ kind: 'data', seq: 5, items: [5] }]);
    expect(box.dropped).toBe(0);
  });

  it('treats an item larger than a frame as an overflow', () => {
    const box = createOutbox<number>(
      'lossless',
      options({ maxFrameBytes: 10 }),
    );
    put(box, 1, 11);
    expect(drainAll(box)).toEqual([
      {
        kind: 'snapshot',
        seq: 1,
        gap: { fromSeq: 1, toSeq: 1, reason: 'overflow' },
      },
    ]);
  });

  it('holds back items when the session budget is smaller than the outbox bound', () => {
    const box = createOutbox<number>('lossless', options());
    box.push({ value: 1, bytes: 10 }, undefined, 5);
    expect(box.dropped).toBe(1);
    expect(box.bytes).toBe(0);
  });

  it('rewinds to what the client missed, or reports that it cannot', () => {
    const box = createOutbox<number>('lossless', options());
    for (let v = 1; v <= 4; v++) put(box, v);
    drainAll(box);
    expect(box.rewind(4)).toBe(true);
    expect(box.take(0)).toBeNull();
    expect(box.rewind(2)).toBe(true);
    expect(drainAll(box)).toEqual([{ kind: 'data', seq: 4, items: [3, 4] }]);
    expect(box.rewind(0)).toBe(true);
    expect(drainAll(box)).toEqual([
      { kind: 'data', seq: 4, items: [1, 2, 3, 4] },
    ]);
    expect(box.rewind(9)).toBe(false);
    put(box, 5);
    drainAll(box);
    // seq 1 was evicted to make room for 5, so a client that stopped at 0 cannot continue.
    expect(box.rewind(0)).toBe(false);
    expect(box.rewind(1)).toBe(true);
  });

  it('refuses removals', () => {
    expect(() => {
      createOutbox<number>('lossless', options()).remove('k', BIG);
    }).toThrow(RangeError);
  });
});

describe('latest outbox', () => {
  it('coalesces by key and sends the newest value per key in update order', () => {
    const box = createOutbox<number>('latest', options());
    put(box, 1, 1, 'a');
    put(box, 2, 1, 'b');
    put(box, 3, 1, 'a');
    expect(box.items).toBe(2);
    expect(drainAll(box)).toEqual([{ kind: 'data', seq: 3, items: [2, 3] }]);
    expect(box.dropped).toBe(0);
  });

  it('drops the oldest key when full and reports the count once', () => {
    const box = createOutbox<number>(
      'latest',
      options({ bounds: { items: 2, bytes: 100 } }),
    );
    put(box, 1, 1, 'a');
    put(box, 2, 1, 'b');
    put(box, 3, 1, 'c');
    expect(drainAll(box)).toEqual([
      { kind: 'data', seq: 3, items: [2, 3], dropped: 1 },
    ]);
    put(box, 4, 1, 'a');
    expect(drainAll(box)).toEqual([{ kind: 'data', seq: 4, items: [4] }]);
    expect(box.dropped).toBe(1);
  });

  it('counts an item that can never fit', () => {
    const box = createOutbox<number>('latest', options({ maxFrameBytes: 10 }));
    put(box, 1, 11, 'a');
    put(box, 2, 1, 'a');
    expect(drainAll(box)).toEqual([
      { kind: 'data', seq: 2, items: [2], dropped: 1 },
    ]);
  });

  it('snapshot-delta starts with a snapshot, then sends deltas', () => {
    const box = createOutbox<number>(
      'latest',
      options({ flow: 'snapshot-delta' }),
    );
    expect(drainAll(box)).toEqual([{ kind: 'snapshot', seq: 0 }]);
    put(box, 1, 1, 'a');
    put(box, 2, 1, 'b');
    box.remove('a', BIG);
    put(box, 3, 1, 'c');
    expect(drainAll(box)).toEqual([
      { kind: 'delta', seq: 4, upserts: [2, 3], removes: ['a'] },
    ]);
    // An upsert after a removal wins, and the other way round.
    box.remove('b', BIG);
    put(box, 9, 1, 'b');
    expect(drainAll(box)).toEqual([
      { kind: 'delta', seq: 6, upserts: [9], removes: [] },
    ]);
  });

  it('snapshot-delta overflow is a gap then a snapshot, never a silent drop', () => {
    const box = createOutbox<number>(
      'latest',
      options({ flow: 'snapshot-delta', bounds: { items: 2, bytes: 100 } }),
    );
    drainAll(box);
    put(box, 1, 1, 'a');
    drainAll(box);
    put(box, 2, 1, 'b');
    put(box, 3, 1, 'c');
    put(box, 4, 1, 'd');
    box.remove('a', BIG);
    expect(drainAll(box)).toEqual([
      {
        kind: 'snapshot',
        seq: 5,
        gap: { fromSeq: 2, toSeq: 5, reason: 'overflow' },
      },
    ]);
  });

  it('refuses removals on credit flow', () => {
    expect(() => {
      createOutbox<number>('latest', options()).remove('a', BIG);
    }).toThrow(RangeError);
  });

  it('splits a large delta at the frame limit and keeps the rest', () => {
    const box = createOutbox<number>(
      'latest',
      options({
        flow: 'snapshot-delta',
        maxFrameBytes: 4,
        bounds: { items: 10, bytes: 100 },
      }),
    );
    drainAll(box);
    for (const [i, key] of ['a', 'b', 'c'].entries()) put(box, i, 2, key);
    expect(drainAll(box)).toEqual([
      { kind: 'delta', seq: 2, upserts: [0, 1], removes: [] },
      { kind: 'delta', seq: 3, upserts: [2], removes: [] },
    ]);
  });
});

describe('sampled outbox', () => {
  it('keeps every n-th item and announces n', () => {
    const box = createOutbox<number>('sampled', options({ sampleEvery: 3 }));
    for (let v = 1; v <= 7; v++) put(box, v);
    expect(drainAll(box)).toEqual([
      { kind: 'data', seq: 7, items: [1, 4, 7], sampledEvery: 3 },
    ]);
  });

  it('drops the oldest when full and counts it', () => {
    const box = createOutbox<number>(
      'sampled',
      options({ bounds: { items: 2, bytes: 100 } }),
    );
    for (let v = 1; v <= 4; v++) put(box, v);
    expect(drainAll(box)).toEqual([
      { kind: 'data', seq: 4, items: [3, 4], dropped: 2 },
    ]);
    expect(box.dropped).toBe(2);
  });

  it('accounts for every offered item: delivered + dropped + skipped = offered', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.integer({ min: 1, max: 30 }), { maxLength: 60 }),
        (every, maxItems, sizes) => {
          const box = createOutbox<number>(
            'sampled',
            options({
              sampleEvery: every,
              bounds: { items: maxItems, bytes: 40 },
              maxFrameBytes: 25,
            }),
          );
          let delivered = 0;
          let reported = 0;
          sizes.forEach((bytes, i) => {
            put(box, i, bytes);
            if (i % 7 === 6) {
              for (const take of drainAll(box)) {
                if (take.kind !== 'data') throw new Error('data only');
                delivered += take.items.length;
                reported += take.dropped ?? 0;
              }
            }
          });
          for (const take of drainAll(box)) {
            if (take.kind !== 'data') throw new Error('data only');
            delivered += take.items.length;
            reported += take.dropped ?? 0;
          }
          const kept = Math.ceil(sizes.length / every);
          expect(delivered + box.dropped).toBe(kept);
          expect(reported).toBeLessThanOrEqual(box.dropped);
          expect(box.items).toBe(0);
        },
      ),
    );
  });
});

describe('pacing', () => {
  it('spaces frames at least 1000 / maxHz apart and ends on the newest value', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(fc.integer({ min: 0, max: 400 }), {
          minLength: 1,
          maxLength: 80,
        }),
        (maxHz, gaps) => {
          const box = createOutbox<number>('latest', options({ maxHz }));
          let now = 0;
          const emitted: number[] = [];
          const values: number[] = [];
          const pump = (): void => {
            for (const take of drainAll(box, now)) {
              if (take.kind !== 'data') throw new Error('data only');
              emitted.push(now);
              values.push(...take.items);
            }
          };
          gaps.forEach((gap, i) => {
            now += gap;
            put(box, i, 1, 'k');
            pump();
          });
          while (box.readyAt(now) !== null) {
            now = box.readyAt(now) ?? now;
            pump();
          }
          emitted.slice(1).forEach((at, i) => {
            expect(at - (emitted[i] ?? 0)).toBeGreaterThanOrEqual(
              1000 / maxHz - 1e-9,
            );
          });
          expect(values).toEqual([...values].sort((a, b) => a - b));
          expect(new Set(values).size).toBe(values.length);
          expect(values.at(-1)).toBe(gaps.length - 1);
        },
      ),
    );
  });
});

describe('construction', () => {
  it('rejects unbounded or nonsensical bounds', () => {
    expect(() =>
      createOutbox('lossless', options({ bounds: { items: 0, bytes: 1 } })),
    ).toThrow(RangeError);
    expect(() => createOutbox('latest', options({ maxHz: 0 }))).toThrow(
      RangeError,
    );
    expect(() => createOutbox('sampled', options({ sampleEvery: 0 }))).toThrow(
      RangeError,
    );
  });
});
