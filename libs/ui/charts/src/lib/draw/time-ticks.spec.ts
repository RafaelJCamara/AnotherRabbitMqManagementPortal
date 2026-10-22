import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TIME_STEPS_MS, timeStep, timeTicks } from './time-ticks';

const DAY = 86_400_000;

describe('M1-54 time ticks', () => {
  it('AC-2 time ticks are aligned to a round step', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
        fc.integer({ min: 1000, max: 30 * DAY }),
        fc.integer({ min: 3, max: 10 }),
        (from, span, count) => {
          const to = from + span;
          const step = timeStep(span, count);
          expect(TIME_STEPS_MS).toContain(step);
          const ticks = timeTicks(from, to, count);
          expect(ticks.length).toBeLessThanOrEqual(count + 1);
          for (let i = 0; i < ticks.length; i++) {
            const tick = ticks[i] ?? NaN;
            expect(tick).toBeGreaterThanOrEqual(from);
            expect(tick).toBeLessThanOrEqual(to);
            expect(tick % step).toBe(0);
            if (i > 0) expect(tick - (ticks[i - 1] ?? NaN)).toBe(step);
          }
          // The step is the smallest that fits: the next smaller one would give too many intervals.
          const smaller = TIME_STEPS_MS[TIME_STEPS_MS.indexOf(step) - 1];
          if (smaller !== undefined)
            expect(span / smaller).toBeGreaterThan(count);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('AC-2 an empty or non-finite range has no ticks, and a huge one still gets a step', () => {
    expect(timeTicks(10, 10, 4)).toEqual([]);
    expect(timeTicks(10, 5, 4)).toEqual([]);
    expect(timeTicks(Number.NaN, 5, 4)).toEqual([]);
    expect(timeTicks(0, Infinity, 4)).toEqual([]);
    expect(timeStep(400 * DAY, 4) % (30 * DAY)).toBe(0);
    expect(timeTicks(0, 3_600_000, 6)).toHaveLength(7); // ten minutes each, both ends
  });
});
