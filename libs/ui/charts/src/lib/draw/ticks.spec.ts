import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { niceStep, niceTicks } from './ticks';

const isNice = (step: number): boolean => {
  const exponent = Math.floor(Math.log10(step));
  const mantissa = Number((step / 10 ** exponent).toPrecision(9));
  return [1, 2, 5, 10].includes(mantissa);
};

const range = fc
  .tuple(
    fc.double({ min: -1e9, max: 1e9, noNaN: true }),
    fc.double({ min: 0, max: 1e9, noNaN: true }),
  )
  .map(([low, span]) => [low, low + span] as const);

describe('M1-54 ticks', () => {
  it('AC-1 nice ticks cover the range with 1-2-5 steps', () => {
    fc.assert(
      fc.property(
        range,
        fc.integer({ min: 1, max: 10 }),
        ([min, max], count) => {
          const { ticks, step } = niceTicks(min, max, count);
          expect(ticks.length).toBeGreaterThanOrEqual(2);
          expect(ticks.length).toBeLessThanOrEqual(count + 2);
          expect(isNice(step)).toBe(true);
          const tolerance = step * 1e-4;
          // Covers the data.
          expect(ticks[0] ?? NaN).toBeLessThanOrEqual(min + tolerance);
          expect(ticks.at(-1) ?? NaN).toBeGreaterThanOrEqual(max - tolerance);
          // Ascending and equally spaced.
          for (let i = 1; i < ticks.length; i++) {
            const gap = (ticks[i] ?? NaN) - (ticks[i - 1] ?? NaN);
            expect(gap).toBeGreaterThan(0);
            expect(Math.abs(gap - step)).toBeLessThanOrEqual(step * 1e-4);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('AC-1 a flat range, an empty range and junk never give a zero-height axis', () => {
    expect(niceTicks(0, 0, 4)).toMatchObject({ min: 0, max: 1 });
    const flat = niceTicks(500, 500, 4);
    expect(flat.min).toBeLessThan(500);
    expect(flat.max).toBeGreaterThan(500);
    const negative = niceTicks(-20, -20, 4);
    expect(negative.min).toBeLessThan(negative.max);
    // Swapped bounds, NaN and Infinity are read as a range, not thrown on.
    expect(niceTicks(10, 0, 4).ticks).toEqual(niceTicks(0, 10, 4).ticks);
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const junk = niceTicks(bad, bad, 4);
      expect(junk.max).toBeGreaterThan(junk.min);
      expect(junk.ticks.every(Number.isFinite)).toBe(true);
    }
    expect(niceTicks(0, 100, 4).ticks).toEqual([0, 50, 100]);
    expect(niceTicks(0, 0.3, 3).ticks).toEqual([0, 0.1, 0.2, 0.3]);
    expect(niceStep(0.7)).toBe(1);
    expect(niceStep(2.1)).toBe(5);
    expect(niceStep(5.1)).toBe(10);
  });
});
