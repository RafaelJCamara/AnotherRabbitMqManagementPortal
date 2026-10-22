// Ordinary least squares over a window of a series, with what a confidence band needs. Time is
// measured in seconds before the last point of the window, so the intercept is the fitted value
// "now" and the arithmetic stays small and exact for epoch-millisecond inputs.
import type { Point } from './series.ts';

export interface LinearFit {
  readonly n: number;
  /** Change of the value per second. */
  readonly slope: number;
  /** The fitted value at the last point of the window. */
  readonly current: number;
  /** Coefficient of determination, 0 to 1. A constant series that the line fits exactly is 1. */
  readonly r2: number;
  /** Standard error of the slope (per second); 0 when the fit is exact. */
  readonly slopeError: number;
  /** Milliseconds from the first to the last point of the window. */
  readonly spanMs: number;
}

/** Fits `points` (at least 3, oldest first). */
export function linearFit(points: readonly Point[]): LinearFit {
  const n = points.length;
  const first = points[0];
  const last = points.at(-1);
  if (n < 3 || first === undefined || last === undefined) {
    throw new RangeError('A fit needs at least 3 points.');
  }
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += (point.t - last.t) / 1000;
    sumY += point.v;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const point of points) {
    const dx = (point.t - last.t) / 1000 - meanX;
    const dy = point.v - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residual = Math.max(0, syy - slope * sxy);
  // A flat series fitted exactly has no variance to explain: it is a perfect fit of a constant.
  const r2 = syy === 0 ? 1 : Math.min(1, Math.max(0, 1 - residual / syy));
  const slopeError = sxx === 0 ? 0 : Math.sqrt(residual / (n - 2) / sxx);
  return {
    n,
    slope,
    current: intercept,
    r2,
    slopeError,
    spanMs: last.t - first.t,
  };
}

/**
 * The two-sided 95 % Student t quantile for `df` degrees of freedom (Cornish-Fisher expansion of
 * the normal quantile 1.96: within 0.5 % of the table from 4 degrees of freedom up).
 */
export function tQuantile95(df: number): number {
  const z = 1.959964;
  const d = Math.max(df, 1);
  return (
    z +
    (z ** 3 + z) / (4 * d) +
    (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * d * d)
  );
}
