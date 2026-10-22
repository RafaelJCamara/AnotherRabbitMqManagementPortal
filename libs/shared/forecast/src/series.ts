// The shape every function of this library reads: a time series of finite numbers, oldest first.
// Real series are messy (a scrape that repeated a timestamp, a NaN a broker sent), so each function
// cleans its input with `cleanSeries` first and never throws on it.

/** One observation: `t` is epoch milliseconds, `v` the value. */
export interface Point {
  readonly t: number;
  readonly v: number;
}

/**
 * The finite points in time order, one per timestamp (the last one wins). A copy: the argument is
 * never changed.
 */
export function cleanSeries(points: readonly Point[]): Point[] {
  const finite = points.filter(
    (point) => Number.isFinite(point.t) && Number.isFinite(point.v),
  );
  // Series are almost always sorted already; the check keeps the common case linear.
  let sorted = true;
  let previous: Point | undefined;
  for (const point of finite) {
    if (previous !== undefined && point.t < previous.t) {
      sorted = false;
      break;
    }
    previous = point;
  }
  const ordered = sorted ? finite : [...finite].sort((a, b) => a.t - b.t);
  const out: Point[] = [];
  for (const point of ordered) {
    const last = out.at(-1);
    if (last?.t === point.t) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}
