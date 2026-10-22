import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { atOrBefore, nearestIndex, stepCursor } from './pick';

const pts = (...ts: number[]): { t: number; v: number }[] =>
  ts.map((t) => ({ t, v: t }));

describe('M1-54 picking', () => {
  it('AC-5 the nearest point and the point at or before a time are found by binary search', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 10_000 }), {
          minLength: 1,
          maxLength: 60,
        }),
        fc.integer({ min: -100, max: 10_100 }),
        (times, t) => {
          const points = pts(...[...times].sort((a, b) => a - b));
          const near = nearestIndex(points, t);
          const best = Math.min(...points.map((p) => Math.abs(p.t - t)));
          expect(Math.abs((points[near]?.t ?? NaN) - t)).toBe(best);
          // A tie goes to the earlier point.
          const tie = points.findIndex((p) => Math.abs(p.t - t) === best);
          expect(near).toBe(tie);
          const before = atOrBefore(points, t);
          expect(before).toBe(points.filter((p) => p.t <= t).length - 1);
        },
      ),
      { numRuns: 200 },
    );
    expect(nearestIndex([], 5)).toBe(-1);
    expect(nearestIndex(pts(1), Number.NaN)).toBe(-1);
    expect(atOrBefore([], 5)).toBe(-1);
    expect(atOrBefore(pts(10, 20), 5)).toBe(-1);
  });

  it('AC-5 the cursor steps by key, clamps at the ends, starts on the newest point and clears on Escape', () => {
    expect(stepCursor(null, 'ArrowLeft', 5)).toBe(4);
    expect(stepCursor(null, 'Home', 5)).toBe(0);
    expect(stepCursor(2, 'ArrowLeft', 5)).toBe(1);
    expect(stepCursor(2, 'ArrowRight', 5)).toBe(3);
    expect(stepCursor(0, 'ArrowLeft', 5)).toBe(0);
    expect(stepCursor(4, 'ArrowRight', 5)).toBe(4);
    expect(stepCursor(30, 'PageUp', 100)).toBe(20);
    expect(stepCursor(30, 'PageDown', 100)).toBe(40);
    expect(stepCursor(3, 'PageUp', 100)).toBe(0);
    expect(stepCursor(3, 'End', 100)).toBe(99);
    expect(stepCursor(3, 'Escape', 100)).toBeNull();
    expect(stepCursor(3, 'a', 100)).toBeUndefined();
    expect(stepCursor(3, 'Enter', 100)).toBeUndefined();
    // No points: there is nowhere to go.
    expect(stepCursor(null, 'End', 0)).toBeNull();
  });
});
