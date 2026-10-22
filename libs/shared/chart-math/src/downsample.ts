// Downsampling to the pixel width (M1-54, R6): for each pixel column keep the first, the last, the lowest and the
// highest point (the "M4" reduction), so a spike is never lost and a column costs at most four vertices. The
// result is a subsequence of the input in time order. Pure; no DOM.

export interface Point {
  readonly t: number;
  readonly v: number;
}

const finite = (point: Point): boolean =>
  Number.isFinite(point.t) && Number.isFinite(point.v);

/**
 * The points of `points` (ascending in time) inside `[from, to]` reduced to at most four per column of a plot
 * `columns` pixels wide. Points that are not finite are dropped. With four points or fewer per column on
 * average nothing is reduced.
 */
export function downsample(
  points: readonly Point[],
  from: number,
  to: number,
  columns: number,
): Point[] {
  const width = Math.max(1, Math.floor(columns));
  const inside = points.filter(
    (point) => finite(point) && point.t >= from && point.t <= to,
  );
  if (inside.length <= width * 4) return inside;
  const span = to - from;
  const out: Point[] = [];
  let column = -1;
  let first = 0;
  let last = 0;
  let low = 0;
  let high = 0;
  const flush = (): void => {
    if (column < 0) return;
    const picked = [...new Set([first, low, high, last])].sort((a, b) => a - b);
    for (const index of picked) {
      const point = inside[index];
      if (point !== undefined) out.push(point);
    }
  };
  inside.forEach((point, index) => {
    const at =
      span > 0
        ? Math.min(width - 1, Math.floor(((point.t - from) / span) * width))
        : 0;
    if (at !== column) {
      flush();
      column = at;
      first = low = high = index;
    }
    last = index;
    if (point.v < (inside[low]?.v ?? point.v)) low = index;
    if (point.v > (inside[high]?.v ?? point.v)) high = index;
  });
  flush();
  return out;
}
