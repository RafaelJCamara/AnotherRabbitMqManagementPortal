import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { downsample, type Point } from './downsample';

const series = fc
  .array(
    fc.record({
      dt: fc.integer({ min: 1, max: 1000 }),
      v: fc.integer({ min: -1000, max: 1000 }),
    }),
    { minLength: 0, maxLength: 3000 },
  )
  .map((steps) => {
    let t = 1_000_000;
    return steps.map((s): Point => ({ t: (t += s.dt), v: s.v }));
  });

describe('M1-54 downsample', () => {
  it('AC-3 M4 downsampling is bounded, ordered and keeps every extreme', () => {
    fc.assert(
      fc.property(
        series,
        fc.integer({ min: 1, max: 120 }),
        (points, columns) => {
          const from = points[0]?.t ?? 0;
          const to = points.at(-1)?.t ?? 1;
          const out = downsample(points, from, to, columns);
          expect(out.length).toBeLessThanOrEqual(Math.max(columns * 4, 0) || 4);
          // A subsequence of the input, in time order.
          let at = -1;
          for (const point of out) {
            const found = points.indexOf(point, at + 1);
            expect(found).toBeGreaterThan(at);
            at = found;
          }
          if (points.length > 0) {
            const values = points.map((p) => p.v);
            const outValues = out.map((p) => p.v);
            // The extremes and both ends survive.
            expect(Math.max(...outValues)).toBe(Math.max(...values));
            expect(Math.min(...outValues)).toBe(Math.min(...values));
            expect(out[0]).toBe(points[0]);
            expect(out.at(-1)).toBe(points.at(-1));
          } else {
            expect(out).toEqual([]);
          }
          // With room to spare nothing is reduced.
          if (points.length <= columns * 4) expect(out).toEqual(points);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('AC-3 a spike inside a column is kept, points outside the window and non-finite points are dropped', () => {
    const points: Point[] = Array.from({ length: 1000 }, (_, i) => ({
      t: i * 10,
      v: i === 500 ? 9999 : 1,
    }));
    const out = downsample(points, 0, 9990, 10);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.some((p) => p.v === 9999)).toBe(true);
    const windowed = downsample(points, 1000, 2000, 500);
    expect(windowed.every((p) => p.t >= 1000 && p.t <= 2000)).toBe(true);
    const dirty = downsample(
      [
        { t: 1, v: 1 },
        { t: 2, v: Number.NaN },
        { t: Infinity, v: 3 },
        { t: 3, v: Infinity },
        { t: 4, v: 4 },
      ],
      0,
      10,
      10,
    );
    expect(dirty).toEqual([
      { t: 1, v: 1 },
      { t: 4, v: 4 },
    ]);
    // A zero-width time window with many points at one instant still terminates and is bounded.
    const same = Array.from({ length: 50 }, (_, i) => ({ t: 5, v: i }));
    expect(downsample(same, 5, 5, 2).length).toBeLessThanOrEqual(8);
  });
});
