// The counter reading is written from the fact sheet (b.1), not from the era broker or a projection.
import { describe, expect, it } from 'vitest';

import { counterDeltas, countersOf, type CounterHeaders } from './counters.ts';

const headers = (dc: number | null, ac: number | null): CounterHeaders => ({
  'x-delivery-count': dc,
  'x-acquired-count': ac,
});
const NONE = headers(null, null);

describe('counterDeltas', () => {
  it('AC-3 each era reads the counter headers as the fact sheet b.1 says', () => {
    // One return: the first delivery sends no counter, the second shows what the era shows.
    expect(counterDeltas('4.3', NONE, headers(0, 1))).toStrictEqual({
      deltaAC: 1,
      deltaDC: 0,
    });
    // 4.0 to 4.2: x-delivery-count IS the acquired count, and the delivery count is not shown.
    expect(counterDeltas('4.0-4.2', NONE, headers(1, null))).toStrictEqual({
      deltaAC: 1,
    });
    // 3.13: x-delivery-count is the delivery count, and there is no acquired count.
    expect(counterDeltas('3.13', NONE, headers(1, null))).toStrictEqual({
      deltaDC: 1,
    });

    // Swapping the two headers on 4.3 moves the deltas to the other counter.
    expect(counterDeltas('4.3', NONE, headers(1, 0))).toStrictEqual({
      deltaAC: 0,
      deltaDC: 1,
    });
    // A header an era does not use is ignored, never inferred into the other counter.
    expect(counterDeltas('4.0-4.2', NONE, headers(1, 5))).toStrictEqual({
      deltaAC: 1,
    });
    expect(counterDeltas('3.13', NONE, headers(1, 5))).toStrictEqual({
      deltaDC: 1,
    });

    // An era it does not know, and names that only exist on Object.prototype: null.
    for (const era of ['5.0', '', '4.3.6', 'constructor', 'toString']) {
      expect(counterDeltas(era, NONE, headers(1, 1)), era).toBeNull();
    }

    // Across two queues a header that one side does not send says nothing (never a 0).
    expect(
      counterDeltas('4.3', headers(0, 1), headers(null, 2), 'both-present'),
    ).toStrictEqual({ deltaAC: 1 });
    expect(
      counterDeltas('3.13', headers(1, null), NONE, 'both-present'),
    ).toStrictEqual({});
    expect(counterDeltas('4.3', headers(0, 1), headers(null, 2))).toStrictEqual(
      { deltaAC: 1, deltaDC: 0 },
    );

    // Anything but a number is "the broker sent none".
    expect(
      countersOf({ 'x-delivery-count': '1', 'x-acquired-count': undefined }),
    ).toStrictEqual(NONE);
  });
});
