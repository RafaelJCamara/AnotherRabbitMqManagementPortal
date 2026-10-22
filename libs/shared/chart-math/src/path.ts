// SVG path strings (M1-54, R1, R6). A line is broken where the series has a gap in time (a visible gap, never a
// bridge over missing data), coordinates are rounded to one decimal, and a value that is not finite never reaches
// a path. Pure; no DOM.
import type { Point } from './downsample';

/** Three times the median interval between points: a longer silence is a gap. `Infinity` with fewer than two intervals. */
export function gapThreshold(points: readonly Point[], factor = 3): number {
  const intervals: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a !== undefined && b !== undefined && b.t > a.t) {
      intervals.push(b.t - a.t);
    }
  }
  if (intervals.length < 2) return Infinity;
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)] ?? Infinity;
  return median * factor;
}

/** The runs of points with no gap longer than `gapMs` between neighbours; non-finite points are skipped. */
export function segments(points: readonly Point[], gapMs: number): Point[][] {
  const runs: Point[][] = [];
  let run: Point[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.t) || !Number.isFinite(point.v)) continue;
    const before = run[run.length - 1];
    if (before !== undefined && point.t - before.t > gapMs) {
      runs.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

const round = (value: number): string => String(Math.round(value * 10) / 10);

function pair(
  point: Point,
  x: (t: number) => number,
  y: (v: number) => number,
): string | null {
  const px = x(point.t);
  const py = y(point.v);
  return Number.isFinite(px) && Number.isFinite(py)
    ? `${round(px)} ${round(py)}`
    : null;
}

/** The `d` of a line over `points`: one `M` per run; a run of one point is a zero-length stroke (a dot with round caps). */
export function pathOf(
  points: readonly Point[],
  x: (t: number) => number,
  y: (v: number) => number,
  gapMs: number,
): string {
  const parts: string[] = [];
  for (const run of segments(points, gapMs)) {
    const coordinates = run
      .map((point) => pair(point, x, y))
      .filter((c): c is string => c !== null);
    const [head] = coordinates;
    if (head === undefined) continue;
    parts.push(
      coordinates.length === 1
        ? `M${head}L${head}`
        : `M${head}${coordinates
            .slice(1)
            .map((c) => `L${c}`)
            .join('')}`,
    );
  }
  return parts.join('');
}

/** The `d` of the area between a line and the `baseline` pixel row, one closed polygon per run. */
export function areaOf(
  points: readonly Point[],
  x: (t: number) => number,
  y: (v: number) => number,
  baseline: number,
  gapMs: number,
): string {
  const parts: string[] = [];
  for (const run of segments(points, gapMs)) {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) continue;
    const coordinates = run
      .map((point) => pair(point, x, y))
      .filter((c): c is string => c !== null);
    if (coordinates.length === 0) continue;
    parts.push(
      `M${round(x(first.t))} ${round(baseline)}${coordinates.map((c) => `L${c}`).join('')}L${round(x(last.t))} ${round(baseline)}Z`,
    );
  }
  return parts.join('');
}
