import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Point } from './downsample';
import { areaOf, gapThreshold, pathOf, segments } from './path';
import { linearScale, symlog, yAxis, type YScaleKind } from './scales';

const KINDS: readonly YScaleKind[] = ['zero', 'fit', 'log'];
const identity = (n: number): number => n;

describe('M1-54 scales and paths', () => {
  it('AC-4 scales are monotone and paths break at gaps and never carry a non-finite number', () => {
    const data = fc.array(fc.integer({ min: -500, max: 100_000 }), {
      minLength: 1,
      maxLength: 40,
    });
    fc.assert(
      fc.property(data, fc.constantFrom(...KINDS), (values, kind) => {
        const min = Math.min(...values);
        const max = Math.max(...values);
        const axis = yAxis(kind, min, max, 100);
        // Every datum lands inside the plot, and a larger value is never drawn lower.
        const sorted = [...values].sort((a, b) => a - b);
        let before = Infinity;
        for (const value of sorted) {
          const y = axis.map(value);
          expect(Number.isFinite(y)).toBe(true);
          expect(y).toBeGreaterThanOrEqual(-1e-6);
          expect(y).toBeLessThanOrEqual(100 + 1e-6);
          expect(y).toBeLessThanOrEqual(before + 1e-9);
          before = y;
        }
        expect(axis.ticks.every(Number.isFinite)).toBe(true);
        expect(axis.max).toBeGreaterThanOrEqual(max);
        // A flat series has height on every scale.
        const flat = yAxis(kind, values[0] ?? 0, values[0] ?? 0, 100);
        expect(Number.isFinite(flat.map(values[0] ?? 0))).toBe(true);
      }),
      { numRuns: 200 },
    );
    // `zero` includes zero, `fit` does not have to, `log` draws zero and negatives.
    expect(yAxis('zero', 50, 100, 100).min).toBe(0);
    expect(yAxis('fit', 50, 100, 100).min).toBeGreaterThan(0);
    const log = yAxis('log', 0, 1000, 100);
    expect(log.map(0)).toBeCloseTo(100, 5);
    expect(log.map(1000)).toBeLessThan(log.map(10));
    expect(log.ticks).toEqual([0, 1, 10, 100, 1000]);
    expect(yAxis('log', -50, 50, 100).map(-50)).toBeGreaterThan(
      yAxis('log', -50, 50, 100).map(0),
    );
    expect(symlog(0)).toBe(0);
    expect(symlog(-9)).toBeCloseTo(-1, 9);
    expect(linearScale(5, 5, 0, 10)(5)).toBe(5);
    expect(yAxis('fit', Number.NaN, Number.NaN, 100).map(0)).not.toBeNaN();

    // Paths: one M per run, every finite point once, one decimal, no junk.
    const points: Point[] = [
      { t: 0, v: 1 },
      { t: 10, v: 2 },
      { t: 20, v: 3 },
      { t: 1000, v: 4 }, // a gap
      { t: 1010, v: Number.NaN },
      { t: 1020, v: 5 },
      { t: 1030, v: Infinity },
      { t: 2000, v: 6 }, // a lone point after another gap
    ];
    const gap = gapThreshold(points.filter((p) => Number.isFinite(p.v)));
    expect(gap).toBeGreaterThan(0);
    const d = pathOf(points, identity, identity, 100);
    expect(d).toBe('M0 1L10 2L20 3M1000 4L1020 5M2000 6L2000 6');
    expect((d.match(/M/g) ?? []).length).toBe(segments(points, 100).length);
    expect(d).not.toMatch(/NaN|Infinity/);
    expect(pathOf([{ t: 1.26, v: 2.34 }], identity, identity, 100)).toBe(
      'M1.3 2.3L1.3 2.3',
    );
    expect(pathOf([], identity, identity, 100)).toBe('');
    // A scale that returns NaN for a point drops that point.
    expect(
      pathOf(
        [
          { t: 0, v: 1 },
          { t: 1, v: 2 },
        ],
        identity,
        (v) => (v === 2 ? Number.NaN : v),
        100,
      ),
    ).toBe('M0 1L0 1');
    // Areas close on the baseline, one polygon per run.
    expect(areaOf(points.slice(0, 3), identity, identity, 9, 100)).toBe(
      'M0 9L0 1L10 2L20 3L20 9Z',
    );
    expect(
      (areaOf(points, identity, identity, 9, 100).match(/Z/g) ?? []).length,
    ).toBe(3);
  });

  it('AC-4 the gap threshold is three median intervals, and a short series has no gaps', () => {
    const regular = Array.from({ length: 10 }, (_, i) => ({
      t: i * 15_000,
      v: i,
    }));
    expect(gapThreshold(regular)).toBe(45_000);
    expect(gapThreshold(regular.slice(0, 2))).toBe(Infinity);
    expect(gapThreshold([])).toBe(Infinity);
    // A line is never bridged over a silence longer than the threshold.
    const withHole = [...regular, { t: 10 * 15_000 + 10 * 60_000, v: 1 }];
    expect(segments(withHole, gapThreshold(withHole))).toHaveLength(2);
  });
});
