// The cooperative helpers (I-5): same results as a plain loop and a plain sort, and the event loop is
// given a turn at counted intervals. Counted per item and per comparison, never timed.
import { describe, expect, it } from 'vitest';

import { forEachCooperative, sortCooperative } from './cooperative';

/** A repeatable stream of numbers (an LCG), so a failing case can be replayed. */
function numbers(count: number, modulo: number, seed = 7): number[] {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % modulo;
  });
}

describe('explorer cooperative work', () => {
  it('M0-48 explorer forEachCooperative gives the loop a turn every N items and keeps the order', async () => {
    const seen: number[] = [];
    let yields = 0;
    let widest = 0;
    let since = 0;
    const items = Array.from({ length: 10_500 }, (_, i) => i);

    await forEachCooperative(
      items,
      (item) => {
        seen.push(item);
        since++;
        widest = Math.max(widest, since);
      },
      1_000,
      () => {
        yields++;
        since = 0;
        return Promise.resolve();
      },
    );

    expect(seen).toEqual(items);
    // Ten full chunks, each followed by a turn; the tail of 500 needs none after it.
    expect(yields).toBe(10);
    expect(widest).toBe(1_000);
    // The yield count follows the size of the list, and a list that fits one chunk never yields.
    let longer = 0;
    await forEachCooperative(
      Array.from({ length: 21_000 }, (_, i) => i),
      () => undefined,
      1_000,
      () => {
        longer++;
        return Promise.resolve();
      },
    );
    expect(longer).toBe(20);
    let none = 0;
    await forEachCooperative(
      [1, 2, 3],
      () => undefined,
      3,
      () => {
        none++;
        return Promise.resolve();
      },
    );
    expect(none).toBe(0);
    // A throw ends the walk where it happens.
    let visited = 0;
    await expect(
      forEachCooperative(
        items,
        () => {
          if (++visited === 2_500) throw new Error('stop');
        },
        1_000,
        () => Promise.resolve(),
      ),
    ).rejects.toThrow('stop');
    expect(visited).toBe(2_500);
  });

  it('M0-48 explorer sortCooperative gives the result of a plain stable sort', async () => {
    const compare = (a: { v: number }, b: { v: number }) => a.v - b.v;
    for (const [count, every] of [
      [0, 1_000],
      [1, 1_000],
      [999, 1_000],
      [1_000, 1_000],
      [1_001, 1_000],
      [6_500, 1_000],
      [5_000, 7],
      [313, 1],
    ] as const) {
      // Many equal values, so the order of equals (the original order) is part of the answer.
      const items = numbers(count, 50).map((v, index) => ({ v, index }));
      const want = [...items].sort(compare);

      const got = await sortCooperative(items, compare, every, () =>
        Promise.resolve(),
      );

      expect(got, `${String(count)} items every ${String(every)}`).toEqual(
        want,
      );
    }
    // The input is not touched.
    const input = [3, 1, 2];
    await sortCooperative(
      input,
      (a, b) => a - b,
      1,
      () => Promise.resolve(),
    );
    expect(input).toEqual([3, 1, 2]);
  });

  it('M0-48 explorer sortCooperative never compares more than a chunk sort between two turns', async () => {
    const measure = async (count: number, every: number) => {
      let compares = 0;
      let widest = 0;
      let yields = 0;
      await sortCooperative(
        numbers(count, 1_000_000, 11),
        (a, b) => {
          compares++;
          widest = Math.max(widest, compares);
          return a - b;
        },
        every,
        () => {
          yields++;
          compares = 0;
          return Promise.resolve();
        },
      );
      return { widest, yields };
    };

    const small = await measure(20_000, 1_000);
    const large = await measure(40_000, 1_000);

    // Between two turns: one run sorted whole (about N log N comparisons) or N merge steps; one
    // plain sort of 20,000 items takes about 280,000 comparisons without a turn.
    const bound = 1_000 * Math.ceil(Math.log2(1_000)) + 1_000;
    expect(small.widest).toBeLessThanOrEqual(bound);
    expect(large.widest).toBeLessThanOrEqual(bound);
    // The turns grow with the list: a turn per run and a turn per 1,000 items written at each merge level.
    expect(small.yields).toBeGreaterThanOrEqual(20 + 20 * 3);
    expect(large.yields).toBeGreaterThan(small.yields * 2);
  });
});
