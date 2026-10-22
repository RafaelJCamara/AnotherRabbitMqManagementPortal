// Picking a point (M1-54, R7): the nearest point to a time (a pointer), the last point at or before a time (the
// value a series had at the cursor) and the keyboard steps of the cursor. Pure; no DOM.
import type { Point } from './downsample';

/** The index of the point nearest in time to `t` (ties go to the earlier point), or -1 for no points. */
export function nearestIndex(points: readonly Point[], t: number): number {
  if (points.length === 0 || Number.isNaN(t)) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid]?.t ?? Infinity) < t) lo = mid + 1;
    else hi = mid;
  }
  const after = points[lo];
  const before = points[lo - 1];
  if (after === undefined) return -1;
  if (before === undefined) return lo;
  return t - before.t <= after.t - t ? lo - 1 : lo;
}

/** The index of the last point at or before `t`, or -1 when the series had no point yet. */
export function atOrBefore(points: readonly Point[], t: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid]?.t ?? Infinity) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Where a key moves the cursor, an index into `length` points: Left and PageUp go back (one and ten points), Right
 * and PageDown forward, Home and End to the ends; from no cursor any of them lands on the newest point. A move
 * stops at the ends. Escape clears the cursor (`null`); any other key is not a cursor key (`undefined`).
 */
export function stepCursor(
  current: number | null,
  key: string,
  length: number,
): number | null | undefined {
  if (key === 'Escape') return null;
  const delta =
    key === 'ArrowLeft'
      ? -1
      : key === 'ArrowRight'
        ? 1
        : key === 'PageUp'
          ? -10
          : key === 'PageDown'
            ? 10
            : 0;
  if (delta === 0 && key !== 'Home' && key !== 'End') return undefined;
  if (length <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (current === null) return length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}
