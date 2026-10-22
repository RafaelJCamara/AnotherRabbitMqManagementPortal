import { describe, expect, it } from 'vitest';

import { counterRate, drainEtaFromRates, ewma } from './rate.ts';

const T0 = 1_760_000_000_000;

describe('counterRate', () => {
  it('AC-4 counters are turned into rates across a reset', () => {
    const rates = counterRate([
      { t: T0, v: 100 },
      { t: T0 + 10_000, v: 150 },
      { t: T0 + 20_000, v: 250 },
      // The broker restarted: the counter fell. The interval is skipped, not negative.
      { t: T0 + 30_000, v: 20 },
      { t: T0 + 40_000, v: 70 },
    ]);
    expect(rates).toEqual([
      { t: T0 + 10_000, v: 5 },
      { t: T0 + 20_000, v: 10 },
      { t: T0 + 40_000, v: 5 },
    ]);
    expect(rates.every((point) => point.v >= 0)).toBe(true);
  });

  it('AC-4 gaps, repeated and unordered samples are handled, not joined', () => {
    const rates = counterRate(
      [
        { t: T0 + 20_000, v: 40 },
        { t: T0, v: 0 },
        { t: T0 + 10_000, v: 20 },
        { t: T0 + 10_000, v: 20 },
        { t: T0 + 300_000, v: 640 },
      ],
      { maxGapMs: 60_000 },
    );
    expect(rates).toEqual([
      { t: T0 + 10_000, v: 2 },
      { t: T0 + 20_000, v: 2 },
    ]);
    expect(counterRate([])).toEqual([]);
    expect(counterRate([{ t: T0, v: 1 }])).toEqual([]);
  });
});

describe('ewma', () => {
  it('AC-4 weighs by elapsed time, so an old sample counts half after one half-life', () => {
    expect(ewma([], 1_000)).toBeUndefined();
    expect(ewma([{ t: T0, v: 8 }], 1_000)).toBe(8);
    // One half-life later the new value weighs 0.5: the average is the midpoint.
    expect(
      ewma(
        [
          { t: T0, v: 0 },
          { t: T0 + 1_000, v: 10 },
        ],
        1_000,
      ),
    ).toBeCloseTo(5, 10);
    // Evenly spaced and uneven sampling of one level give that level.
    expect(
      ewma(
        [
          { t: T0, v: 4 },
          { t: T0 + 700, v: 4 },
          { t: T0 + 5_000, v: 4 },
        ],
        1_000,
      ),
    ).toBeCloseTo(4, 10);
    expect(() => ewma([], 0)).toThrow(RangeError);
  });
});

describe('drainEtaFromRates', () => {
  it('AC-3 backlog over net outflow, and the states around it', () => {
    expect(drainEtaFromRates(1_000, 10, 20)).toEqual({
      state: 'ok',
      etaMs: 100_000,
    });
    expect(drainEtaFromRates(0, 10, 20)).toEqual({ state: 'reached' });
    expect(drainEtaFromRates(1_000, 20, 20)).toEqual({ state: 'moving-away' });
    expect(drainEtaFromRates(1_000, 30, 20)).toEqual({ state: 'moving-away' });
    expect(() => drainEtaFromRates(1_000, -1, 20)).toThrow(RangeError);
    expect(() => drainEtaFromRates(Number.NaN, 1, 2)).toThrow(RangeError);
  });
});
